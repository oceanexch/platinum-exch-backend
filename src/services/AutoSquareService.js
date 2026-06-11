/**
 * Auto Square-Off Service
 * Handles automatic position closing when M2M limits are hit
 */

const { getSingleStockData } = require("./RedisService");
const { saveTransaction } = require("./StockService");
const { setUserPosition, updateUserQuantity, getUserQuantity } = require("./StockService");
const { StockTransactionEvent, DashboardStockEvent } = require("./RedisStockService");
const MonitorService = require("./MonitorService");
const M2MService = require("./M2MService");
const UserScript = require("../models/UserScriptModel");
const { redisClient } = require("../config/redis");
const { getTimeByMarket, getHolidayByFilter } = require("./SettingService");

/**
 * Get user details for auto square-off
 */
const getUserDetailsForSquareOff = async (userId) => {
    const UserModel = require("../models/UserModel");

    const user = await UserModel.findById(userId)
        .select({
            basicDetails: 1,
            accountDetails: 1,
            partnership: 1,
            parentIds: 1,
            createdBy: 1,
            marketAccess: 1,
            loginIP: 1
        })
        .populate({
            path: "parentIds",
            select: "accountCode marketAccess"
        })
        .lean();

    return user;
};

/**
 * Get expiry from label
 */
const getExpiry = (label) => {
    if (!label) return "";
    const parts = label.split(" ");
    return parts[parts.length - 1] || "";
};

const squareOffLocks = new Set();

/**
 * Execute auto square-off for all positions in a market group
 */
const executeAutoSquareOff = async (userId, valanId, marketGroup, reason) => {
    const lockKey = `${userId}:${marketGroup}`;
    const redisLockKey = `sq_off_lock:${userId}:${marketGroup}`;

    try {
        const isLocked = await redisClient.get(redisLockKey);

        if (isLocked === "true" || squareOffLocks.has(lockKey)) {
            return { success: true, squaredPositions: 0, inProgress: true };
        }

        // Set lock with 5 minute expiration as a safety net
        await redisClient.setex(redisLockKey, 300, "true");
        squareOffLocks.add(lockKey);

        // Get user details
        const user = await getUserDetailsForSquareOff(userId);
        if (!user) {
            throw new Error(`User ${userId} not found`);
        }

        // Get all open positions for this market group
        const marketIds = M2MService.MARKET_GROUPS[marketGroup];
        const positions = await M2MService.getUserPositionsByMarketGroup(userId, valanId, marketIds || marketGroup);

        if (!positions || positions.length === 0) {
            return { success: true, squaredPositions: 0 };
        }



        let squaredCount = 0;
        const errors = [];

        // Skip all if entire market group is closed (timing)
        const allMarketsClosed = await areAllMarketsClosedForSquareOff(marketIds);

        // Process each position
        for (const position of positions) {
            try {
                if (allMarketsClosed) continue;

                // Skip only this position if its specific market is on holiday
                const nowTs = moment().valueOf();
                const onHoliday = await getHolidayByFilter({
                    marketId: position.marketId,
                    startDate: { $lte: nowTs },
                    endDate: { $gte: nowTs }
                });
                if (onHoliday) continue;

                const result = await squareOffPosition(position, user, valanId, reason);
                if (result) squaredCount++;
            } catch (error) {
                console.error(`[AUTO SQUARE-OFF] Error squaring position ${position.scriptId}:`, error);
                errors.push({
                    scriptId: position.scriptId,
                    error: error.message
                });
            }
        }


        // Invalidate M2M cache immediately after square-off to prevent repeated triggers
        // We pass false to NOT clear alert states, avoiding redundant notifications in M2MWatcher
        await M2MService.invalidateM2MCache(userId, valanId, false);



        return {
            success: true,
            squaredPositions: squaredCount,
            totalPositions: positions.length,
            errors: errors.length > 0 ? errors : undefined
        };
    } catch (error) {
        console.error("[AUTO SQUARE-OFF] Fatal error:", error);
        throw error;
    } finally {
        await redisClient.del(redisLockKey);
        squareOffLocks.delete(lockKey);
    }
};

const moment = require("moment");

/**
 * Check if a market is currently open for auto square-off
 */
const isMarketOpenForSquareOff = async (marketId) => {
    const { getTimeByMarket } = require("./SettingService");
    const getMarketTime = await getTimeByMarket(marketId);

    if (!getMarketTime) return true; // Fallback to allowed if no settings at all

    const now = moment().valueOf();
    const currentDate = moment().format("YYYY-MM-DD");

    const marketOpen = moment(`${currentDate} ${getMarketTime.marketStartTime}`, "YYYY-MM-DD HH:mm:ss").valueOf();
    const marketClose = moment(`${currentDate} ${getMarketTime.marketEndTime}`, "YYYY-MM-DD HH:mm:ss").valueOf();

    return now >= marketOpen && now <= marketClose;
};

// All markets in the group must be closed (timing) before we skip square-off
const areAllMarketsClosedForSquareOff = async (marketIds) => {
    if (!marketIds || marketIds.length === 0) return false;
    for (const marketId of marketIds) {
        if (await isMarketOpenForSquareOff(marketId)) return false;
    }
    return true;
};

/**
 * Square off a single position
 * @param {Object} position - Position to square off
 * @param {Object} user - User object
 * @param {String} valanId - Valan ID
 * @param {String} reason - Reason for square off (e.g., "M2M Loss", "M2M Profit")
 */
const squareOffPosition = async (position, user, valanId, reason) => {
    const netQty = position.buyQuantity - position.sellQuantity;

    if (netQty === 0) {
        return;
    }

    // Determine square-off transaction type and quantity
    const transactionType = netQty > 0 ? 'SELL' : 'BUY';
    const quantity = Math.abs(netQty);

    // Get live price with fallback for normalized keys (-I, -II)
    const symbolKey = position.scriptId.toUpperCase();
    let redisData = await getSingleStockData(symbolKey);

    // Fallback: Try normalized key if direct lookup fails
    if (!redisData) {
        const normalizedKey = symbolKey.replace(/-I+$/, "").replace(/-II+$/, "");
        if (normalizedKey !== symbolKey) {
            redisData = await getSingleStockData(normalizedKey);
        }
    }

    let price = 0;
    if (redisData) {
        try {
            const parsed = typeof redisData === 'string' ? JSON.parse(redisData) : redisData;

            // If we have a BUY position (netQty > 0), we need to SELL to close it using the BID price (BuyPrice)
            // If we have a SELL position (netQty < 0), we need to BUY to close it using the ASK price (SellPrice)
            if (transactionType === 'SELL') { // Closing a Buy position
                price = parsed.BuyPrice || parsed.LastTradePrice;
            } else { // Closing a Sell position (transactionType === 'BUY')
                price = parsed.SellPrice || parsed.LastTradePrice;
            }

            if (!price) price = parsed.Ltp || 0;
        } catch (e) {
            console.error(`[AUTO SQUARE-OFF] Error parsing price for ${symbolKey}:`, e);
        }
    }

    // Fallback to average entry price if live price is missing
    if (!price || price <= 0) {
        if (netQty > 0 && position.buyQuantity > 0) {
            price = position.buyPrice / position.buyQuantity;
        } else if (netQty < 0 && position.sellQuantity > 0) {
            price = position.sellPrice / position.sellQuantity;
        }

        if (price > 0) {
            console.warn(`[AUTO SQUARE-OFF] Using average entry price fallback for ${position.scriptId}: ${price}`);
        }
    }

    if (!price || price <= 0) {
        throw new Error(`Invalid price for ${position.scriptId}`);
    }

    // Get market access for this market
    const marketAccess = user.marketAccess.find(m => m.marketId === position.marketId);
    if (!marketAccess) {
        throw new Error(`Market access not found for market ${position.marketId}`);
    }

    // Use the net lot from the position
    // This represents the number of trading lots to close
    const lot = Math.abs(position.buyLot - position.sellLot);
    const totalOrderPrice = quantity * price;

    // Get broker IDs
    const brokerIds = user.basicDetails?.brokerPartnership?.map(b => b.broker._id) || [];

    // Prepare parent details
    const parentIds = user.parentIds?.map(p => p._id) || [];
    const myParent = user.createdBy?.userId;

    // Calculate brokerage for auto square-off
    const BrokerageService = require("./BrokerageService");
    
    const brokerageReqData = {
        userId: user._id,
        marketId: position.marketId,
        marketName: position.marketName,
        scriptId: position.scriptId,
        scriptName: position.scriptName,
        label: position.label,
        quantity,
        transactionType,
        lot,
        price,
        type: 'AUTO_SQ',
        orderType: 'Market',
        message: 'Auto Close',
        isExecution: true // Treat as execution to ensure brokerage is calculated
    };

    const brokerageServices = {
        getMarket: marketAccess,
        basicDetails: user.basicDetails
    };

    let brokerageResult;
    try {
        brokerageResult = await BrokerageService.calculateBrokerage(brokerageReqData, brokerageServices);
    } catch (error) {
        console.error(`[AUTO SQUARE-OFF] Error calculating brokerage for ${position.scriptId}:`, error);
        // Fallback to zero brokerage if calculation fails
        brokerageResult = {
            netPrice: price,
            totalNetPrice: totalOrderPrice,
            orderBrokerage: 0,
            netBrokerage: 0,
            brokeragePercentage: 0,
            m2mPrice: totalOrderPrice,
            otherBrokerage: { totalOrderBrokerage: 0, totalBrokerPercentage: 0, brockersBrokerage: [] },
            brokerTotalPercentage: 0,
            brokeragePercentageType: { intraday: 0, delivery: 0 },
            brokerTotalBrokerage: 0,
            totalOrderPrice,
            orderPrice: price,
            quantityType: { intraday: quantity, delivery: 0 }
        };
    }

    // Determine if this is M2M square off and format message accordingly
    let message, shortmsg;
    
    // Check if reason contains loss or profit keywords (case-insensitive)
    const reasonLower = (reason || '').toLowerCase();
    const isM2MSquareOff = reasonLower.includes('loss') || reasonLower.includes('profit');
    
    if (isM2MSquareOff) {
      // Determine if it's profit or loss based on the reason
      const isProfitSquareOff = reasonLower.includes('profit');
      const profitOrLoss = isProfitSquareOff ? 'Profit' : 'Loss';
      message = `Exit m2m (${profitOrLoss})`;
      shortmsg = `Exit m2m (${profitOrLoss})`;
    } else {
      message = `Auto square-off (${reason})`;
      shortmsg = 'Auto sq (Market)';
    }

    // Create square-off transaction with calculated brokerage
    const stock = {
        userId: user._id,
        marketId: position.marketId,
        marketName: position.marketName,
        scriptId: position.scriptId,
        scriptName: position.scriptName,
        label: position.label,
        lot,
        quantity,
        price,
        transactionType,
        orderType: 'Market',
        valanId,
        expiry: getExpiry(position.label),
        ip: user.loginIP || '0.0.0.0', // User's last known IP
        userAgent: 'AUTO_SQUARE_OFF_SYSTEM',
        message,
        shortmsg,
        transactionStatus: 'COMPLETED',
        type: 'AUTO_SQ',
        createdBy: user._id, // User being squared off is the creator of this auto-trade

        // Brokerage fields from calculation
        orderBrokerage: brokerageResult.orderBrokerage,
        netBrokerage: brokerageResult.netBrokerage,
        netPrice: brokerageResult.netPrice,
        totalNetPrice: brokerageResult.totalNetPrice,
        brokeragePercentage: brokerageResult.brokeragePercentage,
        brokerTotalPercentage: brokerageResult.brokerTotalPercentage,
        brokeragePercentageType: brokerageResult.brokeragePercentageType,
        brokerTotalBrokerage: brokerageResult.brokerTotalBrokerage,
        m2mPrice: brokerageResult.m2mPrice,
        totalOrderPrice: brokerageResult.totalOrderPrice,
        orderPrice: brokerageResult.orderPrice,
        quantityType: brokerageResult.quantityType,
        otherBrokerage: brokerageResult.otherBrokerage?.brockersBrokerage || [],

        // Parent/Broker details
        parentIds,
        myParent,
        brokerIds,
        partnership: user.partnership || [],
        minPercentageWiseBrokerage: [],
        minLotWiseBrokerage: [],

        // Auto square-off metadata
        autoSquareOffReason: reason,
        isAutoSquareOff: true
    };

    // Save transaction
    const savedStock = await saveTransaction(stock);

    // Update user position
    const isEqualQty = true; // Position should be squared after this
    await setUserPosition(user._id, position.scriptId, valanId, isEqualQty);

    // Update user quantity
    const checkQuantity = await getUserQuantity({
        userId: user._id,
        marketId: position.marketId,
        marketName: position.marketName,
        scriptId: position.scriptId,
        scriptName: position.scriptName,
        quantity,
        transactionType
    });

    await updateUserQuantity(
        { userId: user._id },
        { previous: checkQuantity.previous, current: checkQuantity.current }
    );

    // Emit events
    try {
        let userScript = await UserScript.findOne({
            createdBy: user._id,
            scriptId: position.scriptId,
            label: position.label
        }).lean();

        // Fallback: search by scriptId only if label match fails
        if (!userScript) {
            userScript = await UserScript.findOne({
                createdBy: user._id,
                scriptId: position.scriptId
            }).lean();
            if (userScript) {
                console.warn(`[AUTO SQUARE-OFF] UserScript fallback for ${position.scriptId} due to label mismatch`);
            }
        }

        StockTransactionEvent({
            userId: user._id,
            parentIds,
            marketId: position.marketId,
            scriptId: position.scriptId,
            transactionType,
            valanId,
            userScriptId: userScript?._id || null,
            price,
            quantity,
            orderType: 'Market',
            status: 'COMPLETED',
            _id: savedStock._id,
            label: position.label,
            scriptName: position.scriptName
        });

        DashboardStockEvent({
            userId: user._id,
            parentIds,
            marketId: position.marketId,
            scriptId: position.scriptId,
            transactionType,
            valanId,
            userScriptId: userScript?._id || null,
            lot,
            quantity,
            orderType: 'Market',
            price,
            status: 'COMPLETED',
            _id: savedStock._id,
            label: position.label,
            scriptName: position.scriptName
        });
    } catch (eventError) {
        console.error("[AUTO SQUARE-OFF] Error emitting events:", eventError);
        // Don't throw - transaction is already saved
    }

    // 🔔 Monitor: notify watchers of auto square-off (fire-and-forget)
    MonitorService.notifyWatchers(user._id, 'SQUARE_OFF', {
        loginUserId: user._id,
        ip: user.loginIP || '—',
        device: 'AUTO_SQUARE_OFF_SYSTEM',
        parentIds: (user.parentIds || []).map(p => (p && p._id) ? p._id : p),
        label: position.label,
        transactionType,
        lot,
        quantity,
        price,
        marketName: position.marketName,
        marketId: position.marketId,
        orderType: 'Market',
        reason: message,
        time: new Date()
    }).catch(() => { });

    return savedStock;
};

module.exports = {
    executeAutoSquareOff,
    squareOffPosition
};
