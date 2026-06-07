const { redisSubscriber } = require("./config/redis");
const StockTransaction = require("./models/StockTransactionModel");
const { syncLimitTrade, LimitTradeExecutedEvent } = require("./services/RedisStockService");
const { getSingleStockData } = require("./services/RedisService");
const MonitorService = require("./services/MonitorService");

console.log("📂 [LIMIT-ENGINE] Module file loaded");

/**
 * Store ONLY the latest tick per symbol
 * Map<normalizedSymbol, lastTick>
 */
const symbolBuffers = new Map();

/**
 * Parse Redis tick message. Handles JSON from our publisher; skips binary (e.g. MessagePack) from others.
 * Returns { BuyPrice, SellPrice, LastTradePrice?, ServerTime2? } or null.
 */
function parseTickMessage(message) {
  if (message == null) return null;
  let str = typeof message === "string" ? message : (Buffer.isBuffer(message) ? message.toString("utf8") : String(message));
  if (!str || typeof str !== "string") return null;
  const first = str[0];
  if (first !== "{" && first !== "[") return null; // skip binary / non-JSON
  if (str.includes("\uFFFD")) return null; // skip UTF-8 replacement chars (binary decoded as utf8)
  try {
    const parsed = JSON.parse(str);
    return parsed;
  } catch {
    return null;
  }
}

/**
 * Redis listener – keep LAST tick only
 */
redisSubscriber.psubscribe("stock:*");
redisSubscriber.on("pmessage", (pattern, channel, message) => {
  try {
    const parsed = parseTickMessage(message);
    if (!parsed) return; // not JSON or parse failed (e.g. binary from another publisher)

    const { BuyPrice, SellPrice, LastTradePrice, ServerTime2 } = parsed;
    if (BuyPrice == null && SellPrice == null) return;

    if (channel.toUpperCase().includes("TOP")) return;

    // Strip 'stock:' prefix if present
    const cleanChannel = channel.startsWith("stock:") ? channel.substring(6) : channel;
    const normalizedSymbol = cleanChannel.toUpperCase();
    symbolBuffers.set(normalizedSymbol, {
      BuyPrice,
      SellPrice,
      LastTradePrice,
      ServerTime2,
    });
  } catch (_) {
    // ignore any unexpected error; do not log to avoid spam from bad messages
  }
});

/**
 * LIMIT order execution engine
 */
const limitTrade = async () => {
  try {
    // 1️⃣ Fetch pending LIMIT trades
    const pendingTrades = await StockTransaction.find({
      // orderType: "Limit",
      transactionStatus: "PENDING",
    })
      .select({
        _id: 1,
        userId: 1,
        marketId: 1,
        marketName: 1,
        scriptId: 1,
        scriptName: 1,
        label: 1,
        transactionType: 1, // BUY / SELL
        orderPrice: 1,
        orderType: 1,
        tradePosition: 1,
        quantity: 1,
        lot: 1,
        parentIds: 1,
        ip: 1
      })
      .lean();

    if (!pendingTrades.length) return;

    const executableTradeIds = [];

    // console.log("Limit trade start ------------------------");
    // 2️⃣ Evaluate each trade using LAST price only
    for (const trade of pendingTrades) {
      const symbolKey = trade.scriptId.toUpperCase();
      // Data is published under the label (e.g. "HDFCBANK 30MAR2026"), not scriptId.
      // Always fetch fresh from Redis hash each cycle — do NOT use symbolBuffers cache
      // because psubscribe("stock:*") never fires for these label-keyed symbols
      // (published without "stock:" prefix), so the in-memory cache goes stale instantly.
      let tick = null;

      let rawData = await getSingleStockData(symbolKey);
      if (!rawData && trade.label) {
        rawData = await getSingleStockData(trade.label);
      }
      if (rawData) {
        try {
          tick = JSON.parse(rawData);
        } catch (e) {
          console.error("❌ Error parsing Redis stock data:", e);
        }
      }

      if (!tick) {
        // console.log(`[LimitEngine] No tick found for trade ${trade._id} | scriptId: ${trade.scriptId} | label: ${trade.label}`);
        continue; // no market data yet
      }

      const { transactionType, tradePosition, orderPrice } = trade;
      const { BuyPrice, SellPrice } = tick;
      // console.log("Tick data ...", tick);
      let triggered = false;
      let conditionDesc = "";

      if (transactionType === "BUY") {
        if (tradePosition === "UP") {
          // BUY UP: execute when BuyPrice rises to or above orderPrice
          triggered = SellPrice >= orderPrice;
          conditionDesc = `BUY UP | BuyPrice(${SellPrice}) >= orderPrice(${orderPrice}) => ${triggered}`;
        } else {
          // BUY DOWN: execute when BuyPrice falls to or below orderPrice
          triggered = SellPrice <= orderPrice;
          conditionDesc = `BUY DOWN | BuyPrice(${SellPrice}) <= orderPrice(${orderPrice}) => ${triggered}`;
        }
      } else if (transactionType === "SELL") {
        if (tradePosition === "UP") {
          // SELL UP: execute when SellPrice rises to or above orderPrice
          triggered = BuyPrice >= orderPrice;
          conditionDesc = `SELL UP | SellPrice(${BuyPrice}) >= orderPrice(${orderPrice}) => ${triggered}`;
        } else {
          // SELL DOWN: execute when SellPrice falls to or below orderPrice
          triggered = BuyPrice <= orderPrice;
          conditionDesc = `SELL DOWN | SellPrice(${BuyPrice}) <= orderPrice(${orderPrice}) => ${triggered}`;
        }
      }

      // console.log(`[LimitEngine] Trade ${trade._id} | ${trade.label || trade.scriptId} | ${conditionDesc}`);

      if (triggered) executableTradeIds.push(trade._id);
    }

    // 3️⃣ Detailed execution & Brokerage calculation
    if (!executableTradeIds.length) return;

    const { getParentDetails } = require("./controllers/StockController");
    const { getActiveWeekValan, setUserPosition, updateUserQuantity } = require("./services/StockService");
    const { CommonStockValidator } = require("./validators/StockValidator");
    const { getBaseScriptName } = require("./utils/StockUtils");
    const { saveLog } = require("./services/LogService");
    const getValan = await getActiveWeekValan().catch(() => null);

    for (const tradeId of executableTradeIds) {
      // Fetch fresh trade data for atomic update
      const trade = await StockTransaction.findOne({
        _id: tradeId,
        transactionStatus: "PENDING"
      });

      if (!trade) continue;


      const symbolKey = trade.scriptId.toUpperCase();
      // Always fetch fresh from Redis hash — do NOT use symbolBuffers cache here
      // for the same reason as in the discovery loop (frozen prices).
      let tick = null;
      let rawData = await getSingleStockData(symbolKey).catch(() => null);
      if (!rawData && trade.label) {
        rawData = await getSingleStockData(trade.label).catch(() => null);
      }
      if (rawData) {
        try {
          tick = JSON.parse(rawData);
        } catch (e) {
          console.error("❌ Error parsing Redis stock data in phase 3:", e);
        }
      }

      if (!tick) {
        console.warn(`[LimitEngine] No tick at execution time for trade ${trade._id}`);
        continue;
      }

      // Fetch user context for brokerage
      const services = await getParentDetails(trade.userId, trade.marketId);
      if (!services) continue;

      services.getMarket = services.marketAccess.find(m => m.marketId == trade.marketId);
      services.getValan = getValan;

      // Prepare reqData for validator
      // We pass the whole trade object (it has transactionType, orderPrice, etc.)
      const reqData = {
        ...trade.toObject(),
        executedprice: trade.transactionType == "BUY" ? tick.BuyPrice : tick.SellPrice,
        price: trade.orderPrice, // for brokerage calc
        isExecution: true // Bypass pending brokerage restriction in validator
      };

      const calcResult = await CommonStockValidator.calculateBrokerageAndMargin(reqData, services, tick);
      if (!calcResult.isValid) {
        console.error(`❌ Brokerage calculation failed for limit trade ${trade._id}:`, calcResult.message);
        continue;
      }

      const { checkQuantity, ...calculatedData } = calcResult.data;

      // Determine execution message based on order type and exit position flag
      const txnType = trade.transactionType === 'BUY' ? 'Buy' : 'Sell';
      const isStopLoss = trade.shortmsg && (trade.shortmsg.toLowerCase().includes('stop loss') || trade.shortmsg.toLowerCase().includes('sl'));
      const isExitPosition = trade.isExitPosition === true;
      
      let executionMessage, executionShortMsg;
      if (isExitPosition) {
        if (isStopLoss) {
          executionMessage = `Close position (${txnType} stop loss)`;
          executionShortMsg = `Close position (${txnType} stop loss)`;
        } else {
          executionMessage = `Close position (${txnType} limit)`;
          executionShortMsg = `Close position (${txnType} limit)`;
        }
      } else {
        if (isStopLoss) {
          executionMessage = `${txnType} stop loss order executed`;
          executionShortMsg = `${txnType} stop loss order executed`;
        } else {
          executionMessage = `${txnType} limit order executed`;
          executionShortMsg = `${txnType} limit order executed`;
        }
      }

      const updateResult = await StockTransaction.updateOne(
        { _id: trade._id, transactionStatus: "PENDING" },
        {
          $set: {
            executedprice: trade.transactionType == "BUY" ? tick.BuyPrice : tick.SellPrice,
            transactionStatus: "COMPLETED",
            createdAt: new Date(),
            updatedAt: new Date(),
            message: executionMessage,
            shortmsg: executionShortMsg,
            ...calculatedData
          }
        },
        { strict: false }
      );

      if (updateResult.modifiedCount > 0) {
        console.log(`✅ [LimitEngine] EXECUTED trade ${trade._id} | ${trade.label || trade.scriptId} | ${trade.transactionType} | orderPrice: ${trade.orderPrice} | lot: ${trade.lot} | qty: ${trade.quantity}`);

        // Sync & Log
        const tradeLog = {
          action: trade.transactionType,
          userId: trade.userId,
          parentIds: trade.parentIds,
          marketId: trade.marketId,
          scriptId: trade.scriptId,
          symbol: trade.label || trade.scriptName,
          order_type: trade.orderType,
          txn_type: trade.transactionType,
          lot: trade.lot,
          qty: trade.quantity,
          order_price: trade.orderPrice,
          message: executionMessage,
          ip: trade.ip || "",
          time: Date.now(),
        };
        saveLog("trade", tradeLog);

        const isEqualQty = (calculatedData.newBuyQty || 0) == (calculatedData.newSellQty || 0);
        await setUserPosition(trade.userId, trade.scriptId, getValan?._id || trade.valanId, isEqualQty);
        await updateUserQuantity(
          { userId: trade.userId, scriptId: trade.scriptId, marketId: trade.marketId },
          { previous: checkQuantity.previous, current: checkQuantity.current }
        );

        // Background sync side effects
        await syncLimitTrade(trade);

        // Notify user and parents that limit order was executed
        await LimitTradeExecutedEvent({
          userId: trade.userId,
          parentIds: trade.parentIds,
          marketId: trade.marketId,
          scriptId: trade.scriptId,
          scriptName: trade.scriptName,
          label: trade.label,
          transactionType: trade.transactionType,
          lot: trade.lot,
          quantity: trade.quantity,
          price: trade.transactionType === "BUY" ? tick.BuyPrice : tick.SellPrice,
          orderPrice: trade.orderPrice,
          orderType: trade.orderType,
          message: executionMessage,
        });

        // 🔔 Monitor: notify watchers that limit triggered (fire-and-forget)
        const executedPrice = trade.transactionType === "BUY" ? tick.BuyPrice : tick.SellPrice;
        MonitorService.notifyWatchers(trade.userId, 'LIMIT_PASSED', {
          loginUserId: trade.userId,
          ip: trade.ip || '—',
          device: 'LIMIT_ENGINE',
          parentIds: trade.parentIds || [],
          label: trade.label,
          transactionType: trade.transactionType,
          lot: trade.lot,
          quantity: trade.quantity,
          price: executedPrice,
          oldValues: {
            lot: trade.lot,
            quantity: trade.quantity,
            price: trade.orderPrice
          },
          marketName: trade.marketName,
          marketId: trade.marketId,
          orderType: trade.orderType,
          reason: executionMessage,
          time: new Date()
        }).catch(() => { });
      } else {
        console.warn(`⚠️ [LimitEngine] Update skipped (already modified?) for trade ${trade._id}`);
      }
    }
  } catch (err) {
    console.error("❌ LimitTrade engine error:", err);
  }
};

/**
 * Run engine every 3 seconds
 */
setInterval(limitTrade, 2000);
