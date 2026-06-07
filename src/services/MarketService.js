const { MarketType } = require("../models/MarketTypeModel");
const ExpiryModel = require("../models/ExpiryModel");
const moment = require("moment");
const { MARKET_ORDER } = require("../config/marketConstants");

// Helper: sort markets by the canonical MARKET_ORDER constant
const sortByMarketOrder = (markets) => {
  return [...markets].sort((a, b) => {
    const orderA = MARKET_ORDER[a.market_type_id] ?? MARKET_ORDER[a.id] ?? 999;
    const orderB = MARKET_ORDER[b.market_type_id] ?? MARKET_ORDER[b.id] ?? 999;
    return orderA - orderB;
  });
};

exports.getMarkets = async (marketsIds) => {
  const RedisService = require("./RedisService");
  try {
    // Ensure unique market IDs to prevent duplicates
    const uniqueMarketIds = [...new Set(marketsIds)];
    
    const markets = await MarketType.find({
      market_type_id: { $in: uniqueMarketIds },
    })
      .sort({ order: 1 })
      .lean();

    const finalMarkets = [];
    const processedMarketIds = new Set(); // Track processed markets to prevent duplicates
    
    for (const mkt of markets) {
      const marketId = mkt.market_type_id;
      
      // Skip if we've already processed this market
      if (processedMarketIds.has(marketId)) {
        continue;
      }
      processedMarketIds.add(marketId);
      
      const cachedData = await RedisService.getData(`market_${marketId}`);

      if (cachedData) {
        const allScripts = JSON.parse(cachedData);
        finalMarkets.push({ ...mkt, scripts: allScripts });
      } else {
        // Fallback: Populate from DB (Old Logic)
        const marketWithScripts = await MarketType.findOne({ _id: mkt._id })
          .populate({
            path: "scripts",
            select: "script_name script_id symbol exchange lot_size tick_size instrument_type strike option_type lastWeekClosing"
          })
          .lean();

        const expiryDocs = await ExpiryModel.find({
          $or: [
            { marketId: marketId },
            { scriptId: { $in: (marketWithScripts.scripts || []).map(s => s.script_id) } }
          ]
        }).lean();

        const expiryLookup = {};
        for (const exp of expiryDocs) {
          if (!expiryLookup[exp.scriptId]) expiryLookup[exp.scriptId] = [];
          expiryLookup[exp.scriptId].push(exp);
        }

        const marketExpiries = [
          ...(expiryLookup["999"] ? expiryLookup["999"].filter(e => e.marketId == mkt.id) : []),
          ...(expiryLookup["ALL"] ? expiryLookup["ALL"].filter(e => e.marketId == mkt.id) : [])
        ];

        const scripts = (marketWithScripts.scripts || []).map((script) => {
          const relevantExpiries = [
            ...(expiryLookup[script.script_id] || []),
            ...marketExpiries
          ];

          const newExpiry = relevantExpiries.map((exp) => {
            const m = moment(exp.expiryDate, "YYYY-MM-DD");
            return {
              expiry_date: m.isValid() ? m.format("DD-MM-YYYY") : exp.expiryDate,
              expiry_date_orginal: m.isValid() ? m.format("DDMMMYYYY").toUpperCase() : exp.expiryDate,
              script_expiry_id: exp.scriptExpiryId,
              script_expiry_type: "",
              script_id: script.script_id,
              script_lot_qty: null,
            };
          });

          return { ...script, lastWeekClosing: script.lastWeekClosing ?? 0, expiry: newExpiry };
        });

        finalMarkets.push({ ...mkt, scripts });
      }
    }

    return sortByMarketOrder(finalMarkets);
  } catch (error) {
    console.error("Error fetching data:", error);
    throw error;
  }
};

exports.getAllMarkets = async () => {
  try {
    const markets = await MarketType.find()
      .select({ id: 1, name: 1, market_type_id: 1 })
      .lean();
    return sortByMarketOrder(markets);
  } catch (error) {
    console.error("Error fetching data:", error);
    throw error;
  }
};
