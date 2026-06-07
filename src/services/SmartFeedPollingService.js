const axios = require('axios');
const http = require('http');
const https = require('https');
const SmartFeedAuthService = require('./SmartFeedAuthService');
const RedisService = require('./RedisService');
const { HEADER_INDICES, SMARTFEED_BATCH_SIZE } = require('../config/marketConstants');

// Force IPv4
const httpAgent = new http.Agent({ family: 4 });
const httpsAgent = new https.Agent({ family: 4 });

/**
 * Service to poll SmartFeed API for live data
 */
class SmartFeedPollingService {
    constructor(relayCallback) {
        this.relayCallback = relayCallback;
        this.interval = null;
        this.batchSize = SMARTFEED_BATCH_SIZE || 250; 
        this.pollInterval = 500; // Default 500ms
        this.SMARTFEED_BASE_URL = process.env.SMARTFEED_BASE_URL || 'https://smartfeed.getlivefeed.xyz/api/v1';
        this.isRunning = false;
    }

    /**
     * Start the polling loop
     */
    async start() {
        if (this.isRunning) return;
        this.isRunning = true;
        console.log('🚀 [SmartFeedPolling] Polling Service started.');
        
        this.runLoop();
    }

    /**
     * The main loop
     */
    async runLoop() {
        while (this.isRunning) {
            const startTime = Date.now();
            
            try {
                await this.pollData();
            } catch (err) {
                console.error('❌ [SmartFeedPolling] Loop error:', err.message);
                if (err.response?.status === 401) {
                    await SmartFeedAuthService.clearToken(); // Force re-login next time
                }
            }

            const elapsed = Date.now() - startTime;
            const waitTime = Math.max(0, this.pollInterval - elapsed);
            
            await new Promise(resolve => setTimeout(resolve, waitTime));
        }
    }

    /**
     * Fetch data for all tokens and relay to workers
     */
    async pollData() {
        const tokensJson = await RedisService.getData('smartfeed_tokens');
        if (!tokensJson) return;

        const tokens = JSON.parse(tokensJson);
        if (!Array.isArray(tokens) || tokens.length === 0) return;

        const token = await SmartFeedAuthService.getAccessToken();

        // Chunk tokens into batches
        for (let i = 0; i < tokens.length; i += this.batchSize) {
            const batch = tokens.slice(i, i + this.batchSize);
            const instrumentTokens = batch.join(',');

            // We don't await each batch to keep it fast, but for 500ms we should be careful
            this.fetchBatch(instrumentTokens, token);
        }
    }

    /**
     * Fetch a single batch of data
     */
    async fetchBatch(instrumentTokens, accessToken) {
        try {
            const response = await axios.post(`${this.SMARTFEED_BASE_URL}/Instrument/feedData`, 
                { instrumentTokens },
                { 
                    headers: { 
                        'Authorization': `Bearer ${accessToken}`,
                        'Content-Type': 'application/json',
                        'X-IP-Version': 'IPv4'
                    },
                    httpAgent,
                    httpsAgent
                }
            );

            if (response.data && response.data.succeeded && Array.isArray(response.data.data)) {
                this.processAndRelay(response.data.data);
            }
        } catch (err) {
            // Silently handle batch errors to keep loop running
        }
    }

    /**
     * Transform SmartFeed data to match system format and relay to workers
     */
    processAndRelay(dataList) {
        dataList.forEach(item => {
            const symbol = item.instrument_token || item.exchangeToken; // We use token as the primary identifier
            if (!symbol) return;

            // Transform to match existing "stock-data" listener expectation
            const transformed = {
                ...item,
                InstrumentIdentifier: symbol,
                Symbol: item.tradingsymbol || symbol,
                name: item.name,
                tradingsymbol: item.tradingsymbol,
                Ltp: parseFloat(item.last_price) || 0,
                BuyPrice: parseFloat(item.buy_price_0 || 0),
                SellPrice: parseFloat(item.sell_price_0 || 0),
                LastTradePrice: parseFloat(item.last_price) || 0,
                High: parseFloat(item.ohlc_high) || 0,
                Low: parseFloat(item.ohlc_low) || 0,
                Open: parseFloat(item.ohlc_open) || 0,
                Close: parseFloat(item.ohlc_close) || 0,
                PriceChange: parseFloat(item.change) || 0,
                PriceChangePercentage: parseFloat(item.percentage_change) || 0,
                Volume: item.volume || 0,
                exchange: (item.exchange === 'NSE-OPT' ? 'NFO' : item.exchange),
                ServerTime: Date.now(),
                ServerTime2: new Date().toISOString()
            };

            // Relay logic
            const isHeader = HEADER_INDICES.some(h => 
                (h.symbol === symbol && h.exchange === item.exchange) || 
                (h.symbol === item.tradingsymbol && h.exchange === item.exchange)
            );

            if (isHeader) {
                // Header Top data emits to [symbol]-TOP channel and requires stringified-twice payload historically
                if (item.symbol === "NIFTYBANK" || item.tradingsymbol === "NIFTYBANK") {
                    transformed.name = "BANKNIFTY"; // Map to legacy expected name
                }
                const ch = symbol + '-TOP';
                RedisService.publishData(ch, JSON.stringify(JSON.stringify(transformed)));
            } else {
                // Normal Stock Data - We rely on RedisService.storeStockData to both save and PUBLISH
                // This ensures M2MWatcher and all Workers (via Master's psubscribe) get the update.
                RedisService.storeStockData(symbol, JSON.stringify(transformed));
            }
        });
    }

    stop() {
        this.isRunning = false;
    }
}

module.exports = SmartFeedPollingService;
