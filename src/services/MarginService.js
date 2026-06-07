const mongoose = require("mongoose");
const UserModel = require("../models/UserModel");
const StockTransaction = require("../models/StockTransactionModel");
const UserPosition = require("../models/UserPositionModel");
const QuantitySettingModel = require("../models/QuantitySettingModel");
const LotSettingModel = require("../models/LotSettingModel");

/**
 * Calculate used margin for a user in a specific market
 * Includes BOTH open positions (COMPLETED) AND pending limit trades (PENDING)
 * @param {String} userId - User ID
 * @param {String} marketId - Market ID
 * @param {String} valanId - Current valan ID
 * @returns {Object} - { usedLots, usedAmount }
 */
exports.calculateUsedMargin = async (userId, marketId, valanId, excludeTradeId = null) => {
    try {
        // 1. Get completed positions for this user/market/valan
        const positions = await UserPosition.find({
            userId: new mongoose.Types.ObjectId(userId),
            marketId: marketId,
            valanId: new mongoose.Types.ObjectId(valanId)
        }).lean();

        const matchQuery = {
            userId: new mongoose.Types.ObjectId(userId),
            marketId: marketId,
            valanId: new mongoose.Types.ObjectId(valanId),
            transactionStatus: "PENDING"
        };

        if (excludeTradeId) {
            matchQuery._id = { $ne: new mongoose.Types.ObjectId(excludeTradeId) };
        }

        // 2. Get pending limit orders from StockTransaction
        const pendingTransactions = await StockTransaction.aggregate([
            {
                $match: matchQuery
            },
            {
                $group: {
                    _id: "$scriptId",
                    pendingNetLot: {
                        $sum: {
                            $cond: [
                                { $eq: ["$transactionType", "BUY"] },
                                "$lot",
                                { $multiply: ["$lot", -1] }
                            ]
                        }
                    },
                    pendingNetAmount: {
                        $sum: {
                            $cond: [
                                { $eq: ["$transactionType", "BUY"] },
                                "$totalOrderPrice",
                                { $multiply: ["$totalOrderPrice", -1] }
                            ]
                        }
                    },
                    pendingNetQty: {
                        $sum: {
                            $cond: [
                                { $eq: ["$transactionType", "BUY"] },
                                "$quantity",
                                { $multiply: ["$quantity", -1] }
                            ]
                        }
                    }
                }
            }
        ]);

        const scriptWise = {};

        // 3. Initialize from completed positions (Purely based on open net position)
        positions.forEach(p => {
            const scriptId = p.scriptId.toString();
            const netLot = (p.buyLot || 0) - (p.sellLot || 0);
            const netQty = (p.buyQuantity || 0) - (p.sellQuantity || 0);

            let netAmount = 0;
            if (netQty > 0) {
                // Long: use average buy price to value the open position
                const avgBuyPrice = (p.buyPrice || 0) / (p.buyQuantity || 1);
                netAmount = netQty * avgBuyPrice;
            } else if (netQty < 0) {
                // Short: use average sell price to value the open position
                const avgSellPrice = (p.sellPrice || 0) / (p.sellQuantity || 1);
                netAmount = netQty * avgSellPrice; // netQty is negative
            }

            scriptWise[scriptId] = {
                netLot: netLot,
                netAmount: netAmount,
                netQty: netQty
            };
        });

        // 4. Overlay pending transactions
        pendingTransactions.forEach(pt => {
            const scriptId = pt._id.toString();
            if (!scriptWise[scriptId]) {
                scriptWise[scriptId] = { netLot: 0, netAmount: 0, netQty: 0 };
            }
            scriptWise[scriptId].netLot += pt.pendingNetLot;
            scriptWise[scriptId].netAmount += pt.pendingNetAmount;
            scriptWise[scriptId].netQty += pt.pendingNetQty;
        });

        let usedLots = 0;
        let usedAmount = 0;

        // 5. Sum absolute net positions to get total used margin
        // This ensures hedging on same script reduces total, but across different scripts it adds up.
        for (const sId in scriptWise) {
            usedLots += Math.abs(scriptWise[sId].netLot);
            usedAmount += Math.abs(scriptWise[sId].netAmount);
        }

        return {
            usedLots,
            usedAmount,
            scriptPositions: scriptWise
        };
    } catch (error) {
        console.error("Error calculating used margin:", error);
        return { usedLots: 0, usedAmount: 0, scriptPositions: {} };
    }
};

/**
 * Get margin limits for a user in a specific market
 * @param {String} userId - User ID
 * @param {String} marketId - Market ID
 * @returns {Object} - Margin configuration
 */
exports.getUserMarginLimits = async (userId, marketId, scriptId = null, price = 0) => {
    try {
        const user = await UserModel.findById(userId)
            .select('marketAccess')
            .lean();

        if (!user) {
            console.warn(`[MarginLimits] User not found: ${userId}`);
            return null;
        }

        if (!user.marketAccess || user.marketAccess.length === 0) {
            console.warn(`[MarginLimits] User has NO marketAccess configured: ${userId}`);
            return null;
        }

        const marketConfig = user.marketAccess.find(m => String(m.marketId) == String(marketId));

        if (!marketConfig) {
            console.warn(`[MarginLimits] marketId ${marketId} NOT FOUND in user's marketAccess. Available IDs: ${user.marketAccess.map(m => m.marketId).join(', ')}`);
            return null;
        }

        // Fetch all quantity limits for this market
        const marketLimitsList = await QuantitySettingModel.find({
            clientId: userId,
            marketId: marketId
        }).lean();

        let baseLotLimit = Number(marketConfig.margin?.totalLotWise) || 0;
        let baseMarginLimit = Number(marketConfig.margin?.totalMargin) || 0;
        let effectiveLimit = Number(marketConfig.margin?.maximumLimit) || 0;
        const lotOrAmount = marketConfig.margin?.lotOrAmount || 'amount';

        // User requested: "script wise quantity settings. make sure that gets more priority then both of these"
        // Priority order: 
        // 1. Script-specific QuantitySetting (if scriptId provided)
        // 2. Lower of (Market Access Margin limit) and (QuantitySetting "999" default)

        /**
         * Selects the most appropriate limit from the list based on scriptId and price range
         */
        const selectLimit = (sid, p) => {
            const relevant = marketLimitsList.filter(l => String(l.scriptId) === String(sid));
            if (relevant.length === 0) return null;

            // 1. Range match
            const rangeMatch = relevant.find(l => {
                const hasRange = l.isRange === true || l.startRange > 0 || l.endRange > 0;
                return hasRange && p >= l.startRange && p <= l.endRange;
            });
            if (rangeMatch) return rangeMatch;

            // 2. General match (no range)
            const general = relevant.find(l => l.isRange !== true && l.startRange === 0 && l.endRange === 0);
            return general || relevant[0];
        };

        let scriptLimit = null;
        if (scriptId) {
            scriptLimit = selectLimit(scriptId, price);
        }

        if (scriptLimit && scriptLimit.positionLimit > 0) {
            // SCRIPT-SPECIFIC PRIORITY (Overrides BOTH marketAccess and 999 for this trade)
            const pLimit = Number(scriptLimit.positionLimit);
            if (lotOrAmount === 'lot' && (scriptLimit.qtySetting === 'Lot' || scriptLimit.qtySetting === 'Qty')) {
                effectiveLimit = pLimit;
            } else if (lotOrAmount === 'amount' && scriptLimit.qtySetting === 'Value') {
                effectiveLimit = pLimit;
            }
        } else {
            // General market-wide logic (min of Market Access and "999")
            const defaultMarketLimit = selectLimit("999", price);
            if (defaultMarketLimit && defaultMarketLimit.positionLimit > 0) {
                const pLimit = Number(defaultMarketLimit.positionLimit);
                if (lotOrAmount === 'lot' && (defaultMarketLimit.qtySetting === 'Lot' || defaultMarketLimit.qtySetting === 'Qty')) {
                    // ELECT LOWER ONE AS LIMIT (as requested)
                    if (effectiveLimit > 0) {
                        effectiveLimit = Math.min(effectiveLimit, pLimit);
                        baseLotLimit = Math.min(baseLotLimit, pLimit);
                    } else {
                        effectiveLimit = pLimit;
                        baseLotLimit = pLimit;
                    }
                } else if (lotOrAmount === 'amount' && defaultMarketLimit.qtySetting === 'Value') {
                    // ELECT LOWER ONE AS LIMIT (as requested)
                    if (effectiveLimit > 0) {
                        effectiveLimit = Math.min(effectiveLimit, pLimit);
                        baseMarginLimit = Math.min(baseMarginLimit, pLimit);
                    } else {
                        effectiveLimit = pLimit;
                        baseMarginLimit = pLimit;
                    }
                }
            }
        }

        return {
            lotOrAmount: lotOrAmount,
            totalLotWise: baseLotLimit,
            totalMargin: baseMarginLimit,
            maximumLimit: effectiveLimit,
            marketId: marketConfig.marketId,
            marketName: marketConfig.marketName
        };
    } catch (error) {
        console.error("Error getting user margin limits:", error);
        return null;
    }
};

/**
 * Check if user can trade based on margin limits — 3-layer validation:
 *
 *  Layer 1 (ALWAYS):   User's absolute maximumLimit from marketAccess vs TOTAL positions across all scripts.
 *  Layer 2 (script):   Script-specific QuantitySetting vs ONLY that script's own net position.
 *                      When Layer 2 applies, Layer 3 is SKIPPED for this script.
 *  Layer 3 (global):   "999" QuantitySetting vs TOTAL positions. Only when no script-specific setting exists.
 *
 * This ensures GOLD's 10-lot limit only counts GOLD's position, NOT Silver or any other script.
 * The user's absolute max (e.g. 30) is always the hard ceiling regardless of script limits.
 *
 * @param {String} userId          - User ID
 * @param {String} marketId        - Market ID
 * @param {String} valanId         - Current valan ID
 * @param {Number} lot             - Lot size for the trade
 * @param {Number} amount          - Order amount
 * @param {String} transactionType - 'BUY' or 'SELL'
 * @param {String} scriptId        - Script being traded
 * @param {Number} quantity        - Quantity for the trade
 * @param {String} excludeTradeId  - Pending trade to exclude (for limit order edits)
 * @returns {Object} { canTrade, message, details }
 */
exports.checkMarginAvailability = async (userId, marketId, valanId, lot, amount, transactionType, scriptId = null, quantity = 0, excludeTradeId = null, scriptName = null) => {
    try {
        const orderPrice = quantity > 0 ? (amount / quantity) : 0;
        const lotNum = Number(lot) || 0;
        const amountNum = Number(amount) || 0;

        // ── Fetch everything in parallel ──────────────────────────────────────────
        const [userDoc, allQtySettings, usedMarginData, lotSettingDoc] = await Promise.all([
            UserModel.findById(userId).select('marketAccess').lean(),
            QuantitySettingModel.find({ clientId: userId, marketId: marketId }).lean(),
            this.calculateUsedMargin(userId, marketId, valanId, excludeTradeId),
            LotSettingModel.findOne({ marketId, scriptName: String(scriptName || '').toUpperCase() }).lean()
        ]);

        let lotSize = 1;
        if (lotSettingDoc) {
            lotSize = Number(lotSettingDoc.quantity) || 1;
        }

        if (!userDoc) {
            return { canTrade: false, message: 'Market access not configured for this user', details: null };
        }

        const marketConfig = (userDoc.marketAccess || []).find(m => String(m.marketId) == String(marketId));
        if (!marketConfig) {
            return { canTrade: false, message: 'Market access not configured for this user', details: null };
        }

        const { usedLots, usedAmount, scriptPositions } = usedMarginData;
        const lotOrAmount = marketConfig.margin?.lotOrAmount || 'amount';

        // ── Helper: pick the best-matching QtyLimit record from a list ────────────
        const selectLimit = (list, p) => {
            if (!list || list.length === 0) return null;
            const rangeMatch = list.find(l => {
                const hasRange = l.isRange === true || l.startRange > 0 || l.endRange > 0;
                return hasRange && p >= l.startRange && p <= l.endRange;
            });
            if (rangeMatch) return rangeMatch;
            const general = list.find(l => l.isRange !== true && l.startRange === 0 && l.endRange === 0);
            return general || list[0];
        };

        // ── Resolve script-specific and global "999" QuantitySettings ─────────────
        const scriptQtyRecords = scriptId
            ? allQtySettings.filter(l => String(l.scriptId) === String(scriptId))
            : [];
        const globalQtyRecords = allQtySettings.filter(l => String(l.scriptId) === '999');

        const scriptQtySetting = selectLimit(scriptQtyRecords, orderPrice);
        const globalQtySetting = selectLimit(globalQtyRecords, orderPrice);

        // ── Absolute ceilings from marketAccess (ALWAYS enforced as hard max) ──────
        const absoluteLotCeiling = Number(marketConfig.margin?.maximumLimit) || 0;
        const absoluteAmountCeiling = Number(marketConfig.margin?.maximumLimit) || 0;

        // ── Current net position for the traded script ─────────────────────────────
        const currentScriptPos = (scriptId && scriptPositions[String(scriptId)]) || { netLot: 0, netAmount: 0, netQty: 0 };

        // ─────────────────────────────────────────────────────────────────────────────
        // LAYER 1: Absolute ceiling — always checked against TOTAL positions
        // ─────────────────────────────────────────────────────────────────────────────
        let absoluteCeilingHit = false;
        let absoluteCeilingMessage = "";
        let absoluteCeilingDetails = null;

        if (lotOrAmount === 'lot') {
            if (absoluteLotCeiling > 0) {
                // If lot is 0 but quantity > 0, calculate equivalent lots for absolute ceiling validation
                let effectiveLotImpact = lotNum;
                if (effectiveLotImpact === 0 && quantity > 0) {
                    effectiveLotImpact = Number(quantity) / lotSize;
                }

                const currentNet = Number(currentScriptPos.netLot);
                const change = transactionType === 'BUY' ? effectiveLotImpact : -effectiveLotImpact;
                const newScriptNet = currentNet + change;
                const rawDelta = Math.abs(newScriptNet) - Math.abs(currentNet);
                // SECURITY FIX: A negative netLot (sell > buy data anomaly) must NOT subsidise
                // new trades. The minimum delta is (effectiveLotImpact - |currentNet|) so the
                // user never benefits from a corrupted opposite-direction position.
                const minDelta = effectiveLotImpact - Math.abs(currentNet);
                const totalDelta = Math.max(rawDelta, minDelta);
                const predictedTotal = (Number(usedLots) || 0) + totalDelta;

                if (predictedTotal > absoluteLotCeiling) {
                    const available = absoluteLotCeiling - (Number(usedLots) || 0);
                    absoluteCeilingHit = true;
                    absoluteCeilingMessage = `Maximum lot limit exceeded. Max Allowed: ${absoluteLotCeiling}, Current Used: ${usedLots}, Predicted After Trade: ${predictedTotal.toFixed(2)}. Available: ${available > 0 ? available.toFixed(2) : 0}`;
                    absoluteCeilingDetails = { layer: 'absolute_ceiling', lotOrAmount, absoluteLotCeiling, currentUsed: usedLots, predictedUsed: predictedTotal };
                }
            }
        } else {
            if (absoluteAmountCeiling > 0) {
                const currentNet = Number(currentScriptPos.netAmount);
                const change = transactionType === 'BUY' ? amountNum : -amountNum;
                const newScriptNet = currentNet + change;
                const rawDelta = Math.abs(newScriptNet) - Math.abs(currentNet);
                // SECURITY FIX: minimum delta prevents a negative netAmount subsidising new trades
                const minDelta = amountNum - Math.abs(currentNet);
                const totalDelta = Math.max(rawDelta, minDelta);
                const predictedTotal = (Number(usedAmount) || 0) + totalDelta;

                if (predictedTotal > absoluteAmountCeiling) {
                    const available = absoluteAmountCeiling - (Number(usedAmount) || 0);
                    absoluteCeilingHit = true;
                    absoluteCeilingMessage = `Maximum margin limit exceeded. Max Allowed: ${absoluteAmountCeiling.toFixed(2)}, Current Used: ${(usedAmount || 0).toFixed(2)}, Predicted After Trade: ${predictedTotal.toFixed(2)}. Available: ${(available > 0 ? available : 0).toFixed(2)}`;
                    absoluteCeilingDetails = { layer: 'absolute_ceiling', lotOrAmount, absoluteAmountCeiling, currentUsed: usedAmount, predictedUsed: predictedTotal };
                }
            }
        }

        // If absolute ceiling hit, we block immediately regardless of other settings
        if (absoluteCeilingHit) {
            return { canTrade: false, message: absoluteCeilingMessage, details: absoluteCeilingDetails };
        }

        // ─────────────────────────────────────────────────────────────────────────────
        // LAYER 2: Script-specific QtyLimit — checks ONLY this script's own net position
        //   When this fires, Layer 3 (global "999") is SKIPPED for this script.
        // ─────────────────────────────────────────────────────────────────────────────
        if (scriptQtySetting && Number(scriptQtySetting.positionLimit) > 0) {
            const scriptSpecificLimit = Number(scriptQtySetting.positionLimit);

            if (scriptQtySetting.qtySetting === 'Lot') {
                const currentNetLot = Number(currentScriptPos.netLot) || 0;
                const changeLot = transactionType === 'BUY' ? lotNum : -lotNum;
                const newNetLot = currentNetLot + changeLot;
                // SECURITY FIX: if sell > buy (netLot is negative/opposite direction to this trade),
                // the checked position must be at least `lotNum` — the opposite position cannot
                // subsidise the new trade and give the user free capacity.
                const isBuy = transactionType === 'BUY';
                const oppositeCredit = isBuy ? Math.max(0, -currentNetLot) : Math.max(0, currentNetLot);
                const effectiveNewPosition = Math.max(Math.abs(newNetLot), lotNum - oppositeCredit);

                if (effectiveNewPosition > scriptSpecificLimit) {
                    return {
                        canTrade: false,
                        message: `Lot limit exceeded for ${scriptId}. Script Limit: ${scriptSpecificLimit}, Current Position: ${Math.abs(currentNetLot)}, Predicted After Trade: ${effectiveNewPosition}. Available: ${Math.max(0, scriptSpecificLimit - Math.abs(currentNetLot))}`,
                        details: { layer: 'script_specific', scriptId, scriptSpecificLimit, currentNet: currentNetLot, predicted: effectiveNewPosition }
                    };
                }
            } else if (scriptQtySetting.qtySetting === 'Qty') {
                const currentNetQty = Number(currentScriptPos.netQty) || 0;
                const changeQty = transactionType === 'BUY' ? Number(quantity) : -Number(quantity);
                const newNetQty = currentNetQty + changeQty;
                // SECURITY FIX: same as Lot — prevent opposite-direction subsidy
                const isBuy = transactionType === 'BUY';
                const oppositeCredit = isBuy ? Math.max(0, -currentNetQty) : Math.max(0, currentNetQty);
                const effectiveNewQty = Math.max(Math.abs(newNetQty), Number(quantity) - oppositeCredit);

                if (effectiveNewQty > scriptSpecificLimit) {
                    return {
                        canTrade: false,
                        message: `Quantity limit exceeded for ${scriptId}. Script Limit: ${scriptSpecificLimit}, Current Position: ${Math.abs(currentNetQty)}, Predicted After Trade: ${effectiveNewQty}. Available: ${Math.max(0, scriptSpecificLimit - Math.abs(currentNetQty))}`,
                        details: { layer: 'script_specific', scriptId, scriptSpecificLimit, currentNet: currentNetQty, predicted: effectiveNewQty }
                    };
                }
            } else if (scriptQtySetting.qtySetting === 'Value') {
                const currentNetAmount = Number(currentScriptPos.netAmount) || 0;
                const changeAmount = transactionType === 'BUY' ? amountNum : -amountNum;
                const newNetAmount = currentNetAmount + changeAmount;
                // SECURITY FIX: prevent opposite-direction amount subsidy
                const isBuy = transactionType === 'BUY';
                const oppositeCredit = isBuy ? Math.max(0, -currentNetAmount) : Math.max(0, currentNetAmount);
                const effectiveNewAmount = Math.max(Math.abs(newNetAmount), amountNum - oppositeCredit);

                if (effectiveNewAmount > scriptSpecificLimit) {
                    return {
                        canTrade: false,
                        message: `Margin limit exceeded for ${scriptId}. Script Limit: ${scriptSpecificLimit.toFixed(2)}, Current Position: ${Math.abs(currentNetAmount).toFixed(2)}, Predicted After Trade: ${effectiveNewAmount.toFixed(2)}. Available: ${Math.max(0, scriptSpecificLimit - Math.abs(currentNetAmount)).toFixed(2)}`,
                        details: { layer: 'script_specific', scriptId, scriptSpecificLimit, currentNet: currentNetAmount, predicted: effectiveNewAmount }
                    };
                }
            }

            // Script-specific check passed — skip Layer 3 for this script, allow trade.
            return {
                canTrade: true,
                message: 'Margin available',
                details: { layer: 'script_specific', lotOrAmount, scriptSpecificLimit, currentScript: currentScriptPos }
            };
        }

        // ─────────────────────────────────────────────────────────────────────────────
        // LAYER 3: Global "all-scripts" QtyLimit (scriptId = "999")
        //   Only reached when NO script-specific setting exists for the traded script.
        //   Checks total positions across all scripts.
        // ─────────────────────────────────────────────────────────────────────────────
        if (globalQtySetting && Number(globalQtySetting.positionLimit) > 0) {
            const globalLimit = Number(globalQtySetting.positionLimit);

            if (lotOrAmount === 'lot' && (globalQtySetting.qtySetting === 'Lot' || globalQtySetting.qtySetting === 'Qty')) {
                const currentNet = Number(currentScriptPos.netLot);
                const change = transactionType === 'BUY' ? lotNum : -lotNum;
                const newScriptNet = currentNet + change;
                const rawDelta = Math.abs(newScriptNet) - Math.abs(currentNet);
                // SECURITY FIX: prevent opposite-direction subsidy at global level
                const minDelta = lotNum - Math.abs(currentNet);
                const totalDelta = Math.max(rawDelta, minDelta);
                const predictedTotal = (Number(usedLots) || 0) + totalDelta;

                if (predictedTotal > globalLimit) {
                    const available = globalLimit - (Number(usedLots) || 0);
                    return {
                        canTrade: false,
                        message: `Lot limit exceeded. Limit: ${globalLimit}, Current Used: ${usedLots}, Predicted After Trade: ${predictedTotal}. Available: ${available > 0 ? available : 0}`,
                        details: { layer: 'global_999', lotOrAmount, globalLimit, currentUsed: usedLots, predictedUsed: predictedTotal }
                    };
                }
            } else if (lotOrAmount === 'amount' && globalQtySetting.qtySetting === 'Value') {
                const currentNet = Number(currentScriptPos.netAmount);
                const change = transactionType === 'BUY' ? amountNum : -amountNum;
                const newScriptNet = currentNet + change;
                const rawDelta = Math.abs(newScriptNet) - Math.abs(currentNet);
                // SECURITY FIX: prevent opposite-direction subsidy at global level
                const minDelta = amountNum - Math.abs(currentNet);
                const totalDelta = Math.max(rawDelta, minDelta);
                const predictedTotal = (Number(usedAmount) || 0) + totalDelta;

                if (predictedTotal > globalLimit) {
                    const available = globalLimit - (Number(usedAmount) || 0);
                    return {
                        canTrade: false,
                        message: `Margin limit exceeded. Limit: ${globalLimit.toFixed(2)}, Current Used: ${(usedAmount || 0).toFixed(2)}, Predicted After Trade: ${predictedTotal.toFixed(2)}. Available: ${(available > 0 ? available : 0).toFixed(2)}`,
                        details: { layer: 'global_999', lotOrAmount, globalLimit, currentUsed: usedAmount, predictedUsed: predictedTotal }
                    };
                }
            }
        }


        // All layers passed — allow trade
        return {
            canTrade: true,
            message: 'Margin available',
            details: { lotOrAmount, currentUsedLots: usedLots, currentUsedAmount: usedAmount }
        };
    } catch (error) {
        console.error("Error checking margin availability:", error);
        return {
            canTrade: false,
            message: 'Error checking margin limits',
            details: null
        };
    }
};

/**
 * Calculate total margin allocated to downline users
 * @param {String} userId - Parent user ID
 * @param {String} marketId - Market ID
 * @returns {Object} - { totalAllocatedLots, totalAllocatedAmount }
 */
exports.calculateDownlineAllocatedMargin = async (userId, marketId) => {
    try {
        const downlineUsers = await UserModel.find({
            'createdBy.userId': userId,
            demoid: { $ne: true }
        })
            .select('marketAccess')
            .lean();

        let totalAllocatedLots = 0;
        let totalAllocatedAmount = 0;

        for (const user of downlineUsers) {
            const marketConfig = user.marketAccess?.find(m => m.marketId == marketId);
            if (marketConfig) {
                totalAllocatedLots += marketConfig.margin?.totalLotWise || 0;
                totalAllocatedAmount += marketConfig.margin?.totalMargin || 0;
            }
        }

        return {
            totalAllocatedLots,
            totalAllocatedAmount,
            count: downlineUsers.length
        };
    } catch (error) {
        console.error("Error calculating downline allocated margin:", error);
        return {
            totalAllocatedLots: 0,
            totalAllocatedAmount: 0,
            count: 0
        };
    }
};

/**
 * Check if parent can allocate margin to a new/edited user
 * Prevents account creation if parent doesn't have available margin
 * @param {String} parentId - Parent user ID
 * @param {String} marketId - Market ID
 * @param {Number} requestedLots - Lots to allocate
 * @param {Number} requestedAmount - Amount to allocate
 * @param {String} lotOrAmount - 'lot' or 'amount'
 * @param {String} excludeUserId - User ID to exclude (for edit operations)
 * @returns {Object} - { canAllocate: boolean, message: string, details: object }
 */
exports.checkParentCanAllocateMargin = async (
    parentId,
    marketId,
    requestedLots,
    requestedAmount,
    lotOrAmount,
    excludeUserId = null,
    marketName = 'this market'
) => {
    try {
        // Read parent's raw marketAccess directly from DB for allocation purposes.
        // We intentionally do NOT use getUserMarginLimits() here because that function
        // applies QuantitySetting overrides (e.g. Math.min(baseLotLimit, pLimit)) which
        // are meant for per-trade checks and would incorrectly shrink the distribution pool.
        const parentUser = await UserModel.findById(parentId)
            .select('marketAccess')
            .lean();

        if (!parentUser) {
            return {
                canAllocate: false,
                message: `Parent does not have access to ${marketName}`,
                details: null
            };
        }

        const parentMarketConfig = parentUser.marketAccess?.find(m => String(m.marketId) == String(marketId));

        if (!parentMarketConfig) {
            return {
                canAllocate: false,
                message: `Parent does not have access to ${marketName}`,
                details: null
            };
        }

        // Get total allocated to downline (excluding the user being edited)
        const downlineUsers = await UserModel.find({
            'createdBy.userId': parentId,
            demoid: { $ne: true },
            ...(excludeUserId ? { _id: { $ne: excludeUserId } } : {})
        })
            .select('marketAccess')
            .lean();

        let totalAllocatedLots = 0;
        let totalAllocatedAmount = 0;

        for (const user of downlineUsers) {
            const marketConfig = user.marketAccess?.find(m => m.marketId == marketId);
            if (marketConfig) {
                totalAllocatedLots += marketConfig.margin?.totalLotWise || 0;
                totalAllocatedAmount += marketConfig.margin?.totalMargin || 0;
            }
        }

        // Use raw values from marketAccess (not adjusted by QuantitySettings)
        const parentTotalLots = Number(parentMarketConfig.margin?.totalLotWise) || 0;
        const parentTotalAmount = Number(parentMarketConfig.margin?.totalMargin) || 0;
        const reqLots = Number(requestedLots) || 0;
        const reqAmount = Number(requestedAmount) || 0;

        if (lotOrAmount === 'lot') {
            const availableLots = parentTotalLots - totalAllocatedLots;

            if (reqLots > availableLots) {
                return {
                    canAllocate: false,
                    message: `Cannot create account for ${marketName}. Parent has ${parentTotalLots} lots total, ${totalAllocatedLots} already allocated, only ${availableLots} available. Requested: ${reqLots} lots`,
                    details: {
                        lotOrAmount: 'lot',
                        parentTotal: parentTotalLots,
                        allocated: totalAllocatedLots,
                        available: availableLots,
                        requested: reqLots,
                        exceeded: reqLots - availableLots
                    }
                };
            }

            return {
                canAllocate: true,
                message: 'Allocation allowed',
                details: {
                    lotOrAmount: 'lot',
                    parentTotal: parentTotalLots,
                    allocated: totalAllocatedLots,
                    available: availableLots,
                    requested: reqLots,
                    afterAllocation: totalAllocatedLots + reqLots
                }
            };
        } else {
            const availableAmount = parentTotalAmount - totalAllocatedAmount;

            if (reqAmount > availableAmount) {
                return {
                    canAllocate: false,
                    message: `Cannot create account for ${marketName}. Parent has ${parentTotalAmount} total, ${totalAllocatedAmount} already allocated, only ${availableAmount.toFixed(2)} available. Requested: ${reqAmount.toFixed(2)}`,
                    details: {
                        lotOrAmount: 'amount',
                        parentTotal: parentTotalAmount,
                        allocated: totalAllocatedAmount,
                        available: availableAmount,
                        requested: reqAmount,
                        exceeded: reqAmount - availableAmount
                    }
                };
            }

            return {
                canAllocate: true,
                message: 'Allocation allowed',
                details: {
                    lotOrAmount: 'amount',
                    parentTotal: parentTotalAmount,
                    allocated: totalAllocatedAmount,
                    available: availableAmount,
                    requested: reqAmount,
                    afterAllocation: totalAllocatedAmount + reqAmount
                }
            };
        }
    } catch (error) {
        console.error("Error checking parent can allocate margin:", error);
        return {
            canAllocate: false,
            message: 'Error checking allocation limits',
            details: null
        };
    }
};
