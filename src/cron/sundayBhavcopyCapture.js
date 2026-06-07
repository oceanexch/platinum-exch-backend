const cron = require('node-cron');
const moment = require('moment');
const mongoose = require('mongoose');
const { Script } = require('../models/MarketTypeModel');
const BhavCopy = require('../models/BhavCopyModel');
const { fetchClosingRates } = require('../services/ClosingRateService');
const { MARKET_NAMES } = require('../config/marketConstants');

const captureSundayBhavcopy = async () => {
  try {
    console.log('[SundayBhavcopy] Starting capture at', new Date().toISOString());

    // 1. Fetch all scripts from DB to build symbol -> metadata map
    const scripts = await Script.find({}).lean();
    if (!scripts || scripts.length === 0) {
      console.log('[SundayBhavcopy] No scripts found in DB');
      return;
    }
    console.log(`[SundayBhavcopy] Found ${scripts.length} scripts`);

    // 2. Build symbol -> script metadata map
    // - FO/NOPT/MCX/INDEX: map each exp.script_id + exp.symbol (fallback for format mismatches)
    // - NSE-EQ (market_type_id 12): no expiry entries, map s.script_id directly
    const symbolMap = new Map();
    scripts.forEach(s => {
      if (s.expiry && Array.isArray(s.expiry) && s.expiry.length > 0) {
        s.expiry.forEach(exp => {
          const meta = {
            script_name: s.script_name,
            market_type_id: s.market_type_id,
            strike: s.strike,
            option_type: s.option_type,
            expiry: exp.expiry_date
          };
          if (exp.script_id) symbolMap.set(exp.script_id.toUpperCase(), meta);
          // Also index by exp.symbol — some markets (NOPT) may differ in API vs DB format
          if (exp.symbol && exp.symbol.toUpperCase() !== (exp.script_id || '').toUpperCase()) {
            symbolMap.set(exp.symbol.toUpperCase(), meta);
          }
        });
      } else if (s.market_type_id === '12') {
        // NSE-EQ has no expiry entries — map script_id directly
        if (s.script_id) {
          symbolMap.set(s.script_id.toUpperCase(), {
            script_name: s.script_name,
            market_type_id: s.market_type_id,
            strike: s.strike,
            option_type: s.option_type,
            expiry: ''
          });
        }
      }
    });

    const allSymbols = Array.from(symbolMap.keys());
    console.log(`[SundayBhavcopy] Extracted ${allSymbols.length} unique symbols`);

    if (allSymbols.length === 0) {
      console.log('[SundayBhavcopy] No symbols to process');
      return;
    }

    // 3. Fetch official closing prices from /closing-price API
    console.log('[SundayBhavcopy] Fetching official closing prices from API...');
    const closingRates = await fetchClosingRates();
    console.log(`[SundayBhavcopy] Fetched ${closingRates.length} closing price records from API`);

    if (!closingRates || closingRates.length === 0) {
      console.log('[SundayBhavcopy] No closing rates from API');
      return;
    }

    // 4. Build bhavcopy documents for insertion
    const bhavcopyDocs = [];
    const currentDate = moment().format('YYYY-MM-DD');

    closingRates.forEach(({ symbol, closing_price }) => {
      if (!symbol || closing_price === undefined || closing_price === null) return;

      const closingNum = Number(closing_price);
      if (closingNum <= 0) return; // Skip invalid prices

      const scriptInfo = symbolMap.get(symbol.toUpperCase());
      if (!scriptInfo) return; // Skip symbols not in our DB

      const marketId = scriptInfo.market_type_id || '';
      const marketName = MARKET_NAMES[marketId] || '';

      bhavcopyDocs.push({
        InstrumentIdentifier: symbol,
        label: scriptInfo.script_name || symbol,
        marketId: String(marketId),
        marketName: marketName,
        scriptId: symbol,
        symbol: symbol,
        scriptName: scriptInfo.script_name || symbol,
        expiry: scriptInfo.expiry || '',
        date: currentDate,
        closingPrice: closingNum
      });
    });

    if (bhavcopyDocs.length === 0) {
      console.log('[SundayBhavcopy] No valid closing price data to capture');
      return;
    }

    console.log(`[SundayBhavcopy] Prepared ${bhavcopyDocs.length} bhavcopy documents for insertion`);

    // 5. Upsert — update existing records so re-runs always reflect the latest closing prices
    const bulkOps = bhavcopyDocs.map(doc => ({
      updateOne: {
        filter: { InstrumentIdentifier: doc.InstrumentIdentifier },
        update: { $set: doc },
        upsert: true
      }
    }));
    const result = await BhavCopy.bulkWrite(bulkOps, { ordered: false });
    console.log(`[SundayBhavcopy] Upserted ${result.upsertedCount} new, updated ${result.modifiedCount} existing records`);

    console.log('[SundayBhavcopy] Capture completed successfully');

  } catch (error) {
    console.error('[SundayBhavcopy] Error during capture:', error.message);
  }
};

// Schedule: Every Sunday at 6 PM (18:00)
cron.schedule('0 18 * * 0', () => {
  captureSundayBhavcopy();
});

// Allow manual execution
if (require.main === module) {
  (async () => {
    try {
      const connectDB = require('../config/database');
      await connectDB();
      console.log('Connected to DB, starting bhavcopy capture...');
      await captureSundayBhavcopy();
      console.log('Bhavcopy capture completed');
      process.exit(0);
    } catch (error) {
      console.error('Error:', error.message);
      process.exit(1);
    }
  })();
}

module.exports = { captureSundayBhavcopy };
