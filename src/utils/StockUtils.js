
/**
 * Strips expiry dates/numbers from a scriptId to get the base symbol name.
 * Examples: "SILVER25FEB25" → "SILVER", "NIFTY23OCT23FUT" → "NIFTY"
 */
const getBaseScriptName = (scriptId = "") => {
    if (!scriptId) return "";
    let base = String(scriptId).trim().toUpperCase().replace(/\s+/g, "");
    // Remove suffixes
    base = base.replace(/(FUT|OPT|CE|PE)$/i, "");
    // Remove month-based expiries (e.g., 25FEB25, 27FEB2026, 05MAR, FEB 2025)
    const months = "JAN|FEB|MAR|APR|MAY|JUN|JUL|AUG|SEP|OCT|NOV|DEC";
    const expiryPattern = `\\d{0,2}(${months})\\d{0,4}`;
    base = base.replace(new RegExp(expiryPattern, "i"), "");
    // Strip any remaining trailing digits/special chars/spaces
    base = base.replace(/[^A-Z]+$/, "");
    return base.trim();
};

const getOtherBrokerDetails = (
    marketId,
    lot,
    brokerCommission,
    scriptId,
    price,
    quantity,
    quantityType,
    totalOrderPrice,
    brokerPartnership,
    brokerage,
    clientNetBrokerage,    // Total client brokerage amount (X)
    clientIntradayRate,    // Client's rate (e.g. 0.02)
    clientDeliveryRate,    // Client's delivery rate
    transactionType,       // BUY or SELL
    isClientScriptWise = false
) => {
    const otherBrokers = { totalOrderBrokerage: 0, totalBrokerPercentage: 0 };
    const sign = transactionType === "SELL" ? -1 : 1;

    for (let obroker of brokerCommission) {
        const brokerId = obroker.brokerId.toString();
        const getPartnership =
            Array.isArray(brokerPartnership)
                ? brokerPartnership.find((bkr) => {
                    if (!bkr || !bkr.broker) return false;
                    const bkrId = bkr.broker._id ? bkr.broker._id.toString() : bkr.broker.toString();
                    return bkrId == brokerId;
                })?.partnership || 0
                : 0;

        let brokerIntraRate = obroker.intradayCommission || 0;
        let brokerDelRate = obroker.deliveryCommission || 0;

        const normalizedTradeScript = getBaseScriptName(scriptId);
        const scriptWise = obroker.scriptWiseBrokerage || [];
        const checkScriptBrokerage = scriptWise.find(
            (s) => s.script && normalizedTradeScript === getBaseScriptName(s.script)
        );
        if (checkScriptBrokerage) {
            brokerIntraRate = checkScriptBrokerage.intradayCommission || 0;
            brokerDelRate = checkScriptBrokerage.deliveryCommission || 0;
        } else if (isClientScriptWise) {
            brokerIntraRate = 0;
            brokerDelRate = 0;
        }

        if (!brokerage) {
            brokerIntraRate = 0;
            brokerDelRate = 0;
        }

        const brokeragePercentageType = {
            intraday: brokerIntraRate,
            delivery: brokerDelRate,
        };

        const totalQty = (quantityType.intraday + quantityType.delivery) || 1;
        const cRate = ((quantityType.intraday * (clientIntradayRate || 0)) + (quantityType.delivery * (clientDeliveryRate || 0))) / totalQty;
        const bRate = ((quantityType.intraday * brokerIntraRate) + (quantityType.delivery * brokerDelRate)) / totalQty;

        let netBrokerage = 0;
        let orderBrokerage = 0;

        // -----------------------------------------------------------------------
        // PRIMARY LOGIC: PROPORTION FORMULA
        // If client rate and brokerage exist, use the ratio to split.
        // This handles both Lot and Per cases automatically and correctly.
        // -----------------------------------------------------------------------
        if (clientNetBrokerage > 0 && cRate > 0) {
            netBrokerage = clientNetBrokerage * (bRate / cRate);
        } else {
            // FALLBACK: Absolute Calculation
            if (obroker.type == "lot") {
                // Rule: qty * broker_rate
                netBrokerage = (quantityType.intraday * brokerIntraRate) + (quantityType.delivery * brokerDelRate);
            } else {
                // Turnover Wise: (turnover * rate) / 100
                netBrokerage =
                    (quantityType.intraday * price * brokerIntraRate) / 100 +
                    (quantityType.delivery * price * brokerDelRate) / 100;
            }
        }

        // Always store as positive value regardless of BUY/SELL
        netBrokerage = Math.abs(netBrokerage);
        orderBrokerage = quantity > 0 ? (netBrokerage / quantity) : 0;

        const netPrice = price + (transactionType === "BUY" ? orderBrokerage : -orderBrokerage);
        const totalNetPrice = netPrice * quantity;
        const brokeragePercentage = price > 0 ? (orderBrokerage * 100) / price : 0;

        otherBrokers[brokerId] = {
            quantityType,
            brokeragePercentage: brokeragePercentage || 0,
            brokeragePercentageType,
            quantity,
            price,
            orderBrokerage,
            netBrokerage,
            partnership: getPartnership,
        };

        if (!otherBrokers.brockersBrokerage) {
            otherBrokers.brockersBrokerage = [];
        }
        if (obroker && obroker.brokerId) {
            otherBrokers.brockersBrokerage.push({
                brokerId: obroker.brokerId,
                rate: netBrokerage
            });
        }

        otherBrokers.totalOrderBrokerage += netBrokerage;
        otherBrokers.totalBrokerPercentage += brokeragePercentage || 0;
    }

    return otherBrokers;
};

module.exports = {
    getBaseScriptName,
    getOtherBrokerDetails
};
