const RedisService = require('./RedisService');
const { Script } = require('../models/MarketTypeModel');

/**
 * Symbol Management Service
 * Handles dynamic symbol updates and WebSocket resubscription
 */

let wsClientInstance = null;

/**
 * Set the WebSocket client instance (called from server.js master process)
 */
const setWebSocketClient = (wsClient) => {
  wsClientInstance = wsClient;
  console.log('[SymbolMgmt] WebSocket client instance registered');
};

/**
 * Get the WebSocket client instance
 */
const getWebSocketClient = () => {
  return wsClientInstance;
};

/**
 * Get all active symbols from database for given markets
 * @param {Array<string>} marketIds - Array of market IDs to include (optional, all if not provided)
 * @returns {Promise<Array<string>>} Array of symbol strings
 */
const getActiveSymbolsForMarkets = async (marketIds = null) => {
  try {
    // Check if mongoose is connected
    const mongoose = require('mongoose');
    if (mongoose.connection.readyState !== 1) {
      console.warn('[SymbolMgmt] Database not connected, cannot fetch symbols');
      return [];
    }

    const query = {};
    
    if (marketIds && Array.isArray(marketIds) && marketIds.length > 0) {
      query.market_type_id = { $in: marketIds };
    }

    const scripts = await Script.find(query).lean();
    const symbols = new Set();

    scripts.forEach(script => {
      // Add main script symbol (for NSE-EQ and other non-expiry scripts)
      if (script.script_id) {
        symbols.add(script.script_id);
      }

      // Add all expiry symbols
      if (script.expiry && Array.isArray(script.expiry)) {
        script.expiry.forEach(exp => {
          if (exp.script_id) {
            symbols.add(exp.script_id);
          }
        });
      }
    });

    return Array.from(symbols);
  } catch (err) {
    console.error('[SymbolMgmt] Error fetching active symbols:', err.message);
    return [];
  }
};

/**
 * Get symbols for a SPECIFIC market (for removal)
 * NSE-EQ (Market 12): uses script.script_id
 * Other markets: uses script.expiry[].script_id
 * @param {string} marketId - Market ID to get symbols for
 * @returns {Promise<Array<string>>} Array of symbol strings
 */
const getSymbolsForMarket = async (marketId) => {
  try {
    const mongoose = require('mongoose');
    if (mongoose.connection.readyState !== 1) {
      console.warn('[SymbolMgmt] Database not connected, cannot fetch symbols');
      return [];
    }

    const scripts = await Script.find({ market_type_id: marketId }).lean();
    const symbols = new Set();

    const isNseEq = marketId === "12";

    scripts.forEach(script => {
      if (isNseEq) {
        // NSE-EQ: Use main script_id
        if (script.script_id) {
          symbols.add(script.script_id);
        }
      } else {
        // Other markets: Use expiry script_ids
        if (script.expiry && Array.isArray(script.expiry)) {
          script.expiry.forEach(exp => {
            if (exp.script_id) {
              symbols.add(exp.script_id);
            }
          });
        }
      }
    });

    return Array.from(symbols);
  } catch (err) {
    console.error('[SymbolMgmt] Error fetching symbols for market:', err.message);
    return [];
  }
};

/**
 * Get all symbols EXCEPT those from specified markets
 * @param {Array<string>} excludeMarketIds - Array of market IDs to exclude
 * @returns {Promise<Array<string>>} Array of symbol strings
 */
const getSymbolsExcludingMarkets = async (excludeMarketIds) => {
  try {
    // Check if mongoose is connected
    const mongoose = require('mongoose');
    if (mongoose.connection.readyState !== 1) {
      console.warn('[SymbolMgmt] Database not connected, cannot fetch symbols');
      return [];
    }

    const query = {
      market_type_id: { $nin: excludeMarketIds }
    };

    const scripts = await Script.find(query).lean();
    const symbols = new Set();

    scripts.forEach(script => {
      if (script.script_id) {
        symbols.add(script.script_id);
      }

      if (script.expiry && Array.isArray(script.expiry)) {
        script.expiry.forEach(exp => {
          if (exp.script_id) {
            symbols.add(exp.script_id);
          }
        });
      }
    });

    return Array.from(symbols);
  } catch (err) {
    console.error('[SymbolMgmt] Error fetching symbols excluding markets:', err.message);
    return [];
  }
};

/**
 * Update Redis symbols and resubscribe WebSocket (FAST - no reconnect)
 * @param {Array<string>} symbols - New symbol array
 * @returns {Promise<boolean>} Success status
 */
const updateSymbolsAndResubscribe = async (symbols) => {
  try {
    const startTime = Date.now();
    
    // Update Redis
    await RedisService.setData('symbols', JSON.stringify(symbols));
    console.log(`[SymbolMgmt] ✓ Updated ${symbols.length} symbols in Redis (${Date.now() - startTime}ms)`);

    // Fast resubscribe without reconnecting
    if (wsClientInstance && wsClientInstance.isConnected) {
      const resubscribed = await wsClientInstance.resubscribe();
      const totalTime = Date.now() - startTime;
      
      if (resubscribed) {
        console.log(`[SymbolMgmt] ✓ WebSocket resubscribed successfully (Total: ${totalTime}ms)`);
        return true;
      } else {
        console.warn(`[SymbolMgmt] ⚠️ WebSocket resubscription failed, will reconnect on next cycle`);
        return false;
      }
    } else {
      console.warn('[SymbolMgmt] ⚠️ WebSocket not available for resubscription');
      return false;
    }
  } catch (err) {
    console.error('[SymbolMgmt] Error updating symbols:', err.message);
    return false;
  }
};

/**
 * FAST: Remove symbols for a specific market and reconnect WebSocket
 * Uses Set operations for O(n) time complexity
 * @param {string} marketId - Market ID to remove symbols for
 * @returns {Promise<boolean>} Success status
 */
const removeMarketSymbolsAndReconnect = async (marketId) => {
  const startTime = Date.now();
  
  try {
    console.log(`[SymbolMgmt] ⚡ FAST symbol removal for market ${marketId}...`);
    
    // Step 1: Get current symbols from Redis (FAST - single Redis call)
    const currentSymbolsJson = await RedisService.getData('symbols');
    if (!currentSymbolsJson) {
      console.warn(`[SymbolMgmt] ⚠️ No symbols in Redis - skipping removal`);
      return false;
    }
    
    const currentSymbols = JSON.parse(currentSymbolsJson);
    console.log(`[SymbolMgmt] Current symbols: ${currentSymbols.length}`);
    
    // Step 2: Get symbols to remove from database (FAST - single DB query)
    const symbolsToRemove = await getSymbolsForMarket(marketId);
    console.log(`[SymbolMgmt] Symbols to remove: ${symbolsToRemove.length}`);
    
    if (symbolsToRemove.length === 0) {
      console.warn(`[SymbolMgmt] ⚠️ No symbols found for market ${marketId}`);
      return false;
    }
    
    // Step 3: Create Set for O(1) lookups (FAST)
    const removeSet = new Set(symbolsToRemove);
    
    // Step 4: Filter out symbols (FAST - O(n) single pass)
    const newSymbols = currentSymbols.filter(symbol => !removeSet.has(symbol));
    
    console.log(`[SymbolMgmt] New symbol count: ${newSymbols.length} (removed ${currentSymbols.length - newSymbols.length})`);
    
    if (newSymbols.length === 0) {
      console.warn(`[SymbolMgmt] ⚠️ Cannot remove all symbols - would disconnect WebSocket`);
      return false;
    }
    
    // Step 5: Update Redis (FAST - single write)
    await RedisService.setData('symbols', JSON.stringify(newSymbols));
    
    // Step 6: Reconnect WebSocket with new symbols (FAST - no delay)
    if (wsClientInstance && wsClientInstance.reconnect) {
      await wsClientInstance.reconnect();
      const totalTime = Date.now() - startTime;
      console.log(`[SymbolMgmt] ✓ WebSocket reconnected with ${newSymbols.length} symbols (${totalTime}ms)`);
      return true;
    } else {
      console.warn('[SymbolMgmt] ⚠️ WebSocket client not available');
      return false;
    }
  } catch (err) {
    const totalTime = Date.now() - startTime;
    console.error(`[SymbolMgmt] ✗ Error removing symbols (${totalTime}ms):`, err.message);
    return false;
  }
};

/**
 * ATOMIC: Add symbols for a specific market with Redis locking
 * Prevents race conditions when multiple markets update simultaneously
 * @param {string} marketId - Market ID to add symbols for
 * @param {number} retries - Number of retries on lock failure
 * @returns {Promise<boolean>} Success status
 */
const addMarketSymbolsAndReconnectAtomic = async (marketId, retries = 3) => {
  const startTime = Date.now();
  const lockKey = 'symbol-update-lock';
  const lockValue = `${marketId}_${Date.now()}_${Math.random()}`;
  const lockTTL = 10; // 10 seconds max lock
  
  try {
    console.log(`[SymbolMgmt] ⚡ ATOMIC symbol addition for market ${marketId}...`);
    
    // Step 1: Acquire lock with retries
    let lockAcquired = false;
    for (let attempt = 0; attempt < retries; attempt++) {
      lockAcquired = await RedisService.acquireLock(lockKey, lockValue, lockTTL);
      if (lockAcquired) {
        console.log(`[SymbolMgmt] ✓ Lock acquired on attempt ${attempt + 1}`);
        break;
      }
      if (attempt < retries - 1) {
        console.warn(`[SymbolMgmt] ⚠️ Lock acquisition failed, retrying in 50ms...`);
        await new Promise(resolve => setTimeout(resolve, 50));
      }
    }
    
    if (!lockAcquired) {
      console.error(`[SymbolMgmt] ✗ Could not acquire lock after ${retries} attempts`);
      return false;
    }
    
    try {
      // Step 2: Get current symbols from Redis (within lock)
      const currentSymbolsJson = await RedisService.getData('symbols');
      const currentSymbols = currentSymbolsJson ? JSON.parse(currentSymbolsJson) : [];
      console.log(`[SymbolMgmt] Current symbols: ${currentSymbols.length}`);
      
      // Step 3: Get symbols to add from database
      const symbolsToAdd = await getSymbolsForMarket(marketId);
      console.log(`[SymbolMgmt] Symbols to add: ${symbolsToAdd.length}`);
      
      if (symbolsToAdd.length === 0) {
        console.warn(`[SymbolMgmt] ⚠️ No symbols found for market ${marketId}`);
        return false;
      }
      
      // Step 4: Merge symbols (within lock)
      const currentSet = new Set(currentSymbols);
      let addedCount = 0;
      symbolsToAdd.forEach(symbol => {
        if (!currentSet.has(symbol)) {
          currentSet.add(symbol);
          addedCount++;
        }
      });
      
      console.log(`[SymbolMgmt] New symbol count: ${currentSet.size} (added ${addedCount})`);
      
      if (addedCount === 0) {
        console.log(`[SymbolMgmt] ℹ️ All symbols already present`);
        return true;
      }
      
      // Step 5: Update Redis (within lock)
      const newSymbols = Array.from(currentSet);
      await RedisService.setData('symbols', JSON.stringify(newSymbols));
      console.log(`[SymbolMgmt] ✓ Updated Redis with ${newSymbols.length} symbols`);
      
      // Step 6: Reconnect WebSocket
      if (wsClientInstance && wsClientInstance.reconnect) {
        await wsClientInstance.reconnect();
        const totalTime = Date.now() - startTime;
        console.log(`[SymbolMgmt] ✓ WebSocket reconnected with ${newSymbols.length} symbols (${totalTime}ms)`);
        return true;
      } else {
        console.warn('[SymbolMgmt] ⚠️ WebSocket client not available');
        return false;
      }
    } finally {
      // Step 7: Release lock
      const released = await RedisService.releaseLock(lockKey, lockValue);
      if (released) {
        console.log(`[SymbolMgmt] ✓ Lock released`);
      } else {
        console.warn(`[SymbolMgmt] ⚠️ Lock release failed (may have expired)`);
      }
    }
  } catch (err) {
    const totalTime = Date.now() - startTime;
    console.error(`[SymbolMgmt] ✗ Error adding symbols (${totalTime}ms):`, err.message);
    console.error(err.stack);
    return false;
  }
};

/**
 * FAST: Add symbols for a specific market and reconnect WebSocket
 * Uses Set operations for O(n) time complexity
 * @param {string} marketId - Market ID to add symbols for
 * @returns {Promise<boolean>} Success status
 */
const addMarketSymbolsAndReconnect = async (marketId) => {
  // Delegate to atomic version
  return await addMarketSymbolsAndReconnectAtomic(marketId);
};

/**
 * Refresh all symbols from database and resubscribe
 * Used after daily symbol sync or major updates
 * @returns {Promise<boolean>} Success status
 */
const refreshAllSymbolsAndResubscribe = async () => {
  try {
    console.log('[SymbolMgmt] Refreshing all symbols from database...');
    
    const allSymbols = await getActiveSymbolsForMarkets();
    console.log(`[SymbolMgmt] Found ${allSymbols.length} total active symbols`);
    
    return await updateSymbolsAndResubscribe(allSymbols);
  } catch (err) {
    console.error('[SymbolMgmt] Error refreshing all symbols:', err.message);
    return false;
  }
};

/**
 * Get current symbol count from Redis
 * @returns {Promise<number>} Number of symbols
 */
const getCurrentSymbolCount = async () => {
  try {
    const symbolsJson = await RedisService.getData('symbols');
    if (symbolsJson) {
      const symbols = JSON.parse(symbolsJson);
      return symbols.length;
    }
    return 0;
  } catch (err) {
    console.error('[SymbolMgmt] Error getting symbol count:', err.message);
    return 0;
  }
};

module.exports = {
  setWebSocketClient,
  getWebSocketClient,
  getActiveSymbolsForMarkets,
  getSymbolsForMarket,
  getSymbolsExcludingMarkets,
  updateSymbolsAndResubscribe,
  removeMarketSymbolsAndReconnect,
  addMarketSymbolsAndReconnect,
  addMarketSymbolsAndReconnectAtomic,
  refreshAllSymbolsAndResubscribe,
  getCurrentSymbolCount
};
