const { getOtherBrokerDetails, getBaseScriptName } = require("../utils/StockUtils");
const mongoose = require("mongoose");
const NseEqBrokerageService = require("./NseEqBrokerageService");

/**
 * Centralized Brokerage Service
 * Handles calculation of brokerage for various trade types (Market, Limit, Square-off, Rollover)
 * Includes special handling for NSE-EQ delivery commission
 */
exports.calculateBrokerage = async (reqData, services) => {
    let {
        userId, marketId, marketName, scriptId, scriptName,
        quantity, transactionType, lot, price, type, label, valanId
    } = reqData;

    // Normalization
    quantity = Number(quantity) || 0;
    price = Number(price) || 0;
    lot = Number(lot) || 0;

    // Lazy load StockService to avoid circular dependency
    const { getUserQuantity } = require("./StockService");
    const { getMarket, basicDetails, getValan } = services || {};

    if (!getMarket) {
        throw new Error("Market configuration not found for brokerage calculation.");
    }

    // Use valanId from services if not provided
    if (!valanId && getValan) {
        valanId = getValan._id;
    }

    // 1. Get User Quantity Limits/Usage (split into Intraday vs Delivery)
    // Support override if already calculated
    const checkQuantity = reqData.quantityType || await getUserQuantity({
        userId,
        marketId,
        marketName,
        scriptId,
        scriptName,
        quantity,
        transactionType,
    });

    const totalOrderPrice = quantity * price;

    // 2. Determine Eligibility
    // BF, CF, FW trades do NOT have brokerage 
    const isBfCfFw = ["BF", "CF", "FW"].includes(type);
    const brokerageExplicitlyDisabled = reqData.brokerage === false || reqData.brokerage === 'false';
    const hasBrokerageConfig = !!getMarket.brokerage;

    const isPendingType = ['LIMIT', 'Limit', 'STOPPLOSS', 'STOPLOSS', 'SL', 'SL-M']
        .some(oType => String(reqData.orderType || '').toUpperCase().includes(oType));
    const isExecution = reqData.isExecution === true;
    
    // Automation types like "Auto Close" or "Square Off" should always have brokerage if config exists
    const isAutoTrade = ["Auto Close", "Auto Close (Exp)", "Square Off", "System Close"].includes(reqData.message);

    let hasBrokerage = !isBfCfFw && !brokerageExplicitlyDisabled && hasBrokerageConfig && 
                      (!isPendingType || isExecution || isAutoTrade);
    
    let intradayPct = 0;
    let deliveryPct = 0;
    let brokerageType = "percentage"; 
    let isClientScriptWise = false;

    if (hasBrokerage) {
        const brok = getMarket.brokerage;
        intradayPct = Number(brok.intradayCommission) || 0;
        deliveryPct = Number(brok.deliveryCommission) || 0;
        brokerageType = brok.type || "percentage";

        // Specific Script Brokerage Override
        const normalizedBase = getBaseScriptName(scriptId || label || scriptName);
        const scriptWise = brok.scriptWiseBrokerage || [];
        const checkScriptBrokerage = scriptWise.find((s) => {
            if (!s.script) return false;
            const ruledBase = getBaseScriptName(s.script);
            const scriptUpper = String(s.script).toUpperCase().trim();
            return (
                normalizedBase === ruledBase ||
                (scriptName && scriptName.toUpperCase().trim() === scriptUpper) ||
                (label && label.toUpperCase().trim() === scriptUpper)
            );
        });

        if (checkScriptBrokerage) {
            intradayPct = Number(checkScriptBrokerage.intradayCommission) || 0;
            deliveryPct = Number(checkScriptBrokerage.deliveryCommission) || 0;
            isClientScriptWise = true;
        }
    }

    // 3. Main Calculation
    let quantityType = {
        intraday: Math.abs(checkQuantity?.intraday || 0),
        delivery: Math.abs(checkQuantity?.delivery || 0),
    };

    const brokeragePercentageType = {
        intraday: intradayPct,
        delivery: deliveryPct,
    };

    let netBrokerage = 0;
    let orderBrokerage = 0;

    // ========== NSE-EQ SPECIAL HANDLING (COMMENTED OUT - CRON HANDLES DELIVERY COMMISSION) ==========
    // const isNseEq = NseEqBrokerageService.isNseEq(marketId);
    
    // IMPORTANT: For NSE-EQ, we now ONLY apply intraday commission during trade execution.
    // The delivery commission difference will be applied by the nseEqDeliveryCommissionCron at end of day.
    // This ensures proper FIFO matching and handles scenarios like:
    // - Day 1: Buy 400 → Intraday commission applied
    // - End of Day 1: Cron applies delivery commission difference on open 400 qty
    // - Day 2: Sell 200 → Intraday commission applied
    // - End of Day 2: Cron applies delivery commission difference on the 200 sell (square-off)
    
    // if (hasBrokerage && isNseEq && valanId) {
    //     try {
    //         // Get DEL applicable quantity for this transaction
    //         const delResult = await NseEqBrokerageService.getDelApplicableQty(
    //             userId,
    //             valanId,
    //             scriptId,
    //             quantity,
    //             transactionType
    //         );

    //         console.log(`[NSE-EQ Brokerage] User ${userId}, Script ${scriptId}: DEL qty=${delResult.delQty}, Intraday qty=${delResult.intradayQty}`);

    //         // Calculate brokerage with DEL split
    //         const nseEqBrokerage = NseEqBrokerageService.calculateNseEqBrokerage(
    //             delResult.delQty,
    //             delResult.intradayQty,
    //             price,
    //             deliveryPct,
    //             intradayPct,
    //             brokerageType === 'lot' ? 'lot' : 'percent',
    //             lot,
    //             quantity
    //         );

    //         netBrokerage = nseEqBrokerage.totalBrokerage;
    //         orderBrokerage = nseEqBrokerage.orderBrokerage;

    //         // Update quantityType to reflect DEL split
    //         quantityType = {
    //             intraday: delResult.intradayQty,
    //             delivery: delResult.delQty,
    //         };

    //         console.log(`[NSE-EQ Brokerage] Total brokerage: ₹${netBrokerage.toFixed(4)} (DEL: ₹${nseEqBrokerage.delBrokerage.toFixed(4)}, Intraday: ₹${nseEqBrokerage.intradayBrokerage.toFixed(4)})`);
    //     } catch (error) {
    //         console.error('[NSE-EQ Brokerage] Error calculating DEL brokerage, falling back to standard calculation:', error);
    //         // Fall back to standard calculation
    //         if (brokerageType === "lot") {
    //             const lotFactor = quantity > 0 ? (lot / quantity) : 0;
    //             netBrokerage = (quantityType.intraday * intradayPct * lotFactor) + (quantityType.delivery * deliveryPct * lotFactor);
    //         } else {
    //             netBrokerage = (quantityType.intraday * price * intradayPct) / 100 + (quantityType.delivery * price * deliveryPct) / 100;
    //         }
    //         orderBrokerage = quantity > 0 ? (netBrokerage / quantity) : 0;
    //     }
    // } else if (hasBrokerage) {
    
    // For NSE-EQ (market 12), ONLY apply intraday commission during trade execution
    // Delivery commission will be handled by the cron at end of day
    const isNseEq = NseEqBrokerageService.isNseEq(marketId);
    
    if (hasBrokerage) {
        // Standard brokerage calculation for non-NSE-EQ markets
        // For NSE-EQ: Only use intraday commission (delivery handled by cron)
        const effectiveIntradayPct = intradayPct;
        const effectiveDeliveryPct = isNseEq ? 0 : deliveryPct; // Zero out delivery for NSE-EQ
        
        if (brokerageType === "lot") {
            const lotFactor = quantity > 0 ? (lot / quantity) : 0;
            netBrokerage = (quantityType.intraday * effectiveIntradayPct * lotFactor) + (quantityType.delivery * effectiveDeliveryPct * lotFactor);
        } else {
            netBrokerage = (quantityType.intraday * price * effectiveIntradayPct) / 100 + (quantityType.delivery * price * effectiveDeliveryPct) / 100;
        }
        orderBrokerage = quantity > 0 ? (netBrokerage / quantity) : 0;
        
     
    }

    netBrokerage = Math.abs(netBrokerage);
    orderBrokerage = Math.abs(orderBrokerage);

    let netPrice = 0;
    let totalNetPrice = 0;

    if (transactionType === "BUY") {
        netPrice = Number(price) + Number(orderBrokerage);
    } else {
        netPrice = Number(price) - Number(orderBrokerage);
    }
    totalNetPrice = netPrice * quantity;

    const _pct = price > 0 ? (orderBrokerage * 100) / price : 0;
    const brokeragePercentage = Number.isFinite(_pct) ? Number(_pct.toFixed(4)) : 0;

    // 4. Other/Partner Brokerage Chain
    const getBrokerData = getOtherBrokerDetails(
        marketId,
        lot,
        getMarket?.brokerage?.brokerCommission || [],
        scriptId,
        price,
        quantity,
        quantityType,
        totalOrderPrice,
        basicDetails?.brokerPartnership || [],
        hasBrokerage,
        netBrokerage,
        intradayPct,
        deliveryPct,
        transactionType,
        isClientScriptWise
    );

    let m2mPrice = 0;
    if (transactionType === "BUY") {
        m2mPrice = totalNetPrice - (getBrokerData?.totalOrderBrokerage || 0);
    } else {
        m2mPrice = totalNetPrice + (getBrokerData?.totalOrderBrokerage || 0);
    }

    return {
        netPrice,
        totalNetPrice,
        orderBrokerage,
        netBrokerage,
        brokeragePercentage,
        m2mPrice,
        otherBrokerage: getBrokerData,
        checkQuantity,
        newBuyQty: transactionType === "BUY" ? quantity : 0,
        newSellQty: transactionType === "SELL" ? quantity : 0,
        brokerTotalPercentage: Number.isFinite(getBrokerData?.totalBrokerPercentage) ? Number(Number(getBrokerData.totalBrokerPercentage).toFixed(4)) : 0,
        brokeragePercentageType,
        brokerTotalBrokerage: getBrokerData?.totalOrderBrokerage || 0,
        brockersBrokerage: getBrokerData?.brockersBrokerage || [],
        totalOrderPrice,
        orderPrice: price,
        quantityType
    };
};
