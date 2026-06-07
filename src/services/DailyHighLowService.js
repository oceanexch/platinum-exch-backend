const DailyHighLow = require('../models/DailyHighLowModel');
const RedisService = require('./RedisService');
const { redisPublisher } = require('../config/redis');
const { MARKET_IDS, MARKET_NAMES } = require('../config/marketConstants');

class DailyHighLowService {
  static getPeriodKeys() {
    const now = new Date();
    const today = now.toISOString().split('T')[0];

    // ISO week number — stable all week (Mon–Sun), resets each new week
    const dayOfWeek = (now.getDay() + 6) % 7; // Mon=0 … Sun=6
    const thursday = new Date(now);
    thursday.setDate(now.getDate() - dayOfWeek + 3);
    const yearStart = new Date(thursday.getFullYear(), 0, 1);
    const isoWeek = Math.ceil(((thursday - yearStart) / 86400000 + 1) / 7);
    const weekKey = `${thursday.getFullYear()}-W${String(isoWeek).padStart(2, '0')}`;

    // Calendar month key — stable all month, resets on 1st
    // const monthKey = `${String(now.getMonth() + 1).padStart(2, '0')}-${now.getFullYear()}`;

    return {
      daily: { key: today, period: 'DAILY' },
      weekly: { key: weekKey, period: 'WEEKLY' },
      // monthly: { key: monthKey, period: 'MONTHLY' }
    };
  }

  static async processStockTick(stockData) {
    try {
      const { symbol, exchange, name, expiry, high, low, ltp, ask, bid, strike } = stockData;

      if (!symbol) return;

      // Skip INDICES (header data — NIFTY50, BANKNIFTY, INDIAVIX, SENSEX from INDICES exchange)
      if (exchange === 'INDICES') return;

      // Skip NOPT raw exchange ticks (options are tracked under resolved marketId below)
      if (exchange === 'NOPT') return;

      const incomingHigh = parseFloat(high || stockData.High) || 0;
      const incomingLow  = parseFloat(low  || stockData.Low)  || 0;

      if (incomingHigh <= 0 && incomingLow <= 0) return;

      // ── Resolve marketId / marketName using the same rules as dailySymbolSync ──
      const exchangeKey = (exchange || 'OTHERS').toUpperCase();
      const itemName    = (name || symbol || '').toUpperCase();
      const strikeVal   = Number(strike) || 0;

      let marketId;
      let marketName;

      if (itemName === 'SENSEX') {
        // SENSEX always goes to INDEX market
        marketId   = MARKET_IDS.NFUT;
        marketName = MARKET_NAMES[marketId];

      } else if (
        (itemName === 'BANKNIFTY' || itemName === 'NIFTY') &&
        (exchangeKey === 'NFUT' || exchangeKey === 'NSE') &&
        strikeVal === 0 &&
        expiry
      ) {
        // NIFTY / BANKNIFTY futures (strike 0 + expiry) → INDEX
        marketId   = MARKET_IDS.NFUT;
        marketName = MARKET_NAMES[marketId];

      } else if (exchangeKey === 'NFUT' || exchangeKey === 'NSE') {
        if (!expiry) {
          // No expiry → NSE-EQ
          marketId   = MARKET_IDS.NSE_EQ;
          marketName = MARKET_NAMES[marketId];
        } else {
          // Has expiry → NSE-FO
          marketId   = MARKET_IDS.NSE;
          marketName = MARKET_NAMES[marketId];
        }

      } else if (exchangeKey === 'NOPT') {
        marketId   = MARKET_IDS.NOPT;
        marketName = MARKET_NAMES[marketId];

      } else if (exchangeKey === 'MCX') {
        marketId   = MARKET_IDS.MCX;
        marketName = MARKET_NAMES[marketId];

      } else if (exchangeKey === 'COMEX') {
        marketId   = MARKET_IDS.COMEX;
        marketName = MARKET_NAMES[marketId];

      } else if (
        itemName.includes('DOWJONES') || itemName.includes('GIFTNIFTY') ||
        itemName.includes('S&P')      || itemName.includes('SPX')       ||
        itemName.includes('S AND P')  || itemName.includes('NASDAQ')    ||
        itemName.includes('GLOBAL')
      ) {
        // Specific global indices → GLOBAL
        marketId   = MARKET_IDS.GLOBAL;
        marketName = MARKET_NAMES[marketId];

      } else if (
        exchangeKey === 'GLOBAL' || exchangeKey === 'FOREX' ||
        exchangeKey === 'FX'     || exchangeKey === 'LMAX'
      ) {
        // Other global / forex items → FOREX
        marketId   = MARKET_IDS.FOREX;
        marketName = MARKET_NAMES[marketId];

      } else {
        // Fallback: use MARKET_IDS lookup or default to NSE
        marketId   = MARKET_IDS[exchangeKey] || MARKET_IDS.NSE;
        marketName = MARKET_NAMES[marketId]  || exchangeKey;
      }

      const scriptId = symbol;
      const periods = this.getPeriodKeys();

      for (const [, periodInfo] of Object.entries(periods)) {
        const { key: periodKey, period } = periodInfo;

        const redisHighKey = `high:${period}:${scriptId}:${periodKey}`;
        const redisLowKey = `low:${period}:${scriptId}:${periodKey}`;

        const [currentHigh, currentLow] = await Promise.all([
          RedisService.getData(redisHighKey),
          RedisService.getData(redisLowKey)
        ]);

        const currentHighPrice = currentHigh ? parseFloat(currentHigh) : null;
        const currentLowPrice = currentLow ? parseFloat(currentLow) : null;

        // Check if incoming high is a new high
        if (incomingHigh > 0 && (currentHighPrice === null || incomingHigh > currentHighPrice)) {
          await RedisService.setData(redisHighKey, incomingHigh.toString());

          const highRecord = {
            scriptId,
            marketId,
            marketName,
            scriptName: name || symbol,
            expiry: expiry || null,
            price: incomingHigh,
            ltp: parseFloat(ltp || stockData.Ltp || stockData.LastTradePrice) || 0,
            bid: parseFloat(bid || stockData.BuyPrice) || 0,
            ask: parseFloat(ask || stockData.SellPrice) || 0,
            type: 'HIGH',
            period,
            periodKey,
            timestamp: new Date()
          };

          this.saveToDB(highRecord);
          await this.publishHighLow(highRecord);
        }

        // Check if incoming low is a new low
        if (incomingLow > 0 && (currentLowPrice === null || incomingLow < currentLowPrice)) {
          await RedisService.setData(redisLowKey, incomingLow.toString());

          const lowRecord = {
            scriptId,
            marketId,
            marketName,
            scriptName: name || symbol,
            expiry: expiry || null,
            price: incomingLow,
            ltp: parseFloat(ltp || stockData.Ltp || stockData.LastTradePrice) || 0,
            bid: parseFloat(bid || stockData.BuyPrice) || 0,
            ask: parseFloat(ask || stockData.SellPrice) || 0,
            type: 'LOW',
            period,
            periodKey,
            timestamp: new Date()
          };

          this.saveToDB(lowRecord);
          await this.publishHighLow(lowRecord);
        }
      }
    } catch (error) {
      // Silent
    }
  }

  static async publishHighLow(record) {
    try {
      await redisPublisher.publish('DAILY_HIGH_LOW', JSON.stringify({
        type: 'HIGH_LOW_UPDATE',
        data: record
      }));
    } catch (error) {
      // Silent
    }
  }

  static saveToDB(data) {
    setImmediate(async () => {
      try {
        const record = new DailyHighLow(data);
        await record.save();
      } catch (error) {
        // Silent
      }
    });
  }

  static async getHighLow(scriptId) {
    try {
      const periods = this.getPeriodKeys();
      const result = {};

      for (const [periodName, periodInfo] of Object.entries(periods)) {
        const { key: periodKey, period } = periodInfo;

        const redisHighKey = `high:${period}:${scriptId}:${periodKey}`;
        const redisLowKey = `low:${period}:${scriptId}:${periodKey}`;

        const [high, low] = await Promise.all([
          RedisService.getData(redisHighKey),
          RedisService.getData(redisLowKey)
        ]);

        result[periodName] = {
          high: high ? parseFloat(high) : null,
          low: low ? parseFloat(low) : null
        };
      }

      return result;
    } catch (error) {
      return { daily: {}, weekly: {}, monthly: {} };
    }
  }

  static async getHistoricalHighLow(scriptId, period = 'DAILY', limit = 10) {
    try {
      const records = await DailyHighLow.find({
        scriptId,
        period
      })
        .sort({ timestamp: -1 })
        .limit(limit)
        .lean();

      return records;
    } catch (error) {
      return [];
    }
  }
}

module.exports = DailyHighLowService;
