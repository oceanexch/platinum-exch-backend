const mongoose = require("mongoose");
const moment = require("moment");
const StockTransaction = require("../models/StockTransactionModel");
const UserBehaviorAnalysis = require("../models/UserBehaviorAnalysisModel");
const EventCalendar = require("../models/EventCalendarModel");
const behaviorConfig = require("../config/behaviorConfig");

const MAX_BEHAVIORS = 3;
const MARKET_OPEN_HOUR_IST = 9;
const MARKET_OPEN_MINUTE_IST = 15;

// ─── FIFO PAIR MATCHING ───────────────────────────────────────────────────────

/**
 * Match BUY and SELL transactions using FIFO to produce closed trade pairs.
 * Each closed trade has: direction, openPrice, closePrice, qty, pnl,
 * openOrderType, closeOrderType, openType (NRM/FW/CF), openTime, closeTime,
 * scriptId, scriptName, marketId, intradayQty (from opening tx).
 */
function buildClosedTrades(transactions) {
  const scriptGroups = {};
  for (const tx of transactions) {
    const key = `${tx.scriptId}__${tx.userId}`;
    if (!scriptGroups[key]) scriptGroups[key] = [];
    scriptGroups[key].push(tx);
  }

  const closedTrades = [];

  for (const key of Object.keys(scriptGroups)) {
    const txs = scriptGroups[key].sort(
      (a, b) => new Date(a.createdAt) - new Date(b.createdAt)
    );

    // FIFO queues for open long/short legs
    const buyQueue = []; // { price, qty, tx }
    const sellQueue = [];

    for (const tx of txs) {
      const price = tx.orderPrice || 0;
      const qty = tx.quantity || 0;

      if (tx.transactionType === "BUY") {
        let remaining = qty;

        // Close open short positions first (FIFO)
        while (remaining > 0 && sellQueue.length > 0) {
          const openShort = sellQueue[0];
          const matchQty = Math.min(remaining, openShort.qty);
          const pnl = (openShort.price - price) * matchQty;

          closedTrades.push({
            direction: "SHORT",
            openTx: openShort.tx,
            closeTx: tx,
            openPrice: openShort.price,
            closePrice: price,
            quantity: matchQty,
            pnl,
            openTime: openShort.tx.createdAt,
            closeTime: tx.createdAt,
            scriptId: tx.scriptId,
            scriptName: tx.scriptName,
            marketId: tx.marketId,
            openOrderType: openShort.tx.orderType,
            closeOrderType: tx.orderType,
            openType: openShort.tx.type,
            intradayQty: openShort.tx.quantityType
              ? openShort.tx.quantityType.intraday || 0
              : 0,
          });

          openShort.qty -= matchQty;
          remaining -= matchQty;
          if (openShort.qty === 0) sellQueue.shift();
        }

        if (remaining > 0) buyQueue.push({ price, qty: remaining, tx });
      } else {
        // SELL — close open long positions first (FIFO)
        let remaining = qty;

        while (remaining > 0 && buyQueue.length > 0) {
          const openLong = buyQueue[0];
          const matchQty = Math.min(remaining, openLong.qty);
          const pnl = (price - openLong.price) * matchQty;

          closedTrades.push({
            direction: "LONG",
            openTx: openLong.tx,
            closeTx: tx,
            openPrice: openLong.price,
            closePrice: price,
            quantity: matchQty,
            pnl,
            openTime: openLong.tx.createdAt,
            closeTime: tx.createdAt,
            scriptId: tx.scriptId,
            scriptName: tx.scriptName,
            marketId: tx.marketId,
            openOrderType: openLong.tx.orderType,
            closeOrderType: tx.orderType,
            openType: openLong.tx.type,
            intradayQty: openLong.tx.quantityType
              ? openLong.tx.quantityType.intraday || 0
              : 0,
          });

          openLong.qty -= matchQty;
          remaining -= matchQty;
          if (openLong.qty === 0) buyQueue.shift();
        }

        if (remaining > 0) sellQueue.push({ price, qty: remaining, tx });
      }
    }
  }

  return closedTrades;
}

// ─── HELPERS ──────────────────────────────────────────────────────────────────

function isLimitOrder(orderType) {
  return orderType === "Limit" || orderType === "LIMIT";
}

function isMarketOrder(orderType) {
  return (
    orderType === "Market" ||
    orderType === "MARKET" ||
    orderType === "Exit Position (Market)" ||
    orderType === "M2M Loss"
  );
}

function profitLossStats(closedTrades) {
  let totalProfit = 0;
  let totalLoss = 0;
  let profitCount = 0;
  let lossCount = 0;
  for (const t of closedTrades) {
    if (t.pnl > 0) {
      totalProfit += t.pnl;
      profitCount++;
    } else {
      totalLoss += Math.abs(t.pnl);
      lossCount++;
    }
  }
  return { totalProfit, totalLoss, profitCount, lossCount };
}

function buildSuccessRate(trades) {
  if (!trades.length) return { successRate: 0, profitAmount: 0, lossAmount: 0, netPnl: 0, tradeCount: 0 };
  const { totalProfit, totalLoss, profitCount } = profitLossStats(trades);
  return {
    tradeCount: trades.length,
    successRate: Math.round((profitCount / trades.length) * 100),
    profitAmount: Math.round(totalProfit * 100) / 100,
    lossAmount: Math.round(totalLoss * 100) / 100,
    netPnl: Math.round((totalProfit - totalLoss) * 100) / 100,
  };
}

// ─── 15 BEHAVIOR DETECTORS ────────────────────────────────────────────────────

function detectHighProfitLowLoss(closedTrades, cfg) {
  const c = cfg.highProfitLowLoss;
  if (closedTrades.length < c.minTrades) return null;

  const { totalProfit, totalLoss, profitCount, lossCount } = profitLossStats(closedTrades);
  const profitRatio = profitCount / closedTrades.length;
  const avgProfit = profitCount ? totalProfit / profitCount : 0;
  const avgLoss = lossCount ? totalLoss / lossCount : 0;
  const plRatio = avgLoss > 0 ? avgProfit / avgLoss : avgProfit > 0 ? 999 : 0;

  if (profitRatio < c.profitTradeRatio || plRatio < c.avgProfitToLossRatio) return null;

  const confidence = (profitRatio + Math.min(plRatio / c.avgProfitToLossRatio, 2) / 2) / 2;
  return {
    type: "highProfitLowLoss",
    label: c.label,
    confidence: Math.min(confidence, 1),
    ...buildSuccessRate(closedTrades),
  };
}

function detectHighLossLowProfit(closedTrades, cfg) {
  const c = cfg.highLossLowProfit;
  if (closedTrades.length < c.minTrades) return null;

  const { totalProfit, totalLoss, profitCount, lossCount } = profitLossStats(closedTrades);
  const lossRatio = lossCount / closedTrades.length;
  const avgLoss = lossCount ? totalLoss / lossCount : 0;
  const avgProfit = profitCount ? totalProfit / profitCount : 0;
  const lpRatio = avgProfit > 0 ? avgLoss / avgProfit : avgLoss > 0 ? 999 : 0;

  if (lossRatio < c.lossTradeRatio || lpRatio < c.avgLossToProfit) return null;

  const confidence = (lossRatio + Math.min(lpRatio / c.avgLossToProfit, 2) / 2) / 2;
  return {
    type: "highLossLowProfit",
    label: c.label,
    confidence: Math.min(confidence, 1),
    ...buildSuccessRate(closedTrades),
  };
}

function detectForwardToForward(rawTrades, closedTrades, cfg) {
  const c = cfg.forwardToForward;
  if (rawTrades.length < c.minTrades) return null;

  const fwCount = rawTrades.filter((t) => t.type === "FW").length;
  const ratio = fwCount / rawTrades.length;

  if (ratio < c.fwTradeRatio) return null;

  const fwScripts = new Set(rawTrades.filter((t) => t.type === "FW").map((t) => t.scriptId));
  const relatedClosed = closedTrades.filter((t) => fwScripts.has(t.scriptId));
  const stats = buildSuccessRate(relatedClosed.length ? relatedClosed : closedTrades);

  return {
    type: "forwardToForward",
    label: c.label,
    confidence: Math.min(ratio / c.fwTradeRatio, 1),
    ...stats,
  };
}

function detectLimitToLimit(rawTrades, closedTrades, cfg) {
  const c = cfg.limitToLimit;
  if (rawTrades.length < c.minTrades) return null;

  const limitCount = rawTrades.filter((t) => isLimitOrder(t.orderType)).length;
  const ratio = limitCount / rawTrades.length;

  if (ratio < c.limitOrderRatio) return null;

  const limitScripts = new Set(
    rawTrades.filter((t) => isLimitOrder(t.orderType)).map((t) => t.scriptId)
  );
  const relatedClosed = closedTrades.filter((t) => limitScripts.has(t.scriptId));

  return {
    type: "limitToLimit",
    label: c.label,
    confidence: Math.min(ratio / c.limitOrderRatio, 1),
    ...buildSuccessRate(relatedClosed.length ? relatedClosed : closedTrades),
  };
}

function detectShortSellers(closedTrades, cfg) {
  const c = cfg.shortSellers;
  if (closedTrades.length < c.minTrades) return null;

  const shortTrades = closedTrades.filter((t) => t.direction === "SHORT");
  const ratio = shortTrades.length / closedTrades.length;

  if (ratio < c.shortOpenRatio) return null;

  return {
    type: "shortSellers",
    label: c.label,
    confidence: Math.min(ratio / c.shortOpenRatio, 1),
    ...buildSuccessRate(shortTrades),
  };
}

function detectLongBuyers(closedTrades, cfg) {
  const c = cfg.longBuyers;
  if (closedTrades.length < c.minTrades) return null;

  const longTrades = closedTrades.filter((t) => t.direction === "LONG");
  const ratio = longTrades.length / closedTrades.length;

  if (ratio < c.longOpenRatio) return null;

  return {
    type: "longBuyers",
    label: c.label,
    confidence: Math.min(ratio / c.longOpenRatio, 1),
    ...buildSuccessRate(longTrades),
  };
}

function detectSlTrade(closedTrades, cfg) {
  const c = cfg.slTrade;
  if (closedTrades.length < c.minTrades) return null;

  const slExits = closedTrades.filter((t) => isLimitOrder(t.closeOrderType));
  const ratio = slExits.length / closedTrades.length;

  if (ratio < c.slOrderRatio) return null;

  return {
    type: "slTrade",
    label: c.label,
    confidence: Math.min(ratio / c.slOrderRatio, 1),
    ...buildSuccessRate(slExits),
  };
}

function detectNoLimitSlTrade(closedTrades, cfg) {
  const c = cfg.noLimitSlTrade;
  if (closedTrades.length < c.minTrades) return null;

  const marketExits = closedTrades.filter((t) => isMarketOrder(t.closeOrderType));
  const ratio = marketExits.length / closedTrades.length;

  if (ratio < c.noLimitRatio) return null;

  return {
    type: "noLimitSlTrade",
    label: c.label,
    confidence: Math.min(ratio / c.noLimitRatio, 1),
    ...buildSuccessRate(marketExits),
  };
}

function detectAveragingDown(rawTrades, closedTrades, cfg) {
  const c = cfg.averagingDown;
  if (rawTrades.length < c.minTrades) return null;

  const result = _detectAveraging(rawTrades, "down");
  const { avgInstances, reEntryCount } = result;

  if (avgInstances < c.minAvgDownInstances) return null;
  const ratio = reEntryCount > 0 ? avgInstances / reEntryCount : 0;
  if (ratio < c.minAvgDownRatio) return null;

  return {
    type: "averagingDown",
    label: c.label,
    confidence: Math.min((avgInstances / c.minAvgDownInstances) * 0.5 + ratio * 0.5, 1),
    ...buildSuccessRate(closedTrades),
  };
}

function detectAveragingUp(rawTrades, closedTrades, cfg) {
  const c = cfg.averagingUp;
  if (rawTrades.length < c.minTrades) return null;

  const result = _detectAveraging(rawTrades, "up");
  const { avgInstances, reEntryCount } = result;

  if (avgInstances < c.minAvgUpInstances) return null;
  const ratio = reEntryCount > 0 ? avgInstances / reEntryCount : 0;
  if (ratio < c.minAvgUpRatio) return null;

  return {
    type: "averagingUp",
    label: c.label,
    confidence: Math.min((avgInstances / c.minAvgUpInstances) * 0.5 + ratio * 0.5, 1),
    ...buildSuccessRate(closedTrades),
  };
}

function _detectAveraging(rawTrades, direction) {
  const scriptGroups = {};
  for (const tx of rawTrades) {
    if (!scriptGroups[tx.scriptId]) scriptGroups[tx.scriptId] = [];
    scriptGroups[tx.scriptId].push(tx);
  }

  let avgInstances = 0;
  let reEntryCount = 0;

  for (const scriptId of Object.keys(scriptGroups)) {
    const txs = scriptGroups[scriptId].sort(
      (a, b) => new Date(a.createdAt) - new Date(b.createdAt)
    );

    let position = 0; // positive = long, negative = short
    let totalCost = 0;
    let avgCost = 0;

    for (const tx of txs) {
      const price = tx.orderPrice || 0;
      const qty = tx.quantity || 0;

      if (tx.transactionType === "BUY") {
        if (position > 0) {
          // Re-entry into existing long
          reEntryCount++;
          if (direction === "down" && price < avgCost) avgInstances++;
          if (direction === "up" && price > avgCost) avgInstances++;
          totalCost += price * qty;
          position += qty;
          avgCost = totalCost / position;
        } else if (position < 0) {
          // Closing short
          const closeQty = Math.min(qty, Math.abs(position));
          position += closeQty;
          const remaining = qty - closeQty;
          if (position >= 0 && remaining > 0) {
            position = remaining;
            totalCost = price * remaining;
            avgCost = price;
          } else if (position === 0) {
            totalCost = 0;
            avgCost = 0;
          }
        } else {
          position = qty;
          totalCost = price * qty;
          avgCost = price;
        }
      } else {
        // SELL
        if (position < 0) {
          // Re-entry into existing short
          reEntryCount++;
          if (direction === "down" && price > avgCost) avgInstances++;
          if (direction === "up" && price < avgCost) avgInstances++;
          totalCost += price * qty;
          position -= qty;
          avgCost = totalCost / Math.abs(position);
        } else if (position > 0) {
          // Closing long
          const closeQty = Math.min(qty, position);
          position -= closeQty;
          const remaining = qty - closeQty;
          if (position <= 0 && remaining > 0) {
            position = -remaining;
            totalCost = price * remaining;
            avgCost = price;
          } else if (position === 0) {
            totalCost = 0;
            avgCost = 0;
          } else {
            totalCost = avgCost * position;
          }
        } else {
          position = -qty;
          totalCost = price * qty;
          avgCost = price;
        }
      }
    }
  }

  return { avgInstances, reEntryCount };
}

function detectIntraday(rawTrades, closedTrades, cfg) {
  const c = cfg.intraday;
  if (rawTrades.length < c.minTrades) return null;

  const totalQty = rawTrades.reduce((s, t) => s + (t.quantity || 0), 0);
  const intradayQty = rawTrades.reduce(
    (s, t) => s + (t.quantityType ? t.quantityType.intraday || 0 : 0),
    0
  );

  if (totalQty === 0) return null;
  const ratio = intradayQty / totalQty;
  if (ratio < c.intradayRatio) return null;

  const intradayClosed = closedTrades.filter((t) => t.intradayQty > 0);

  return {
    type: "intraday",
    label: c.label,
    confidence: Math.min(ratio / c.intradayRatio, 1),
    ...buildSuccessRate(intradayClosed.length ? intradayClosed : closedTrades),
  };
}

function detectEventTrader(rawTrades, closedTrades, eventsBySymbol, cfg) {
  const c = cfg.eventTrader;
  if (rawTrades.length < c.minTrades || !Object.keys(eventsBySymbol).length) return null;

  const windowMs = c.eventWindowDays * 24 * 60 * 60 * 1000;
  let eventTrades = 0;

  for (const tx of rawTrades) {
    const symbol = (tx.scriptName || tx.scriptId || "").toUpperCase().split(" ")[0];
    const events = eventsBySymbol[symbol] || [];
    const txTime = new Date(tx.createdAt).getTime();
    const nearEvent = events.some((ev) => {
      const evTime = new Date(ev.eventDate).getTime();
      return Math.abs(txTime - evTime) <= windowMs;
    });
    if (nearEvent) eventTrades++;
  }

  const ratio = eventTrades / rawTrades.length;
  if (ratio < c.eventTradeRatio) return null;

  const eventScripts = new Set();
  for (const tx of rawTrades) {
    const symbol = (tx.scriptName || tx.scriptId || "").toUpperCase().split(" ")[0];
    if (eventsBySymbol[symbol]) eventScripts.add(tx.scriptId);
  }
  const relatedClosed = closedTrades.filter((t) => eventScripts.has(t.scriptId));

  return {
    type: "eventTrader",
    label: c.label,
    confidence: Math.min(ratio / c.eventTradeRatio, 1),
    ...buildSuccessRate(relatedClosed.length ? relatedClosed : closedTrades),
  };
}

function detectConcentratedPortfolio(rawTrades, closedTrades, cfg) {
  const c = cfg.concentratedPortfolio;
  if (rawTrades.length < c.minTrades) return null;

  const scriptValue = {};
  for (const tx of rawTrades) {
    if (!scriptValue[tx.scriptId]) scriptValue[tx.scriptId] = 0;
    scriptValue[tx.scriptId] += (tx.orderPrice || 0) * (tx.quantity || 0);
  }

  const totalValue = Object.values(scriptValue).reduce((s, v) => s + v, 0);
  if (totalValue === 0) return null;

  const sorted = Object.values(scriptValue).sort((a, b) => b - a);
  const topN = sorted.slice(0, c.topN);
  const topValue = topN.reduce((s, v) => s + v, 0);
  const ratio = topValue / totalValue;

  if (ratio < c.topScriptConcentration) return null;

  const topScriptIds = Object.entries(scriptValue)
    .sort((a, b) => b[1] - a[1])
    .slice(0, c.topN)
    .map(([id]) => id);
  const relatedClosed = closedTrades.filter((t) => topScriptIds.includes(t.scriptId));

  return {
    type: "concentratedPortfolio",
    label: c.label,
    confidence: Math.min(ratio / c.topScriptConcentration, 1),
    ...buildSuccessRate(relatedClosed.length ? relatedClosed : closedTrades),
  };
}

function detectJackpotTrader(closedTrades, cfg) {
  const c = cfg.jackpotTrader;
  if (closedTrades.length < c.minTrades) return null;

  const profitable = closedTrades.filter((t) => t.pnl > 0).sort((a, b) => b.pnl - a.pnl);
  if (!profitable.length) return null;

  const totalProfit = profitable.reduce((s, t) => s + t.pnl, 0);
  if (totalProfit === 0) return null;

  const topTrades = profitable.slice(0, c.topN);
  const topProfit = topTrades.reduce((s, t) => s + t.pnl, 0);
  const ratio = topProfit / totalProfit;

  if (ratio < c.topTradesProfitRatio) return null;

  return {
    type: "jackpotTrader",
    label: c.label,
    confidence: Math.min(ratio / c.topTradesProfitRatio, 1),
    ...buildSuccessRate(closedTrades),
  };
}

function detectOpeningTrader(rawTrades, closedTrades, cfg) {
  const c = cfg.openingTrader;
  if (rawTrades.length < c.minTrades) return null;

  const openWindowEnd =
    MARKET_OPEN_HOUR_IST * 60 + MARKET_OPEN_MINUTE_IST + c.openingWindowMinutes;

  const openingTrades = rawTrades.filter((tx) => {
    const mIST = moment(tx.createdAt).utcOffset(330); // +5:30
    const minuteOfDay = mIST.hours() * 60 + mIST.minutes();
    const openWindowStart = MARKET_OPEN_HOUR_IST * 60 + MARKET_OPEN_MINUTE_IST;
    return minuteOfDay >= openWindowStart && minuteOfDay <= openWindowEnd;
  });

  const ratio = openingTrades.length / rawTrades.length;
  if (ratio < c.openingRatio) return null;

  const openingScripts = new Set(openingTrades.map((t) => t.scriptId));
  const relatedClosed = closedTrades.filter((t) => openingScripts.has(t.scriptId));

  return {
    type: "openingTrader",
    label: c.label,
    confidence: Math.min(ratio / c.openingRatio, 1),
    ...buildSuccessRate(relatedClosed.length ? relatedClosed : closedTrades),
  };
}

// ─── MAIN ANALYSIS ORCHESTRATOR ───────────────────────────────────────────────

/**
 * Fetch events grouped by symbol for the given date range.
 * Returns { SYMBOL: [event, ...] }
 */
async function fetchEventsBySymbol(startDate, endDate, windowDays) {
  const windowMs = windowDays * 24 * 60 * 60 * 1000;
  const events = await EventCalendar.find({
    eventDate: {
      $gte: new Date(new Date(startDate).getTime() - windowMs),
      $lte: new Date(new Date(endDate).getTime() + windowMs),
    },
  }).lean();

  const map = {};
  for (const ev of events) {
    const sym = (ev.symbol || "").toUpperCase();
    if (!map[sym]) map[sym] = [];
    map[sym].push(ev);
  }
  return map;
}

/**
 * Run all 15 detectors and return top MAX_BEHAVIORS by confidence.
 */
function runDetectors(rawTrades, closedTrades, eventsBySymbol, cfg) {
  const results = [
    detectHighProfitLowLoss(closedTrades, cfg),
    detectHighLossLowProfit(closedTrades, cfg),
    detectForwardToForward(rawTrades, closedTrades, cfg),
    detectLimitToLimit(rawTrades, closedTrades, cfg),
    detectShortSellers(closedTrades, cfg),
    detectLongBuyers(closedTrades, cfg),
    detectSlTrade(closedTrades, cfg),
    detectNoLimitSlTrade(closedTrades, cfg),
    detectAveragingDown(rawTrades, closedTrades, cfg),
    detectAveragingUp(rawTrades, closedTrades, cfg),
    detectIntraday(rawTrades, closedTrades, cfg),
    detectEventTrader(rawTrades, closedTrades, eventsBySymbol, cfg),
    detectConcentratedPortfolio(rawTrades, closedTrades, cfg),
    detectJackpotTrader(closedTrades, cfg),
    detectOpeningTrader(rawTrades, closedTrades, cfg),
  ]
    .filter(Boolean)
    .sort((a, b) => b.confidence - a.confidence)
    .slice(0, MAX_BEHAVIORS);

  return results;
}

/**
 * Core: analyze a single user over a match filter.
 * matchFilter must contain userId + (valanId or date range already applied).
 * Returns { behaviors, totalTrades, totalProfit, totalLoss }
 */
async function analyzeUser(matchFilter, cfg = behaviorConfig) {
  const rawTrades = await StockTransaction.find({
    ...matchFilter,
    transactionStatus: "COMPLETED",
  })
    .select(
      "userId scriptId scriptName marketId transactionType orderType type quantity orderPrice quantityType createdAt valanId parentIds"
    )
    .lean();

  if (!rawTrades.length) return { behaviors: [], totalTrades: 0, totalProfit: 0, totalLoss: 0 };

  // Determine date range from trades for event lookup
  const dates = rawTrades.map((t) => new Date(t.createdAt).getTime());
  const startDate = new Date(Math.min(...dates));
  const endDate = new Date(Math.max(...dates));

  const [closedTrades, eventsBySymbol] = await Promise.all([
    Promise.resolve(buildClosedTrades(rawTrades)),
    fetchEventsBySymbol(startDate, endDate, cfg.eventTrader.eventWindowDays),
  ]);

  const { totalProfit, totalLoss } = profitLossStats(closedTrades);
  const behaviors = runDetectors(rawTrades, closedTrades, eventsBySymbol, cfg);

  return {
    behaviors,
    totalTrades: rawTrades.length,
    totalProfit: Math.round(totalProfit * 100) / 100,
    totalLoss: Math.round(totalLoss * 100) / 100,
  };
}

// ─── PUBLIC API ───────────────────────────────────────────────────────────────

/**
 * Analyze a user for a specific valan (or date range).
 * Returns the result without storing it.
 */
async function analyzeUserForPeriod(userId, options = {}) {
  const { valanId, startDate, endDate } = options;
  const matchFilter = { userId: new mongoose.Types.ObjectId(userId) };

  if (valanId) {
    matchFilter.valanId = new mongoose.Types.ObjectId(valanId);
  } else if (startDate && endDate) {
    matchFilter.createdAt = {
      $gte: new Date(startDate),
      $lte: new Date(endDate),
    };
  }

  return analyzeUser(matchFilter);
}

/**
 * Compute and upsert stored behavior analysis for a user + valan.
 * Used by Sunday cron.
 */
async function computeAndStore(userId, valanDoc) {
  try {
    const uidStr = userId.toString();
    const vidStr = valanDoc._id.toString();

    const result = await analyzeUser({
      userId: new mongoose.Types.ObjectId(uidStr),
      valanId: new mongoose.Types.ObjectId(vidStr),
    });

    if (!result.behaviors || result.behaviors.length === 0) return false;

    await UserBehaviorAnalysis.updateOne(
      { userId: new mongoose.Types.ObjectId(uidStr), valanId: new mongoose.Types.ObjectId(vidStr) },
      {
        $set: {
          periodStart: valanDoc.startDate,
          periodEnd: valanDoc.endDate,
          computedAt: new Date(),
          behaviors: result.behaviors,
          totalTrades: result.totalTrades,
          totalProfit: result.totalProfit,
          totalLoss: result.totalLoss,
        },
        $setOnInsert: {
          userId: new mongoose.Types.ObjectId(uidStr),
          valanId: new mongoose.Types.ObjectId(vidStr),
        },
      },
      { upsert: true }
    );
    return true;
  } catch (err) {
    console.error(`[UserBehavior] computeAndStore failed userId=${userId}`, err.message, err.stack);
    return false;
  }
}

/**
 * Get stored analysis records for given filters.
 * valanIds: array of valan ObjectId strings
 * userIds: array of user ObjectId strings
 * Returns array grouped by userId → valanId.
 */
async function getStoredAnalysis(userIds, valanIds) {
  const filter = {};
  if (userIds && userIds.length) filter.userId = { $in: userIds.map((id) => new mongoose.Types.ObjectId(id)) };
  if (valanIds && valanIds.length) filter.valanId = { $in: valanIds.map((id) => new mongoose.Types.ObjectId(id)) };

  return UserBehaviorAnalysis.find(filter)
    .populate("valanId", "keyidentifier label startDate endDate")
    .lean();
}

module.exports = {
  analyzeUserForPeriod,
  computeAndStore,
  getStoredAnalysis,
  buildClosedTrades,
};
