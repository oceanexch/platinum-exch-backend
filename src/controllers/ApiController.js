const { MarketType, Script } = require("../models/MarketTypeModel");
const axios = require("axios");
const { MARKET_ORDER } = require("../config/marketConstants");

// NSE API client with cookie support (kept for nse-option-chain)
let nseClient = null;
let nseClientInitialized = false;




exports.getmarkets = async (req, res) => {
  try {
    const data = await MarketType.find({}).lean();
    // Always sort by canonical MARKET_ORDER constant (ignores stale DB order field)
    data.sort((a, b) => {
      const oa = MARKET_ORDER[a.market_type_id] ?? MARKET_ORDER[a.id] ?? 999;
      const ob = MARKET_ORDER[b.market_type_id] ?? MARKET_ORDER[b.id] ?? 999;
      return oa - ob;
    });
    res.status(200).json({ status: "true", data: data });
  } catch (error) {
    console.log(error);
    res.status(500).json({ status: "false" });
  }
};

exports.getscripts = async (req, res) => {
  try {
    const { marketId } = req.params;
    // We return unique script names for the given market
    // This maintains the hierarchical structure (Market -> Name -> Expiry)
    const scripts = await Script.aggregate([
      { $match: { market_type_id: marketId.toString() } },
      {
        $group: {
          _id: "$script_name",
          script_id: { $first: "$script_name" }, // Using name as base ID for hierarchy
          script_name: { $first: "$script_name" },
          market_type_id: { $first: "$market_type_id" },
          symbol: { $first: "$symbol" }
        }
      },
      { $sort: { script_name: 1 } }
    ]);

    res.status(200).json({ status: "true", data: scripts });
  } catch (error) {
    console.log(error);
    res.status(500).json({ status: "false" });
  }
};

exports.getexpiry = async (req, res) => {
  try {
    const { scriptId } = req.params; // scriptId here is the script_name (e.g. NIFTY)

    // Find all contracts for this name and extract their expiries
    const scripts = await Script.find({ script_name: scriptId }).lean();

    // Flatten and unique expiries
    const allExpiries = [];
    const seenExpiries = new Set();

    scripts.forEach(s => {
      s.expiry.forEach(exp => {
        const key = `${exp.expiry_date}-${exp.script_expiry_type}`;
        if (!seenExpiries.has(key)) {
          seenExpiries.add(key);
          // Ensure symbol is included (preferring exp.symbol, falling back to script.symbol)
          allExpiries.push({
            ...exp,
            symbol: exp.symbol || s.symbol
          });
        }
      });
    });

    res.status(200).json({ status: "true", data: allExpiries });
  } catch (error) {
    console.log(error);
    res.status(500).json({ status: "false" });
  }
};

exports.getstrike = async (req, res) => {
  try {
    let { scriptName, expiryDate, marketId, optionType } = req.query;

    if (!scriptName) {
      return res.status(200).json({ status: "true", data: [] });
    }

    let targetName = scriptName;
    let targetDate = expiryDate;
    let targetMarketId = marketId;

    // Build query to find all strikes for this underlying and expiry
    const query = { script_name: targetName };
    if (targetMarketId) query.market_type_id = targetMarketId;
    if (optionType && optionType !== "") {
      let cepeSearch = optionType.toUpperCase().trim();
      if (cepeSearch === "CALL") cepeSearch = "CE";
      if (cepeSearch === "PUT") cepeSearch = "PE";
      query.option_type = cepeSearch;
    }

    // Normalize targetDate for query consistency
    let dbTargetDate = targetDate;
    if (targetDate && targetDate !== 'NA') {
      const moment = require("moment");
      const m = moment(targetDate, ["DDMMMYYYY", "YYYY-MM-DD", "DD-MM-YYYY"]);
      if (m.isValid()) {
        dbTargetDate = m.format("YYYY-MM-DD");
        // We also check against the literal targetDate to be safe
      }
    }

    if (dbTargetDate) {
      query["$or"] = [
        { "expiry.expiry_date_orginal": dbTargetDate },
        { "expiry.expiry_date": dbTargetDate },
        { "expiry.expiry_date_orginal": targetDate },
        { "expiry.expiry_date": targetDate }
      ];
    }

    const allStrikes = await Script.find(query).lean();

    // Get all unique strikes
    const allStrikesArray = [...new Set(allStrikes.map(s => s.strike).filter(s => s > 0))].sort((a, b) => a - b);

    // Get the underlying index symbol to fetch live LTP
    let filteredStrikes = allStrikesArray;
    
    try {
      // Find the index script (market_type_id: "10") with matching script_name and expiry
      const indexQuery = {
        script_name: targetName,
        market_type_id: "10"
      };

      if (dbTargetDate) {
        indexQuery["$or"] = [
          { "expiry.expiry_date_orginal": dbTargetDate },
          { "expiry.expiry_date": dbTargetDate },
          { "expiry.expiry_date_orginal": targetDate },
          { "expiry.expiry_date": targetDate }
        ];
      }

      const indexScript = await Script.findOne(indexQuery).lean();

      if (indexScript && indexScript.expiry && indexScript.expiry.length > 0) {
        // Find the matching expiry entry
        let matchingExpiry = null;
        
        // First, try to find exact expiry match
        for (const exp of indexScript.expiry) {
          if (dbTargetDate) {
            if (exp.expiry_date === dbTargetDate || 
                exp.expiry_date_orginal === dbTargetDate ||
                exp.expiry_date === targetDate ||
                exp.expiry_date_orginal === targetDate) {
              matchingExpiry = exp;
              break;
            }
          } else {
            matchingExpiry = indexScript.expiry[0];
            break;
          }
        }

        // Fallback: If no exact match found, use any available expiry with a symbol
        if (!matchingExpiry) {
          // console.log(`No exact expiry match found for ${targetName} ${targetDate}, falling back to any available expiry`);
          matchingExpiry = indexScript.expiry.find(exp => exp.symbol) || indexScript.expiry[0];
        }

        if (matchingExpiry && matchingExpiry.symbol) {
          const { redisClient } = require("../config/redis");
          
          // Get live data from Redis
          const liveDataRaw = await redisClient.hget("stocks", matchingExpiry.symbol);
          
          if (liveDataRaw) {
            const liveData = JSON.parse(liveDataRaw);
            
            // Get LTP with fallbacks
            let currentPrice = liveData.Ltp || liveData.LastTradePrice || liveData.SellPrice || liveData.BuyPrice;
            
            if (currentPrice && currentPrice > 0) {
              // Calculate ±5% range
              const lowerBound = currentPrice * 0.95;
              const upperBound = currentPrice * 1.05;
              
              // Filter strikes within the range
              filteredStrikes = allStrikesArray.filter(strike => 
                strike >= lowerBound && strike <= upperBound
              );
              
            }
          }
        }
      }
    } catch (filterError) {
      console.error("Error filtering strikes by LTP range:", filterError);
      // If filtering fails, return all strikes
      filteredStrikes = allStrikesArray;
    }

    res.status(200).json({ status: "true", data: filteredStrikes });
  } catch (error) {
    console.log(error);
    res.status(500).json({ status: "false", message: error.message });
  }
};

// Retry helper function for NSE API calls
async function retryNSERequest(client, url, headers, maxRetries = 3, delay = 2000) {
  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      const response = await client.get(url, {
        headers,
        timeout: 60000 // 60 seconds timeout
      });
      return response;
    } catch (error) {
      const isTimeout = error.code === 'ECONNABORTED' ||
        error.message.includes('timeout') ||
        error.message.includes('Gateway Timeout') ||
        (error.response && error.response.status === 504);

      if (isTimeout && attempt < maxRetries) {
        const waitTime = delay * attempt; // Exponential backoff
        console.warn(`NSE API timeout on attempt ${attempt}, retrying in ${waitTime}ms...`);
        await new Promise(r => setTimeout(r, waitTime));
        continue;
      }
      throw error;
    }
  }
}


