const UserScriptModel = require("../models/UserScriptModel");
const SquareOffModel = require("../models/SquareoffModel");
const { MarketType, Script } = require("../models/MarketTypeModel");
const { ObjectId } = require('mongodb');
const mongoose = require('mongoose');

const getKeyIdentifier = (marketId, scriptId, expiry, strike = 0, cepe = '') => {
  return `${marketId}-${scriptId}-${expiry}-${strike}-${cepe}`;
};

exports.getScriptDataKey = async (script_id, expiry_date_orginal) => {
  const doc = await Script.findOne({ script_id: script_id });
  if (doc) {
    const expiryEntry = doc.expiry.find(e => e.expiry_date_orginal == expiry_date_orginal);
    const key = expiryEntry?.script_data_key;
    // console.log("Found data key:", key);
    return key;
  } else {
    return null;
  }
}

exports.getKeyIdentifier = getKeyIdentifier;

exports.checkScriptExists = async (userId, keyIdentifier, marketId = null) => {
  try {
    const query = {
      createdBy: userId,
      keyIdentifier: keyIdentifier,
    };
    // If marketId is provided, also check that it matches to prevent cross-market conflicts
    if (marketId) {
      query.marketId = marketId;
    }
    const script = await UserScriptModel.findOne(query);
    // console.log("Script found:", script ? { keyIdentifier, marketId: script.marketId, marketName: script.marketName } : null);
    return !!script;
  } catch (error) {
    console.error("Error checking script existence:", error);
    throw error;
  }
};

exports.createScript = async (scriptDetails, userId) => {
  try {
    const script = new UserScriptModel(scriptDetails);
    return await script.save();
  } catch (error) {
    console.error("Error creating data:", error);
    throw error;
  }
};

exports.getUserScripts = async (userId, marketIds = []) => {
  try {
    let match = { createdBy: new ObjectId(userId) };

    if (marketIds && (!Array.isArray(marketIds) || marketIds.length > 0)) {
      const filterIds = Array.isArray(marketIds) ? marketIds : [marketIds];
      match = { ...match, marketId: { $in: filterIds } };
    }
    // console.log("match ", match)
    const today = new Date();
    today.setUTCHours(0, 0, 0, 0); // start of today UTC

    return await UserScriptModel.aggregate([
      { $match: match },

      // Parse expiryDate: "05FEB2026" -> Date
      {
        $addFields: {
          expiryParsed: {
            $dateFromString: {
              dateString: "$expiryDate",
              format: "%d%b%Y",
              timezone: "UTC",
              onError: null,
              onNull: null
            }
          }
        }
      },

      // Keep only valid (expiry >= today)
      {
        $match: {
          $or: [
            { expiryParsed: { $gte: today } },  // not expired
            { expiryParsed: null }              // (optional) keep if no expiry
          ]
        }
      },

      // Select fields
      {
        $project: {
          _id: 1,
          scriptId: 1,
          scriptName: 1,
          marketId: 1,
          marketName: 1,
          label: 1,
          createdBy: 1,
          expiryDate: 1,
          symbol: 1
        }
      }
    ]);
  } catch (error) {
    console.error("Error fetching scripts:", error);
    throw error;
  }
};

exports.getUserScriptsByMarket = async (userId, marketId) => {
  try {
    return await UserScriptModel.find({ marketId, createdBy: new ObjectId(userId) })
      .select({
        _id: 1,
        scriptId: 1,
        scriptName: 1,
        // dataKey: 1,
        marketId: 1,
        marketName: 1,
        label: 1,
        keyIdentifier: 1,
        symbol: 1,
      })
      .lean();
  } catch (error) {
    console.error("Error creating data:", error);
    throw error;
  }
};

exports.removeScript = async (userId, scriptId) => {
  try {
    return await UserScriptModel.deleteOne(
      { _id: new ObjectId(scriptId), createdBy: userId }
    );
  } catch (error) {
    console.error("Error removing data:", error);
    throw error;
  }
};

exports.bulkRemoveScript = async (userId, scriptIds) => {
  try {
    const ids = scriptIds.map(id => new ObjectId(id));
    const uId = typeof userId === 'string' ? new ObjectId(userId) : userId;
    return await UserScriptModel.deleteMany(
      { _id: { $in: ids }, createdBy: uId }
    );
  } catch (error) {
    console.error("Error bulk removing data:", error);
    throw error;
  }
};

exports.removeAllScript = async (userId, marketId) => {
  try {
    return await UserScriptModel.deleteMany(
      { marketId, createdBy: new ObjectId(userId) }
    );
  } catch (error) {
    console.error("Error removing data:", error);
    throw error;
  }
};

exports.createAllScript = async (scripts) => {
  try {
    return await UserScriptModel.insertMany(scripts);
  } catch (error) {
    console.error("Error adding data:", error);
    throw error;
  }
};


exports.getSquareOffList = async (match, project) => {
  try {
    return await SquareOffModel.find(match)
      .populate({ path: "userId", select: "accountName accountCode" })
      .select(project)
      .lean();
  } catch (error) {
    console.error("Error updating data:", error);
    throw error;
  }
};

exports.getDataKeyByLabel = async (labels) => {
  try {
    return await UserScriptModel.find({ label: { $in: labels } }).select('label symbol');
  } catch (error) {
    console.error("Error updating data:", error);
    throw error;
  }
};

const moment = require("moment");

exports.getScriptsExpiryAndDataKey = async (filter) => {
  try {
    return await Script.aggregate([
      { $match: filter },
      { $unwind: "$expiry" },
      {
        $project: {
          _id: 0,
          marketId: "$market_type_id",
          scriptId: { $ifNull: ["$expiry.script_id", "$script_id"] },
          scriptName: "$script_name",
          symbol: { $ifNull: ["$expiry.symbol", "$symbol"] },
          expiryData: "$expiry.expiry_date_orginal",
          label: {
            $cond: {
              if: { $in: ["$instrument_type", ["CE", "PE", "OPTSTK", "OPTIDX"]] },
              then: {
                $concat: [
                  "$script_name", " ",
                  "$expiry.expiry_date_orginal", " ",
                  { $toString: { $ifNull: ["$strike", ""] } }, " ",
                  { $ifNull: ["$instrument_type", ""] }
                ]
              },
              else: {
                $concat: ["$script_name", " ", "$expiry.expiry_date_orginal"]
              }
            }
          },
          InstrumentIdentifier: {
            $concat: [
              "$script_name", "-",
              "$expiry.expiry_date_orginal",
              {
                $cond: {
                  if: { $in: ["$instrument_type", ["CE", "PE", "OPTSTK", "OPTIDX"]] },
                  then: {
                    $concat: ["-", { $toString: { $ifNull: ["$strike", ""] } }, "-", "$instrument_type"]
                  },
                  else: ""
                }
              },
              {
                $cond: {
                  if: { $ne: ["$expiry.script_data_key", ""] },
                  then: { $concat: ["-", "$expiry.script_data_key"] },
                  else: ""
                }
              }
            ]
          }
        }
      }
    ]);
  } catch (error) {
    console.error("Error updating data:", error);
    throw error;
  }
};

exports.refreshMarketCache = async (marketId) => {
  try {
    const scripts = await Script.find({ market_type_id: marketId.toString() }).lean();
    const marketScriptsMap = new Map();

    scripts.forEach(script => {
      const name = script.script_name;
      const groupKey = name;
      const strike = script.strike || 0;
      const type = script.instrument_type || "";

      if (!marketScriptsMap.has(groupKey)) {
        marketScriptsMap.set(groupKey, {
          script_name: name,
          script_id: script.script_id || name,
          symbol: script.symbol,
          exchange: script.exchange || "OTHERS",
          lot_size: script.lot_size || 1,
          tick_size: script.tick_size || 0.05,
          instrument_type: type,
          strike: strike,
          option_type: script.option_type || "FUT",
          market_type_id: marketId,
          dacimal: script.dacimal,
          lastWeekClosing: script.lastWeekClosing ?? 0,
          expiry: []
        });
      }
      const scriptObj = marketScriptsMap.get(groupKey);
      const expirySet = new Set(scriptObj.expiry.map(e => e.expiry_date_orginal));

      script.expiry.forEach(exp => {
        let formattedExpiry = 'NA';
        let originalExpiry = 'NA';
        const rawExpiry = exp.expiry_date_orginal;
        if (rawExpiry && rawExpiry !== 'NA') {
          const m = moment(rawExpiry);
          if (m.isValid()) {
            formattedExpiry = m.format("DD-MM-YYYY");
            originalExpiry = m.format("DDMMMYYYY").toUpperCase();
          } else {
            formattedExpiry = rawExpiry;
            originalExpiry = rawExpiry;
          }
        }

        if (!expirySet.has(originalExpiry)) {
          expirySet.add(originalExpiry);
          scriptObj.expiry.push({
            expiry_date: formattedExpiry,
            expiry_date_orginal: originalExpiry,
            actual_expiry: exp.actual_expiry || exp.expiry_date || 'NA',
            script_expiry_id: exp.symbol || script.symbol,
            script_id: name,
            script_lot_qty: exp.script_lot_qty || null,
            symbol: exp.symbol || script.symbol
          });
        }
      });
    });

    const redisData = Array.from(marketScriptsMap.values());
    const RedisService = require('./RedisService');
    if (redisData.length > 0) {
      await RedisService.setData(`market_${marketId}`, JSON.stringify(redisData));
    }
    return true;
  } catch (error) {
    console.error("Error refreshing market cache:", error);
    return false;
  }
};

exports.updateScriptData = async (id, updateData) => {
  try {
    // Cannot edit scriptId
    delete updateData.scriptId;
    delete updateData.script_id;

    const script = await Script.findByIdAndUpdate(id, updateData, { new: true });
    if (script) {
      await exports.refreshMarketCache(script.market_type_id);
    }
    return script;
  } catch (error) {
    console.error("Error updating script data:", error);
    throw error;
  }
};
