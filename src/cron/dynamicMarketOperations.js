const moment = require("moment");
const TimeSettingModel = require("../models/TimeSettingModel");
const MarketOperationsService = require("../services/MarketOperationsService");
const { chargeNseEqDailyInterest } = require("./nseEqInterestCron");
const { applyNseEqDeliveryCommission } = require("./nseEqDeliveryCommissionCron");

// ─── CACHE FOR MARKET TIMINGS ─────────────────────────────────────────────────
let _cachedMarketTimings = [];
let _timeCacheTs = 0;
const TIME_CACHE_MS = 5 * 60 * 1000; // 5 minutes cache

// Track which markets have already executed today (reset at midnight)
const _executedToday = {
  marketClose: new Set(),
  marketOpen: new Set(),
  lastResetDate: moment().format("YYYY-MM-DD")
};

/**
 * Fetch all market timings from TimeSettingModel with caching
 */
const getMarketTimings = async () => {
  const now = Date.now();
  
  // Return cached data if still valid
  if (now - _timeCacheTs < TIME_CACHE_MS && _cachedMarketTimings.length > 0) {
    return _cachedMarketTimings;
  }

  try {
    // Fetch all market timings where scriptName is 'All' (market-level settings)
    const timings = await TimeSettingModel.find({ scriptName: "All" })
      .select({
        marketId: 1,
        marketName: 1,
        marketStartTime: 1,
        marketEndTime: 1,
        tradeStartTime: 1,
        tradeEndTime: 1
      })
      .lean();

    _cachedMarketTimings = timings;
    _timeCacheTs = now;
    
    return timings;
  } catch (err) {
    console.error("[DynamicMarketOps] Error fetching market timings:", err.message);
    return _cachedMarketTimings; // Return stale cache on error
  }
};

/**
 * Extract HH:mm from time string (handles "HH:mm:ss" or "HH:mm")
 */
const toHHMM = (timeStr) => {
  if (!timeStr) return null;
  return timeStr.substring(0, 5);
};

/**
 * Derive trading day date from market end time.
 * Markets closing before 06:00 (early AM) belong to the previous calendar day.
 */
const getTradingDate = (endTime) => {
  const hour = parseInt(endTime?.substring(0, 2) || '23');
  return hour < 6
    ? moment().subtract(1, 'day').format('YYYY-MM-DD')
    : moment().format('YYYY-MM-DD');
};

/**
 * Reset execution tracking at midnight
 */
const resetExecutionTracking = () => {
  const currentDate = moment().format("YYYY-MM-DD");
  if (_executedToday.lastResetDate !== currentDate) {
    _executedToday.marketClose.clear();
    _executedToday.marketOpen.clear();
    _executedToday.lastResetDate = currentDate;
    console.log("[DynamicMarketOps] Execution tracking reset for new day:", currentDate);
  }
};

/**
 * Execute market closing operations for a specific market
 */
const executeMarketClose = async (marketId, marketName, endTime) => {
  const executionKey = `${marketId}_${moment().format("YYYY-MM-DD_HH:mm")}`;
  
  // Prevent duplicate execution
  if (_executedToday.marketClose.has(executionKey)) {
    return;
  }

  console.log(`[DynamicMarketOps] ═══════════════════════════════════════════════════`);
  console.log(`[DynamicMarketOps] Market Close Triggered: ${marketName} (ID: ${marketId})`);
  console.log(`[DynamicMarketOps] Time: ${moment().format("YYYY-MM-DD HH:mm:ss")}`);
  console.log(`[DynamicMarketOps] ═══════════════════════════════════════════════════`);

  _executedToday.marketClose.add(executionKey);

  const tradingDate = getTradingDate(endTime);
  const isFriday = moment().day() === 5;
  const isNseEq = marketId === "12";

  // Collect all operations to run in parallel
  const operations = [];

  // Standard market operations
  operations.push(
    (async () => {
      try {
        console.log(`[DynamicMarketOps] [${marketName}] Starting expiry position rollover...`);
        await MarketOperationsService.expiryPositionRollover(marketId, tradingDate);
        console.log(`[DynamicMarketOps] [${marketName}] ✓ Expiry rollover completed`);
      } catch (err) {
        console.error(`[DynamicMarketOps] [${marketName}] ✗ Expiry rollover failed:`, err.message);
        console.error(err.stack);
      }
    })()
  );

  // Uncomment when ready to enable these operations:
  operations.push(
    (async () => {
      try {
        await MarketOperationsService.cancelPendingLimitOrders(marketId);
        console.log(`[DynamicMarketOps] [${marketName}] ✓ Pending orders cancelled`);
      } catch (err) {
        console.error(`[DynamicMarketOps] [${marketName}] ✗ Cancel orders failed:`, err.message);
      }
    })()
  );

  operations.push(
    (async () => {
      try {
        await MarketOperationsService.intradaySquareOff(marketId);
        console.log(`[DynamicMarketOps] [${marketName}] ✓ Intraday square-off completed`);
      } catch (err) {
        console.error(`[DynamicMarketOps] [${marketName}] ✗ Intraday square-off failed:`, err.message);
      }
    })()
  );

  if (isFriday) {
    operations.push(
      (async () => {
        try {
          await MarketOperationsService.weeklySquareOff(marketId);
          console.log(`[DynamicMarketOps] [${marketName}] ✓ Weekly square-off completed`);
        } catch (err) {
          console.error(`[DynamicMarketOps] [${marketName}] ✗ Weekly square-off failed:`, err.message);
        }
      })()
    );
  }

  // NSE-EQ specific operations (Market ID: 12)
  if (isNseEq) {
    console.log(`[DynamicMarketOps] [${marketName}] NSE-EQ market detected - adding specific operations...`);
    
    // Daily interest charge
    operations.push(
      (async () => {
        try {
          console.log(`[DynamicMarketOps] [${marketName}] Charging daily interest...`);
          await chargeNseEqDailyInterest();
          console.log(`[DynamicMarketOps] [${marketName}] ✓ Daily interest charged`);
        } catch (err) {
          console.error(`[DynamicMarketOps] [${marketName}] ✗ Interest charge failed:`, err.message);
          console.error(err.stack);
        }
      })()
    );

    // Delivery commission
    operations.push(
      (async () => {
        try {
          console.log(`[DynamicMarketOps] [${marketName}] Applying delivery commission...`);
          await applyNseEqDeliveryCommission();
          console.log(`[DynamicMarketOps] [${marketName}] ✓ Delivery commission applied`);
        } catch (err) {
          console.error(`[DynamicMarketOps] [${marketName}] ✗ Delivery commission failed:`, err.message);
          console.error(err.stack);
        }
      })()
    );
  }

  // Execute all operations in parallel
  await Promise.all(operations);

  console.log(`[DynamicMarketOps] [${marketName}] ✓ All operations completed`);
  
  // ═══════════════════════════════════════════════════════════════════════════
  // FAST WebSocket Symbol Removal & Reconnection
  // ═══════════════════════════════════════════════════════════════════════════
  // Symbol removal is now handled by BATCH signal from checkAndExecuteMarketOperations
  // This prevents race conditions when multiple markets close simultaneously
  console.log(`[DynamicMarketOps] [${marketName}] ℹ️ Symbol removal will be handled by batch signal from market operations`);
  
  console.log(`[DynamicMarketOps] ═══════════════════════════════════════════════════\n`);
};

/**
 * Execute market opening operations for a specific market
 */
const executeMarketOpen = async (marketId, marketName) => {
  const executionKey = `${marketId}_${moment().format("YYYY-MM-DD_HH:mm")}`;
  
  // Prevent duplicate execution
  if (_executedToday.marketOpen.has(executionKey)) {
    return;
  }

  console.log(`[DynamicMarketOps] ───────────────────────────────────────────────────`);
  console.log(`[DynamicMarketOps] Market Open: ${marketName} (ID: ${marketId})`);
  console.log(`[DynamicMarketOps] Time: ${moment().format("YYYY-MM-DD HH:mm:ss")}`);
  console.log(`[DynamicMarketOps] ───────────────────────────────────────────────────`);

  _executedToday.marketOpen.add(executionKey);

  try {
    // Add any market opening operations here if needed
    console.log(`[DynamicMarketOps] [${marketName}] Market opened successfully`);
  } catch (err) {
    console.error(`[DynamicMarketOps] [${marketName}] Market open operations failed:`, err.message);
  }
  
  console.log(`[DynamicMarketOps] ───────────────────────────────────────────────────\n`);
};

/**
 * Execute pre-market sync operations (10 minutes before market opens)
 * This syncs scripts, expiries, and adds symbols to WebSocket
 */
const executePreMarketSync = async (marketId, marketName) => {
  const executionKey = `${marketId}_${moment().format("YYYY-MM-DD_HH:mm")}_premarket`;
  
  // Prevent duplicate execution
  if (_executedToday.marketOpen.has(executionKey)) {
    return;
  }

  console.log(`[DynamicMarketOps] ═══════════════════════════════════════════════════`);
  console.log(`[DynamicMarketOps] Pre-Market Sync: ${marketName} (ID: ${marketId})`);
  console.log(`[DynamicMarketOps] Time: ${moment().format("YYYY-MM-DD HH:mm:ss")}`);
  console.log(`[DynamicMarketOps] ═══════════════════════════════════════════════════`);

  _executedToday.marketOpen.add(executionKey);

  try {
    const MarketSpecificSyncService = require('../services/MarketSpecificSyncService');
    const success = await MarketSpecificSyncService.syncMarketBeforeOpen(marketId, marketName);
    
    if (success) {
      console.log(`[DynamicMarketOps] [${marketName}] ✓ Pre-market sync completed successfully`);
    } else {
      console.warn(`[DynamicMarketOps] [${marketName}] ⚠️ Pre-market sync failed`);
    }
  } catch (err) {
    console.error(`[DynamicMarketOps] [${marketName}] ✗ Pre-market sync error:`, err.message);
    console.error(err.stack);
  }
  
  console.log(`[DynamicMarketOps] ═══════════════════════════════════════════════════\n`);
};

/**
 * Main function to check and execute market operations
 * Called every minute by the scheduler
 */
const checkAndExecuteMarketOperations = async () => {
  try {
    // Reset tracking if it's a new day
    resetExecutionTracking();

    const currentTime = moment().format("HH:mm");

    // Fetch all market timings
    const marketTimings = await getMarketTimings();

    if (!marketTimings || marketTimings.length === 0) {
      // Only log once per cache period to avoid spam
      if (Date.now() - _timeCacheTs < 1000) {
        console.log("[DynamicMarketOps] No market timings configured in database");
      }
      return;
    }

    let operationsTriggered = false;
    const marketsToSync = [];
    const marketsToClose = [];

    // Check each market's timing
    for (const market of marketTimings) {
      const { marketId, marketName, marketStartTime, marketEndTime } = market;

      const startTime = toHHMM(marketStartTime);
      const endTime = toHHMM(marketEndTime);

      if (!startTime || !endTime) {
        continue;
      }

      // Calculate time 10 minutes before market opens
      const preMarketTime = moment(startTime, "HH:mm").subtract(10, 'minutes').format("HH:mm");

      // Check if market is closing now (PRIORITY: check close first to skip pre-market sync)
      const isMarketClosing = currentTime === endTime;
      if (isMarketClosing) {
        operationsTriggered = true;
        marketsToClose.push({ marketId, marketName, endTime });
        // Skip pre-market sync if market is closing in same minute
        continue;
      }

      // Check if it's 10 minutes before market opens (pre-market sync)
      if (currentTime === preMarketTime) {
        operationsTriggered = true;
        marketsToSync.push({ marketId, marketName });
      }

      // Check if market is opening now
      if (currentTime === startTime) {
        operationsTriggered = true;
        // Execute market open operations and WAIT for completion
        await executeMarketOpen(marketId, marketName).catch(err => {
          console.error(`[DynamicMarketOps] Unhandled error in market open for ${marketName}:`, err);
        });
      }
    }

    // ═══════════════════════════════════════════════════════════════════════════
    // BATCH PRE-MARKET SYNC (Multiple markets at once)
    // ═══════════════════════════════════════════════════════════════════════════
    if (marketsToSync.length > 0) {
      console.log(`[DynamicMarketOps] ═══════════════════════════════════════════════════`);
      console.log(`[DynamicMarketOps] BATCH Pre-Market Sync: ${marketsToSync.length} market(s)`);
      console.log(`[DynamicMarketOps] Markets: ${marketsToSync.map(m => m.marketName).join(', ')}`);
      console.log(`[DynamicMarketOps] ═══════════════════════════════════════════════════`);

      // Execute all pre-market syncs in parallel
      const syncPromises = marketsToSync.map(market =>
        executePreMarketSync(market.marketId, market.marketName).catch(err => {
          console.error(`[DynamicMarketOps] Unhandled error in pre-market sync for ${market.marketName}:`, err);
        })
      );

      await Promise.all(syncPromises);

      // After all syncs complete, publish BATCH symbol addition signal
      console.log(`[DynamicMarketOps] Publishing batch symbol addition signal...`);
      try {
        const { redisPublisher } = require('../config/redis');
        
        await redisPublisher.publish('ws:batch-add-market-symbols', JSON.stringify({
          markets: marketsToSync,
          timestamp: Date.now()
        }));
        
        console.log(`[DynamicMarketOps] ✓ Batch symbol addition signal published`);
      } catch (err) {
        console.error(`[DynamicMarketOps] ✗ Error publishing batch signal:`, err.message);
      }

      console.log(`[DynamicMarketOps] ═══════════════════════════════════════════════════\n`);
    }

    // ═══════════════════════════════════════════════════════════════════════════
    // BATCH MARKET CLOSE (Multiple markets at once)
    // ═══════════════════════════════════════════════════════════════════════════
    if (marketsToClose.length > 0) {
      // Execute all market closes in parallel
      const closePromises = marketsToClose.map(market =>
        executeMarketClose(market.marketId, market.marketName, market.endTime).catch(err => {
          console.error(`[DynamicMarketOps] Unhandled error in market close for ${market.marketName}:`, err);
        })
      );

      await Promise.all(closePromises);

      // After all closes complete, publish BATCH symbol removal signal
      console.log(`[DynamicMarketOps] Publishing batch symbol removal signal...`);
      try {
        const { redisPublisher } = require('../config/redis');
        
        await redisPublisher.publish('ws:batch-remove-market-symbols', JSON.stringify({
          markets: marketsToClose,
          timestamp: Date.now()
        }));
        
        console.log(`[DynamicMarketOps] ✓ Batch symbol removal signal published`);
      } catch (err) {
        console.error(`[DynamicMarketOps] ✗ Error publishing batch removal signal:`, err.message);
      }
    }

    // Only log when operations are actually triggered
    if (!operationsTriggered) {
      // Silent - no operations needed at this time
      return;
    }
  } catch (err) {
    console.error("[DynamicMarketOps] Error in checkAndExecuteMarketOperations:", err.message);
  }
};

module.exports = {
  checkAndExecuteMarketOperations,
  getMarketTimings,
  executeMarketClose,
  executeMarketOpen,
  executePreMarketSync
};
