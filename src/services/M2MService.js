/**
 * M2M (Mark-to-Market) Service
 * Handles real-time profit/loss calculations for user positions
 * Now includes booked P&L from past trades in the active valan
 */

const { getSingleStockData, getMultipleStockData } = require("./RedisService");
const { redisClient } = require("../config/redis");
const UserPosition = require("../models/UserPositionModel");
const StockTransaction = require("../models/StockTransactionModel");
const mongoose = require("mongoose");
const { getActiveWeekValan } = require("./StockService");

// M2M User Cache
let m2mUserCache = null;
let lastRefreshedAt = null;

// Market groupings for M2M logic
const MARKET_GROUPS = {
    // Combined group for NSE FO/NOPT, MCX, INDEX, and others
    NSE_MCX_NOPT: ['1', '2', '3', '4', '5', '10', '11', '13', '14'],
    // Separate group for NSE Equity
    NSEEQ: ['12'],
    // Only Forex and Comex have separate params
    FOREX_COMEX: ['6', '7']
};

/**
 * Determine which market group a marketId belongs to
 */
const getMarketGroup = (marketId) => {
    // If array, use first element to determine group
    const id = Array.isArray(marketId) ? marketId[0] : marketId;
    if (!id) return null;

    if (MARKET_GROUPS.NSE_MCX_NOPT.includes(id.toString())) {
        return 'NSE_MCX_NOPT';
    }
    if (MARKET_GROUPS.NSEEQ.includes(id.toString())) {
        return 'NSEEQ';
    }
    if (MARKET_GROUPS.FOREX_COMEX.includes(id.toString())) {
        return 'FOREX_COMEX';
    }
    return null;
};

/**
 * Get all open positions for a user in a specific market group
 */
const { getUserPosition } = require("./StockService");

const getUserPositionsByMarketGroup = async (userId, valanId, marketGroupOrIds) => {
    try {
        const marketIds = Array.isArray(marketGroupOrIds)
            ? marketGroupOrIds
            : (MARKET_GROUPS[marketGroupOrIds] || []);

        const positions = await getUserPosition({
            userId: new mongoose.Types.ObjectId(userId),
            valanId,
            marketId: { $in: marketIds },
            $expr: { $ne: ["$buyQuantity", "$sellQuantity"] }
        });

        return positions;
    } catch (error) {
        console.error("Error fetching positions:", error);
        throw error;
    }
};

/**
 * Calculate booked (realized) P&L for a user from fully squared-off positions
 * This gets the profit/loss from trades that have been fully closed in the active valan
 * @param {string} userId - User ID
 * @param {string} valanId - Valan ID (active week valan)
 * @param {Array} marketIds - Array of market IDs in the market group
 * @returns {Promise<number>} - Total booked P&L
 */
const calculateBookedPnL = async (userId, valanId, marketIds) => {
    try {
        // Aggregate all transactions grouped by scriptId
        // Where buyQuantity === sellQuantity (fully squared off positions)
        const pipeline = [
            {
                $match: {
                    userId: new mongoose.Types.ObjectId(userId),
                    valanId: new mongoose.Types.ObjectId(valanId),
                    marketId: { $in: marketIds },
                    transactionStatus: "COMPLETED"
                }
            },
            {
                $group: {
                    _id: { scriptId: "$scriptId" },
                    buyQuantity: {
                        $sum: {
                            $cond: [{ $eq: ["$transactionType", "BUY"] }, "$quantity", 0]
                        }
                    },
                    sellQuantity: {
                        $sum: {
                            $cond: [{ $eq: ["$transactionType", "SELL"] }, "$quantity", 0]
                        }
                    },
                    buyValue: {
                        $sum: {
                            $cond: [{ $eq: ["$transactionType", "BUY"] }, "$totalNetPrice", 0]
                        }
                    },
                    sellValue: {
                        $sum: {
                            $cond: [{ $eq: ["$transactionType", "SELL"] }, "$totalNetPrice", 0]
                        }
                    },
                    totalBrokerage: {
                        $sum: "$netBrokerage"
                    }
                }
            },
            {
                $project: {
                    scriptId: "$_id.scriptId",
                    buyQuantity: 1,
                    sellQuantity: 1,
                    buyValue: 1,
                    sellValue: 1,
                    totalBrokerage: 1,
                    isFullySquaredOff: {
                        $eq: ["$buyQuantity", "$sellQuantity"]
                    },
                    // Calculate the booked P&L for fully closed positions
                    bookedPnL: {
                        $cond: [
                            { $eq: ["$buyQuantity", "$sellQuantity"] },
                            { $subtract: ["$sellValue", "$buyValue"] },
                            0
                        ]
                    }
                }
            },
            {
                $group: {
                    _id: null,
                    totalBookedPnL: { $sum: "$bookedPnL" },
                    totalBrokerage: { $sum: "$totalBrokerage" },
                    scriptsAnalyzed: { $sum: 1 },
                    fullySquaredOffScripts: {
                        $sum: { $cond: ["$isFullySquaredOff", 1, 0] }
                    }
                }
            }
        ];

        const result = await StockTransaction.aggregate(pipeline);

        if (!result || result.length === 0) {
            return 0;
        }

        const bookedPnL = result[0].totalBookedPnL || 0;

        // console.log(`[M2M-BOOKED] User ${userId}, Valan ${valanId}: Booked P&L = ${bookedPnL.toFixed(2)}, Scripts: ${result[0].fullySquaredOffScripts}/${result[0].scriptsAnalyzed}`);

        return bookedPnL;
    } catch (error) {
        console.error("Error calculating booked P&L:", error);
        return 0; // Return 0 on error to not break M2M calculation
    }
};

/**
 * Calculate M2M for a single position
 * Formula: (Total Sell Value - Total Buy Value) + (Net Quantity * Live Price)
 * This correctly accounts for both Realized P&L (from squared portions) and Unrealized P&L (from open portions)
 */
const calculatePositionM2M = (position, liveStock) => {
    const netQty = (position.buyQuantity || 0) - (position.sellQuantity || 0);
    const totalBuyValue = position.buyPrice || 0;
    const totalSellValue = position.sellPrice || 0;

    // Determine the base price (LastTradePrice is standard fallback)
    let livePrice = 0;
    if (liveStock) {
        livePrice = liveStock.LastTradePrice ? parseFloat(liveStock.LastTradePrice) : 0;
    }

    // Use a fallback price if livePrice is 0 or invalid
    let priceToUse = livePrice;
    if (!priceToUse || priceToUse <= 0) {
        if (netQty > 0) {
            priceToUse = totalBuyValue / (position.buyQuantity || 1);
        } else if (netQty < 0) {
            priceToUse = totalSellValue / (position.sellQuantity || 1);
        } else {
            priceToUse = 0;
        }
    }

    // "Mark-to-Exit" Logic:
    // If Long (netQty > 0), we exit by Selling at BID (BuyPrice)
    // If Short (netQty < 0), we exit by Buying at ASK (SellPrice)
    let valuationPrice = priceToUse;

    if (liveStock && netQty !== 0) {
        if (netQty > 0) {
            // Unwinding Long -> Sell to Buyer -> BuyPrice (Bid)
            if (liveStock.BuyPrice && parseFloat(liveStock.BuyPrice) > 0) {
                valuationPrice = parseFloat(liveStock.BuyPrice);
            }
        } else {
            // Unwinding Short -> Buy from Seller -> SellPrice (Ask)
            if (liveStock.SellPrice && parseFloat(liveStock.SellPrice) > 0) {
                valuationPrice = parseFloat(liveStock.SellPrice);
            }
        }
    }

    // Formula: (Total Sell Value - Total Buy Value) + (Net Quantity * Valuation Price)
    const m2m = (totalSellValue - totalBuyValue) + (netQty * valuationPrice);

    return m2m;
};

/**
 * Calculate total M2M for a user across a market group
 * Now includes BOTH:
 * 1. Unrealized P&L from current open positions (using live prices)
 * 2. Booked P&L from fully squared-off positions in this active valan
 * Uses Redis caching for performance - cache shortened to 2s for "real-time" feel
 */
const calculateUserM2M = async (userId, valanId, marketGroupOrIds) => {
    try {
        // Determine market IDs and group name for cache/logging
        let marketIds;
        let groupName;

        if (Array.isArray(marketGroupOrIds)) {
            marketIds = marketGroupOrIds;
            groupName = getMarketGroup(marketIds);
        } else if (MARKET_GROUPS[marketGroupOrIds]) {
            // It's a group name (NSE_MCX_NOPT, etc.)
            groupName = marketGroupOrIds;
            marketIds = MARKET_GROUPS[groupName];
        } else {
            // It's a single marketId string (e.g., "1")
            groupName = getMarketGroup(marketGroupOrIds);
            marketIds = MARKET_GROUPS[groupName] || [];
        }

        if (!groupName) return { totalM2M: 0, bookedPnL: 0, unrealizedPnL: 0, positions: [] };

        // Check cache first
        const cacheKey = `m2m:${userId}:${valanId}:${groupName || 'unknown'}`;
        const cached = await redisClient.get(cacheKey);

        if (cached) {
            const cachedData = JSON.parse(cached);
            cachedData.fromCache = true;
            return cachedData;
        }

        // ============================================================
        // STEP 1: Calculate BOOKED P&L from fully squared-off positions
        // ============================================================
        const bookedPnL = await calculateBookedPnL(userId, valanId, marketIds);

        // ============================================================
        // STEP 2: Calculate UNREALIZED P&L from open positions
        // ============================================================
        // Get all positions for this market group/ID list
        const positions = await getUserPositionsByMarketGroup(userId, valanId, marketIds);

        let unrealizedPnL = 0;
        const positionDetails = [];

        if (positions && positions.length > 0) {
            // Collect all unique symbols
            const symbols = [...new Set(positions.map(pos => pos.scriptId))];

            // Fetch live prices
            const livePricesRaw = await getMultipleStockData(symbols);
            const livePricesMap = {};
            symbols.forEach((symbol, index) => {
                const data = livePricesRaw[index];
                if (data) livePricesMap[symbol] = data;
            });

            for (const position of positions) {
                const symbol = position.scriptId;
                const liveStock = livePricesMap[symbol];
                const livePrice = liveStock && liveStock.LastTradePrice ? parseFloat(liveStock.LastTradePrice) : 0;

                const posM2M = calculatePositionM2M(position, liveStock);
                unrealizedPnL += posM2M;

                positionDetails.push({
                    scriptId: position.scriptId,
                    scriptName: position.scriptName,
                    label: position.label,
                    netQty: (position.buyQuantity || 0) - (position.sellQuantity || 0),
                    livePrice,
                    m2m: posM2M
                });
            }
        }

        // ============================================================
        // STEP 3: Combine BOOKED + UNREALIZED for total M2M
        // ============================================================
        const totalM2M = bookedPnL + unrealizedPnL;

        // console.log(`[M2M-TOTAL] User ${userId}, ${groupName}: Booked=${bookedPnL.toFixed(2)}, Unrealized=${unrealizedPnL.toFixed(2)}, Total=${totalM2M.toFixed(2)}`);

        const result = {
            totalM2M: parseFloat(totalM2M.toFixed(4)),
            bookedPnL: parseFloat(bookedPnL.toFixed(4)),
            unrealizedPnL: parseFloat(unrealizedPnL.toFixed(4)),
            positions: positionDetails,
            calculatedAt: new Date().toISOString(),
            fromCache: false
        };

        // Cache for 1 second (Optimized for real-time watcher and live ticks)
        await redisClient.setex(cacheKey, 1, JSON.stringify(result));

        return result;
    } catch (error) {
        console.error("Error calculating user M2M:", error);
        throw error;
    }
};

/**
 * Check if user has hit M2M limits
 */
const checkM2MLimitStatus = async (userId, valanId, marketIdOrIds, accountDetails) => {
    const NO_LIMITS = { loss: 0, profit: 0, autoSquare: 0, alertPercent: 0 };
    const marketGroup = getMarketGroup(marketIdOrIds);
    if (!marketGroup) return { isHit: false, alertHit: false, m2m: 0, limits: NO_LIMITS };

    const limits = getM2MLimits(accountDetails, marketGroup);
    if (!limits.loss && !limits.profit) return { isHit: false, alertHit: false, m2m: 0, limits };

    const m2mData = await calculateUserM2M(userId, valanId, marketIdOrIds);
    const m2m = m2mData.totalM2M;

    const status = {
        isHit: false,
        alertHit: false,
        m2m,
        limits,
        marketGroup
    };

    // 1. Check ALERT Threshold (Profit or Loss)
    if (limits.alertPercent > 0) {
        const checkAlert = (limitVal) => {
            if (!limitVal) return false;
            const threshold = (Math.abs(limitVal) * limits.alertPercent) / 100;
            return Math.abs(m2m) >= threshold;
        };

        if (checkAlert(limits.loss) || checkAlert(limits.profit)) {
            status.alertHit = true;
        }
    }

    // 2. Check BREACH (Loss)
    if (limits.loss && m2m <= -Math.abs(limits.loss)) {
        status.isHit = true;
        status.type = 'loss';
        status.limit = limits.loss;
        status.message = `M2M Loss limit reached: ₹${m2m.toFixed(2)} (Limit: ₹${limits.loss})`;
        status.autoSquare = limits.autoSquare === 1;

//         console.log(`[M2M-SERVICE-BREACH] User: ${userId}, Group: ${marketGroup}, !!! LOSS HIT !!! M2M: ${m2m.toFixed(2)}, Limit: -${limits.loss}, AutoSquare: ${status.autoSquare}`);
        return status;
    }

    // 3. Check BREACH (Profit)
    if (limits.profit && m2m >= Math.abs(limits.profit)) {
        status.isHit = true;
        status.type = 'profit';
        status.limit = limits.profit;
        status.message = `M2M Profit limit reached: ₹${m2m.toFixed(2)} (Limit: ₹${limits.profit})`;
        status.autoSquare = limits.autoSquare === 1;

//         console.log(`[M2M-SERVICE-BREACH] User: ${userId}, Group: ${marketGroup}, !!! PROFIT HIT !!! M2M: ${m2m.toFixed(2)}, Limit: ${limits.profit}, AutoSquare: ${status.autoSquare}`);
        return status;
    }

    return status;
};

/**
 * Get all users who should be monitored for M2M limits
 * This includes ANY user who has M2M loss or profit limits configured,
 * AND has active open positions in the UserPosition model for the current valan.
 */
const getActiveM2MUsers = async (valanId) => {
    try {
        if (!valanId) return [];

        const cacheKey = `active_m2m_users:${valanId}`;
        const cached = await redisClient.get(cacheKey);

        if (cached) {
            return JSON.parse(cached);
        }

        // 1. Get all UserIds that have active positions in this valan
        // We only care about users who currently HAVE positions to monitor/square-off
        const activeUserIds = await UserPosition.distinct("userId", {
            valanId: new mongoose.Types.ObjectId(valanId)
        });

        if (!activeUserIds || activeUserIds.length === 0) {
            return [];
        }

        const UserModel = require("../models/UserModel");

        // 2. Get users from that list who have ANY M2M limit configured
        const users = await UserModel.find({
            _id: { $in: activeUserIds },
            $or: [
                // NSE_MCX_NOPT limits
                { "accountDetails.m2mLoss_NSE_MCX_NOPT": { $exists: true, $ne: null, $ne: 0, $ne: "" } },
                { "accountDetails.m2mProfit_NSE_MCX_NOPT": { $exists: true, $ne: null, $ne: 0, $ne: "" } },
                // NSEEQ limits
                { "accountDetails.m2mLoss_NSEEQ": { $exists: true, $ne: null, $ne: 0, $ne: "" } },
                { "accountDetails.m2mProfit_NSEEQ": { $exists: true, $ne: null, $ne: 0, $ne: "" } },
                // FOREX_COMEX limits
                { "accountDetails.m2mLoss_FOREX_COMEX": { $exists: true, $ne: null, $ne: 0, $ne: "" } },
                { "accountDetails.m2mProfit_FOREX_COMEX": { $exists: true, $ne: null, $ne: 0, $ne: "" } }
            ],
            isDeleted: false,
            status: true
        }).select({
            _id: 1,
            accountCode: 1,
            accountDetails: 1,
            parentIds: 1,
            accountName: 1
        }).lean();

        // console.log(`[M2M-WATCHER] Found ${users.length} users with M2M limits and active positions`);

        // Cache for 30 seconds (short because positions change frequently)
        await redisClient.setex(cacheKey, 30, JSON.stringify(users));
        return users;
    } catch (error) {
        console.error("Error in getActiveM2MUsers:", error);
        return [];
    }
};

/**
 * Robustly caches ALL users with M2M configs to avoid DB load on every cycle.
 * Called on server init, hourly by scheduler, and on user updates.
 */
const refreshM2MUserCache = async () => {
    try {
        const UserModel = require("../models/UserModel");

        const users = await UserModel.find({
            $or: [
                { "accountDetails.m2mLoss_NSE_MCX_NOPT": { $exists: true, $ne: null, $ne: 0, $ne: "" } },
                { "accountDetails.m2mProfit_NSE_MCX_NOPT": { $exists: true, $ne: null, $ne: 0, $ne: "" } },
                { "accountDetails.m2mLoss_NSEEQ": { $exists: true, $ne: null, $ne: 0, $ne: "" } },
                { "accountDetails.m2mProfit_NSEEQ": { $exists: true, $ne: null, $ne: 0, $ne: "" } },
                { "accountDetails.m2mLoss_FOREX_COMEX": { $exists: true, $ne: null, $ne: 0, $ne: "" } },
                { "accountDetails.m2mProfit_FOREX_COMEX": { $exists: true, $ne: null, $ne: 0, $ne: "" } }
            ],
            isDeleted: false,
            status: true
        }).select({
            _id: 1,
            accountCode: 1,
            accountDetails: 1,
            parentIds: 1,
            accountName: 1,
            partnership: 1
        }).lean();

        m2mUserCache = users;
        lastRefreshedAt = new Date();

        // Also sync to Redis for multi-node support (Long TTL: 24h)
        await redisClient.set("m2m_global_user_cache", JSON.stringify(users), "EX", 86400);

//         console.log(`[M2M-SERVICE] Cache Refreshed. Total Users: ${users.length} at ${lastRefreshedAt}`);
        return users;
    } catch (error) {
        console.error("Error refreshing M2M user cache:", error);
        throw error;
    }
};

/**
 * Returns cached M2M users.
 * ALWAYS reads from Redis first so that all worker processes (PM2 cluster)
 * immediately pick up the fresh limits after a user edit calls refreshM2MUserCache().
 * In-memory is only used as a last-resort fallback when Redis is unavailable.
 */
const getCachedM2MUsers = async () => {
    try {
        const redisCached = await redisClient.get("m2m_global_user_cache");
        if (redisCached) {
            m2mUserCache = JSON.parse(redisCached); // keep in-memory in sync
            return m2mUserCache;
        }
    } catch (redisErr) {
        console.warn("[M2M-SERVICE] Redis unavailable, falling back to in-memory cache:", redisErr.message);
        // Fall through to in-memory below
    }

    // Redis miss or error: use in-memory if available
    if (m2mUserCache) return m2mUserCache;

    // Nothing cached anywhere - do a full DB refresh
    return await refreshM2MUserCache();
};

/**
 * @deprecated Use getActiveM2MUsers instead
 * Get all users who have auto-square-off enabled
 */
const getActiveAutoSquareUsers = async () => {
//     console.warn("[DEPRECATED] getActiveAutoSquareUsers is deprecated. Use getActiveM2MUsers instead.");
    return getActiveM2MUsers();
};

/**
 * Invalidate M2M cache for a user
 */
const invalidateM2MCache = async (userId, valanId, clearAlertStates = false) => {
    try {
        const keys = [
            `m2m:${userId}:${valanId}:NSE_MCX_NOPT`,
            `m2m:${userId}:${valanId}:NSEEQ`,
            `m2m:${userId}:${valanId}:FOREX_COMEX`
        ];

        if (clearAlertStates) {
            // Also invalidate alert/breach markers so they can trigger again on next entry
            const groups = ['NSE_MCX_NOPT', 'NSEEQ', 'FOREX_COMEX'];
            groups.forEach(group => {
                keys.push(`m2m_alert_state:${userId}:${group}`);
                keys.push(`m2m_breach_state:${userId}:${group}`);
            });
        }

        for (const key of keys) {
            await redisClient.del(key);
        }
    } catch (error) {
        console.error("Error invalidating M2M cache:", error);
    }
};

/**
 * Reset ALL M2M breach/alert state for a user.
 * Call this whenever a user's M2M limits are increased so they are unblocked
 * from trading and the watcher re-evaluates them from a clean state.
 *
 * Clears:
 *  - m2m_watcher_lock:breach:{userId}:{group}  (watcher breach lock)
 *  - m2m_watcher_lock:alert:{userId}:{group}   (watcher alert threshold lock)
 *  - m2m_alert_state:{userId}:{group}           (legacy alert state)
 *  - m2m_breach_state:{userId}:{group}          (legacy breach state)
 *  - m2m_blocked:{userId}                       (upline trading block)
 */
const resetM2MBreachState = async (userId) => {
    try {
        const groups = ['NSE_MCX_NOPT', 'NSEEQ', 'FOREX_COMEX'];
        const keys = [
            `m2m_blocked:${userId}`
        ];

        groups.forEach(group => {
            keys.push(`m2m_watcher_lock:breach:${userId}:${group}`);
            keys.push(`m2m_watcher_lock:alert:${userId}:${group}`);
            keys.push(`m2m_alert_state:${userId}:${group}`);
            keys.push(`m2m_breach_state:${userId}:${group}`);
        });

        const deleted = await Promise.all(keys.map(k => redisClient.del(k)));
        const totalDeleted = deleted.filter(Boolean).length;

//         console.log(`[M2M-SERVICE] Breach state RESET for user ${userId}. Cleared ${totalDeleted}/${keys.length} Redis keys.`);
    } catch (error) {
        console.error(`[M2M-SERVICE] Error resetting M2M breach state for user ${userId}:`, error);
    }
};

/**
 * Get M2M limits for a user based on market group
 */
const getM2MLimits = (accountDetails, marketGroup) => {
    if (!accountDetails) return { loss: 0, profit: 0, autoSquare: 0, alertPercent: 0 };

    const base = {
        alertPercent: accountDetails.alertPercent || 0
    };

    let limits;
    if (marketGroup === 'NSE_MCX_NOPT') {
        limits = {
            ...base,
            loss: Math.abs(accountDetails.m2mLoss_NSE_MCX_NOPT || 0),
            profit: Math.abs(accountDetails.m2mProfit_NSE_MCX_NOPT || 0),
            autoSquare: accountDetails.applyAutoSquare_NSE_MCX_NOPT || 0
        };
    } else if (marketGroup === 'NSEEQ') {
        limits = {
            ...base,
            loss: Math.abs(accountDetails.m2mLoss_NSEEQ || 0),
            profit: Math.abs(accountDetails.m2mProfit_NSEEQ || 0),
            autoSquare: accountDetails.applyAutoSquare_NSEEQ || 0
        };
    } else if (marketGroup === 'FOREX_COMEX') {
        limits = {
            ...base,
            loss: Math.abs(accountDetails.m2mLoss_FOREX_COMEX || 0),
            profit: Math.abs(accountDetails.m2mProfit_FOREX_COMEX || 0),
            autoSquare: accountDetails.applyAutoSquare_FOREX_COMEX || 0
        };
    } else {
        limits = { loss: 0, profit: 0, autoSquare: 0, alertPercent: 0 };
    }

//         console.log(`[M2M-LIMITS] ${marketGroup}: loss=${limits.loss}, profit=${limits.profit}, auto=${limits.autoSquare}, alert=${limits.alertPercent}%`);

    return limits;
};

module.exports = {
    getMarketGroup,
    getUserPositionsByMarketGroup,
    calculateBookedPnL,
    calculatePositionM2M,
    calculateUserM2M,
    checkM2MLimitStatus,
    getActiveM2MUsers,
    refreshM2MUserCache,
    getCachedM2MUsers,
    getActiveAutoSquareUsers,  // Deprecated, use getActiveM2MUsers
    invalidateM2MCache,
    resetM2MBreachState,
    getM2MLimits,
    MARKET_GROUPS
};
