/**
 * Configurable thresholds for each user behavior pattern.
 * Edit values here to tune sensitivity. No restart needed for cron jobs
 * but API calls load this at require-time (restart server after editing).
 */
module.exports = {
  highProfitLowLoss: {
    label: "High Profit Low Loss",
    minTrades: 10,
    profitTradeRatio: 0.6,       // >= 60% of closed trades must be profitable
    avgProfitToLossRatio: 1.5,   // avg profit per trade >= 1.5x avg loss per trade
  },

  highLossLowProfit: {
    label: "High Loss Low Profit",
    minTrades: 10,
    lossTradeRatio: 0.6,         // >= 60% of closed trades must be losing
    avgLossToProfit: 1.5,        // avg loss per trade >= 1.5x avg profit per trade
  },

  forwardToForward: {
    label: "Forward to Forward",
    minTrades: 5,
    fwTradeRatio: 0.3,           // >= 30% of trades have type "FW"
  },

  limitToLimit: {
    label: "Limit to Limit Trade",
    minTrades: 10,
    limitOrderRatio: 0.5,        // >= 50% of trades have orderType "Limit" / "LIMIT"
  },

  shortSellers: {
    label: "Short Sellers",
    minTrades: 10,
    shortOpenRatio: 0.6,         // >= 60% of opened positions start with SELL
  },

  longBuyers: {
    label: "Long Buyers",
    minTrades: 10,
    longOpenRatio: 0.6,          // >= 60% of opened positions start with BUY
  },

  slTrade: {
    label: "SL Trade (Safe Exiters)",
    minTrades: 10,
    slOrderRatio: 0.5,           // >= 50% of closed positions were exited via Limit order
  },

  noLimitSlTrade: {
    label: "No Limit SL Trades",
    minTrades: 10,
    noLimitRatio: 0.6,           // >= 60% of closed positions were exited via Market order
  },

  averagingDown: {
    label: "Averaging Down Traders",
    minTrades: 5,
    minAvgDownInstances: 3,      // minimum number of averaging-down re-entries detected
    minAvgDownRatio: 0.2,        // >= 20% of re-entries are averaging down
  },

  averagingUp: {
    label: "Averaging Up Traders",
    minTrades: 5,
    minAvgUpInstances: 3,
    minAvgUpRatio: 0.2,
  },

  intraday: {
    label: "Intraday Traders",
    minTrades: 10,
    intradayRatio: 0.6,          // >= 60% of total quantity is intraday
  },

  eventTrader: {
    label: "Event Traders",
    minTrades: 5,
    eventWindowDays: 2,          // trade must be within ±2 calendar days of an event
    eventTradeRatio: 0.4,        // >= 40% of trades happen around event dates
  },

  concentratedPortfolio: {
    label: "Concentrated Portfolio",
    minTrades: 10,
    topN: 3,                     // look at top N scripts by traded value
    topScriptConcentration: 0.7, // top N scripts account for >= 70% of total value
  },

  jackpotTrader: {
    label: "Jackpot Traders",
    minTrades: 10,
    topN: 3,                     // top N profitable trades
    topTradesProfitRatio: 0.5,   // top N trades account for >= 50% of total profit
  },

  openingTrader: {
    label: "Opening Traders",
    minTrades: 10,
    openingRatio: 0.4,           // >= 40% of trades placed in opening window
    openingWindowMinutes: 30,    // window starts at market open (9:15 AM IST) + this many minutes
  },
};
