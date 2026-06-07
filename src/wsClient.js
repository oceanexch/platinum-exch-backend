// wsClient.js
const WebSocket = require("ws");
const { storeStockData, publishData, getData } = require("./services/RedisService");
const DailyHighLowService = require("./services/DailyHighLowService");

const API_TOKEN = "Bearer 96e38803-3bf0-45fd-b0bc-49c1c3208b8a";
const RECONNECT_INTERVAL = 5000;
const CHUNK_SIZE = 500; // Chunk subscriptions to stay safe

function createWebSocketClient(serverUrl, onData = null, isHeader = false) {
  let ws;
  let reconnectTimer;
  let isClosedIndentionally = false;

  async function subscribeToSymbols() {
    if (!ws || ws.readyState !== WebSocket.OPEN) {
      console.warn("⚠️ WebSocket not open, cannot subscribe to symbols.");
      return false;
    }

    try {
      const symbolsJson = await getData('symbols');
      if (symbolsJson) {
        const symbols = JSON.parse(symbolsJson);

        // Safety check: Don't subscribe to 0 symbols (causes disconnection)
        if (symbols.length === 0) {
          console.warn("⚠️ No symbols in Redis - skipping subscription to prevent disconnection");
          return false;
        }

        console.log(`🔄 Subscribing to ${symbols.length} symbols...`);

        // Send all symbols at once for fast subscription
        ws.send(JSON.stringify({ symbols }));

        console.log(`✓ Successfully subscribed to ${symbols.length} symbols`);
        return true;
      } else {
        console.warn("⚠️ No symbols found in Redis to subscribe.");
        return false;
      }
    } catch (err) {
      console.error("❌ Error during symbol subscription:", err.message);
      return false;
    }
  }

  function connect() {

    ws = new WebSocket(serverUrl, {
      headers: {
        Authorization: API_TOKEN
      }
    });

    ws.on("open", async () => {
      isClosedIndentionally = false;

      // On connect, fetch all symbols from Redis and subscribe
      try {
        const symbolsJson = await getData('symbols');
        if (symbolsJson) {
          const symbols = JSON.parse(symbolsJson);
       
          // Emit all symbols at once as requested
          ws.send(JSON.stringify({ symbols }));

        } else {
          console.warn("⚠️ No symbols found in Redis to subscribe.");
        }
      } catch (err) {
        console.error("❌ Error during initial subscription:", err.message);
      }
    });

    ws.on("message", (message) => {
      try {
        const readableData = message.toString("utf8");
        if (!readableData) return;

        const parsed = JSON.parse(readableData);
        // Handle the new API format
        if (parsed.status && Array.isArray(parsed.data)) {
          parsed.data.forEach(item => {
            const symbol = item.symbol;
            if (!symbol) return;
            const zeroCount = [item.ltp, item.bid, item.ask].filter(v => Number(v) === 0).length;
            if (zeroCount >= 2) return;
            if ((item.symbol == "NIFTY50" || item.symbol == "NIFTYBANK" || item.symbol == "INDIAVIX") && item.exchange == "INDICES") {
              if (item.symbol == "NIFTYBANK") {
                item.name = "BANKNIFTY"
              }
              const transformed = {
                ...item,
                InstrumentIdentifier: symbol,
                Symbol: symbol,
                name: item.name,
                Ltp: item.ltp || 0,
                BuyPrice: item.bid || 0,
                SellPrice: item.ask || 0,
                LastTradePrice: item.ltp || 0,
                High: item.high || 0,
                Low: item.low || 0,
                Open: item.open || 0,
                Close: item.close || 0,
                PriceChange: item.ch || 0,
                PriceChangePercentage: item.chp || 0,
                Volume: item.volume || 0,
                ServerTime: Date.now(),
                ServerTime2: new Date().toISOString()
              };
              
              const dataStr = JSON.stringify(transformed);
              const key = symbol + "-TOP";
              publishData(key, JSON.stringify(dataStr));
              if (typeof onData === 'function') onData(key, JSON.stringify(dataStr));
            }
            if (isHeader) {
              // Header mode: specific for TOP data
            } else {
             
              // Transformation to match legacy expected format
              const transformed = {
                ...item,
                InstrumentIdentifier: symbol,
                Symbol: symbol,
                name: item.name,
                Ltp: item.ltp || 0,
                BuyPrice: item.bid || 0,
                SellPrice: item.ask || 0,
                LastTradePrice: item.ltp || 0,
                High: item.high || 0,
                Low: item.low || 0,
                Open: item.open || 0,
                Close: item.close || 0,
                PriceChange: item.ch || 0,
                PriceChangePercentage: item.chp || 0,
                Volume: item.volume || 0,
                ServerTime: Date.now(),
                ServerTime2: new Date().toISOString()
              };

              const dataStr = JSON.stringify(transformed);
              storeStockData(symbol, dataStr);

              // Process high/low tracking
              DailyHighLowService.processStockTick(transformed).catch(err => {
                console.error('❌ High/Low processing error:', err.message);
              });

              if (typeof onData === 'function') onData(symbol, dataStr);
            }
          });
        }
      } catch (err) {
        // Silently skip non-json or malformed messages
        // console.error("Error processing message:", err);
      }
    });

    ws.on("close", () => {
      console.warn("❌ WebSocket connection closed.");
      if (!isClosedIndentionally) {
        clearTimeout(reconnectTimer);
        reconnectTimer = setTimeout(connect, RECONNECT_INTERVAL);
      }
    });

    ws.on("error", (error) => {
      console.error("❌ WebSocket error:", error.message);
      ws.close();
    });

    // Simple keep-alive/heartbeat
    const pingInterval = setInterval(() => {
      if (ws.readyState === WebSocket.OPEN) {
        try {
          ws.ping();
        } catch (e) {
          console.error("Error sending ping:", e.message);
        }
      } else if (ws.readyState === WebSocket.CLOSED || ws.readyState === WebSocket.CLOSING) {
        clearInterval(pingInterval);
      }
    }, 30000);
  }

  connect();

  // Return a proxy-like object to maintain interface compatibility
  return {
    send: (data) => {
      if (ws && ws.readyState === WebSocket.OPEN) {
        ws.send(data);
      } else {
        console.warn("⚠️ WebSocket not open, cannot send data.");
      }
    },
    close: () => {
      isClosedIndentionally = true;
      if (ws) ws.close();
    },
    get readyState() {
      return ws ? ws.readyState : WebSocket.CLOSED;
    },
    get isConnected() {
      return ws && ws.readyState === WebSocket.OPEN;
    },
    /**
     * Resubscribe to symbols without reconnecting
     * Used for fast symbol updates
     */
    resubscribe: async () => {
      try {
        if (!ws || ws.readyState !== WebSocket.OPEN) {
          console.warn("⚠️ WebSocket not open, cannot resubscribe");
          return false;
        }
        
        const success = await subscribeToSymbols();
        return success;
      } catch (err) {
        console.error("❌ Error resubscribing to symbols:", err.message);
        return false;
      }
    },
    /**
     * Reconnect to WebSocket and resubscribe to symbols
     * Used when symbols change (market open/close)
     */
    reconnect: async () => {
      try {
        console.log("🔄 [WebSocket] Reconnecting...");

        // Close existing connection
        isClosedIndentionally = true;
        if (ws && ws.readyState === WebSocket.OPEN) {
          ws.close();
        }

        // Wait for clean close
        await new Promise(resolve => setTimeout(resolve, 100));

        // Reset flag and reconnect
        isClosedIndentionally = false;

        return new Promise((resolve) => {
          let openHandler, subscribeHandler;
          const timeout = setTimeout(() => {
            cleanup();
            console.warn("⚠️ [WebSocket] Reconnection timeout (5s)");
            resolve(false);
          }, 5000);

          const cleanup = () => {
            clearTimeout(timeout);
            if (openHandler && ws) ws.removeEventListener("open", openHandler);
          };

          openHandler = async () => {
            try {
              console.log("✓ [WebSocket] Connected, subscribing to symbols...");
              // Attempt subscription
              const success = await subscribeToSymbols();
              cleanup();
              if (success) {
                console.log("✓ [WebSocket] Reconnected and subscribed successfully");
                resolve(true);
              } else {
                console.warn("⚠️ [WebSocket] Subscription failed during reconnect");
                resolve(false);
              }
            } catch (err) {
              console.error("❌ [WebSocket] Error during subscription:", err.message);
              cleanup();
              resolve(false);
            }
          };

          // Start connection
          connect();

          // Listen for open event once
          ws.once("open", openHandler);
        });
      } catch (err) {
        console.error("❌ [WebSocket] Error reconnecting:", err.message);
        return false;
      }
    }
  };
}

module.exports = createWebSocketClient;
