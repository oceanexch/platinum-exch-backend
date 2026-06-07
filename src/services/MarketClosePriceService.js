const moment = require("moment");
const { Script } = require("../models/MarketTypeModel");
const { getAllStocksHash } = require("./RedisService");
const { saveMarketClosePrices } = require("./SettingService");
const { MARKET_NAMES } = require("../config/marketConstants");

const capturePricesForMarkets = async (marketIds) => {
  try {
    const currentTime = moment().format("HH:mm");
    console.log(`[Scheduler] Starting price capture for markets: [${marketIds.join(', ')}] at ${currentTime}`);

    const scripts = await Script.find({
      market_type_id: { $in: marketIds.map(String) }
    }).lean();

    if (!scripts || scripts.length === 0) {
      console.log(`[Scheduler] No scripts found in DB for markets: [${marketIds.join(', ')}]`);
      return;
    }

    const symbolToScriptMap = new Map();
    const symbolSet = new Set();

    scripts.forEach(s => {
      const script_name = s.script_name;
      const market_type_id = s.market_type_id;

      if (s.expiry && Array.isArray(s.expiry)) {
        s.expiry.forEach(exp => {
          if (exp.symbol) {
            symbolSet.add(exp.symbol);
            symbolToScriptMap.set(exp.symbol, {
              script_name,
              market_type_id,
              strike: s.strike,
              option_type: s.option_type,
              expiry: exp.expiry_date
            });
          }
        });
      }
      if (s.symbol) {
        symbolSet.add(s.symbol);
        if (!symbolToScriptMap.has(s.symbol)) {
          symbolToScriptMap.set(s.symbol, {
            script_name,
            market_type_id,
            strike: s.strike,
            option_type: s.option_type,
            expiry: s.expiry && s.expiry[0] ? s.expiry[0].expiry_date : ""
          });
        }
      }
    });

    const symbols = Array.from(symbolSet);
    console.log(`[Scheduler] Identified ${symbols.length} unique symbols across ${scripts.length} scripts to capture.`);

    if (symbols.length === 0) {
      console.log("[Scheduler] No symbols found in DB to capture.");
      return;
    }

    console.log(`[Scheduler] Fetching all live stock data from Redis for processing...`);
    const allLiveStocks = await getAllStocksHash();
    console.log(`[Scheduler] Fetched ${allLiveStocks.size} live keys from Redis stocks hash.`);

    const pricesToSave = [];
    const seenKeys = new Set();

    symbols.forEach((currentSymbol) => {
      const scriptInfo = symbolToScriptMap.get(currentSymbol);
      const expiry = scriptInfo?.expiry;
      const hasExpiry = expiry && (Array.isArray(expiry) ? expiry.length > 0 : true);
      if (String(currentSymbol).trim().toUpperCase() === 'SENSEX' && !hasExpiry) return;

      const priceData = allLiveStocks.get(String(currentSymbol).toUpperCase());

      if (priceData) {
        let finalScriptName = scriptInfo ? scriptInfo.script_name : (priceData.name || priceData.Symbol || currentSymbol);
        const expiryValue = priceData.ExpiryDate || priceData.expiry || (scriptInfo ? scriptInfo.expiry : "");
        const marketIdValue = scriptInfo ? String(scriptInfo.market_type_id) : String(priceData.marketId || priceData.MarketId || "");

        if (scriptInfo && String(scriptInfo.market_type_id) === "3") {
          const strike = scriptInfo.strike || 0;
          const optType = scriptInfo.option_type || "";
          const expiryStr = scriptInfo.expiry ? moment(scriptInfo.expiry).format("DD-MMM-YYYY").toUpperCase() : "";
          finalScriptName = `${scriptInfo.script_name} ${strike} ${optType} ${expiryStr}`.trim();
        }

        const uniqueKey = `${currentSymbol}|${marketIdValue}|${expiryValue}`;

        if (seenKeys.has(uniqueKey)) {
          console.log(`[Scheduler] Skipping duplicate entry for symbol: ${currentSymbol}`);
          return;
        }
        seenKeys.add(uniqueKey);

        const ltp = Number(priceData.Ltp ?? priceData.ltp ?? priceData.LastTradePrice ?? priceData.last_price ?? 0);
        let buyRate = Number(priceData.BuyPrice ?? priceData.bid ?? 0);
        let sellRate = Number(priceData.SellPrice ?? priceData.ask ?? 0);
        const high = Number(priceData.High ?? priceData.high ?? 0);
        const low = Number(priceData.Low ?? priceData.low ?? 0);
        const open = Number(priceData.Open ?? priceData.open ?? 0);

        if (buyRate === 0 && ltp > 0) buyRate = ltp;
        if (sellRate === 0 && ltp > 0) sellRate = ltp;

        pricesToSave.push({
          scriptName: finalScriptName,
          expiry: expiryValue,
          symbol: currentSymbol,
          marketId: marketIdValue,
          marketName: MARKET_NAMES[marketIdValue] || "",
          buyRate,
          sellRate,
          ltp,
          high,
          low,
          open
        });
      }
    });

    if (pricesToSave.length > 0) {
      console.log(`[Scheduler] Capturing ${pricesToSave.length} prices for markets [${marketIds.join(', ')}] at close ${currentTime}`);
      await saveMarketClosePrices(pricesToSave);
      console.log("[Scheduler] Successfully saved closing prices.");
    } else {
      console.log("[Scheduler] No valid price data found in Redis for the identified symbols.");
      if (symbols.length > 0) {
        console.log("[Scheduler] Symbols checked:", symbols.length);
      }
    }
  } catch (error) {
    console.error("Error in capturePricesForMarkets:", error);
  }
};

module.exports = { capturePricesForMarkets };
