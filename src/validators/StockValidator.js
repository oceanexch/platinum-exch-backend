const moment = require("moment");
const mongoose = require("mongoose");
const { saveLog } = require("../services/LogService");
const quantitySetting = require("../models/QuantitySettingModel");
const ScriptFroze = require("../models/ScriptFrozeModel");
const UserPosition = require("../models/UserPositionModel");
const WeekValanModel = require("../models/WeekValanModel");
const StockTransaction = require("../models/StockTransactionModel");
const UserModel = require("../models/UserModel");
const LotSettingModel = require("../models/LotSettingModel");
const { getHolidayByFilter, getTimeByMarket, getFilterLimitDisable, getFilterExpiries } = require("../services/SettingService");
const { isScriptBanned } = require("../services/NSEBanService");
const { checkBannedScript, checkLimitSLDisabled, checkLimitSLDisabledInHierarchy, checkShortSellDisabledInHierarchy, checkFreshLimitDisabledInHierarchy, checkScriptBlockedInHierarchy } = require("../services/MarketOperationsService");
const { redisClient } = require("../services/RedisService");
const { getBaseScriptName } = require("../utils/StockUtils"); // Imported from Utils
const { MARKET_IDS } = require("../config/marketConstants");

// Lazy load StockService inside functions to avoid circular dependency

// Helper to convert time "HH:mm:ss" to timestamp
const convertTime = (time) => {
    const currentDate = moment().format("YYYY-MM-DD");
    const dateTimeStr = `${currentDate} ${time}`;
    return moment(dateTimeStr, "YYYY-MM-DD HH:mm:ss").valueOf();
};

const CommonStockValidator = {
    async validateBasicRules(reqData, services) {
        const {
            userId,
            marketId,
            scriptName,
            price,
            transactionType,
            createdBy,
            userIp,
            label,
            scriptId
        } = reqData;

        const { basicDetails, accountDetails } = services;


        const rejectionLog = {
            action: "INS",
            clientId: userId,
            marketId,
            scriptId,
            symbol: label,
            order_type: reqData.orderType,
            lot: reqData.lot,
            qty: reqData.quantity,
            order_price: price,
            message: "",
            ip: userIp,
            time: new Date(),
            parentIds: services.parentIds,
            txn_type: transactionType,
        };

        // 1. Price > 0
        if (price <= 0) {
            return { isValid: false, message: "Price must be greater than 0", log: rejectionLog };
        }

        // 2. Ban Period Check (NSE)
        if (await isScriptBanned(scriptName) && !await checkBannedScript(userId, scriptName)) {
            return { isValid: false, message: "Script is in Ban Period. Trading is not allowed.", log: rejectionLog };
        }

        // 3. View Only Access
        const isSelfTrade = createdBy.toString() === userId.toString();
        const viewOnly = (basicDetails?.viewOnlyAccess == 1 || basicDetails?.viewOnlyAccess === "1");

        if (isSelfTrade && viewOnly) {
            return { isValid: false, message: "Self trading is not allowed.", log: rejectionLog, statusCode: 403 };
        }

        // 5. Decimal Quantity Check
        const quantity = Number(reqData.quantity);
        if (!Number.isInteger(quantity)) {
            const { Script } = require("../models/MarketTypeModel");
            const baseScriptName = getBaseScriptName(scriptName || scriptId);

            const script = await Script.findOne({
                $or: [
                    { script_name: baseScriptName },
                    { script_id: scriptId }
                ]
            }).lean();

            if (!script || script.dacimal !== true) {
                return {
                    isValid: false,
                    message: `Trading in decimal quantities is not allowed for ${baseScriptName}. Only whole numbers allowed.`,
                    log: rejectionLog
                };
            }
        }

        // Lot/Qty consistency validation
        const lotDoc = await LotSettingModel.findOne({
            marketId: String(marketId),
            scriptName: String(scriptName || '').toUpperCase()
        }).lean();

        let lotSize = lotDoc ? Number(lotDoc.quantity) : 0;

        if (!lotSize) {
            const { Script } = require("../models/MarketTypeModel");
            const scriptDoc = await Script.findOne({ script_id: String(scriptId) }).select("lot_size").lean();
            if (scriptDoc && scriptDoc.lot_size > 0) lotSize = scriptDoc.lot_size;
        }

        if (lotSize > 0) {
            const tradeLot = Number(reqData.lot);
            const tradeQty = Number(reqData.quantity);
            if (tradeLot > 0) {
                const roundedLot = Math.round(tradeLot * 10000) / 10000;
                const expectedQty = Math.round(roundedLot * lotSize);
                if (Math.abs(tradeQty - expectedQty) > 0.5) {
                    return {
                        isValid: false,
                        message: `Invalid lot/qty: ${roundedLot} lot × ${lotSize} (lot size) = ${expectedQty} qty expected, but received ${tradeQty} qty.`,
                        log: rejectionLog
                    };
                }
            }
        }

        return { isValid: true };
    },

    /**
     * Validate that trading is allowed for a given script based on its expiry tradeEndDate.
     * If today is past the tradeEndDate, only squareoff of existing positions is allowed.
     *
     * Lookup strategy (two-step):
     *   1. Try exact match by scriptId
     *   2. Fallback: match by scriptName + expiryDate extracted from label/expiryDate field
     *      (handles cases where the expiry collection stores a different scriptId format)
     *
     * @param {Object} reqData  - Trade request data
     * @param {Object} services - Services object (must include getValan)
     * @returns {{ isValid: boolean, message?: string }}
     */
    /**
     * Validate that trading is allowed for a given script based on its expiry tradeEndDate.
     * If today is past the tradeEndDate, only squareoff of existing positions is allowed.
     */
    /**
     * Validate that trading is allowed for a given script based on its expiry tradeEndDate.
     * If today is past the tradeEndDate, only squareoff of existing positions is allowed.
     */
    async validateExpiryStatus(reqData, services) {
        const { scriptId, scriptName, label, marketId } = reqData;
        //// console.log("reqData", reqData);

        // 1. Skip expiry check for NSE-EQ (12)
        if (String(marketId) === "12") {
            return { isValid: true };
        }


        const incomingExpiryStr = String(reqData.expiryDate || reqData.expiry || "");
        if (!incomingExpiryStr) {
            return { isValid: false, message: "Expiry date is missing in the trade request." };
        }

        // 2. Normalize incoming expiry string into the DB target format (YYYY-MM-DD)
        const dateFormats = [
            "DDMMMYYYY", "DD-MMM-YYYY", "YYYY-MM-DD", "DD-MM-YYYY",
            "D-M-YYYY", "DD-M-YYYY", "D-MM-YYYY",
            "DD-MM", "D-M", "DD-MMM", "D-MMM"
        ];

        const m = moment(incomingExpiryStr, dateFormats, true);
        if (!m.isValid()) {
            return { isValid: false, message: `Invalid expiry format: ${incomingExpiryStr}` };
        }
        const targetExpiry = m.format("YYYY-MM-DD");

        // 3. Lookup candidate records for this script
        let candidates = [];
        if (scriptId) candidates = await getFilterExpiries({ scriptId, marketId });

        if ((!candidates || candidates.length === 0) && scriptName) {
            candidates = await getFilterExpiries({ scriptName, marketId });
        }
        if (String(marketId) === "2") {
            candidates = await getFilterExpiries({ marketId: "2", scriptName: "ALL" });
        }
        if (String(marketId) === "3") {
            // For NOPT, we use deduplicated records stored under scriptName (e.g. NIFTY)
            candidates = await getFilterExpiries({ marketId: "3", scriptName: scriptName });
        }
        // 4. Match against actualExpiry field
        const specificRecord = candidates.find(e => e.actualExpiry === targetExpiry);

        if (!specificRecord) {
            return {
                isValid: false,
                message: `Trading in ${label || scriptName} is not allowed. No active expiry configuration found for ${targetExpiry} (Request: ${incomingExpiryStr}).`
            };
        }

        // Validation successful based on record match
        return { isValid: true };
    },

    async validateMarginLimits(reqData, services, excludeTradeId = null) {
        const { userId, marketId, lot, price, quantity, transactionType, scriptId, scriptName } = reqData;
        const { getValan } = services;

        const totalOrderPrice = quantity * price;

        // Use MarginService for comprehensive margin validation
        const MarginService = require("../services/MarginService");

        // Check margin availability (includes both COMPLETED and PENDING trades, with hedging support)
        const marginCheck = await MarginService.checkMarginAvailability(
            userId,
            marketId,
            getValan._id,
            lot,
            totalOrderPrice,
            transactionType,
            scriptId,
            quantity,
            excludeTradeId,
            scriptName
        );

        if (!marginCheck.canTrade) {
            return {
                isValid: false,
                message: marginCheck.message,
                details: marginCheck.details
            };
        }

        return { isValid: true };
    },

    /**
     * Validate Position Square-Off restrictions
     * If onlyPositionSquareOff is enabled, user can only exit positions, not create or increase them
     */
    async validatePositionSquareOff(reqData, services) {
        const { userId, scriptId, transactionType, quantity } = reqData;
        const { accountDetails, getValan } = services;

        // Skip if position square-off is not enabled
        if (accountDetails?.onlyPositionSquareOff !== 1) {
            return { isValid: true };
        }

        // Lazy load getUserPosition
        const { getUserPosition } = require("../services/StockService");

        // Get current position for this script
        const positions = await getUserPosition({
            userId,
            scriptId,
            valanId: getValan._id
        });

        // No existing position - block trade
        if (!positions || positions.length === 0) {
            return {
                isValid: false,
                message: "Only position square-off allowed. Cannot create new position."
            };
        }

        const [position] = positions;
        const netQuantity = position.buyQuantity - position.sellQuantity;

        // Check if this trade would increase the position
        const isIncreasingPosition =
            (netQuantity > 0 && transactionType === 'BUY') ||  // Long position, buying more
            (netQuantity < 0 && transactionType === 'SELL');   // Short position, selling more

        if (isIncreasingPosition) {
            return {
                isValid: false,
                message: "Only position square-off allowed. Cannot increase existing position."
            };
        }

        // Check if trying to square off more than position
        const oppositeQty = transactionType === 'BUY' ? position.sellQuantity : position.buyQuantity;
        const sameQty = transactionType === 'BUY' ? position.buyQuantity : position.sellQuantity;

        if (quantity > Math.abs(netQuantity)) {
            return {
                isValid: false,
                message: `Cannot square-off more than existing position. Current net position: ${Math.abs(netQuantity)}`
            };
        }

        return { isValid: true };
    },

    /**
     * Validate M2M (Mark-to-Market) Profit/Loss Limits
     * Checks if user has exceeded configured profit or loss limits
     * Triggers auto square-off if enabled
     */
    async validateM2MLimits(reqData, services) {
        const { userId, marketId, quantity } = reqData;
        const { accountDetails, getValan } = services;

        // Lazy load M2M service
        const M2MService = require("../services/M2MService");

        // Use the consolidated limit status check
        // NOTE: calculateUserM2M strictly uses COMPLETED positions, excluding PENDING limit trades as requested.
        const m2mStatus = await M2MService.checkM2MLimitStatus(userId, getValan._id, marketId, accountDetails);

        if (m2mStatus.isHit) {
            // Check if this is a position-reducing trade (always allow square-off/release margin)
            const reductionInfo = await this.getPositionReductionInfo(reqData, services);

            if (reductionInfo.isReducing) {
                // If it's reducing, we must ensure it doesn't exceed the existing position quantity
                // (i.e., user can't square-off 200 qty if they only have 100 qty)
                if (quantity > reductionInfo.maxReducibleQty) {
                    return {
                        isValid: false,
                        message: `${m2mStatus.message}. You can only square-off up to your existing position (${reductionInfo.maxReducibleQty}).`
                    };
                }
                return { isValid: true };
            }

            // Trigger auto square-off if enabled
            if (m2mStatus.autoSquare) {
                const marketGroup = M2MService.getMarketGroup(marketId);
                this.triggerAutoSquareOff(userId, getValan._id, marketGroup, m2mStatus.type).catch(err => {
                    console.error("Error triggering auto square-off:", err);
                });
            }

            return {
                isValid: false,
                message: `${m2mStatus.message}. Only square-off trades are allowed in this market group.`
            };
        }

        return { isValid: true };
    },

    /**
     * Get information about how much a trade reduces an existing position
     */
    async getPositionReductionInfo(reqData, services) {
        const { userId, scriptId, transactionType, marketId, label, scriptName } = reqData;
        const { getValan } = services;

        // Lazy Load
        const { getUserPosition } = require("../services/StockService");
        const sId = String(scriptId);
        const sLabel = String(label || reqData.label || "");
        const sName = String(scriptName || reqData.scriptName || "");

        // Fetch all matching positions for robustness (handles multiple identifier possibilities)
        const positions = await getUserPosition({
            userId,
            valanId: getValan._id,
            marketId: String(marketId),
            $or: [
                { scriptId: sId },
                { label: sLabel },
                { scriptName: sName }
            ]
        });

        if (!positions || positions.length === 0) {
            return { isReducing: false, maxReducibleQty: 0 };
        }

        // Sum quantities from all matching position rows for robustness
        let totalBuyQty = 0;
        let totalSellQty = 0;
        positions.forEach(pos => {
            totalBuyQty += Number(pos.buyQuantity) || 0;
            totalSellQty += Number(pos.sellQuantity) || 0;
        });

        const netQty = totalBuyQty - totalSellQty;

        const isReducing = (netQty > 0 && transactionType === 'SELL') || (netQty < 0 && transactionType === 'BUY');

        return {
            isReducing,
            maxReducibleQty: Math.abs(netQty)
        };
    },

    /**
     * Validate Short Sell restriction
     * If shortSellAllowed is disabled, user can only sell if they hold a BUY position.
     * Total SELL quantity (current + pending) cannot exceed net BUY position.
     */
    async validateShortSellAllowed(reqData, services) {
        const { userId, scriptId, transactionType, quantity, marketId, label, scriptName } = reqData;
        const { getValan, getMarket } = services;

        // Only apply to NOPT market (marketId 3)
        if (String(marketId) !== '3') {
            return { isValid: true };
        }

        // Skip if it's a BUY order
        if (transactionType !== 'SELL') {
            return { isValid: true };
        }

        const isShortSellDisabled = await checkShortSellDisabledInHierarchy(userId, null, marketId);

        // If shortSellAllowed is disabled in hierarchy
        if (isShortSellDisabled) {
            const { getUserPendingQuantity } = require("../services/StockService");

            // 1. Get net reduction info (current position)
            const reductionInfo = await this.getPositionReductionInfo(reqData, services);

            // If net position is NOT a Net BUY, any SELL is a new short/increase short
            if (!reductionInfo.isReducing || reductionInfo.maxReducibleQty <= 0) {
                return {
                    isValid: false,
                    message: "Short selling is not allowed in this market. You can only sell to exit an existing buy position."
                };
            }

            // 2. Fetch pending SELL orders to prevent over-selling
            const uId = new mongoose.Types.ObjectId(userId);
            const vId = new mongoose.Types.ObjectId(getValan._id);
            const sId = String(scriptId);
            const sLabel = String(label || "");
            const sName = String(scriptName || "");

            const pendingOrders = await getUserPendingQuantity({
                userId: uId,
                valanId: vId,
                transactionStatus: "PENDING"
            });

            const pendingSellList = (pendingOrders || []).filter(res => {
                const isMatch = String(res._id?.scriptId) === sId ||
                    String(res.lastTransaction?.label) === sLabel ||
                    String(res.lastTransaction?.scriptName) === sName ||
                    String(res.lastTransaction?.symbol) === sId;
                return isMatch;
            });

            let pendingSellQty = 0;
            pendingSellList.forEach(res => {
                pendingSellQty += Number(res.SELL_QTY) || 0;
            });

            const totalSellAttempted = Number(quantity) + Number(pendingSellQty);

            if (totalSellAttempted > reductionInfo.maxReducibleQty) {
                const availableToSell = Math.max(0, reductionInfo.maxReducibleQty - pendingSellQty);

                // Get lot size for a more user-friendly message if possible
                const lotSetting = await LotSettingModel.findOne({ marketId: String(marketId), scriptName: String(scriptName || '').toUpperCase() }).lean();
                const lotSize = Number(lotSetting?.quantity) || 1;

                const maxLots = (reductionInfo.maxReducibleQty / lotSize);
                const availableLots = (availableToSell / lotSize);

                if (pendingSellQty > 0) {
                    return {
                        isValid: false,
                        message: `Short selling not allowed. You have ${maxLots} lots buy position, with ${pendingSellQty / lotSize} lots already pending in sell limits. Available to sell: ${availableLots} lots.`
                    };
                } else {
                    return {
                        isValid: false,
                        message: `Short selling not allowed. You can only sell up to your existing buy position of ${maxLots} lots.`
                    };
                }
            }
        }

        return { isValid: true };
    },

    /**
     * @deprecated Use getPositionReductionInfo instead
     */
    async isPositionReducingTrade(reqData, services) {
        const info = await this.getPositionReductionInfo(reqData, services);
        return info.isReducing;
    },

    /**
     * Trigger auto square-off for all positions in a market group
     * This runs asynchronously and doesn't block the validation
     */
    async triggerAutoSquareOff(userId, valanId, marketGroup, reason) {
        try {
            //// console.log(`[AUTO SQUARE-OFF] Triggered for user ${userId}, market group: ${marketGroup}, reason: ${reason}`);

            // Lazy load services
            const M2MService = require("../services/M2MService");
            const AutoSquareService = require("../services/AutoSquareService");

            // Execute auto square-off
            await AutoSquareService.executeAutoSquareOff(userId, valanId, marketGroup, reason);

            // Invalidate M2M cache without clearing alert states to prevent redundant notifications
            await M2MService.invalidateM2MCache(userId, valanId, false);

            //// console.log(`[AUTO SQUARE-OFF] Completed for user ${userId}`);
        } catch (error) {
            console.error("[AUTO SQUARE-OFF] Error:", error);
            throw error;
        }
    },

    async validateStaleData(scriptId, lookupKey) {
        const stalenessConfig = await ScriptFroze.findOne({
            scriptId,
            isEnabled: true,
        }).lean();

        if (stalenessConfig) {
            const lastTick = await redisClient.get(`last_tick:${lookupKey}`);

            if (!lastTick) {
                return { isValid: false, message: "Market data not available yet. Trading paused." };
            }

            const diff = Date.now() - parseInt(lastTick);
            const timeoutMs = stalenessConfig.timeoutSeconds * 1000;

            if (diff > timeoutMs) {
                return {
                    isValid: false,
                    message: `Market data is stale (last update ${Math.round(diff / 1000)}s ago). Trading paused.`
                };
            }
        }
        return { isValid: true };
    },

    async validateMarketStatus(reqData, services) {
        const marketId = typeof reqData === 'object' ? reqData.marketId : reqData;
        const currentTime = moment().valueOf();
        const currentDate = moment().format('YYYY-MM-DD');
        const isFullReqData = typeof reqData === 'object' && services;
        const orderType = isFullReqData ? (reqData.orderType || 'Market') : 'Market';

        // 1. Holiday Check (Enhanced for Half-Day Holidays)
        const checkHoliday = await getHolidayByFilter({
            marketId: String(marketId),
            startDate: { $lte: currentTime },
            endDate: { $gte: currentTime },
        });

        if (checkHoliday) {
            const hStart = moment(checkHoliday.startDate);
            const hEnd = moment(checkHoliday.endDate);
            
            // Check if start and end are on the same day
            const isSameDay = hStart.format("YYYY-MM-DD") === hEnd.format("YYYY-MM-DD");
            
            // Check if end time is not 23:59:59 (indicating partial day closure)
            const isPartialDay = hEnd.format("HH:mm:ss") !== "23:59:59";
            
            // Half-day holiday: same day + ends before midnight
            const isHalfDay = isSameDay && isPartialDay;
            
            if (isHalfDay) {
                // Market is closed during the holiday window, will open after endDate
                const reopenTime = moment(hEnd).add(1, 'second');
                return { 
                    isValid: false, 
                    message: `Market Closed until ${reopenTime.format("hh:mm A")} - ${checkHoliday.holiday}` 
                };
            } else {
                // Full-day holiday
                return { 
                    isValid: false, 
                    message: `Market Closed due to ${checkHoliday.holiday}` 
                };
            }
        }

        // 2. LimitDisable Check (Admin-controlled per-day, per-segment setting)
        console.log(`[LIMIT-DEBUG][FilterLimitDisable] Checking marketId=${marketId} date=${currentDate} orderType=${orderType} userId=${reqData.userId}`);
        const limitDisableRecord = await getFilterLimitDisable({ marketId, date: currentDate });
        console.log(`[LIMIT-DEBUG][FilterLimitDisable] Record: ${limitDisableRecord ? JSON.stringify(limitDisableRecord) : 'none'}`);

        if (limitDisableRecord) {
            const isLimitOrder = ['Limit', 'SL', 'Stop Loss'].includes(orderType);
            const isSquareOffOnly = limitDisableRecord.onlySquareOff === 'Yes';
            console.log(`[LIMIT-DEBUG][FilterLimitDisable] isLimitOrder=${isLimitOrder} isSquareOffOnly=${isSquareOffOnly}`);

            // Always block Limit/SL orders when LimitDisable is set
            if (isLimitOrder) {
                console.log(`[LIMIT-DEBUG][FilterLimitDisable] BLOCKED Limit/SL — marketId=${marketId} userId=${reqData.userId} orderType=${orderType}`);
                return { isValid: false, message: "Limit/SL orders are disabled for this market today." };
            }

            // If onlySquareOff=Yes, also block new positions (only market square-offs allowed)
            if (isSquareOffOnly && isFullReqData) {
                const reductionInfo = await this.getPositionReductionInfo(reqData, services);
                console.log(`[LIMIT-DEBUG][FilterLimitDisable] SquareOffOnly check — isReducing=${reductionInfo.isReducing} qty=${reqData.quantity} maxReducible=${reductionInfo.maxReducibleQty} userId=${reqData.userId}`);
                if (!reductionInfo.isReducing) {
                    console.log(`[LIMIT-DEBUG][FilterLimitDisable] BLOCKED non-squareoff — userId=${reqData.userId} marketId=${marketId}`);
                    return { isValid: false, message: "Only square-off (market orders) are allowed for this market today." };
                }
                // Prevent over-squaring
                if (reqData.quantity > reductionInfo.maxReducibleQty) {
                    console.log(`[LIMIT-DEBUG][FilterLimitDisable] BLOCKED over-squaring — qty=${reqData.quantity} max=${reductionInfo.maxReducibleQty} userId=${reqData.userId}`);
                    return {
                        isValid: false,
                        message: `Only square-off allowed. You can square off at most ${reductionInfo.maxReducibleQty} quantity.`
                    };
                }
            }
        }

        // 3. Market Timing Check (Two-tier)
        // marketStartTime/marketEndTime = hard market window, NO trades at all outside
        // tradeStartTime/tradeEndTime   = new-position window, only square-off allowed outside (but within market time)
        const getMarketTime = await getTimeByMarket(marketId);

        if (getMarketTime) {
            const marketOpen = convertTime(getMarketTime.marketStartTime);
            const marketClose = convertTime(getMarketTime.marketEndTime);
            const tradeOpen = convertTime(getMarketTime.tradeStartTime);
            const tradeClose = convertTime(getMarketTime.tradeEndTime);

            // Check if market operates across midnight (e.g., 6:00 AM to 2:30 AM next day)
            const marketCrossedMidnight = marketClose < marketOpen;
            const tradeCrossedMidnight = tradeClose < tradeOpen;

            // Hard check: Market window validation
            let isWithinMarketHours;
            if (marketCrossedMidnight) {
                // Market is open if current time is >= marketOpen OR <= marketClose
                isWithinMarketHours = currentTime >= marketOpen || currentTime <= marketClose;
            } else {
                // Normal case: market is open if current time is between open and close
                isWithinMarketHours = currentTime >= marketOpen && currentTime <= marketClose;
            }

            if (!isWithinMarketHours) {
                if (currentTime < marketOpen && (!marketCrossedMidnight || currentTime > marketClose)) {
                    return { isValid: false, message: "Market is not open yet." };
                }
                return { isValid: false, message: "Market is closed." };
            }

            // Soft check: Trade window validation (only square-off allowed outside)
            let isWithinTradeHours;
            if (tradeCrossedMidnight) {
                // Trade window is active if current time is >= tradeOpen OR <= tradeClose
                isWithinTradeHours = currentTime >= tradeOpen || currentTime <= tradeClose;
            } else {
                // Normal case: trade window is active if current time is between open and close
                isWithinTradeHours = currentTime >= tradeOpen && currentTime <= tradeClose;
            }

            if (!isWithinTradeHours) {
                if (isFullReqData) {
                    const reductionInfo = await this.getPositionReductionInfo(reqData, services);
                    if (reductionInfo.isReducing) {
                        // Allow square-off within market time
                        if (reqData.quantity > reductionInfo.maxReducibleQty) {
                            return {
                                isValid: false,
                                message: `Only square-off allowed. You can square off at most ${reductionInfo.maxReducibleQty} quantity.`
                            };
                        }
                        return { isValid: true };
                    }
                    return { isValid: false, message: "Trading time is over. Only square-off allowed." };
                }
                return { isValid: false, message: "Trading time is over. Only square-off allowed." };
            }
        }

        return { isValid: true };
    },

        // async validateQuantityLimits(userId, scriptId, marketId, lot, quantity, price, parentIds = [], scriptName = null, transactionType = null, valanId = null) {
        //     let checkLimits = [];
        //     const userMarketLimits = await quantitySetting.find({ clientId: userId, marketId }).lean();

        //     if (userMarketLimits.length > 0) {
        //         // User has at least one limit setting in this market. We strictly use user's limits.
                
        //         if (scriptId) {
        //             checkLimits = userMarketLimits.filter(l => String(l.scriptId) === String(scriptId));
        //         }

        //         // FALLBACK TO SCRIPT-NAME MATCH if no ID match (for shared limits across expiries)
        //         if (checkLimits.length === 0 && scriptName && scriptId !== "999") {
        //             checkLimits = userMarketLimits.filter(l => l.scriptName === scriptName);
        //         }

        //         // If no specific script settings, fetch default (999) settings
        //         if (checkLimits.length === 0) {
        //             checkLimits = userMarketLimits.filter(l => String(l.scriptId) === "999");
        //         }
        //     } else {
        //         // User has NO limits defined for this market at all. Inherit from immediate parent (createdBy).
        //         const userDoc = await UserModel.findById(userId).select('createdBy').lean();
        //         const pId = userDoc?.createdBy?.userId;

        //         if (pId) {
        //             const parentMarketLimits = await quantitySetting.find({ clientId: pId, marketId }).lean();

        //             if (parentMarketLimits.length > 0) {
        //                 if (scriptId) {
        //                     checkLimits = parentMarketLimits.filter(l => String(l.scriptId) === String(scriptId));
        //                 }

        //                 if (checkLimits.length === 0 && scriptName && scriptId !== "999") {
        //                     checkLimits = parentMarketLimits.filter(l => l.scriptName === scriptName);
        //                 }

        //                 if (checkLimits.length === 0) {
        //                     checkLimits = parentMarketLimits.filter(l => String(l.scriptId) === "999");
        //                 }
        //             }
        //         }
        //     }

        //     if (checkLimits.length === 0) {
        //         return { isValid: false, message: "Limit not exists" };
        //     }

        //     /**
        //      * Selects the most appropriate limit record for a given setting type
        //      * based on the current trade price.
        //      */
        //     const selectLimit = (type) => {
        //         const relevantLimits = checkLimits.filter(l => l.qtySetting === type);
        //         if (relevantLimits.length === 0) return null;

        //         // 1. Try to find an EXACT price range match
        //         // A match is found if price is within [startRange, endRange] 
        //         // and the setting specifically defines a range (isRange=true or non-zero ranges)
        //         const rangeMatch = relevantLimits.find(l => {
        //             const hasRange = l.isRange === true || l.startRange > 0 || l.endRange > 0;
        //             if (!hasRange) return false;
        //             return price >= l.startRange && price <= l.endRange;
        //         });

        //         if (rangeMatch) {
        //             return rangeMatch;
        //         }

        //         // 2. If no range match, look for a "General" setting (no range defined)
        //         const generalSetting = relevantLimits.find(l =>
        //             l.isRange !== true && l.startRange === 0 && l.endRange === 0
        //         );

        //         if (generalSetting) {
        //             return generalSetting;
        //         }

        //         // 3. Fallback to the first available if no specialized match was found
        //         // This maintains backward compatibility
        //         return relevantLimits[0];
        //     };

        //     const lotLimits = selectLimit("Lot");
        //     const qtyLimits = selectLimit("Qty");
        //     const valueLimits = selectLimit("Value");

        //     // Fetch current position for cumulative validation (Position Limit)
        //     // This is now RANGE-AWARE for script-specific/settings-based limits.
        //     let currentPos = { netLot: 0, netQty: 0 };
        //     const vId = valanId || (await WeekValanModel.findOne({ isActive: true }).lean())?._id;
        //     const isGlobalLimitCheck = checkLimits.length > 0 && checkLimits.some(l => l.scriptId === '999');

        //     // Fetch User and Absolute Ceiling details
        //     const userDoc = await UserModel.findById(userId).select('marketAccess').lean();
        //     const absoluteLotCeiling = userDoc?.marketAccess?.margin?.find(m => String(m.marketId) === String(marketId))?.maximumLimit || 0;

        //     if (vId && (lotLimits?.positionLimit > 0 || qtyLimits?.positionLimit > 0 || absoluteLotCeiling > 0)) {
        //         // Determine active range for siloed position tracking
        //         // We use the qtyLimits or lotLimits range depending on what's defined.
        //         const targetLimit = qtyLimits || lotLimits;
        //         const startRange = targetLimit?.startRange || 0;
        //         const endRange = targetLimit?.endRange || 0;
        //         const hasRange = targetLimit?.isRange || startRange > 0 || endRange > 0;
        //         // Step 1: Calculate Global Account-Wide Position for Absolute Ceiling (no ranges)
        //         // Using Absolute Net Position Sum: Total = Sum|Net_i|
        //         let totalAccountGrossLots = 0;
        //         let currentScriptNetLot = 0;
        //         let match;
        //         if (targetLimit?.scriptId == '999') {
        //             match = { userId: new mongoose.Types.ObjectId(userId), valanId: vId, transactionStatus: "COMPLETED", marketId: String(marketId),scriptName:String(scriptName)}
        //         }else {
        //             match = { userId: new mongoose.Types.ObjectId(userId), valanId: vId, transactionStatus: "COMPLETED", marketId: String(marketId)}
        //         }
        //         if (absoluteLotCeiling > 0) {
        //             const totalStats = await StockTransaction.aggregate([
        //                 { $match: match },
        //                 {
        //                     $group: {
        //                         _id: "$scriptId",
        //                         netLot: { $sum: { $cond: [{ $eq: ["$transactionType", "BUY"] }, "$lot", { $multiply: ["$lot", -1] }] } }
        //                     }
        //                 },
        //                 {
        //                     $group: {
        //                         _id: null,
        //                         totalGrossLot: { $sum: { $abs: "$netLot" } },
        //                         scripts: { $push: { scriptId: "$_id", netLot: "$netLot" } }
        //                     }
        //                 }
        //             ]);
        //            // console.log('totalStats', totalStats);
        //             if (totalStats.length > 0) {
        //                 totalAccountGrossLots = Number(totalStats[0].totalGrossLot) || 0;
        //                 const currentScript = totalStats[0].scripts.find(s => String(s.scriptId) === String(scriptId));
        //                 currentScriptNetLot = currentScript ? Number(currentScript.netLot) : 0;
        //             }

        //             // Absolute Ceiling Validation (Layer 1)
        //             const isBuy = String(transactionType).toUpperCase() === 'BUY';
        //             let lotImpact = Number(lot);
        //             if (lot === 0 && quantity > 0) {
        //                 const lotSetting = await LotSettingModel.findOne({ marketId: String(marketId), scriptId: String(scriptId) }).lean();
        //                 const lotSize = Number(lotSetting?.quantity) || 1;
        //                 lotImpact = Number(quantity) / lotSize;
        //             }

        //             const lotDelta = isBuy ? lotImpact : -lotImpact;

        //             // Formula: New_Total = Old_Total - |Old_Net_Current| + |Old_Net_Current + Delta|
        //             const predictedTotalLots = totalAccountGrossLots - Math.abs(currentScriptNetLot) + Math.abs(currentScriptNetLot + lotDelta);

        //             if (predictedTotalLots > absoluteLotCeiling) {
        //                 return {
        //                     isValid: false,
        //                     message: `Absolute account limit reached. Allowed: ${absoluteLotCeiling} lots, Current Total Usage: ${totalAccountGrossLots.toFixed(2)}, Predicted: ${predictedTotalLots.toFixed(2)}`
        //                 };
        //             }
        //         }

        //         // Step 2: Calculate Siloed Position for current settings/range
        //         const baseQuery = {
        //             userId: new mongoose.Types.ObjectId(userId),
        //             valanId: vId,
        //             transactionStatus: "COMPLETED",
        //             marketId: String(marketId)
        //         };

        //         // Build script conditions for siloed tracking
        //         const scriptConditions = [];
        //         if (mongoose.Types.ObjectId.isValid(scriptId)) {
        //             scriptConditions.push({ scriptId: String(scriptId) });
        //         }
        //         if (scriptName) {
        //             // We check both scriptName and label to ensure we capture all related trades
        //             // scriptName field in transaction contains the base ticker (e.g. NIFTY)
        //             // label field contains the full symbol (e.g. NIFTY 13APR2026 20000 CE)
        //             scriptConditions.push({ scriptName: String(scriptName) });
        //             scriptConditions.push({ label: String(scriptName) });
        //         } else if (scriptId && !mongoose.Types.ObjectId.isValid(scriptId)) {
        //             // Handle cases where scriptId is a symbol string (common for NSE-EQ)
        //             scriptConditions.push({ scriptId: String(scriptId) });
        //         }

        //         if (isGlobalLimitCheck) {
        //             // For Global (999) limit, exclude any script that has its OWN specific settings.
        //             // This keeps specific scripts in their own silos.
        //             // We fetch settings by both scriptId AND scriptName to find all specific exclusions.
        //             const specificSettings = await quantitySetting.find({
        //                 clientId: userId,
        //                 marketId: String(marketId),
        //                 scriptId: { $ne: "999" }
        //             }).select('scriptId scriptName').lean();

        //             if (specificSettings.length > 0) {
        //                 const excludeIds = specificSettings.filter(s => s.scriptId).map(s => String(s.scriptId));
        //                 const excludeNames = specificSettings.filter(s => s.scriptName).map(s => String(s.scriptName));

        //                 const excludeConditions = [];
        //                 if (excludeIds.length > 0) excludeConditions.push({ scriptId: { $in: excludeIds } });
        //                 if (excludeNames.length > 0) excludeConditions.push({ label: { $in: excludeNames } });

        //                 if (excludeConditions.length > 0) {
        //                     baseQuery.$nor = excludeConditions;
        //                 }
        //             }

        //             /**
        //              * USER REQUEST CHANGE: Within range scenarios, fallback limits (999) should apply PER SCRIPT.
        //              * This prevents ABB trades from taking up 360ONE's room in the same price range.
        //              * "only in range" - We apply this silo strictly when hasRange is true.
        //              */
        //             if (hasRange && scriptConditions.length > 0) {
        //                 baseQuery.$or = scriptConditions;
        //             }
        //         } else {
        //             // Script-specific Limit: Match by ID or Name (Label) to capture all expiries
        //             if (scriptConditions.length > 0) {
        //                 baseQuery.$or = scriptConditions;
        //             }
        //         }

        //         // If a range is defined, strictly filter by entry price (Independent Silos)
        //         if (hasRange) {
        //             baseQuery.orderPrice = { $gte: startRange };
        //             if (endRange > 0) baseQuery.orderPrice.$lte = endRange;
        //         } else {
        //             // For General Range (0-0), it should theoretically exclude other specific ranges
        //             // defined for that same script/settings to keep them siloed.
        //             const otherRanges = checkLimits.filter(l => (l.isRange || l.startRange > 0 || l.endRange > 0));
        //             if (otherRanges.length > 0) {
        //                 const priceConditions = otherRanges.map(r => ({
        //                     orderPrice: { $gte: r.startRange, ...(r.endRange > 0 ? { $lte: r.endRange } : {}) }
        //                 }));
        //                 baseQuery.$nor = priceConditions;
        //             }
        //         }

        //         // Aggregate transaction history to find net exposure in this specific range silo
        //         const siloedStats = await StockTransaction.aggregate([
        //             { $match: baseQuery },
        //             {
        //                 $group: {
        //                     _id: null,
        //                     buyLot: { $sum: { $cond: [{ $eq: ["$transactionType", "BUY"] }, "$lot", 0] } },
        //                     sellLot: { $sum: { $cond: [{ $eq: ["$transactionType", "SELL"] }, "$lot", 0] } },
        //                     buyQty: { $sum: { $cond: [{ $eq: ["$transactionType", "BUY"] }, "$quantity", 0] } },
        //                     sellQty: { $sum: { $cond: [{ $eq: ["$transactionType", "SELL"] }, "$quantity", 0] } },
        //                 }
        //             }
        //         ]);

        //         if (siloedStats.length > 0) {
        //             currentPos.netLot = (siloedStats[0].buyLot || 0) - (siloedStats[0].sellLot || 0);
        //             currentPos.netQty = (siloedStats[0].buyQty || 0) - (siloedStats[0].sellQty || 0);
        //         }
        //     }


        //     // Lot Validation
        //     if (lotLimits) {
        //         if (lot < lotLimits.minOrder || lot > lotLimits.maxOrder) {
        //             return { isValid: false, message: `Lot limit reached. Allowed: ${lotLimits.minOrder} to ${lotLimits.maxOrder}` };
        //         }
        //         if (lotLimits.isRange || lotLimits.startRange > 0 || lotLimits.endRange > 0) {
        //             if (price < lotLimits.startRange || price > lotLimits.endRange) {
        //                 return { isValid: false, message: `Price ${price} is out of lot range limits (${lotLimits.startRange} - ${lotLimits.endRange})` };
        //             }
        //         }
        //         if (lotLimits.positionLimit > 0 && transactionType) {
        //             const isBuy = String(transactionType).toUpperCase() === 'BUY';
        //             const lotDelta = isBuy ? Number(lot) : -Number(lot);
        //             const newNetLot = currentPos.netLot + lotDelta;

        //             if (Math.abs(newNetLot) > lotLimits.positionLimit) {
        //                 return {
        //                     isValid: false,
        //                     message: `Position limit exceeded. Allowed: ${lotLimits.positionLimit} lots, Current Usage: ${Math.abs(currentPos.netLot).toFixed(2)}, Predicted: ${Math.abs(newNetLot).toFixed(2)}`
        //                 };
        //             }
        //         }
        //     }

        //     // Quantity / Amount Validation
        //     if (qtyLimits) {
        //         if (marketId == MARKET_IDS.NSE_EQ) {
        //             // For NSE-EQ, 'Qty' type setting handles max amount validation
        //             const orderValue = quantity * price;
        //             const allowedAmount = qtyLimits.maxAmount || qtyLimits.maxOrder;
        //             if (allowedAmount > 0 && orderValue > allowedAmount) {
        //                 return {
        //                     isValid: false,
        //                     message: `Order value (${orderValue.toFixed(2)}) exceeds maximum allowed amount (${allowedAmount}) for NSE-EQ.`
        //                 };
        //             }
        //             if (qtyLimits.positionLimit > 0 && transactionType) {
        //                 const isBuy = String(transactionType).toUpperCase() === 'BUY';
        //                 const qtyDelta = isBuy ? Number(quantity) : -Number(quantity);
        //                 const newNetQty = currentPos.netQty + qtyDelta;

        //                 if (Math.abs(newNetQty) > qtyLimits.positionLimit) {
        //                     return {
        //                         isValid: false,
        //                         message: `Quantity position limit exceeded. Allowed: ${qtyLimits.positionLimit}, Current Usage: ${Math.abs(currentPos.netQty)}, Predicted: ${Math.abs(newNetQty)}`
        //                     };
        //                 }
        //             }
        //         } else {
        //             // Standard Quantity Validation
        //             if (quantity < qtyLimits.minOrder || quantity > qtyLimits.maxOrder) {
        //                 return { isValid: false, message: `Quantity limit reached. Allowed: ${qtyLimits.minOrder} to ${qtyLimits.maxOrder}` };
        //             }
        //             if (qtyLimits.isRange || qtyLimits.startRange > 0 || qtyLimits.endRange > 0) {
        //                 if (price < qtyLimits.startRange || price > qtyLimits.endRange) {
        //                     return { isValid: false, message: `Price ${price} is out of quantity range limits (${qtyLimits.startRange} - ${qtyLimits.endRange})` };
        //                 }
        //             }
        //             if (qtyLimits.positionLimit > 0 && transactionType) {
        //                 const isBuy = String(transactionType).toUpperCase() === 'BUY';
        //                 const qtyDelta = isBuy ? Number(quantity) : -Number(quantity);
        //                 const newNetQty = currentPos.netQty + qtyDelta;

        //                 if (Math.abs(newNetQty) > qtyLimits.positionLimit) {
        //                     return {
        //                         isValid: false,
        //                         message: `Quantity position limit exceeded. Allowed: ${qtyLimits.positionLimit}, Current Net: ${Math.abs(currentPos.netQty)}, Predicted: ${Math.abs(newNetQty)}`
        //                     };
        //                 }
        //             }
        //         }
        //     }

        //     // Value Validation
        //     if (valueLimits) {
        //         const orderValue = quantity * price;
        //         if (orderValue < valueLimits.minOrder || orderValue > valueLimits.maxOrder) {
        //             return { isValid: false, message: `Order value limit reached. Allowed range: ${valueLimits.minOrder} to ${valueLimits.maxOrder}` };
        //         }
        //         if (valueLimits.isRange || valueLimits.startRange > 0 || valueLimits.endRange > 0) {
        //             if (price < valueLimits.startRange || price > valueLimits.endRange) {
        //                 return { isValid: false, message: `Price ${price} is out of value range limits (${valueLimits.startRange} - ${valueLimits.endRange})` };
        //             }
        //         }
        //     }

        //     return { isValid: true };
        // },


      async validateQuantityLimits(userId, scriptId, marketId, lot, quantity, price, parentIds = [], scriptName = null, transactionType = null, valanId = null) {
            let checkLimits = [];
            const userMarketLimits = await quantitySetting.find({ clientId: userId, marketId }).lean();

            if (userMarketLimits.length > 0) {
                // User has at least one limit setting in this market. We strictly use user's limits.
                
                if (scriptId) {
                    checkLimits = userMarketLimits.filter(l => String(l.scriptId) === String(scriptId));
                }

                // FALLBACK TO SCRIPT-NAME MATCH if no ID match (for shared limits across expiries)
                if (checkLimits.length === 0 && scriptName && scriptId !== "999") {
                    checkLimits = userMarketLimits.filter(l => l.scriptName === scriptName);
                }

                // If no specific script settings, fetch default (999) settings
                if (checkLimits.length === 0) {
                    checkLimits = userMarketLimits.filter(l => String(l.scriptId) === "999");
                }
            } else {
                // User has NO limits defined for this market at all. Inherit from immediate parent (createdBy).
                const userDoc = await UserModel.findById(userId).select('createdBy').lean();
                const pId = userDoc?.createdBy?.userId;

                if (pId) {
                    const parentMarketLimits = await quantitySetting.find({ clientId: pId, marketId }).lean();

                    if (parentMarketLimits.length > 0) {
                        if (scriptId) {
                            checkLimits = parentMarketLimits.filter(l => String(l.scriptId) === String(scriptId));
                        }

                        if (checkLimits.length === 0 && scriptName && scriptId !== "999") {
                            checkLimits = parentMarketLimits.filter(l => l.scriptName === scriptName);
                        }

                        if (checkLimits.length === 0) {
                            checkLimits = parentMarketLimits.filter(l => String(l.scriptId) === "999");
                        }
                    }
                }
            }

            if (checkLimits.length === 0) {
                return { isValid: false, message: "Limit not exists" };
            }

            /**
             * Selects the most appropriate limit record for a given setting type
             * based on the current trade price.
             */
            const selectLimit = (type) => {
                const relevantLimits = checkLimits.filter(l => l.qtySetting === type);
                if (relevantLimits.length === 0) return null;

                // 1. Try to find an EXACT price range match
                // A match is found if price is within [startRange, endRange] 
                // and the setting specifically defines a range (isRange=true or non-zero ranges)
                const rangeMatch = relevantLimits.find(l => {
                    const hasRange = l.isRange === true || l.startRange > 0 || l.endRange > 0;
                    if (!hasRange) return false;
                    return price >= l.startRange && price <= l.endRange;
                });

                if (rangeMatch) {
                    return rangeMatch;
                }

                // 2. If no range match, look for a "General" setting (no range defined)
                const generalSetting = relevantLimits.find(l =>
                    l.isRange !== true && l.startRange === 0 && l.endRange === 0
                );

                if (generalSetting) {
                    return generalSetting;
                }

                // 3. Fallback to the first available if no specialized match was found
                // This maintains backward compatibility
                return relevantLimits[0];
            };

            const lotLimits = selectLimit("Lot");
            const qtyLimits = selectLimit("Qty");
            const valueLimits = selectLimit("Value");

            // Fetch current position for cumulative validation (Position Limit)
            // This is now RANGE-AWARE for script-specific/settings-based limits.
            let currentPos = { netLot: 0, netQty: 0 };
            const vId = valanId || (await WeekValanModel.findOne({ isActive: true }).lean())?._id;
            const isGlobalLimitCheck = checkLimits.length > 0 && checkLimits.some(l => l.scriptId === '999');

            // Fetch User and Absolute Ceiling details
            const userDoc = await UserModel.findById(userId).select('marketAccess').lean();
            const absoluteLotCeiling = userDoc?.marketAccess?.margin?.find(m => String(m.marketId) === String(marketId))?.maximumLimit || 0;

            if (vId && (lotLimits?.positionLimit > 0 || qtyLimits?.positionLimit > 0 || absoluteLotCeiling > 0)) {
                // Determine active range for siloed position tracking
                // We use the qtyLimits or lotLimits range depending on what's defined.
                const targetLimit = qtyLimits || lotLimits;
                const startRange = targetLimit?.startRange || 0;
                const endRange = targetLimit?.endRange || 0;
                const hasRange = targetLimit?.isRange || startRange > 0 || endRange > 0;
                // Step 1: Calculate Global Account-Wide Position for Absolute Ceiling (no ranges)
                // Using Absolute Net Position Sum: Total = Sum|Net_i|
                let totalAccountGrossLots = 0;
                let currentScriptNetLot = 0;
                
                // Define match query based on scriptId 999 check - MOVED OUTSIDE the absoluteLotCeiling check
                // Include BOTH COMPLETED and PENDING transactions in position limit calculations
                let match;
                if (targetLimit?.scriptId == '999') {
                    match = { userId: new mongoose.Types.ObjectId(userId), valanId: vId, transactionStatus: { $in: ["COMPLETED", "PENDING"] }, marketId: String(marketId), scriptName: String(scriptName) };
                } else {
                    match = { userId: new mongoose.Types.ObjectId(userId), valanId: vId, transactionStatus: { $in: ["COMPLETED", "PENDING"] }, marketId: String(marketId) };
                }
                
                if (absoluteLotCeiling > 0) {
                    const totalStats = await StockTransaction.aggregate([
                        { $match: match },
                        {
                            $group: {
                                _id: "$scriptId",
                                netLot: { $sum: { $cond: [{ $eq: ["$transactionType", "BUY"] }, "$lot", { $multiply: ["$lot", -1] }] } }
                            }
                        },
                        {
                            $group: {
                                _id: null,
                                totalGrossLot: { $sum: { $abs: "$netLot" } },
                                scripts: { $push: { scriptId: "$_id", netLot: "$netLot" } }
                            }
                        }
                    ]);
                   // console.log('totalStats', totalStats);
                    if (totalStats.length > 0) {
                        totalAccountGrossLots = Number(totalStats[0].totalGrossLot) || 0;
                        const currentScript = totalStats[0].scripts.find(s => String(s.scriptId) === String(scriptId));
                        currentScriptNetLot = currentScript ? Number(currentScript.netLot) : 0;
                    }

                    // Absolute Ceiling Validation (Layer 1)
                    const isBuy = String(transactionType).toUpperCase() === 'BUY';
                    let lotImpact = Number(lot);
                    if (lot === 0 && quantity > 0) {
                        const lotSetting = await LotSettingModel.findOne({ marketId: String(marketId), scriptName: String(scriptName || '').toUpperCase() }).lean();
                        const lotSize = Number(lotSetting?.quantity) || 1;
                        lotImpact = Number(quantity) / lotSize;
                    }

                    const lotDelta = isBuy ? lotImpact : -lotImpact;

                    // Formula: New_Total = Old_Total - |Old_Net_Current| + |Old_Net_Current + Delta|
                    const predictedTotalLots = totalAccountGrossLots - Math.abs(currentScriptNetLot) + Math.abs(currentScriptNetLot + lotDelta);

                    if (predictedTotalLots > absoluteLotCeiling) {
                        return {
                            isValid: false,
                            message: `Absolute account limit reached. Allowed: ${absoluteLotCeiling} lots, Current Total Usage: ${totalAccountGrossLots.toFixed(2)}, Predicted: ${predictedTotalLots.toFixed(2)}`
                        };
                    }
                }

                // Step 2: Calculate Siloed Position for current settings/range
                // Include BOTH COMPLETED and PENDING transactions in position limit calculations
                const baseQuery = {
                    userId: new mongoose.Types.ObjectId(userId),
                    valanId: vId,
                    transactionStatus: { $in: ["COMPLETED", "PENDING"] },
                    marketId: String(marketId)
                };

                // Build script conditions for siloed tracking
                // For SCRIPT-SPECIFIC limits only (not for global 999 limits)
                const scriptConditions = [];
                if (!isGlobalLimitCheck) {
                    if (mongoose.Types.ObjectId.isValid(scriptId)) {
                        scriptConditions.push({ scriptId: String(scriptId) });
                    }
                    if (scriptName) {
                        // We check both scriptName and label to ensure we capture all related trades
                        // scriptName field in transaction contains the base ticker (e.g. NIFTY)
                        // label field contains the full symbol (e.g. NIFTY 13APR2026 20000 CE)
                        scriptConditions.push({ scriptName: String(scriptName) });
                        scriptConditions.push({ label: String(scriptName) });
                    } else if (scriptId && !mongoose.Types.ObjectId.isValid(scriptId)) {
                        // Handle cases where scriptId is a symbol string (common for NSE-EQ)
                        scriptConditions.push({ scriptId: String(scriptId) });
                    }
                    
                    // For MCX/NCDEX (market 1/3), also match by the full scriptId since label might be the full symbol
                    if (scriptId && !mongoose.Types.ObjectId.isValid(scriptId)) {
                        scriptConditions.push({ label: String(scriptId) });
                    }
                }

                if (isGlobalLimitCheck) {
                    // For Global (999) limit, ALWAYS apply PER-SCRIPT filtering.
                    // Each script gets its own limit allocation, not a total market limit.
                    // This prevents one script from consuming the entire market limit.
                    
                    // First, exclude any script that has its OWN specific settings.
                    // This keeps specific scripts in their own silos.
                    const specificSettings = await quantitySetting.find({
                        clientId: userId,
                        marketId: String(marketId),
                        scriptId: { $ne: "999" }
                    }).select('scriptId scriptName').lean();

                    if (specificSettings.length > 0) {
                        const excludeIds = specificSettings.filter(s => s.scriptId).map(s => String(s.scriptId));
                        const excludeNames = specificSettings.filter(s => s.scriptName).map(s => String(s.scriptName));

                        const excludeConditions = [];
                        if (excludeIds.length > 0) excludeConditions.push({ scriptId: { $in: excludeIds } });
                        if (excludeNames.length > 0) excludeConditions.push({ scriptName: { $in: excludeNames } });

                        if (excludeConditions.length > 0) {
                            baseQuery.$nor = excludeConditions;
                        }
                    }

                    /**
                     * USER REQUEST: Global (999) limits should apply PER SCRIPT.
                     * This means each script can have up to the limit (e.g., 5 lots),
                     * not 5 lots total across all scripts in the market.
                     * 
                     * For global limits, we DON'T filter by specific script in the match stage.
                     * Instead, we group by scriptId in the aggregation to get per-script totals.
                     * Then we select only the current script's total.
                     */
                } else {
                    // Script-specific Limit: Match by ID or Name (Label) to capture all expiries
                    if (scriptConditions.length > 0) {
                        baseQuery.$or = scriptConditions;
                    }
                }

                // If a range is defined, strictly filter by entry price (Independent Silos)
                if (hasRange) {
                    baseQuery.orderPrice = { $gte: startRange };
                    if (endRange > 0) baseQuery.orderPrice.$lte = endRange;
                } else {
                    // For General Range (0-0), it should theoretically exclude other specific ranges
                    // defined for that same script/settings to keep them siloed.
                    const otherRanges = checkLimits.filter(l => (l.isRange || l.startRange > 0 || l.endRange > 0));
                    if (otherRanges.length > 0) {
                        const priceConditions = otherRanges.map(r => ({
                            orderPrice: { $gte: r.startRange, ...(r.endRange > 0 ? { $lte: r.endRange } : {}) }
                        }));
                        baseQuery.$nor = priceConditions;
                    }
                }

                // Aggregate transaction history to find net exposure in this specific range silo
                // For global (999) limits applied per-script, group by scriptId to get individual script totals
                // For script-specific limits, group by null to get total for that script
                const groupByField = isGlobalLimitCheck ? "$scriptId" : null;
                
                const siloedStats = await StockTransaction.aggregate([
                    { $match: baseQuery },
                    {
                        $group: {
                            _id: groupByField,
                            buyLot: { $sum: { $cond: [{ $eq: ["$transactionType", "BUY"] }, "$lot", 0] } },
                            sellLot: { $sum: { $cond: [{ $eq: ["$transactionType", "SELL"] }, "$lot", 0] } },
                            buyQty: { $sum: { $cond: [{ $eq: ["$transactionType", "BUY"] }, "$quantity", 0] } },
                            sellQty: { $sum: { $cond: [{ $eq: ["$transactionType", "SELL"] }, "$quantity", 0] } },
                        }
                    }
                ]);

               // console.log(`[QTY LIMITS] Aggregation - isGlobal: ${isGlobalLimitCheck}, groupByField: ${groupByField}, results: ${siloedStats.length}`);
               // console.log(`[QTY LIMITS] Aggregation results:`, JSON.stringify(siloedStats, null, 2));

                if (siloedStats.length > 0) {
                    // For global limits, find the stats for the current script
                    // For script-specific limits, use the first (and only) result
                    let targetStats = siloedStats[0];
                    
                    if (isGlobalLimitCheck && siloedStats.length > 0) {
                        // Multiple scripts returned, find the one matching current scriptId
                        // The _id field contains the scriptId value from the $group stage
                       // console.log(`[QTY LIMITS] Looking for scriptId: ${scriptId} in results`);
                        targetStats = siloedStats.find(s => String(s._id) === String(scriptId));
                        
                        if (!targetStats) {
                           // console.log(`[QTY LIMITS] No position found for scriptId: ${scriptId}, available: ${siloedStats.map(s => s._id).join(', ')}`);
                            // If no match found, this script has no position yet
                            targetStats = { buyLot: 0, sellLot: 0, buyQty: 0, sellQty: 0 };
                        }
                    }
                    
                    currentPos.netLot = (targetStats.buyLot || 0) - (targetStats.sellLot || 0);
                    currentPos.netQty = (targetStats.buyQty || 0) - (targetStats.sellQty || 0);
                   // console.log(`[QTY LIMITS] Script: ${scriptId}, netLot: ${currentPos.netLot}, limit: ${lotLimits?.positionLimit || 'N/A'}`);
                } else {
                   // console.log(`[QTY LIMITS] No aggregation results, netLot: 0`);
                }
            }


            // Lot Validation
            if (lotLimits) {
                if (lot < lotLimits.minOrder || lot > lotLimits.maxOrder) {
                    return { isValid: false, message: `Lot limit reached. Allowed: ${lotLimits.minOrder} to ${lotLimits.maxOrder}` };
                }
                if (lotLimits.isRange || lotLimits.startRange > 0 || lotLimits.endRange > 0) {
                    if (price < lotLimits.startRange || price > lotLimits.endRange) {
                        return { isValid: false, message: `Price ${price} is out of lot range limits (${lotLimits.startRange} - ${lotLimits.endRange})` };
                    }
                }
                if (lotLimits.positionLimit > 0 && transactionType) {
                    const isBuy = String(transactionType).toUpperCase() === 'BUY';
                    const lotDelta = isBuy ? Number(lot) : -Number(lot);
                    const newNetLot = currentPos.netLot + lotDelta;

                   // console.log(`[QTY LIMITS] Position validation - isBuy: ${isBuy}, lot: ${lot}, lotDelta: ${lotDelta}, currentNetLot: ${currentPos.netLot}, newNetLot: ${newNetLot}, limit: ${lotLimits.positionLimit}`);
                   // console.log(`[QTY LIMITS] Check: Math.abs(${newNetLot}) > ${lotLimits.positionLimit}? ${Math.abs(newNetLot) > lotLimits.positionLimit}`);

                    if (Math.abs(newNetLot) > lotLimits.positionLimit) {
                       // console.log(`[QTY LIMITS] BLOCKING TRADE`);
                        return {
                            isValid: false,
                            message: `Position limit exceeded. Allowed: ${lotLimits.positionLimit} lots, Current Usage: ${Math.abs(currentPos.netLot).toFixed(2)}, Predicted: ${Math.abs(newNetLot).toFixed(2)}`
                        };
                    }
                   // console.log(`[QTY LIMITS] ALLOWING TRADE`);
                }
            }

            // Quantity / Amount Validation
            if (qtyLimits) {
                if (marketId == MARKET_IDS.NSE_EQ) {
                    // For NSE-EQ, 'Qty' type setting handles max amount validation.
                    // Exits (trades that reduce |netQty| toward 0) bypass the maxAmount check —
                    // covers both SELL exiting a long and BUY covering a short.
                    const nseVId = vId || (await WeekValanModel.findOne({ isActive: true }).lean())?._id;
                    let nseNetQty = 0;
                    if (nseVId && transactionType) {
                        const nsePos = await UserPosition.findOne({
                            userId: new mongoose.Types.ObjectId(userId),
                            valanId: nseVId,
                            $or: [
                                { scriptId: String(scriptId) },
                                ...(scriptName ? [{ scriptName: String(scriptName) }] : [])
                            ]
                        }).lean();
                        if (nsePos) {
                            nseNetQty = (Number(nsePos.buyQuantity) || 0) - (Number(nsePos.sellQuantity) || 0);
                        }
                    }
                    const isBuyTx = transactionType && String(transactionType).toUpperCase() === 'BUY';
                    // Exit = trade direction is opposite to current net position AND qty doesn't exceed net
                    const isExit = (!isBuyTx && nseNetQty > 0 && Number(quantity) <= nseNetQty) ||
                                   (isBuyTx  && nseNetQty < 0 && Number(quantity) <= Math.abs(nseNetQty));

                    if (!isExit) {
                        const orderValue = quantity * price;
                        const allowedAmount = qtyLimits.maxAmount || qtyLimits.maxOrder;
                        if (allowedAmount > 0 && orderValue > allowedAmount) {
                            return {
                                isValid: false,
                                message: `Order value (${orderValue.toFixed(2)}) exceeds maximum allowed amount (${allowedAmount}) for NSE-EQ.`
                            };
                        }
                    }
                    if (qtyLimits.positionLimit > 0 && transactionType) {
                        const isBuy = String(transactionType).toUpperCase() === 'BUY';
                        const qtyDelta = isBuy ? Number(quantity) : -Number(quantity);
                        const newNetQty = currentPos.netQty + qtyDelta;

                        if (Math.abs(newNetQty) > qtyLimits.positionLimit) {
                            return {
                                isValid: false,
                                message: `Quantity position limit exceeded. Allowed: ${qtyLimits.positionLimit}, Current Usage: ${Math.abs(currentPos.netQty)}, Predicted: ${Math.abs(newNetQty)}`
                            };
                        }
                    }
                } else {
                    // Standard Quantity Validation
                    if (quantity < qtyLimits.minOrder || quantity > qtyLimits.maxOrder) {
                        return { isValid: false, message: `Quantity limit reached. Allowed: ${qtyLimits.minOrder} to ${qtyLimits.maxOrder}` };
                    }
                    if (qtyLimits.isRange || qtyLimits.startRange > 0 || qtyLimits.endRange > 0) {
                        if (price < qtyLimits.startRange || price > qtyLimits.endRange) {
                            return { isValid: false, message: `Price ${price} is out of quantity range limits (${qtyLimits.startRange} - ${qtyLimits.endRange})` };
                        }
                    }
                    if (qtyLimits.positionLimit > 0 && transactionType) {
                        const isBuy = String(transactionType).toUpperCase() === 'BUY';
                        const qtyDelta = isBuy ? Number(quantity) : -Number(quantity);
                        const newNetQty = currentPos.netQty + qtyDelta;

                        if (Math.abs(newNetQty) > qtyLimits.positionLimit) {
                            return {
                                isValid: false,
                                message: `Quantity position limit exceeded. Allowed: ${qtyLimits.positionLimit}, Current Net: ${Math.abs(currentPos.netQty)}, Predicted: ${Math.abs(newNetQty)}`
                            };
                        }
                    }
                }
            }

            // Value Validation
            if (valueLimits) {
                const orderValue = quantity * price;
                if (orderValue < valueLimits.minOrder || orderValue > valueLimits.maxOrder) {
                    return { isValid: false, message: `Order value limit reached. Allowed range: ${valueLimits.minOrder} to ${valueLimits.maxOrder}` };
                }
                if (valueLimits.isRange || valueLimits.startRange > 0 || valueLimits.endRange > 0) {
                    if (price < valueLimits.startRange || price > valueLimits.endRange) {
                        return { isValid: false, message: `Price ${price} is out of value range limits (${valueLimits.startRange} - ${valueLimits.endRange})` };
                    }
                }
            }

            return { isValid: true };
        },
    async calculateBrokerageAndMargin(reqData, services, liveStockPrice) {
        try {
            const BrokerageService = require("../services/BrokerageService");
            const result = await BrokerageService.calculateBrokerage(reqData, services);
            return {
                isValid: true,
                data: result
            };
        } catch (error) {
            console.error("[calculateBrokerageAndMargin] Error:", error);
            return { isValid: false, message: error.message || "Error calculating brokerage" };
        }
    },
    /**
     * Validate Square-Off Timeout restriction (sqOfDisabled_MINUTES)
     * If enabled, user cannot exit a position IN PROFIT within a certain time window.
     * Logic tracks individual entries using FIFO.
     */
   async validateSquareOffTimeout(reqData, services, liveStock) {
        const { userId, scriptId, transactionType, quantity, marketId, label, scriptName } = reqData;
        const { accountDetails, getValan } = services;
        const timeoutMinutes = accountDetails?.sqOfDisabled_MINUTES;

        //// console.log(`[SQUARE-OFF TIMEOUT] Starting validation for user ${userId}, script ${scriptId || label}, type ${transactionType}, price ${reqData.price}`);

        // Skip if no timeout configured
        if (!timeoutMinutes || timeoutMinutes <= 0) {
            //// console.log(`[SQUARE-OFF TIMEOUT] No timeout configured (${timeoutMinutes}), allowing trade`);
            return { isValid: true };
        }

        //// console.log(`[SQUARE-OFF TIMEOUT] Timeout configured: ${timeoutMinutes} minutes`);

        // Lazy Load
        const { getFilterStockTransactions } = require("../services/StockService");

        const now = Date.now();

        // 1. Determine the execution price for this order
        let executionPrice = +reqData.price;
        const isMarket = ['Market', 'MARKET', 'Exit Position (Market)'].includes(reqData.orderType);

        if (isMarket || !executionPrice || isNaN(executionPrice)) {
            if (transactionType === 'SELL') {
                executionPrice = liveStock?.BuyPrice || liveStock?.Bid || liveStock?.LastTradePrice;
            } else {
                executionPrice = liveStock?.SellPrice || liveStock?.Ask || liveStock?.LastTradePrice;
            }
            //// console.log(`[SQUARE-OFF TIMEOUT] Market order, using live price: ${executionPrice}`);
        } else {
            //// console.log(`[SQUARE-OFF TIMEOUT] Limit order, using order price: ${executionPrice}`);
        }

        if (!executionPrice) {
            //// console.log(`[SQUARE-OFF TIMEOUT] No execution price available, allowing trade`);
            return { isValid: true };
        }

        // 2. Get the OPPOSITE side positions (completed + pending) within timeout window
        // If user is SELLING, check against BUY positions
        // If user is BUYING, check against SELL positions
        const oppositeType = transactionType === 'SELL' ? 'BUY' : 'SELL';
        //// console.log(`[SQUARE-OFF TIMEOUT] Checking opposite type: ${oppositeType}`);

        // Calculate the cutoff time (now - timeout minutes)
        const timeoutWindowMs = timeoutMinutes * 60 * 1000;
        const cutoffTime = new Date(now - timeoutWindowMs);

        //// console.log(`[SQUARE-OFF TIMEOUT] Fetching trades within last ${timeoutMinutes} minutes (after ${cutoffTime.toLocaleString()})`);

        // Get completed trades of opposite type within timeout window
        const completedTrades = await getFilterStockTransactions(
            {
                userId,
                scriptId,
                valanId: getValan._id,
                transactionType: oppositeType,
                transactionStatus: 'COMPLETED',
                createdAt: { $gte: cutoffTime }  // Within timeout window
            },
            { orderPrice: 1, createdAt: 1, quantity: 1 },
            { createdAt: 1 }
        );

        //// console.log(`[SQUARE-OFF TIMEOUT] Found ${completedTrades?.length || 0} completed ${oppositeType} trades`);
        if (completedTrades && completedTrades.length > 0) {
            completedTrades.forEach((t, i) => {
                const minsAgo = ((now - new Date(t.createdAt).getTime()) / (1000 * 60)).toFixed(2);
                //// console.log(`[SQUARE-OFF TIMEOUT]   ${i+1}. ${oppositeType} at ${t.orderPrice}, ${minsAgo} mins ago (${new Date(t.createdAt).toLocaleString()})`);
            });
        }

        // Get pending limit orders of opposite type within timeout window
        const pendingLimits = await getFilterStockTransactions(
            {
                userId,
                scriptId,
                valanId: getValan._id,
                transactionType: oppositeType,
                transactionStatus: 'PENDING',
                orderType: { $in: ['Limit', 'SL', 'Stop Loss'] },
                createdAt: { $gte: cutoffTime }  // Within timeout window
            },
            { orderPrice: 1, createdAt: 1, quantity: 1 },
            { createdAt: 1 }
        );

        //// console.log(`[SQUARE-OFF TIMEOUT] Found ${pendingLimits?.length || 0} pending ${oppositeType} limits`);
        if (pendingLimits && pendingLimits.length > 0) {
            pendingLimits.forEach((t, i) => {
                const minsAgo = ((now - new Date(t.createdAt).getTime()) / (1000 * 60)).toFixed(2);
                //// console.log(`[SQUARE-OFF TIMEOUT]   ${i+1}. ${oppositeType} limit at ${t.orderPrice}, ${minsAgo} mins ago (${new Date(t.createdAt).toLocaleString()})`);
            });
        }

        // Combine all opposite positions
        const allOppositePositions = [...(completedTrades || []), ...(pendingLimits || [])];

        if (!allOppositePositions || allOppositePositions.length === 0) {
            //// console.log(`[SQUARE-OFF TIMEOUT] No opposite positions found within timeout window, allowing trade`);
            return { isValid: true };
        }

        // 3. Check if this order would make profit on ANY opposite position
        let wouldMakeProfit = false;
        let profitDetails = [];

        //// console.log(`[SQUARE-OFF TIMEOUT] Checking profit for ${transactionType} at ${executionPrice}:`);

        for (const oppTrade of allOppositePositions) {
            const oppPrice = Number(oppTrade.orderPrice);
            let isProfit = false;

            if (transactionType === 'SELL') {
                // Selling: profit if sell price > buy price
                isProfit = executionPrice > oppPrice;
                //// console.log(`[SQUARE-OFF TIMEOUT]   ${oppositeType} at ${oppPrice}: SELL at ${executionPrice} ${isProfit ? '> (PROFIT)' : '<= (LOSS)'} ${oppPrice}`);
                
                if (isProfit) {
                    wouldMakeProfit = true;
                    profitDetails.push(`${oppositeType} at ${oppPrice}`);
                    //// console.log(`[SQUARE-OFF TIMEOUT]   *** PROFIT DETECTED: SELL ${executionPrice} > BUY ${oppPrice} ***`);
                }
            } else {
                // Buying: profit if buy price < sell price
                isProfit = executionPrice < oppPrice;
                //// console.log(`[SQUARE-OFF TIMEOUT]   ${oppositeType} at ${oppPrice}: BUY at ${executionPrice} ${isProfit ? '< (PROFIT)' : '>= (LOSS)'} ${oppPrice}`);
                
                if (isProfit) {
                    wouldMakeProfit = true;
                    profitDetails.push(`${oppositeType} at ${oppPrice}`);
                    //// console.log(`[SQUARE-OFF TIMEOUT]   *** PROFIT DETECTED: BUY ${executionPrice} < SELL ${oppPrice} ***`);
                }
            }
        }

        //// console.log(`[SQUARE-OFF TIMEOUT] Final: wouldMakeProfit = ${wouldMakeProfit}`);

        // 4. Block ONLY if would make profit
        if (wouldMakeProfit) {
            const mostRecentTradeTime = Math.max(...allOppositePositions.map(t => new Date(t.createdAt).getTime()));
            const timeSinceMostRecentMins = (now - mostRecentTradeTime) / (1000 * 60);
            const timeRemaining = Math.max(0, Math.ceil(timeoutMinutes - timeSinceMostRecentMins));
            
            //// console.log(`[SQUARE-OFF TIMEOUT] BLOCKING: Would make profit on ${profitDetails.join(', ')}. Time remaining: ${timeRemaining} mins`);
            return {
                isValid: false,
                message: `Square-off blocked: Last Trade Time remaining: ${timeRemaining} mins.`
            };
        }

        //// console.log(`[SQUARE-OFF TIMEOUT] ALLOWING: No profit would be made`);
        return { isValid: true };
    }
};

const MarketOrderValidator = {
    async validate(reqData, services, liveStock) {
        // Lazy Load
        const { getUserPosition, getFilterStockTransaction } = require("../services/StockService");

        const { price, transactionType, userId, scriptId, marketId, label, scriptName } = reqData;
        const { accountDetails, getMarket } = services;

        // 1. Blocked Script Check (Hierarchical - checks user and all parents)
        const scriptBlockCheck = await checkScriptBlockedInHierarchy(
            userId, 
            services.parentIds, 
            marketId, 
            scriptId, 
            label, 
            scriptName
        );
        
        if (scriptBlockCheck.isBlocked) {
            return { isValid: false, message: scriptBlockCheck.message };
        }

        // 2. Min Script Rate Check
        if (reqData.marketId == "2" && +reqData.price < +getMarket.brokerage.minScriptRate) {
            return { isValid: false, message: "Min Script rate is " + getMarket.brokerage.minScriptRate };
        }
        if (reqData.marketId == "3" && +reqData.price < +getMarket.other.minRateScriptBlock && transactionType == "BUY") {
            return { isValid: false, message: "Min Script rate is " + getMarket.other.minRateScriptBlock };
        }

        // 3. High/Low Circuit & Ask/Bid check removed for Market Type trade as requested

        // 4. Square Off Disabled Time Check (Updated to use FIFO Profitable check)
        const squareOffTimeoutValidation = await CommonStockValidator.validateSquareOffTimeout(reqData, services, liveStock);
        if (!squareOffTimeoutValidation.isValid) {
            return squareOffTimeoutValidation;
        }

        // 5. Short Sell Allowed Check
        const shortSellValidation = await CommonStockValidator.validateShortSellAllowed(reqData, services);
        if (!shortSellValidation.isValid) {
            return shortSellValidation;
        }

        return { isValid: true };
    }
};

const LimitOrderValidator = {
    async validate(reqData, services, liveStock) {
        // Lazy Load
        const { getUserPosition } = require("../services/StockService");

        const { userId, scriptId, price, transactionType, marketId, quantity, label, scriptName } = reqData;
        const { accountDetails, getMarket, getValan } = services;

        // 1. Blocked Script Check (Hierarchical - checks user and all parents)
        const scriptBlockCheck = await checkScriptBlockedInHierarchy(
            userId, 
            services.parentIds, 
            marketId, 
            scriptId, 
            label, 
            scriptName
        );
        
        if (scriptBlockCheck.isBlocked) {
            return { isValid: false, message: scriptBlockCheck.message };
        }

        // 2. Check if Limit/SL Orders are Disabled in User's Hierarchy
        // This checks the user AND all parents in the hierarchy (both global and market-specific)
        console.log(`[LIMIT-DEBUG][LimitSLHierarchy] Checking userId=${userId} marketId=${marketId}`);
        const _limitSLDisabled = await checkLimitSLDisabledInHierarchy(userId, null, marketId);
        console.log(`[LIMIT-DEBUG][LimitSLHierarchy] Result=${_limitSLDisabled} userId=${userId} marketId=${marketId}`);
        if (_limitSLDisabled) {
            console.log(`[LIMIT-DEBUG][LimitSLHierarchy] BLOCKED — userId=${userId} marketId=${marketId} scriptId=${scriptId}`);
            return { isValid: false, message: "Limit/SL orders are disabled." };
        }

        // 3. Min Script Rate Check
        if (marketId == "2" && +price < +getMarket.brokerage.minScriptRate) {
            return { isValid: false, message: "Min Script rate is " + getMarket.brokerage.minScriptRate };
        }
        if (marketId == "3" && +price < +getMarket.other.minRateScriptBlock && transactionType == "BUY") {
            return { isValid: false, message: "Min Script rate is " + getMarket.other.minRateScriptBlock };
        }

        // 4. High/Low Validation (USER REQUEST CHANGE)
        // If orderBetweenHighLow is set, the user is ALLOWED to order between high and low.
        // If it is NOT set, they are BLOCKED if the price is between high and low.
        if (!accountDetails.orderBetweenHighLow || getMarket.other.orderBetweenHighLowDisabled) {
            // Standard High/Low Circuit Check (Blocks if INSIDE range)
            if (price >= liveStock.Low && price <= liveStock.High) {
                return { isValid: false, message: "Rate should not be in between high and low" };
            }
        }
        // If orderBetweenHighLow is true, we bypass the circuit and bid/ask spread checks.

            if (reqData.marketId != "3" && accountDetails.orderLimitValue > 0) {
            // 4. Order Limit Value Range Check (e.g. 5% from LTP)
            const updownPrice = reqData.transactionType == "SELL" ? (liveStock.bid * accountDetails.orderLimitValue) / 100 : (liveStock.ask * accountDetails.orderLimitValue) / 100;
            const minTradePrice = reqData.transactionType == "SELL" ? liveStock.bid - updownPrice : liveStock.ask - updownPrice;
            const maxTradePrice = reqData.transactionType == "SELL" ? liveStock.bid + updownPrice : liveStock.ask + updownPrice;
             if (price < minTradePrice || price > maxTradePrice) {

                return {
                    isValid: false,
                    message: `Rate should be in between ${minTradePrice.toFixed(2)} and ${maxTradePrice.toFixed(2)}`
                };
            }
        }

        // 4a. Square Off Disabled Time Check (Updated to use FIFO Profitable check)
        const squareOffTimeoutValidation = await CommonStockValidator.validateSquareOffTimeout(reqData, services, liveStock);
        if (!squareOffTimeoutValidation.isValid) {
            return squareOffTimeoutValidation;
        }

        // 4b. Short Sell Allowed Check
        const shortSellValidation = await CommonStockValidator.validateShortSellAllowed(reqData, services);
        if (!shortSellValidation.isValid) {
            return shortSellValidation;
        }

        // 5. Fresh Limit Allowed Check (Hierarchical - Polished)
        // If freshLimitAllowed is disabled in user OR any parent, user cannot create NEW positions OR INCREASE existing positions.
        // They can only reduce/exit existing positions, within the limit of their current position (measured in LOTS).
        
        // Skip fresh limit validation if this is an edit and quantity/lot hasn't changed
        const isEdit = reqData?.isEdit === true;
        const isQuantityChanged = reqData?.isQuantityChanged === true;
        const isLotChanged = reqData?.isLotChanged === true;
        const editingTradeId = reqData?.tradeId; // Get the trade ID being edited
        
        const shouldCheckFreshLimit = !isEdit || isQuantityChanged || isLotChanged;
        
        console.log(`[LIMIT-DEBUG][FreshLimitHierarchy] shouldCheck=${shouldCheckFreshLimit} userId=${userId} marketId=${marketId} isEdit=${isEdit} qtyChanged=${isQuantityChanged} lotChanged=${isLotChanged}`);
        const isFreshLimitDisabled = shouldCheckFreshLimit ? await checkFreshLimitDisabledInHierarchy(userId, services.parentIds, marketId) : false;
        console.log(`[LIMIT-DEBUG][FreshLimitHierarchy] Result=${isFreshLimitDisabled} userId=${userId} marketId=${marketId}`);

        if (isFreshLimitDisabled) {
            const { getUserPendingQuantity } = require("../services/StockService");

            // Normalize values for reliable matching
            const tType = String(transactionType).toUpperCase();
            const sId = String(scriptId);
            const sLabel = String(label || reqData.label || "");
            const sName = String(scriptName || reqData.scriptName || "");
            const uId = new mongoose.Types.ObjectId(userId);
            const vId = new mongoose.Types.ObjectId(getValan._id);

            // Fetch positions matching by multiple possible identifiers for robustness
            const positionList = await getUserPosition({
                userId: uId,
                valanId: vId,
                marketId: String(marketId),
                $or: [
                    { scriptId: sId },
                    { label: sLabel },
                    { scriptName: sName }
                ]
            });


            // Sum quantities AND lots from all matching position rows
            let totalBuyQty = 0;
            let totalSellQty = 0;
            let totalBuyLot = 0;
            let totalSellLot = 0;
            
            if (positionList && positionList.length > 0) {
                positionList.forEach(pos => {
                    totalBuyQty += Number(pos.buyQuantity) || 0;
                    totalSellQty += Number(pos.sellQuantity) || 0;
                    totalBuyLot += Number(pos.buyLot) || 0;
                    totalSellLot += Number(pos.sellLot) || 0;
                });
            }

            let netQty = totalBuyQty - totalSellQty;
            let netLot = Number((totalBuyLot - totalSellLot).toFixed(4));
            const currentQty = Number(reqData.quantity) || 0;
            const currentLot = Number(reqData.lot) || 0;

            
            if (netQty === 0 && netLot === 0) {
                return { isValid: false, message: "Fresh Limit not allowed. You do not hold any position in this script to exit." };
            }

            // Check if this trade side would increase/create a new position (Strict fresh limit)
            // Use quantity for more accurate comparison
            const isIncreasingPosition =
                (netQty > 0 && tType === 'BUY') ||  // Long position, buying more
                (netQty < 0 && tType === 'SELL');   // Short position, selling more

            if (isIncreasingPosition) {
                const posType = netQty > 0 ? "Long (Buy)" : "Short (Sell)";
                return { isValid: false, message: `Fresh Limit not allowed. You already hold a ${posType} position (${Math.abs(netQty)} qty) and cannot increase it.` };
            }

            // Prevent over-squaring by checking existing position + other pending square-off orders
            const pendingOrders = await getUserPendingQuantity({
                userId: uId,
                valanId: vId, // Pending orders are usually for the current valan
                transactionStatus: "PENDING"
            });

            // Filter pending orders in code AND exclude the trade being edited
            const pendingList = (pendingOrders || []).filter(res => {
                const isMatchingScript = String(res._id?.scriptId) === sId ||
                    String(res.lastTransaction?.label) === sLabel ||
                    String(res.lastTransaction?.scriptName) === sName ||
                    String(res.lastTransaction?.symbol) === sId;
                
                // If this is an edit, exclude the trade being edited from pending calculations
                if (isEdit && editingTradeId && res.lastTransaction?._id) {
                    const isEditingTrade = String(res.lastTransaction._id) === String(editingTradeId);
                    return isMatchingScript && !isEditingTrade;
                }
                
                return isMatchingScript;
            });

            // Sum up pending quantities AND lots (excluding the trade being edited)
            let pendingBuyQty = 0;
            let pendingSellQty = 0;
            let pendingBuyLot = 0;
            let pendingSellLot = 0;
            
            pendingList.forEach(res => {
                pendingBuyQty += Number(res.BUY_QTY) || 0;
                pendingSellQty += Number(res.SELL_QTY) || 0;
                pendingBuyLot += Number(res.BUY_LOT) || 0;
                pendingSellLot += Number(res.SELL_LOT) || 0;
            });

            if (netQty > 0) { // Current Long: can only place SELL orders to reduce
                if (tType !== 'SELL') {
                    return { isValid: false, message: `Fresh Limit not allowed. You can only place SELL orders to exit your Long position (${netQty} qty).` };
                }
                
                // Check both quantity and lot limits
                const totalSellQtyAttempted = pendingSellQty + currentQty;
                const totalSellLotAttempted = Number((pendingSellLot + currentLot).toFixed(4));
                const availableQtyToSell = Math.max(0, netQty - pendingSellQty);
                const availableLotToSell = Math.max(0, Number((netLot - pendingSellLot).toFixed(4)));
                  
                // Use quantity as primary check, lot as secondary
                if (totalSellQtyAttempted > netQty) {
                    return {
                        isValid: false,
                        message: `Fresh Limit not allowed. Total Sell quantity ${totalSellQtyAttempted} exceeds Buy position ${netQty}. Available to sell: ${availableQtyToSell} qty`
                    };
                }
                
                // Also check lot limit as backup (in case quantity data is missing)
                if (totalSellLotAttempted > netLot && availableQtyToSell === 0) {
                    return {
                        isValid: false,
                        message: `Fresh Limit not allowed. Total Sell lots ${totalSellLotAttempted} exceeds Buy position ${netLot} lots. Available to sell: ${availableLotToSell} lots`
                    };
                }
                
            } else if (netQty < 0) { // Current Short: can only place BUY orders to reduce
                if (tType !== 'BUY') {
                    return { isValid: false, message: `Fresh Limit not allowed. You can only place BUY orders to exit your Short position (${Math.abs(netQty)} qty).` };
                }
                
                const absNetQty = Math.abs(netQty);
                const absNetLot = Math.abs(netLot);
                const totalBuyQtyAttempted = pendingBuyQty + currentQty;
                const totalBuyLotAttempted = Number((pendingBuyLot + currentLot).toFixed(4));
                const availableQtyToBuy = Math.max(0, absNetQty - pendingBuyQty);
                const availableLotToBuy = Math.max(0, Number((absNetLot - pendingBuyLot).toFixed(4)));
                
                // Use quantity as primary check, lot as secondary
                if (totalBuyQtyAttempted > absNetQty) {
                    return {
                        isValid: false,
                        message: `Fresh Limit not allowed. Total Buy quantity ${totalBuyQtyAttempted} exceeds Sell position ${absNetQty}. Available to buy: ${availableQtyToBuy} qty`
                    };
                }
                
                // Also check lot limit as backup (in case quantity data is missing)
                if (totalBuyLotAttempted > absNetLot && availableQtyToBuy === 0) {
                    return {
                        isValid: false,
                        message: `Fresh Limit not allowed. Total Buy lots ${totalBuyLotAttempted} exceeds Sell position ${absNetLot} lots. Available to buy: ${availableLotToBuy} lots`
                    };
                }
            }

        }

        return { isValid: true };
    }
};

const ManualOrderValidator = {
    // Manual trades often bypass strict checks, but we enforce Limits/Brokerage
    async validate(reqData, services) {
        // Check Min Script Rate
        const { getMarket } = services;
        const { marketId, price, transactionType } = reqData;

        if (marketId == "2" && +price < +getMarket.brokerage.minScriptRate) {
            return { isValid: false, message: "Min Script rate is " + getMarket.brokerage.minScriptRate };
        }
        if (marketId == "3" && +price < +getMarket.other.minRateScriptBlock && transactionType == "BUY") {
            return { isValid: false, message: "Min Script rate is " + getMarket.other.minRateScriptBlock };
        }
        return { isValid: true };
    }
};

module.exports = {
    CommonStockValidator,
    MarketOrderValidator,
    LimitOrderValidator,
    ManualOrderValidator
};
