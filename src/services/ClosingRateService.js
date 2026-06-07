'use strict';

/**
 * ClosingRateService
 * ─────────────────────────────────────────────────────────────────────────────
 *
 * POST-MARKET CLOSING PRICE PIPELINE
 * ────────────────────────────────────
 *
 * 1. fetchClosingRates()
 *      GET /closing-price from Apollo API
 *      Returns: [ { symbol, closing_price }, ... ]
 *
 * 2. applyClosingRatesToRedis(rates)
 *      Processes EACH symbol individually:
 *
 *        a) HGET stocks <symbol>
 *        b) If not in Redis → skip
 *        c) Compare API closing_price vs current LTP (last tick data):
 *
 *              closing_price === Ltp ?
 *                → SKIP — Either already applied, or the API hasn't "toggled" 
 *                  to today's official closing rate yet (it's matching live).
 *                  "if that matches do not set that"
 *
 *              closing_price ≠ Ltp ?
 *                → APPLY — This is the NEW official closing price.
 *                  Set BuyPrice, SellPrice, Ltp, and LastTradePrice to closing_price.
 *                  "if it doesnt [match] only then set that as new closing price"
 *
 *        d) Remove token-keyed duplicate if present.
 *        e) PUBLISH updated payload.
 *
 *      Returns: number of symbols updated this pass.
 * ─────────────────────────────────────────────────────────────────────────────
 */

const axios = require('axios');
const { redisClient } = require('../config/redis');

const BASE_URL   = (process.env.NEW_API_URL  || 'https://feed.apollo.in.net/test/api').replace(/\/$/, '');
const API_TOKEN  = process.env.NEW_API_TOKEN || '96e38803-3bf0-45fd-b0bc-49c1c3208b8a';
const STOCKS_KEY = 'stocks';

/**
 * Calls the Apollo closing-price endpoint.
 */
async function fetchClosingRates() {
  const url = `${BASE_URL}/closing-price`;
  // console.log(`[ClosingRateService] GET ${url}`);

  const res = await axios.get(url, {
    headers: {
      Authorization: `Bearer ${API_TOKEN}`,
      'Content-Type': 'application/json',
    },
    timeout: 15000,
  });

  const raw = res.data;
  if (Array.isArray(raw))             return raw;
  if (raw && Array.isArray(raw.data)) return raw.data;
  return [];
}

/**
 * Applies closing prices to Redis symbol-by-symbol.
 */
async function applyClosingRatesToRedis(rates) {
  if (!rates || rates.length === 0) return 0;

  let updatedCount = 0;

  for (const { symbol, closing_price } of rates) {
    try {
      const raw = await redisClient.hget(STOCKS_KEY, symbol);
      if (!raw) continue;

      let parsed;
      try {
        parsed = typeof raw === 'string' ? JSON.parse(raw) : raw;
      } catch {
        continue;
      }

      // Comparison with "last tick data" (Ltp)
      const existingLtp = Number(parsed.close || parsed.LastTradePrice || 0);
      const closingNum  = Number(closing_price);

      if (existingLtp === closingNum) {
        // "if that matches do not set that ... or else it means it is tommorows closing data"
        continue;
      }

      // "if it doesnt [match] only then set that as new closing price"
      const updated = {
        ...parsed,
        BuyPrice:       closingNum,
        SellPrice:      closingNum,
        Ltp:            closingNum,
        LastTradePrice: closingNum,
        ServerTime:     Date.now(),
        ServerTime2:    new Date().toISOString(),
      };

      const updatedStr = JSON.stringify(updated);
      const pipeline   = redisClient.pipeline();

      const tokenKey = parsed.InstrumentIdentifier;
      if (tokenKey && tokenKey !== symbol) {
        pipeline.hdel(STOCKS_KEY, tokenKey);
      }

      pipeline.hset(STOCKS_KEY, symbol, updatedStr);
      pipeline.publish(symbol, updatedStr);

      await pipeline.exec();

      // console.log(`[ClosingRateService] Updated ${symbol} to closing price: ${closingNum}`);
      updatedCount++;

    } catch (err) {
      console.error(`[ClosingRateService] Error processing ${symbol}:`, err.message);
    }
  }

  return updatedCount;
}

module.exports = {
  fetchClosingRates,
  applyClosingRatesToRedis,
};
