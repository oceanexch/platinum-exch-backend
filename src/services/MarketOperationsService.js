const mongoose = require("mongoose");
const StockTransaction = require("../models/StockTransactionModel");
const User = require("../models/UserModel");
const { saveTransaction, setUserPosition, updateUserQuantity, getUserQuantity, getActiveWeekValan, getExpiry } = require("./StockService");
const { isScriptBanned } = require("./NSEBanService");
const { getSingleStockData, redisClient } = require("./RedisService");
const { StockTransactionEvent, DashboardStockEvent } = require("./RedisStockService");
const { getFilterExpiries } = require("./SettingService");
const { Script } = require("../models/MarketTypeModel");
const UserPosition = require("../models/UserPositionModel");
const moment = require("moment");

/**
 * Cancel pending limit orders after market close.
 * @param {string} marketId - Optional: Cancel only for specific market.
 */
exports.cancelPendingLimitOrders = async (marketId = null) => {
    try {
        const query = {
            orderType: "Limit",
            transactionStatus: "PENDING",
        };

        if (marketId) {
            query.marketId = marketId;
        }

        const pendingTrades = await StockTransaction.find(query);

        if (pendingTrades.length === 0) {
            return;
        }


        const idsToCancel = pendingTrades.map((t) => t._id);

        await StockTransaction.updateMany(
            { _id: { $in: idsToCancel } },
            {
                $set: {
                    transactionStatus: "DELETED",
                    message: "Auto Cancelled: Market Closed"
                }
            }
        );

    } catch (error) {
        console.error("Error cancelling pending limit orders:", error);
    }
};

/**
 * Execute Square Off for a list of positions
 */
const executeSquareOff = async (openPositions, typeLabel) => {
    const userCache = new Map();
    const processedPositions = new Set(); // Track processed positions to prevent duplicates

    // console.log(`[AutoSquareOff] Starting ${typeLabel} square-off for ${openPositions.length} positions`);

    for (const pos of openPositions) {
        try {
            const userId = pos._id.userId.toString();
            const scriptId = pos._id.scriptId;
            const marketId = pos._id.marketId;
            const valanId = pos.valanId || pos._id.valanId;

            // Create unique key for this position - MUST include valanId
            const positionKey = `${userId}:${scriptId}:${marketId}:${valanId}`;
            const positionType = pos.netQty > 0 ? 'LONG' : 'SHORT';

            // console.log(`[AutoSquareOff] Processing ${positionType} position: ${pos.scriptName} | User: ${userId} | NetQty: ${pos.netQty} | Valan: ${valanId}`);

            // Skip if already processed in this batch
            if (processedPositions.has(positionKey)) {
                // console.log(`[AutoSquareOff] Position ${positionKey} already processed in this batch, skipping duplicate`);
                continue;
            }

            // Try to acquire Redis lock for this specific position
            const lockKey = `squareoff:position:${positionKey}`;
            const lockAcquired = await redisClient.set(lockKey, '1', 'NX', 'EX', 30);

            if (!lockAcquired) {
                // console.log(`[AutoSquareOff] Position ${positionKey} is locked by another process, skipping...`);
                continue;
            }

            // Mark as processed
            processedPositions.add(positionKey);

            // Fetch and cache user details if not already fetched
            if (!userCache.has(userId)) {
                const user = await User.findById(userId)
                    .select("parentIds brokerIds partnership loginIP createdBy marketAccess accountDetails")
                    .populate("parentIds", "_id")
                    .lean();
                userCache.set(userId, user);
            }

            const user = userCache.get(userId);
            if (!user) {
                console.warn(`[AutoSquareOff] User ${userId} not found, skipping position ${pos._id.scriptId}`);
                await redisClient.del(lockKey); // Release lock
                continue;
            }

            const qtyToClose = Math.abs(pos.netQty);
            const transactionType = pos.netQty > 0 ? "SELL" : "BUY";

            // Fetch current price
            // If user has BUY position (netQty > 0), we SELL at ask price
            // If user has SELL position (netQty < 0), we BUY at bid price
            let currentPrice = 0;
            const keysToTry = [pos.symbol, pos._id?.scriptId, pos.scriptId, pos.scriptName].filter(Boolean);

            for (const key of keysToTry) {
                try {
                    const redisData = await getSingleStockData(key);
                    if (redisData) {
                        const parsed = typeof redisData === 'string' ? JSON.parse(redisData) : redisData;

                        // Extract bid and ask prices from Redis data
                        // Redis stores: SellPrice (bid) and BuyPrice (ask)
                        const bid = Number(parsed.SellPrice ?? parsed.bid ?? parsed.Ltp ?? 0);
                        const ask = Number(parsed.BuyPrice ?? parsed.ask ?? parsed.Ltp ?? 0);

                        // When squaring off:
                        // - SELL transaction (closing long position): use bid (SellPrice)
                        // - BUY transaction (closing short position): use ask (BuyPrice)
                        currentPrice = transactionType === "SELL" ? bid : ask;

                        if (!currentPrice) {
                            currentPrice = Number(parsed.ltp ?? parsed.Ltp ?? 0);
                        }

                        if (currentPrice) {
                            // console.log(`[AutoSquareOff] ${pos.scriptName} - ${transactionType} at price ${currentPrice} (bid: ${bid}, ask: ${ask}, ltp: ${parsed.ltp ?? parsed.Ltp})`);
                            break;
                        }
                    }
                } catch (e) {
                    console.error(`Error fetching price for ${pos.scriptName} using key ${key}:`, e);
                }
            }

            if (!currentPrice) {
                console.warn(`[AutoSquareOff] SKIPPING ${positionType} position for ${pos.scriptName} (User: ${userId}) - NO PRICE AVAILABLE`);
                console.warn(`[AutoSquareOff] Tried keys: ${keysToTry.join(', ')}`);
                await redisClient.del(lockKey); // Release lock
                continue;
            }

            const BrokerageService = require("./BrokerageService");
            const getMarket = (user.marketAccess || []).find(m => String(m.marketId) == String(pos._id.marketId));

            const brokerageResult = await BrokerageService.calculateBrokerage({
                userId: pos._id.userId,
                valanId: pos.valanId,
                marketId: pos._id.marketId,
                marketName: pos.marketName,
                scriptId: pos._id.scriptId,
                scriptName: pos.scriptName,
                symbol: pos.symbol,
                label: pos.label,
                lot: pos.lot || 1,
                quantity: qtyToClose,
                price: currentPrice,
                transactionType: transactionType,
                message: typeLabel === "Expired Script" ? "FUTURE AUTO CLOSE" : "Square Off",
                type: "NRM"
            }, {
                getMarket,
                basicDetails: user
            });

            // Create Stock Object
            const stock = {
                userId: pos._id.userId,
                valanId: pos.valanId,
                marketId: pos._id.marketId,
                marketName: pos.marketName,
                scriptId: pos._id.scriptId,
                scriptName: pos.scriptName,
                symbol: pos.symbol,
                label: pos.label,
                expiry: pos.expiry || getExpiry(pos.label || pos.scriptName),
                lot: pos.lot || 1,
                quantity: qtyToClose,
                quantityType: brokerageResult.quantityType,
                orderPrice: currentPrice,
                totalOrderPrice: currentPrice * qtyToClose,
                netPrice: brokerageResult.netPrice,
                totalNetPrice: brokerageResult.totalNetPrice,
                m2mPrice: brokerageResult.m2mPrice,
                orderBrokerage: brokerageResult.orderBrokerage,
                netBrokerage: brokerageResult.netBrokerage,
                brokeragePercentage: brokerageResult.brokeragePercentage,
                brokeragePercentageType: brokerageResult.brokeragePercentageType,
                brokerTotalBrokerage: brokerageResult.brokerTotalBrokerage,
                brokerTotalPercentage: brokerageResult.brokerTotalPercentage,
                brockersBrokerage: brokerageResult.brockersBrokerage,
                otherBrokerage: brokerageResult.otherBrokerage,
                type: typeLabel === "Expired Script" ? "AUTO_SQ" : `NRM`,
                transactionType: transactionType,
                transactionStatus: "COMPLETED",
                orderType: "Market",
                tradePosition: "NRM",
                message: typeLabel === "Expired Script" ? "FUTURE AUTO CLOSE" : `Auto Square Off: ${typeLabel}`,
                shortmsg: typeLabel === "Expired Script" ? "FUTURE AUTO CLOSE" : `Auto sq (Market)`,
                ip: user.loginIP || "0.0.0.0",
                createdBy: pos._id.userId,

                // Lineage for reports
                parentIds: user.parentIds?.map(p => p._id) || [],
                brokerIds: user.brokerIds || [],
                partnership: user.partnership || [],
                myParent: user.createdBy?.userId
            };

            await saveTransaction(stock);

            // Update User Position
            await setUserPosition(pos._id.userId, pos._id.scriptId, pos.valanId);

            // Update User Quantity (Wallet/Holding)
            const checkQuantity = await getUserQuantity({
                userId: pos._id.userId,
                marketId: pos._id.marketId,
                marketName: pos.marketName,
                scriptId: pos._id.scriptId,
                scriptName: pos.scriptName,
                quantity: qtyToClose,
                transactionType: transactionType
            });

            await updateUserQuantity(
                { userId: pos._id.userId, scriptId: pos._id.scriptId, marketId: pos._id.marketId },
                { previous: checkQuantity.previous, current: checkQuantity.current }
            );

            // Trigger Socket Events for Frontend Updates
            try {
                // Determine userScriptId if possible, or fallback
                // For auto-square off, we might not have the exact userScript ID handy without a lookup,
                // but the event service handles fallback using label/scriptId

                await StockTransactionEvent({
                    userId: pos._id.userId,
                    parentIds: stock.parentIds,
                    marketId: pos._id.marketId,
                    scriptId: pos._id.scriptId,
                    transactionType,
                    valanId: pos.valanId,
                    userScriptId: null, // Let service find it
                    lot: stock.lot,
                    quantity: qtyToClose,
                    orderType: 'Market',
                    price: currentPrice,
                    label: pos.label,
                    scriptName: pos.scriptName
                });

                await DashboardStockEvent({
                    userId: pos._id.userId,
                    parentIds: stock.parentIds,
                    marketId: pos._id.marketId,
                    scriptId: pos._id.scriptId,
                    transactionType,
                    valanId: pos.valanId,
                    userScriptId: null,
                    lot: stock.lot,
                    quantity: qtyToClose,
                    orderType: 'Market',
                    price: currentPrice,
                    status: 'COMPLETED',
                    label: pos.label,
                    scriptName: pos.scriptName
                });
            } catch (eventErr) {
                console.error(`[AutoSquareOff] Error triggering events for ${pos.scriptName}:`, eventErr);
            }

            // Release the position lock after successful processing
            await redisClient.del(lockKey);
            // console.log(`[AutoSquareOff] ✓ Successfully squared off ${positionType} position ${positionKey} at price ${currentPrice}`);

        } catch (err) {
            console.error(`[AutoSquareOff] ✗ Error processing square off for ${pos.scriptName}:`, err.message);
            console.error(err.stack);

            // Release lock on error
            try {
                const errorUserId = pos._id.userId.toString();
                const errorScriptId = pos._id.scriptId;
                const errorMarketId = pos._id.marketId;
                const errorValanId = pos.valanId || pos._id.valanId;
                const errorPositionKey = `${errorUserId}:${errorScriptId}:${errorMarketId}:${errorValanId}`;
                const errorLockKey = `squareoff:position:${errorPositionKey}`;
                await redisClient.del(errorLockKey);
            } catch (unlockErr) {
                console.error(`[AutoSquareOff] Error releasing position lock:`, unlockErr);
            }
        }
    }

    // console.log(`[AutoSquareOff] Completed ${typeLabel} square-off. Processed ${processedPositions.size} positions.`);
}

/**
 * Intraday Auto Square Off
 * Closes net intraday positions for users with intraDayAutoSquare enabled.
 */
// Global lock to prevent concurrent executions
const _intradaySquareOffLocks = new Map();

exports.intradaySquareOff = async (marketId = null) => {
    const lockKey = `intraday_squareoff_${marketId || 'all'}`;

    // Check if already running for this market
    if (_intradaySquareOffLocks.get(lockKey)) {
        // console.log(`[IntradaySquareOff] Already running for market ${marketId}, skipping duplicate execution`);
        return;
    }

    // Set lock
    _intradaySquareOffLocks.set(lockKey, true);

    try {
        const users = await User.find({ "accountDetails.intraDayAutoSquare": 1 }).select("_id");
        const userIds = users.map(u => u._id);

        if (userIds.length === 0) return;

        // Use the EXACT same aggregation logic as setUserPosition
        // This ensures we're calculating positions the same way
        const matchStage = {
            userId: { $in: userIds },
            transactionStatus: "COMPLETED"
        };

        if (marketId) {
            matchStage.marketId = String(marketId);
        }

        const pipeline = [
            {
                $match: matchStage
            },
            {
                $sort: { createdAt: 1 }
            },
            {
                $group: {
                    _id: {
                        userId: "$userId",
                        scriptId: "$scriptId",
                        marketId: "$marketId",
                        valanId: "$valanId"
                    },
                    marketName: { $first: "$marketName" },
                    scriptName: { $first: "$scriptName" },
                    label: { $first: "$label" },
                    expiry: { $first: "$expiry" },
                    symbol: { $first: "$symbol" },
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
                    buyLot: {
                        $sum: { $cond: [{ $eq: ["$transactionType", "BUY"] }, "$lot", 0] }
                    },
                    sellLot: {
                        $sum: { $cond: [{ $eq: ["$transactionType", "SELL"] }, "$lot", 0] }
                    }
                }
            },
            {
                $match: {
                    $expr: { $ne: ["$buyQuantity", "$sellQuantity"] }
                }
            }
        ];

        const openPositions = await StockTransaction.aggregate(pipeline);

        if (openPositions.length === 0) {
            // console.log(`[IntradaySquareOff] No open positions found for market ${marketId}`);
            return;
        }

        // console.log(`[IntradaySquareOff] Found ${openPositions.length} open positions to square off for market ${marketId}`);

        // Transform to match executeSquareOff expected format
        const positionsToSquareOff = openPositions.map(pos => ({
            _id: {
                userId: pos._id.userId,
                scriptId: pos._id.scriptId,
                marketId: pos._id.marketId,
                valanId: pos._id.valanId  // CRITICAL: Include valanId in _id
            },
            netQty: pos.buyQuantity - pos.sellQuantity,
            scriptName: pos.scriptName,
            marketName: pos.marketName,
            valanId: pos._id.valanId,  // Also at top level for easy access
            expiry: pos.expiry,
            lot: Math.abs(pos.buyLot - pos.sellLot) || 1,
            symbol: pos.symbol || pos._id.scriptId,
            label: pos.label
        }));

        await executeSquareOff(positionsToSquareOff, "Intraday");

    } catch (error) {
        console.error("[IntradaySquareOff] Error in intraday square off:", error);
        console.error(error.stack);
    } finally {
        // Always release the lock
        _intradaySquareOffLocks.delete(lockKey);
        // console.log(`[IntradaySquareOff] Lock released for market ${marketId}`);
    }
};

/**
 * Weekly Auto Square Off
 * Squares off ALL positions on Fridays for users with weeklyAutoSquare enabled.
 * Also cancels pending limit orders for these users.
 */
// Global lock to prevent concurrent executions
const _weeklySquareOffLocks = new Map();

exports.weeklySquareOff = async (marketId = null) => {
    const lockKey = `weekly_squareoff_${marketId || 'all'}`;

    // Check if already running for this market
    if (_weeklySquareOffLocks.get(lockKey)) {
        // console.log(`[WEEKLY SQUARE-OFF] Already running for market ${marketId}, skipping duplicate execution`);
        return;
    }

    // Set lock
    _weeklySquareOffLocks.set(lockKey, true);

    try {
        // console.log(`[WEEKLY SQUARE-OFF] Starting for market ${marketId || 'ALL'}`);

        const users = await User.find({ "accountDetails.weeklyAutoSquare": 1 }).select("_id");
        const userIds = users.map(u => u._id);

        if (userIds.length === 0) {
            // console.log('[WEEKLY SQUARE-OFF] No users with weeklyAutoSquare enabled');
            return;
        }

        // console.log(`[WEEKLY SQUARE-OFF] Found ${userIds.length} users with weekly auto square-off enabled`);

        // 1. Cancel pending limit orders for these users
        const cancelQuery = {
            userId: { $in: userIds },
            orderType: "Limit",
            transactionStatus: "PENDING"
        };

        if (marketId) {
            cancelQuery.marketId = marketId;
        }

        const cancelledCount = await StockTransaction.updateMany(
            cancelQuery,
            {
                $set: {
                    transactionStatus: "DELETED",
                    message: "Auto Cancelled: Weekly Square-Off"
                }
            }
        );

        // console.log(`[WEEKLY SQUARE-OFF] Cancelled ${cancelledCount.modifiedCount} pending limit orders`);

        // 2. Square off all open positions
        const pipeline = [
            {
                $match: {
                    userId: { $in: userIds },
                    transactionStatus: "COMPLETED",
                    ...(marketId ? { marketId: marketId } : {})
                }
            },
            {
                $group: {
                    _id: {
                        userId: "$userId",
                        scriptId: "$scriptId",
                        marketId: "$marketId",
                        valanId: "$valanId"  // CRITICAL: Include valanId in grouping
                    },
                    netQty: {
                        $sum: {
                            $cond: [
                                { $eq: ["$transactionType", "BUY"] },
                                "$quantity",
                                { $multiply: ["$quantity", -1] }
                            ]
                        }
                    },
                    scriptName: { $first: "$scriptName" },
                    marketName: { $first: "$marketName" },
                    valanId: { $first: "$valanId" },
                    expiry: { $first: "$expiry" },
                    lot: { $first: "$lot" },
                    symbol: { $first: "$symbol" },
                    label: { $first: "$label" }
                }
            },
            {
                $match: {
                    netQty: { $ne: 0 }
                }
            }
        ];

        const openPositions = await StockTransaction.aggregate(pipeline);
        // console.log(`[WEEKLY SQUARE-OFF] Found ${openPositions.length} open positions to square off`);

        await executeSquareOff(openPositions, "Weekly");

        // 3. Invalidate M2M cache for all affected users
        try {
            const M2MService = require("./M2MService");
            const { getActiveWeekValan } = require("./StockService");
            const valan = await getActiveWeekValan();

            if (valan) {
                for (const userId of userIds) {
                    await M2MService.invalidateM2MCache(userId, valan._id);
                }
                // console.log(`[WEEKLY SQUARE-OFF] Invalidated M2M cache for ${userIds.length} users`);
            }
        } catch (cacheErr) {
            console.error('[WEEKLY SQUARE-OFF] Error invalidating M2M cache:', cacheErr);
        }

        // console.log(`[WEEKLY SQUARE-OFF] Completed successfully`);

    } catch (error) {
        console.error("[WEEKLY SQUARE-OFF] Error in weekly square off:", error);
        console.error(error.stack);
    } finally {
        // Always release the lock
        _weeklySquareOffLocks.delete(lockKey);
        // console.log(`[WEEKLY SQUARE-OFF] Lock released for market ${marketId}`);
    }
};

/**
 * Check if Position Rollover is allowed
 * @returns {Promise<boolean>}
 */
exports.checkPositionRollOver = async (userId, parentIds) => {
    try {
        const ids = [userId, ...(parentIds || [])];
        const count = await User.countDocuments({
            _id: { $in: ids },
            "accountDetails.positionRollOverDisabled": 1
        });
        return count === 0; // Allowed if NO ONE in hierarchy has it disabled
    } catch (e) {
        return false;
    }
};

/**
 * Check if User can trade a banned script
 * @returns {Promise<boolean>}
 */
exports.checkBannedScript = async (userId, scriptName) => {
    try {
        const isBanned = await isScriptBanned(scriptName);
        if (!isBanned) return true; // Allowed if not banned

        // If banned, check if user has exception permission
        const user = await User.findById(userId).select("accountDetails.bandScriptAllow").lean();
        if (user && user.accountDetails && user.accountDetails.bandScriptAllow === 1) {
            return true; // Allowed via permission
        }

        return false; // Banned
    } catch (e) {
        console.error("checkBannedScript error:", e);
        return false;
    }
};

/**
 * Check if Limit/SL orders are allowed for specific user
 * @param {string} userId - User ID to check
 * @param {string} marketId - Optional: check for specific market disability
 * @returns {Promise<boolean>} - TRUE if disabled
 */
exports.checkLimitSLDisabled = async (userId, marketId = null) => {
    try {
        const query = User.findById(userId);
        if (marketId) {
            query.select("accountDetails.limitSLDisabled basicDetails.limitSLDisabled marketAccess");
        } else {
            query.select("accountDetails.limitSLDisabled basicDetails.limitSLDisabled");
        }

        const user = await query.lean();

        // 1. Check global disability
        if (user?.accountDetails?.limitSLDisabled === 1 || user?.basicDetails?.limitSLDisabled === 1) {
            return true;
        }

        // 2. Check market-specific disability if marketId is provided (only for marketId "3")
        if (marketId && String(marketId) === "3" && user?.marketAccess) {
            const market = user.marketAccess.find(m => m.marketId == marketId);
            const loa = market?.other?.limitOrderAllowed;
            // If property not configured for this market, skip check (treat as allowed)
            console.log("Limit allowed for market ", loa);
            if (loa === undefined) {
                return false;
            }
            if (market && market.other && loa !== undefined && loa !== null) {
                if (loa === false || loa === 0 || loa === "false" || loa === "0") {
                    return true;
                }
            }
        }

        return false;
    } catch (e) {
        console.error("checkLimitSLDisabled error:", e);
        return true; // Default to Disabled (safe) on error
    }
};

/**
 * Check if Limit/SL orders are disabled anywhere in the parent hierarchy
 * If any parent (admin -> subadmin -> client) has limit/SL disabled,
 * all children in that hierarchy cannot trade in limit/SL
 * @param {string} userId - The user ID to check
 * @param {Array} parentIds - Optional: Array of parent IDs if already fetched
 * @param {string} marketId - Optional: The market ID to check market-specific disability
 * @returns {Promise<boolean>} - TRUE if disabled in hierarchy, FALSE if allowed
 */
exports.checkLimitSLDisabledInHierarchy = async (userId, parentIds = null, marketId = null) => {
    try {
        // First check the user themselves
        if (await exports.checkLimitSLDisabled(userId, marketId)) {
            return true;
        }

        // Get parentIds if not provided
        let parents = parentIds;
        if (!parents) {
            const user = await User.findById(userId).select("parentIds").lean();
            parents = user?.parentIds || [];
        }

        // If no parents, only user check matters
        if (!parents || parents.length === 0) {
            return false;
        }

        // 1. Check if ANY parent in the hierarchy has global limit/SL disabled
        const globalDisabledCount = await User.countDocuments({
            _id: { $in: parents },
            $or: [
                { "accountDetails.limitSLDisabled": 1 },
                { "basicDetails.limitSLDisabled": 1 }
            ]
        });

        if (globalDisabledCount > 0) {
            // // console.log("Global limit disabled in parent hierarchy. Count:", globalDisabledCount);
            return true;
        }

        // 2. Check market-specific disability if marketId provided
        if (marketId) {
            const marketDisabledCount = await User.countDocuments({
                _id: { $in: parents },
                marketAccess: {
                    $elemMatch: {
                        marketId: marketId,
                        "other.limitOrderAllowed": { $in: [0, false, "0", "false"] }
                    }
                }
            });

            if (marketDisabledCount > 0) {
                return true;
            }
        }

        return false; // Allowed
    } catch (e) {
        console.error("checkLimitSLDisabledInHierarchy error:", e);
        return true; // Default to Disabled (safe) on error
    }
};

/**
 * Check if Short Selling is disabled for a specific user and market
 * @param {string} userId
 * @param {string} marketId
 * @returns {Promise<boolean>}
 */
exports.checkShortSellDisabled = async (userId, marketId = null) => {
    try {
        const user = await User.findById(userId).select("marketAccess").lean();
        if (marketId && user?.marketAccess) {
            const market = user.marketAccess.find(m => String(m.marketId) === String(marketId));
            const ssa = market?.other?.shortSellAllowed;
            // If property not configured for this market, skip check (treat as allowed)
           console.log("Short Sell allowed for market ", ssa);
            if (ssa === undefined) {
                return false;
            }
            if (market && market.other && ssa !== undefined && ssa !== null) {
                if (ssa === false || ssa === 0 || ssa === "false" || ssa === "0") {
                    return true;
                }
            }
        }
        return false;
    } catch (e) {
        console.error("checkShortSellDisabled error:", e);
        return true; // Default to Disabled (safe) on error
    }
};

/**
 * Check if Short Selling is disabled anywhere in the parent hierarchy
 * @param {string} userId
 * @param {Array} parentIds
 * @param {string} marketId
 * @returns {Promise<boolean>}
 */
exports.checkShortSellDisabledInHierarchy = async (userId, parentIds = null, marketId = null) => {
    try {
        // First check the user themselves
        if (await exports.checkShortSellDisabled(userId, marketId)) {
            return true;
        }

        // Get parentIds if not provided
        let parents = parentIds;
        if (!parents) {
            const user = await User.findById(userId).select("parentIds").lean();
            parents = user?.parentIds || [];
        }

        if (!parents || parents.length === 0) {
            return false;
        }

        // Check if ANY parent in the hierarchy has short selling disabled for the market
        if (marketId) {
            const marketDisabledCount = await User.countDocuments({
                _id: { $in: parents },
                marketAccess: {
                    $elemMatch: {
                        marketId: String(marketId),
                        "other.shortSellAllowed": { $in: [0, false, "0", "false"] }
                    }
                }
            });

            if (marketDisabledCount > 0) {
                return true;
            }
        }

        return false; // Allowed
    } catch (e) {
        console.error("checkShortSellDisabledInHierarchy error:", e);
        return true; // Default to Disabled (safe) on error
    }
};

/**
 * Expiry Position Rollover
 * Finds scripts with tradeEndDate yesterday, squares off positions, and cleans up.
 */
// Global lock to prevent concurrent executions
const _expiryRolloverLocks = new Map();

exports.expiryPositionRollover = async (marketId = null, tradingDate = null) => {
    const lockKey = `expiry_rollover_${marketId || 'all'}`;

    // Check if already running for this market
    if (_expiryRolloverLocks.get(lockKey)) {
        // console.log(`[EXPIRY ROLLOVER] Already running for market ${marketId}, skipping duplicate execution`);
        return;
    }

    // Set lock
    _expiryRolloverLocks.set(lockKey, true);

    try {
        const today = tradingDate
            ? moment(tradingDate, 'YYYY-MM-DD').startOf('day')
            : moment().startOf('day');
        const todayStr = today.format("YYYY-MM-DD");

        const activeValan = await getActiveWeekValan();
        if (!activeValan) {
            return;
        }

        // console.log(`[EXPIRY ROLLOVER] Starting for market ${marketId} on ${todayStr}`);

        // ── 1. Find scripts with expiry.tradeEndDate = todayStr ──────────
        const scriptQuery = {
            "expiry.tradeEndDate": todayStr
        };
        if (marketId) {
            scriptQuery.market_type_id = String(marketId);
        }


        const scriptsWithExpiry = await Script.find(scriptQuery).lean();
        // console.log("Scriptquery :",scriptQuery);
        // console.log("Scripts :",scriptsWithExpiry);
        // // console.log("Scripts to expire : ",scriptsWithExpiry);
        if (scriptsWithExpiry.length === 0) {
            // console.log(`[EXPIRY ROLLOVER] No expiring scripts found for market ${marketId} on ${todayStr}.`);
            return;
        }

        // ── 2. Extract scriptIds from matching expiry entries ──────────
        const scriptIdsToClose = new Set();
        const expiryEntriesToCleanup = [];

        // console.log(`[EXPIRY ROLLOVER] Found expiring entries:`);

        for (const script of scriptsWithExpiry) {
            if (Array.isArray(script.expiry)) {
                for (const exp of script.expiry) {
                    if (exp.tradeEndDate === todayStr) {
                        // console.log(`  - ${exp.script_id} (${script.script_name}) - tradeEndDate: ${exp.tradeEndDate}, expiryDate: ${exp.expiry_date}`);

                        scriptIdsToClose.add(exp.script_id);
                        expiryEntriesToCleanup.push({
                            scriptDocId: script._id,
                            scriptExpiryId: exp.script_expiry_id,
                            scriptId: exp.script_id
                        });
                    }
                }
            }
        }

        const uniqueScriptIds = [...scriptIdsToClose];
        // console.log(`[EXPIRY ROLLOVER] Found ${expiryEntriesToCleanup.length} expiring entries. ScriptIds: ${uniqueScriptIds.join(', ')}`);

        // ── 3. Aggregate open positions from StockTransaction for these scriptIds ───────────────────
        const matchStage = {
            scriptId: { $in: uniqueScriptIds },
            valanId: activeValan._id,
            transactionStatus: "COMPLETED"
        };

        if (marketId) {
            matchStage.marketId = String(marketId);
        }

        const pipeline = [
            {
                $match: matchStage
            },
            {
                $sort: { createdAt: 1 }
            },
            {
                $group: {
                    _id: {
                        userId: "$userId",
                        scriptId: "$scriptId",
                        marketId: "$marketId",
                        valanId: "$valanId"
                    },
                    marketName: { $first: "$marketName" },
                    scriptName: { $first: "$scriptName" },
                    label: { $first: "$label" },
                    expiry: { $first: "$expiry" },
                    symbol: { $first: "$symbol" },
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
                    buyLot: {
                        $sum: { $cond: [{ $eq: ["$transactionType", "BUY"] }, "$lot", 0] }
                    },
                    sellLot: {
                        $sum: { $cond: [{ $eq: ["$transactionType", "SELL"] }, "$lot", 0] }
                    }
                }
            },
            {
                $match: {
                    $expr: { $ne: ["$buyQuantity", "$sellQuantity"] }
                }
            }
        ];

        const openPositions = await StockTransaction.aggregate(pipeline);

        if (openPositions.length === 0) {
            // console.log(`[EXPIRY ROLLOVER] No open positions found for expired scripts in market ${marketId}.`);
        } else {
            // console.log(`[EXPIRY ROLLOVER] Found ${openPositions.length} open positions for market ${marketId}.`);

            // Log details of each position BEFORE mapping
            // console.log(`[EXPIRY ROLLOVER] Raw aggregation results:`);
            openPositions.forEach((pos, index) => {
                const netQty = pos.buyQuantity - pos.sellQuantity;
                const positionType = netQty > 0 ? 'LONG' : 'SHORT';
                // console.log(`[EXPIRY ROLLOVER] [${index}] ${pos.scriptName} | User: ${pos._id.userId} | Valan: ${pos._id.valanId} | Type: ${positionType} | NetQty: ${netQty} | Buy: ${pos.buyQuantity} | Sell: ${pos.sellQuantity}`);
            });

            const positionsToSquareOff = openPositions.map(pos => ({
                _id: {
                    userId: pos._id.userId,
                    scriptId: pos._id.scriptId,
                    marketId: pos._id.marketId,
                    valanId: pos._id.valanId  // Make sure valanId is included here
                },
                netQty: pos.buyQuantity - pos.sellQuantity,
                scriptName: pos.scriptName,
                marketName: pos.marketName,
                valanId: pos._id.valanId,  // Also at top level for easy access
                symbol: pos.symbol || pos._id.scriptId,
                scriptId: pos._id.scriptId,
                label: pos.label,
                expiry: pos.expiry || "EXPIRED",
                lot: Math.abs(pos.buyLot - pos.sellLot) || 1
            }));

            // console.log(`[EXPIRY ROLLOVER] Starting square-off for ${positionsToSquareOff.length} positions...`);
            await executeSquareOff(positionsToSquareOff, "Expired Script");
            // console.log(`[EXPIRY ROLLOVER] Square-off completed.`);
        }

        // ── 4. Cleanup ───────────────────────────────────────────────────
        const UserScript = require("../models/UserScriptModel");

        for (const entry of expiryEntriesToCleanup) {
            const { scriptDocId, scriptExpiryId, scriptId } = entry;

            // Delete UserScript docs
            try {
                await UserScript.deleteMany({ scriptId: scriptId });
                // console.log(`[EXPIRY ROLLOVER] Deleted UserScript docs for scriptId=${scriptId}`);
            } catch (err) {
                console.error(`[EXPIRY ROLLOVER] Error deleting UserScript for ${scriptId}:`, err);
            }

            // Pull expiry entry from Script.expiry[]
            try {
                await Script.updateOne(
                    { _id: scriptDocId },
                    { $pull: { expiry: { script_expiry_id: scriptExpiryId } } }
                );
                // console.log(`[EXPIRY ROLLOVER] Pulled expiry entry ${scriptExpiryId} from Script doc ${scriptDocId}`);
            } catch (err) {
                console.error(`[EXPIRY ROLLOVER] Error pulling expiry entry from Script ${scriptDocId}:`, err);
            }
        }

        // console.log(`[EXPIRY ROLLOVER] Completed for market ${marketId}.`);
    } catch (error) {
        console.error("Error in expiry rollover:", error);
    }
};


/**
 * Check if Fresh Limit is disabled for a specific user and market
 * @param {string} userId
 * @param {string} marketId
 * @returns {Promise<boolean>} - TRUE if disabled
 */
exports.checkFreshLimitDisabled = async (userId, marketId = null) => {
    try {
        const user = await User.findById(userId).select("marketAccess").lean();
        if (marketId && user?.marketAccess) {
            const market = user.marketAccess.find(m => String(m.marketId) === String(marketId));
            const fla = market?.other?.freshLimitAllowed;
            // If freshLimitAllowed is 0, false, "0", "false", "No" - it means disabled
            if (market && market.other && (fla === false || fla === 0 || fla === "0" || fla === "false" || fla === "No")) {
                return true;
            }
        }
        return false;
    } catch (e) {
        console.error("checkFreshLimitDisabled error:", e);
        return true; // Default to Disabled (safe) on error
    }
};

/**
 * Check if Fresh Limit is disabled anywhere in the parent hierarchy for a specific market
 * If any parent has freshLimitAllowed disabled for this market, all children cannot place fresh limits in that market
 * NOTE: Skips Super Admin (level 1) - hierarchy check stops before reaching Super Admin
 * @param {string} userId
 * @param {Array} parentIds - Optional: Array of parent IDs if already fetched
 * @param {string} marketId - REQUIRED: Market ID to check
 * @returns {Promise<boolean>} - TRUE if disabled in hierarchy for this market, FALSE if allowed
 */
exports.checkFreshLimitDisabledInHierarchy = async (userId, parentIds = null, marketId = null) => {
    try {
        if (!marketId) {
            console.warn(`[FRESH LIMIT HIERARCHY] No marketId provided for user ${userId}`);
            return false; // If no market specified, allow by default
        }

        // First check the user themselves for THIS specific market
        if (await exports.checkFreshLimitDisabled(userId, marketId)) {
            // console.log(`[FRESH LIMIT HIERARCHY] User ${userId} has fresh limit disabled for market ${marketId}`);
            return true;
        }

        // Get parentIds if not provided
        let parents = parentIds;
        if (!parents) {
            const user = await User.findById(userId).select("parentIds").lean();
            parents = user?.parentIds || [];
        }

        if (!parents || parents.length === 0) {
            // console.log(`[FRESH LIMIT HIERARCHY] User ${userId} has no parents`);
            return false;
        }

        // Convert ObjectIds to proper format for query
        const parentIdObjects = parents.map(p => {
            if (typeof p === 'object' && p._id) return p._id;
            return p;
        });

        // console.log(`[FRESH LIMIT HIERARCHY] Checking ${parentIdObjects.length} parents for user ${userId} in market ${marketId}`);

        // Fetch parent users with their account type levels to skip Super Admin (level 1)
        const parentUsers = await User.find({
            _id: { $in: parentIdObjects }
        })
            .select('_id accountType')
            .populate('accountType', 'level')
            .lean();

        // Check each parent individually for THIS specific market
        // Skip Super Admin (level 1)
        for (const parent of parentUsers) {
            const parentLevel = parent.accountType?.level;

            // Skip Super Admin (level 1)
            if (parentLevel === 1) {
                // console.log(`[FRESH LIMIT HIERARCHY] Skipping Super Admin ${parent._id} (level 1)`);
                continue;
            }

            if (await exports.checkFreshLimitDisabled(parent._id, marketId)) {
                // console.log(`[FRESH LIMIT HIERARCHY] Parent ${parent._id} (level ${parentLevel}) has fresh limit disabled for market ${marketId}`);
                return true;
            }
        }

        // console.log(`[FRESH LIMIT HIERARCHY] Fresh limit allowed for user ${userId} in market ${marketId}`);
        return false; // Allowed
    } catch (e) {
        console.error("checkFreshLimitDisabledInHierarchy error:", e);
        return true; // Default to Disabled (safe) on error
    }
};

/**
 * Check if a script is blocked for a specific user and market based on allow/block lists
 * @param {string} userId
 * @param {string} marketId
 * @param {string} scriptId
 * @param {string} label
 * @param {string} scriptName
 * @returns {Promise<{isBlocked: boolean, message?: string}>}
 */
exports.checkScriptBlocked = async (userId, marketId, scriptId, label, scriptName) => {
    try {
        const user = await User.findById(userId).select("marketAccess accountDetails").lean();

        if (!user) {
            // console.log(`[SCRIPT BLOCK CHECK] User ${userId} not found`);
            return { isBlocked: false };
        }

        // Check if user has permission to trade banned/blocked scripts
        const bandScriptAllow = user?.accountDetails?.bandScriptAllow === 1 || user?.accountDetails?.bandScriptAllow === "1";
        if (bandScriptAllow) {
            // console.log(`[SCRIPT BLOCK CHECK] User ${userId} has bandScriptAllow - bypassing restrictions`);
            return { isBlocked: false };
        }

        if (marketId && user?.marketAccess) {
            const market = user.marketAccess.find(m => String(m.marketId) === String(marketId));

            if (!market) {
                // console.log(`[SCRIPT BLOCK CHECK] User ${userId} - No market access for marketId ${marketId}`);
                return { isBlocked: false };
            }

            if (market && market.other) {
                const { allowOrBlock, allowScript, blockScript } = market.other;
                // console.log(`[SCRIPT BLOCK CHECK] User ${userId} - allowOrBlock: ${allowOrBlock}, allowScript: ${JSON.stringify(allowScript)}, blockScript: ${JSON.stringify(blockScript)}`);

                // Matcher function for strings or objects
                // Priority: Match against FULL identifiers (label/scriptId) first, then scriptName
                // This prevents "SILVER" from matching "SILVERM" or "SILVERMINI"
                const scriptMatches = (s, targetScriptId, targetLabel, targetScriptName) => {
                    if (!s) return false;

                    // Filter out empty strings
                    if (typeof s === 'string') {
                        const trimmed = s.trim();
                        if (!trimmed) return false;

                        // EXACT match only - no substring matching
                        const trimmedUpper = trimmed.toUpperCase();
                        const targetIdUpper = targetScriptId ? targetScriptId.toUpperCase().trim() : '';
                        const targetLabelUpper = targetLabel ? targetLabel.toUpperCase().trim() : '';
                        const targetNameUpper = targetScriptName ? targetScriptName.toUpperCase().trim() : '';

                        // PRIORITY: Match against label or scriptId first (full identifiers)
                        // Only match scriptName if label/scriptId are not available
                        if (targetLabelUpper && trimmedUpper === targetLabelUpper) return true;
                        if (targetIdUpper && trimmedUpper === targetIdUpper) return true;

                        // Fallback to scriptName only if no label/scriptId match
                        // This prevents base name collisions (SILVER vs SILVERM)
                        if (!targetLabelUpper && !targetIdUpper && targetNameUpper && trimmedUpper === targetNameUpper) {
                            return true;
                        }

                        return false;
                    }

                    // Handle object format: {scriptName: "ALUMINIUM", scriptId: "ALUMINIUM26APRFUT"}
                    if (typeof s === 'object') {
                        const sName = s.scriptName;
                        const sId = s.scriptId;

                        const targetIdUpper = targetScriptId ? targetScriptId.toUpperCase().trim() : '';
                        const targetLabelUpper = targetLabel ? targetLabel.toUpperCase().trim() : '';
                        const targetNameUpper = targetScriptName ? targetScriptName.toUpperCase().trim() : '';

                        // PRIORITY 1: Match by scriptId (full identifier - most specific)
                        if (sId) {
                            const sIdUpper = sId.toUpperCase().trim();

                            // Match against label or scriptId
                            if (targetLabelUpper && targetLabelUpper === sIdUpper) return true;
                            if (targetIdUpper && targetIdUpper === sIdUpper) return true;
                        }

                        // PRIORITY 2: Match by scriptName (base name - less specific)
                        // Only match if no scriptId was provided in the block config
                        // AND only match against label/scriptId if available, not base scriptName
                        if (sName && !sId) {
                            const sNameUpper = sName.toUpperCase().trim();

                            // Match against full identifiers (label/scriptId) to avoid base name collisions
                            if (targetLabelUpper && targetLabelUpper === sNameUpper) return true;
                            if (targetIdUpper && targetIdUpper === sNameUpper) return true;

                            // Only match against scriptName if no label/scriptId available
                            if (!targetLabelUpper && !targetIdUpper && targetNameUpper && targetNameUpper === sNameUpper) {
                                return true;
                            }
                        }
                    }

                    return false;
                };

                if (allowOrBlock === "allow") {
                    // If "allow" mode, only scripts in allowScript are permitted
                    // Filter out empty strings from allowScript
                    const validAllowScripts = (allowScript || []).filter(s => {
                        if (typeof s === 'string') return s.trim() !== '';
                        return s && (s.scriptId || s.scriptName);
                    });

                    // console.log(`[SCRIPT BLOCK CHECK] User ${userId} - ALLOW mode, validAllowScripts: ${JSON.stringify(validAllowScripts)}`);

                    // If no valid scripts in allow list, allow all (empty list = no restriction)
                    if (validAllowScripts.length === 0) {
                        // console.log(`[SCRIPT BLOCK CHECK] User ${userId} - Empty allow list, allowing all`);
                        return { isBlocked: false };
                    }

                    const isAllowed = validAllowScripts.some(s => {
                        const matches = scriptMatches(s, scriptId, label, scriptName);
                        if (typeof s === 'object') {
                            // console.log(`[SCRIPT BLOCK CHECK] Comparing: s.scriptName="${s.scriptName}", s.scriptId="${s.scriptId}" vs target scriptName="${scriptName}", label="${label}", scriptId="${scriptId}" => matches: ${matches}`);
                        }
                        return matches;
                    });

                    // console.log(`[SCRIPT BLOCK CHECK] User ${userId} - Script ${scriptId || label || scriptName} isAllowed: ${isAllowed}`);

                    if (!isAllowed) {
                        return {
                            isBlocked: true,
                            message: `Trading in ${label || scriptName} is not allowed for this market.`
                        };
                    }
                } else if (allowOrBlock === "block") {
                    // If "block" mode, scripts in blockScript are rejected
                    // Filter out empty strings from blockScript
                    const validBlockScripts = (blockScript || []).filter(s => {
                        if (typeof s === 'string') return s.trim() !== '';
                        return s && (s.scriptId || s.scriptName);
                    });

                    // console.log(`[SCRIPT BLOCK CHECK] User ${userId} - BLOCK mode, validBlockScripts: ${JSON.stringify(validBlockScripts)}`);

                    // If no valid scripts in block list, allow all (empty list = no restriction)
                    if (validBlockScripts.length === 0) {
                        // console.log(`[SCRIPT BLOCK CHECK] User ${userId} - Empty block list, allowing all`);
                        return { isBlocked: false };
                    }

                    const isBlocked = validBlockScripts.some(s => {
                        const matches = scriptMatches(s, scriptId, label, scriptName);
                        if (typeof s === 'object') {
                            // console.log(`[SCRIPT BLOCK CHECK] Comparing: s.scriptName="${s.scriptName}", s.scriptId="${s.scriptId}" vs target scriptName="${scriptName}", label="${label}", scriptId="${scriptId}" => matches: ${matches}`);
                        }
                        return matches;
                    });

                    // console.log(`[SCRIPT BLOCK CHECK] User ${userId} - Script ${scriptId || label || scriptName} isBlocked: ${isBlocked}`);

                    if (isBlocked) {
                        return {
                            isBlocked: true,
                            message: `Trading in ${label || scriptName} is blocked for this market.`
                        };
                    }
                }
            }
        }

        return { isBlocked: false };
    } catch (e) {
        console.error("checkScriptBlocked error:", e);
        return { isBlocked: true, message: "Error checking script permissions" };
    }
};

/**
 * Check if a script is blocked anywhere in the parent hierarchy
 * If any parent blocks a script or uses allow-list that excludes it, children cannot trade it
 * @param {string} userId
 * @param {Array} parentIds - Optional: Array of parent IDs if already fetched
 * @param {string} marketId
 * @param {string} scriptId
 * @param {string} label
 * @param {string} scriptName
 * @returns {Promise<{isBlocked: boolean, message?: string}>}
 */
exports.checkScriptBlockedInHierarchy = async (userId, parentIds = null, marketId, scriptId, label, scriptName) => {
    try {
        // First check the user themselves
        const userCheck = await exports.checkScriptBlocked(userId, marketId, scriptId, label, scriptName);
        if (userCheck.isBlocked) {
            return userCheck;
        }

        // Get parentIds if not provided
        let parents = parentIds;
        if (!parents) {
            const user = await User.findById(userId).select("parentIds").lean();
            parents = user?.parentIds || [];
        }

        if (!parents || parents.length === 0) {
            return { isBlocked: false };
        }

        // Convert ObjectIds to strings if needed
        const parentIdStrings = parents.map(p => {
            if (typeof p === 'object' && p._id) return p._id.toString();
            if (typeof p === 'object' && p.toString) return p.toString();
            return String(p);
        });


        // Check each parent in the hierarchy (from top to bottom)
        for (const parentId of parentIdStrings) {
            const parentCheck = await exports.checkScriptBlocked(parentId, marketId, scriptId, label, scriptName);
            if (parentCheck.isBlocked) {
                return {
                    isBlocked: true,
                    message: `${parentCheck.message} (Restricted by parent account)`
                };
            }
        }

        return { isBlocked: false };
    } catch (e) {
        console.error("checkScriptBlockedInHierarchy error:", e);
        return { isBlocked: true, message: "Error checking script permissions in hierarchy" };
    }
};
