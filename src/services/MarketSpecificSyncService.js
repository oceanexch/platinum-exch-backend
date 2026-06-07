const mongoose = require('mongoose');
const { MarketType, Script } = require('../models/MarketTypeModel');
const ExpiryModel = require('../models/ExpiryModel');
const LotSetting = require('../models/LotSettingModel');
const moment = require('moment');
const axios = require('axios');
const RedisService = require('./RedisService');
const { refreshMarketCache } = require('./ScriptService');
const SymbolManagementService = require('./SymbolManagementService');
const BhavCopy = require('../models/BhavCopyModel');
const { MARKET_IDS, MARKET_NAMES, MARKET_ORDER, ALLOWED_MCX_SCRIPTS } = require('../config/marketConstants');

const API_BASE_URL = process.env.NEW_API_URL || `https://feed.apollo.in.net/test/api`;
const AUTH_TOKEN = process.env.NEW_API_TOKEN || '96e38803-3bf0-45fd-b0bc-49c1c3208b8a';

/**
 * Get exchange key(s) for a given market ID
 * Returns array of exchange keys that map to this market
 */
const getExchangeKeysForMarket = (marketId) => {
  const reverseMap = {};
  
  // Build reverse mapping from MARKET_IDS
  Object.keys(MARKET_IDS).forEach(key => {
    const id = MARKET_IDS[key];
    if (!reverseMap[id]) reverseMap[id] = [];
    reverseMap[id].push(key);
  });
  
  return reverseMap[marketId] || [];
};

/**
 * Filter expiries for a specific market based on business rules
 */
const filterExpiriesForMarket = (apiData, marketId) => {
  const scriptExpiriesMap = {};
  const todayStr = moment().format('YYYY-MM-DD');
  
  // Group expiries by script+exchange
  apiData.forEach(item => {
    if (item.name && item.expiry) {
      const name = item.name.toUpperCase();
      const exchange = (item.exchange || 'OTHERS').toUpperCase();
      const key = `${name}_${exchange}`;
      const expDate = moment(item.expiry).format('YYYY-MM-DD');
      
      if (!scriptExpiriesMap[key]) scriptExpiriesMap[key] = new Set();
      scriptExpiriesMap[key].add(expDate);
    }
  });
  
  const allowedExpiriesMap = {};
  
  Object.keys(scriptExpiriesMap).forEach(key => {
    const dates = Array.from(scriptExpiriesMap[key]).sort((a, b) => 
      moment(a).valueOf() - moment(b).valueOf()
    );
    
    if (dates.length <= 1) {
      allowedExpiriesMap[key] = new Set(dates);
      return;
    }
    
    const isTodayExpiry = dates.includes(todayStr);
    const isMcx = key.toUpperCase().endsWith('_MCX');
    const futureDates = dates.filter(d => moment(d).isSameOrAfter(todayStr));
    const isNiftyBankNiftyNopt = (key === 'NIFTY_NOPT' || key === 'BANKNIFTY_NOPT');
    
    if (isNiftyBankNiftyNopt && futureDates.length > 0) {
      const strictFuture = futureDates.filter(d => moment(d).isAfter(todayStr));
      
      const findMonthly = (pool) => pool.find(d => {
        const next = moment(d).add(7, 'days');
        return next.month() !== moment(d).month();
      });
      
      const weekly = futureDates[0];
      const nextWeekly = strictFuture[1] || strictFuture[0];
      const monthly = findMonthly(futureDates);
      const monthlyIndex = futureDates.indexOf(monthly);
      const nextMonthly = monthlyIndex >= 0 ? findMonthly(futureDates.slice(monthlyIndex + 1)) : null;
      
      const allowedSet = new Set();
      const daysToWeekly = weekly ? moment(weekly).diff(moment(todayStr), 'days') : 999;
      const daysToMonthly = monthly ? moment(monthly).diff(moment(todayStr), 'days') : 999;
      
      if (weekly) allowedSet.add(weekly);
      if (daysToWeekly <= 1 && nextWeekly) allowedSet.add(nextWeekly);
      if (monthly) allowedSet.add(monthly);
      if (daysToMonthly <= 1 && nextMonthly) allowedSet.add(nextMonthly);
      
      allowedExpiriesMap[key] = allowedSet;
      console.log(`[MarketSync] [${key}] Weekly=${weekly || 'None'} (${daysToWeekly}d), Monthly=${monthly || 'None'} (${daysToMonthly}d), Allowed=[${[...allowedSet].join(', ')}]`);
    } else {
      const daysToExpiry = futureDates.length > 0 ? 
        moment(futureDates[0]).startOf('day').diff(moment(todayStr).startOf('day'), 'days') : -1;
      const isNoptNfutNse = key.toUpperCase().endsWith('_NOPT') || 
                            key.toUpperCase().endsWith('_NFUT') || 
                            key.toUpperCase().endsWith('_NSE');
      
      if (isTodayExpiry || (daysToExpiry > 0 && daysToExpiry <= 3)) {
        if (isMcx || isNoptNfutNse) {
          allowedExpiriesMap[key] = new Set(futureDates.slice(0, 2));
        } else {
          allowedExpiriesMap[key] = new Set(futureDates.slice(0, 2));
        }
      } else {
        if (isNoptNfutNse) {
          allowedExpiriesMap[key] = new Set(futureDates.slice(0, 2));
        } else if (futureDates.length > 0) {
          allowedExpiriesMap[key] = new Set([futureDates[0]]);
        } else {
          allowedExpiriesMap[key] = new Set();
        }
      }
    }
  });
  
  return allowedExpiriesMap;
};

/**
 * Ensure MongoDB connection is alive
 */
const ensureMongoConnection = async () => {
  const mongoose = require('mongoose');
  
  if (mongoose.connection.readyState === 1) {
    return true; // Already connected
  }
  
  // Reconnect if disconnected
  console.log('[MarketSync] MongoDB disconnected, reconnecting...');
  const MONGODB_URI = process.env.MONGODB_URI || process.env.DATABASE_URL;
  
  if (!MONGODB_URI) {
    throw new Error('MONGODB_URI not found in environment');
  }
  
  await mongoose.connect(MONGODB_URI, {
    serverSelectionTimeoutMS: 10000,
    socketTimeoutMS: 60000,
    maxPoolSize: 50,
    minPoolSize: 10,
  });
  
  console.log('[MarketSync] ✓ MongoDB reconnected');
  return true;
};

/**
 * Sync a specific market before it opens
 * This updates scripts, expiries, lot settings, and adds symbols to WebSocket
 * 
 * @param {string} marketId - Market ID to sync (e.g., "2", "3", "12")
 * @param {string} marketName - Market name for logging
 * @returns {Promise<boolean>} Success status
 */
const syncMarketBeforeOpen = async (marketId, marketName) => {
  const startTime = Date.now();
  
  try {
    console.log(`[MarketSync] ═══════════════════════════════════════════════════`);
    console.log(`[MarketSync] Starting pre-open sync for ${marketName} (ID: ${marketId})`);
    console.log(`[MarketSync] Time: ${moment().format('YYYY-MM-DD HH:mm:ss')}`);
    console.log(`[MarketSync] ═══════════════════════════════════════════════════`);
    
    // Ensure MongoDB connection is alive before starting
    await ensureMongoConnection();
    
    // Step 1: Fetch fresh data from API
    console.log(`[MarketSync] Fetching symbol data from API...`);
    const response = await axios.get(`${API_BASE_URL}/symbol-info`, {
      headers: { Authorization: `Bearer ${AUTH_TOKEN}` },
      timeout: 60000
    });
    
    const apiData = response.data?.data || response.data || [];
    if (!Array.isArray(apiData)) {
      console.error('[MarketSync] Invalid data format from API');
      return false;
    }
    
    console.log(`[MarketSync] Fetched ${apiData.length} total symbols from API`);
    
    // Apply COMEX transformation
    apiData.forEach(item => {
      if (item.exchange && item.exchange.toUpperCase() === 'COMEX') {
        if (item.name && item.name.toUpperCase().endsWith('CMX')) {
          item.name = item.name.substring(0, item.name.length - 3) + '-USD';
        }
      }
    });
    
    // Step 2: Get exchange keys for this market
    const exchangeKeys = getExchangeKeysForMarket(marketId);
    console.log(`[MarketSync] Exchange keys for market ${marketId}: ${exchangeKeys.join(', ')}`);
    
    // Step 3: Filter API data for this market only
    // We need to process items and determine which market(s) they belong to
    const marketApiData = [];
    
    for (const item of apiData) {
      const itemName = (item.name || '').toUpperCase();
      const strike = Number(item.strike) || 0;
      let exchangeKey = (item.exchange || 'OTHERS').toUpperCase();
      
      // MCX Filter: Only allow specific MCX scripts
      if (exchangeKey === 'MCX' && !ALLOWED_MCX_SCRIPTS.includes(itemName)) {
        continue;
      }
      
      let targetExchangeKeys = [exchangeKey];
      
      // Custom mapping rules for INDEX market (EXACT COPY from dailySymbolSync)
      if (itemName === 'SENSEX') {
        targetExchangeKeys = ['NFUT']; // Force SENSEX to INDEX market
      } else if ((itemName === 'BANKNIFTY' || itemName === 'NIFTY') && 
                 (exchangeKey === 'NFUT' || exchangeKey === 'NSE') && 
                 strike === 0 && item.expiry) {
        // NIFTY/BANKNIFTY Futures (Strike 0 + Expiry) go to both INDEX (NFUT) and NOPT (NOPT)
        targetExchangeKeys = ['NFUT', 'NOPT'];
      } else if (exchangeKey === 'NFUT' || exchangeKey === 'NSE') {
        // Categorize based on presence of expiry
        if (!item.expiry) {
          targetExchangeKeys = ['NSE_EQ']; // Scripts without expiry go to NSE-EQ (ID 12)
        } else {
          targetExchangeKeys = ['NSE'];    // Scripts with expiry go to NSE (ID 2)
        }
      } else if (itemName.includes('DOWJONES') || itemName.includes('GIFTNIFTY') || 
                 itemName.includes('S&P') || itemName.includes('SPX') || 
                 itemName.includes('S AND P') || itemName.includes('NASDAQ') || 
                 itemName.includes('GLOBAL')) {
        // Specific global indices go to GLOBAL market
        targetExchangeKeys = ['GLOBAL'];
      } else if (exchangeKey === 'GLOBAL' || exchangeKey === 'FOREX' || 
                 exchangeKey === 'FX' || exchangeKey === 'LMAX') {
        // Other global items go to FOREX
        targetExchangeKeys = ['FOREX'];
      } else if (exchangeKey === 'NOPT') {
        // Logic handled inside loop below
        targetExchangeKeys = ['NOPT'];
      }
      
      // Check if any of the target exchange keys match our market
      for (const currentKey of targetExchangeKeys) {
        if (currentKey === 'NOPT') {
          // Only keep NIFTY and BANKNIFTY for NOPT, discard others
          if (itemName !== 'BANKNIFTY' && itemName !== 'NIFTY') {
            continue;
          }
        }
        
        // Check if this exchange key maps to our target market
        if (exchangeKeys.includes(currentKey)) {
          marketApiData.push(item);
          break; // Only add once even if multiple keys match
        }
      }
    }
    
    console.log(`[MarketSync] Filtered to ${marketApiData.length} symbols for this market`);
    
    if (marketApiData.length === 0) {
      console.warn(`[MarketSync] No symbols found for market ${marketId}`);
      return false;
    }
    
    // Step 4: Apply expiry filtering
    const allowedExpiriesMap = filterExpiriesForMarket(marketApiData, marketId);
    
    // Step 5: Get existing decimal settings
    const existingScripts = await Script.find(
      { market_type_id: marketId }, 
      { script_name: 1, dacimal: 1 }
    ).lean();
    const decimalMap = {};
    existingScripts.forEach(s => {
      if (s.script_name) decimalMap[s.script_name.toUpperCase()] = s.dacimal;
    });
    
    // Step 6: Get BhavCopy closing prices
    const bhavCopyAgg = await BhavCopy.aggregate([
      { $match: { scriptId: { $exists: true, $ne: null } } },
      { $sort: { createdAt: -1 } },
      {
        $group: {
          _id: { $toUpper: '$scriptId' },
          records: {
            $push: {
              closingPrice: '$closingPrice',
              createdAt: '$createdAt'
            }
          }
        }
      }
    ]);
    
    const bhavCopyMap = {};
    bhavCopyAgg.forEach(entry => {
      if (!entry._id || !entry.records.length) return;
      
      let sundayRecord = null;
      let saturdayRecord = null;
      let latestRecord = entry.records[0];
      
      for (const rec of entry.records) {
        if (!rec.createdAt) continue;
        const dow = new Date(rec.createdAt).getDay();
        if (dow === 0 && !sundayRecord) sundayRecord = rec;
        if (dow === 6 && !saturdayRecord) saturdayRecord = rec;
        if (sundayRecord && saturdayRecord) break;
      }
      
      const chosen = sundayRecord || saturdayRecord || latestRecord;
      if (chosen && chosen.closingPrice !== undefined && chosen.closingPrice !== null) {
        bhavCopyMap[entry._id] = parseFloat(chosen.closingPrice.toFixed(2));
      }
    });
    
    // Step 7: Delete existing data for this market
    console.log(`[MarketSync] Removing existing data for market ${marketId}...`);
    await Script.deleteMany({ market_type_id: marketId });
    await ExpiryModel.deleteMany({ marketId: marketId });
    // await LotSetting.deleteMany({ marketId: marketId }); // LotSettings managed via refreshLotSettings
    console.log(`[MarketSync] ✓ Deleted existing data`);
    
    // Step 8: Build new scripts, expiries, and lot settings
    const scriptsMap = {};
    const scripts = [];
    const expiryDocs = [];
    // const lotSettingDocs = []; // LotSettings managed via refreshLotSettings
    const marketExpiryDedup = new Set();
    
    for (const item of marketApiData) {
      // Apply expiry filter
      if (item.expiry) {
        const fName = (item.name || '').toUpperCase();
        const fExchange = (item.exchange || 'OTHERS').toUpperCase();
        const fDate = moment(item.expiry).format('YYYY-MM-DD');
        const key = `${fName}_${fExchange}`;
        
        if (allowedExpiriesMap[key] && !allowedExpiriesMap[key].has(fDate)) {
          continue;
        }
      }
      
      const itemName = (item.name || '').toUpperCase();
      const strike = Number(item.strike) || 0;
      const scriptKey = `${item.name}_${strike}_${item.instrument_type}_${marketId}`;
      
      let scriptData = scriptsMap[scriptKey];
      
      if (!scriptData) {
        const primaryScriptId = item.symbol;
        const lastWeekClosing = bhavCopyMap[primaryScriptId?.toUpperCase()] ?? 0;
        
        scriptData = {
          script_name: itemName.trim(),
          script_id: primaryScriptId,
          market_type_id: marketId,
          symbol: primaryScriptId,
          last_price: item.last_price || 0,
          closing_price: item.closing_price || 0,
          lot_size: item.lot_size || 1,
          tick_size: item.tick_size || 0.05,
          instrument_type: item.instrument_type,
          option_type: item.instrument_type === 'CE' ? 'CE' : 
                       (item.instrument_type === 'PE' ? 'PE' : 'FUT'),
          strike: strike,
          exchange: item.exchange,
          dacimal: decimalMap[itemName] !== undefined ? decimalMap[itemName] : true,
          lastWeekClosing: lastWeekClosing,
          expiry: []
        };
        scriptsMap[scriptKey] = scriptData;
        scripts.push(scriptData);
      }
      
      // Add expiry
      const exists = scriptData.expiry.some(e => e.symbol === item.symbol);
      if (!exists && item.expiry) {
        scriptData.expiry.push({
          script_expiry_id: item.symbol,
          script_id: item.symbol,
          expiry_date: item.actual_expiry || item.expiry || 'NA',
          tradeEndDate: item.tradeEndDate || item.expiry || "NA",
          script_expiry_type: item.instrument_type || '',
          script_data_key: "",
          script_lot_qty: item.lot_size || null,
          expiry_date_orginal: item.actual_expiry || item.expiry || 'NA',
          symbol: item.symbol
        });
        
        // LotSettings are now managed via refreshLotSettings endpoint/script — not inserted here
        
        // Add expiry doc
        const formattedExpiry = moment(item.expiry).format('YYYY-MM-DD');
        const isNseFoMarket = (marketId === MARKET_IDS.NSE);
        
        if (isNseFoMarket) {
          const dedupKey = `${marketId}_${formattedExpiry}`;
          if (!marketExpiryDedup.has(dedupKey)) {
            marketExpiryDedup.add(dedupKey);
            expiryDocs.push({
              marketId: marketId,
              marketName: marketName,
              scriptId: 'ALL',
              scriptName: 'ALL',
              tradeStartDate: moment().format('YYYY-MM-DD'),
              tradeEndDate: formattedExpiry,
              expiryDate: formattedExpiry,
              actualExpiry: item.actual_expiry || item.expiry,
              ip: "auto"
            });
          }
        } else if (marketId === '3') {
          const dedupKey = `${marketId}_${item.name}_${formattedExpiry}`;
          if (!marketExpiryDedup.has(dedupKey)) {
            marketExpiryDedup.add(dedupKey);
            expiryDocs.push({
              marketId: marketId,
              marketName: marketName,
              scriptId: item.name,
              scriptName: item.name,
              tradeStartDate: moment().format('YYYY-MM-DD'),
              tradeEndDate: formattedExpiry,
              expiryDate: formattedExpiry,
              actualExpiry: item.actual_expiry || item.expiry,
              ip: "auto"
            });
          }
        } else {
          expiryDocs.push({
            marketId: marketId,
            marketName: marketName,
            scriptId: scriptData.script_id,
            scriptName: item.name,
            tradeStartDate: moment().format('YYYY-MM-DD'),
            tradeEndDate: formattedExpiry,
            expiryDate: formattedExpiry,
            actualExpiry: item.actual_expiry || item.expiry,
            ip: "auto"
          });
        }
      }
    }
    
    // Step 9: Save to database
    console.log(`[MarketSync] Saving ${scripts.length} scripts...`);
    const savedScripts = await Script.insertMany(scripts, { ordered: false });
    console.log(`[MarketSync] ✓ Saved ${savedScripts.length} scripts`);
    
    if (expiryDocs.length > 0) {
      console.log(`[MarketSync] Saving ${expiryDocs.length} expiry docs...`);
      await ExpiryModel.insertMany(expiryDocs, { ordered: false });
      console.log(`[MarketSync] ✓ Saved ${expiryDocs.length} expiry docs`);
    }
    
    // LotSettings are now managed via refreshLotSettings endpoint/script — not inserted here
    
    // Step 10: Update MarketType document
    const scriptObjectIds = savedScripts.map(s => s._id);
    await MarketType.findOneAndUpdate(
      { market_type_id: marketId },
      { 
        $set: { 
          scripts: scriptObjectIds,
          name: marketName,
          market_type_name: marketName
        } 
      },
      { upsert: true }
    );
    console.log(`[MarketSync] ✓ Updated MarketType document`);
    
    // Step 11: Refresh market cache in Redis
    console.log(`[MarketSync] Refreshing market cache...`);
    await refreshMarketCache(marketId);
    
    // Step 12: Symbol addition is now handled by BATCH signal from checkAndExecuteMarketOperations
    // This prevents race conditions when multiple markets sync simultaneously
    console.log(`[MarketSync] ℹ️ Symbol addition will be handled by batch signal from market operations`)
    
    const totalTime = Date.now() - startTime;
    console.log(`[MarketSync] ✓ Market sync completed in ${totalTime}ms`);
    console.log(`[MarketSync] ═══════════════════════════════════════════════════\n`);
    
    return true;
  } catch (err) {
    const totalTime = Date.now() - startTime;
    console.error(`[MarketSync] ✗ Error syncing market ${marketId} (${totalTime}ms):`, err.message);
    console.error(err.stack);
    return false;
  }
};

module.exports = {
  syncMarketBeforeOpen
};
