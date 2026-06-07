/**
 * squareOffScript.js
 *
 * Square off all open positions for a specific script.
 * - LONG positions (buyQty > sellQty) → SELL at SellPrice (bid)
 * - SHORT positions (sellQty > buyQty) → BUY at BuyPrice (ask)
 *
 * Usage:
 *   node scripts/squareOffScript.js <marketId> <scriptName> [expiry] [--dry-run]
 *
 * Examples:
 *   node scripts/squareOffScript.js 1 NIFTY 26-JUN-2025
 *   node scripts/squareOffScript.js 2 RELIANCE
 *   node scripts/squareOffScript.js 1 BANKNIFTY 26-JUN-2025 --dry-run
 */

require("dotenv").config();
const mongoose = require("mongoose");
const moment = require("moment");
const fs = require("fs");
const path = require("path");

// ── Parse args ───────────────────────────────────────────────────────────────
const rawArgs = process.argv.slice(2);
const dryRun = rawArgs.includes("--dry-run");
const positional = rawArgs.filter(a => !a.startsWith("--"));

if (positional.length < 2) {
    console.error("Usage: node scripts/squareOffScript.js <marketId> <scriptName> [expiry] [--dry-run]");
    console.error("  marketId   : numeric market ID (e.g. 1)");
    console.error("  scriptName : script name (e.g. NIFTY, RELIANCE)");
    console.error("  expiry     : expiry string (e.g. 26-JUN-2025) — omit for NSE EQ");
    process.exit(1);
}

const marketId = positional[0];
const scriptName = positional[1].toUpperCase();
const expiryFilter = positional[2] ? positional[2].toUpperCase() : null;

// ── Main ─────────────────────────────────────────────────────────────────────
const run = async () => {
    await mongoose.connect(process.env.MONGODB_URI);
    console.log("✅ MongoDB Connected");
    if (dryRun) console.log("⚠️  DRY RUN\n");

    const { Script } = require("../src/models/MarketTypeModel");
    const StockTransaction = require("../src/models/StockTransactionModel");
    const User = require("../src/models/UserModel");
    const BrokerageService = require("../src/services/BrokerageService");
    const {
        saveTransaction,
        setUserPosition,
        updateUserQuantity,
        getUserQuantity,
        getActiveWeekValan
    } = require("../src/services/StockService");
    const { getSingleStockData } = require("../src/services/RedisService");
    const { StockTransactionEvent, DashboardStockEvent } = require("../src/services/RedisStockService");

    const activeValan = await getActiveWeekValan();
    if (!activeValan) {
        console.error("❌ No active valan");
        process.exit(1);
    }

    console.log(`📅 Date: ${moment().format("YYYY-MM-DD")} | Valan: ${activeValan.label || activeValan._id}`);
    console.log(`🔍 Market: ${marketId} | Script: ${scriptName}${expiryFilter ? ` | Expiry: ${expiryFilter}` : " (no expiry)"}\n`);

    // ── STEP 1: Find scriptIds ────────────────────────────────────────────────
    const scriptDocs = await Script.find({
        script_name: { $regex: new RegExp(`^${scriptName}$`, "i") },
        market_type_id: String(marketId)
    }).lean();

    if (scriptDocs.length === 0) {
        console.error(`❌ No script found: name="${scriptName}" marketId=${marketId}`);
        process.exit(1);
    }

    const scriptIds = new Set();

    for (const doc of scriptDocs) {
        if (expiryFilter) {
            // F&O: find matching expiry entries
            if (Array.isArray(doc.expiry)) {
                for (const exp of doc.expiry) {
                    const expDate = (exp.expiry_date || "").toUpperCase();
                    const expOrig = (exp.expiry_date_orginal || "").toUpperCase();
                    if (expDate.includes(expiryFilter) || expOrig.includes(expiryFilter)) {
                        console.log(`   📌 Matched expiry scriptId: ${exp.script_id} (expiry_date: ${exp.expiry_date})`);
                        scriptIds.add(exp.script_id);
                    }
                }
            }
        } else {
            // NSE EQ or no-expiry: use top-level script_id
            console.log(`   📌 Matched scriptId: ${doc.script_id}`);
            scriptIds.add(doc.script_id);
        }
    }

    if (scriptIds.size === 0) {
        console.error(`❌ No matching scriptId found.${expiryFilter ? ` Check expiry format (tried: "${expiryFilter}")` : ""}`);
        console.log("   Available expiries:");
        for (const doc of scriptDocs) {
            (doc.expiry || []).forEach(e =>
                console.log(`     - ${e.expiry_date} / ${e.expiry_date_orginal} → ${e.script_id}`)
            );
        }
        process.exit(1);
    }

    const uniqueScriptIds = [...scriptIds];
    console.log(`\n   ScriptIds: ${uniqueScriptIds.join(", ")}`);

    // ── STEP 2: Aggregate open positions ─────────────────────────────────────
    const pipeline = [
        {
            $match: {
                scriptId: { $in: uniqueScriptIds },
                valanId: activeValan._id,
                transactionStatus: "COMPLETED"
            }
        },
        { $sort: { createdAt: 1 } },
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
                    $sum: { $cond: [{ $eq: ["$transactionType", "BUY"] }, "$quantity", 0] }
                },
                sellQuantity: {
                    $sum: { $cond: [{ $eq: ["$transactionType", "SELL"] }, "$quantity", 0] }
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
        console.log("\nℹ️  No open positions found for this script.");
        setTimeout(() => process.exit(0), 1000);
        return;
    }

    console.log(`\n📊 Found ${openPositions.length} open position(s)\n`);

    let squaredOff = 0, skipped = 0, errors = 0;
    const userCache = new Map();
    const createdIds = [];

    // ── STEP 3: Square off each position ─────────────────────────────────────
    for (const pos of openPositions) {
        const netQty = pos.buyQuantity - pos.sellQuantity;
        if (netQty === 0) { skipped++; continue; }

        const qtyToClose = Math.abs(netQty);
        const transactionType = netQty > 0 ? "SELL" : "BUY"; // LONG → SELL, SHORT → BUY
        const side = netQty > 0 ? "LONG" : "SHORT";

        console.log(`[${side}] ${pos.scriptName} | ${pos.label}`);
        console.log(`  user=${pos._id.userId} | buy=${pos.buyQuantity} sell=${pos.sellQuantity} → ${transactionType} ${qtyToClose}`);

        if (dryRun) {
            console.log("  ⏩ dry-run skip\n");
            skipped++;
            continue;
        }

        try {
            // Cache user
            const uid = pos._id.userId.toString();
            if (!userCache.has(uid)) {
                const u = await User.findById(uid)
                    .select("parentIds brokerIds partnership loginIP createdBy marketAccess accountDetails")
                    .populate("parentIds", "_id")
                    .lean();
                userCache.set(uid, u);
            }
            const user = userCache.get(uid);
            if (!user) {
                console.warn("  ⚠️  user not found — skip\n");
                skipped++;
                continue;
            }

            // Fetch live price from Redis
            let currentPrice = 0;
            const keysToTry = [pos.symbol, pos._id?.scriptId, pos.scriptName, pos.label].filter(Boolean);

            for (const key of keysToTry) {
                try {
                    const redisData = await getSingleStockData(key);
                    if (redisData) {
                        const parsed = typeof redisData === "string" ? JSON.parse(redisData) : redisData;

                        // LONG → closing with SELL → use SellPrice (bid)
                        // SHORT → closing with BUY  → use BuyPrice (ask)
                        const bid = Number(parsed.SellPrice ?? parsed.bid ?? parsed.Ltp ?? 0);
                        const ask = Number(parsed.BuyPrice ?? parsed.ask ?? parsed.Ltp ?? 0);
                        currentPrice = transactionType === "SELL" ? bid : ask;

                        if (!currentPrice) {
                            currentPrice = Number(parsed.ltp ?? parsed.Ltp ?? 0);
                        }
                        if (currentPrice) break;
                    }
                } catch (_) {}
            }

            if (!currentPrice) {
                console.warn("  ⚠️  no live price found — skip\n");
                skipped++;
                continue;
            }

            console.log(`  💰 price: ${currentPrice} (${transactionType === "SELL" ? "SellPrice/bid" : "BuyPrice/ask"})`);

            const valanId = pos._id.valanId || activeValan._id;
            const lot = Math.abs(pos.buyLot - pos.sellLot) || 1;
            const getMarket = (user.marketAccess || []).find(m => String(m.marketId) == String(pos._id.marketId));

            const brokerageResult = await BrokerageService.calculateBrokerage({
                userId: pos._id.userId,
                valanId,
                marketId: pos._id.marketId,
                marketName: pos.marketName,
                scriptId: pos._id.scriptId,
                scriptName: pos.scriptName,
                symbol: pos.symbol,
                label: pos.label,
                lot,
                quantity: qtyToClose,
                price: currentPrice,
                transactionType,
                message: "MANUAL SQUARE OFF",
                type: "NRM"
            }, { getMarket, basicDetails: user });

            const stock = {
                userId: pos._id.userId,
                valanId,
                marketId: pos._id.marketId,
                marketName: pos.marketName,
                scriptId: pos._id.scriptId,
                scriptName: pos.scriptName,
                symbol: pos.symbol,
                label: pos.label,
                expiry: pos.expiry || "",
                lot,
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
                type: "AUTO_SQ",
                transactionType,
                transactionStatus: "COMPLETED",
                orderType: "Market",
                tradePosition: "NRM",
                message: "MANUAL SQUARE OFF",
                shortmsg: "MANUAL SQ",
                ip: user.loginIP || "0.0.0.0",
                createdBy: pos._id.userId,
                parentIds: user.parentIds?.map(p => p._id) || [],
                brokerIds: user.brokerIds || [],
                partnership: user.partnership || [],
                myParent: user.createdBy?.userId
            };

            const saved = await saveTransaction(stock);
            console.log(`  🆔 txn _id: ${saved._id}`);

            createdIds.push({
                _id: saved._id,
                userId: pos._id.userId,
                scriptName: pos.scriptName,
                label: pos.label,
                transactionType,
                quantity: qtyToClose,
                price: currentPrice,
                createdAt: new Date().toISOString()
            });

            await setUserPosition(pos._id.userId, pos._id.scriptId, valanId);

            const checkQuantity = await getUserQuantity({
                userId: pos._id.userId,
                marketId: pos._id.marketId,
                marketName: pos.marketName,
                scriptId: pos._id.scriptId,
                scriptName: pos.scriptName,
                quantity: qtyToClose,
                transactionType
            });

            await updateUserQuantity(
                { userId: pos._id.userId, scriptId: pos._id.scriptId, marketId: pos._id.marketId },
                { previous: checkQuantity.previous, current: checkQuantity.current }
            );

            try {
                await StockTransactionEvent({
                    userId: pos._id.userId,
                    parentIds: stock.parentIds,
                    marketId: pos._id.marketId,
                    scriptId: pos._id.scriptId,
                    transactionType,
                    valanId,
                    userScriptId: null,
                    lot: stock.lot,
                    quantity: qtyToClose,
                    orderType: "Market",
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
                    valanId,
                    userScriptId: null,
                    lot: stock.lot,
                    quantity: qtyToClose,
                    orderType: "Market",
                    price: currentPrice,
                    status: "COMPLETED",
                    label: pos.label,
                    scriptName: pos.scriptName
                });
            } catch (eventErr) {
                console.warn(`  ⚠️  socket event error: ${eventErr.message}`);
            }

            console.log("  ✅ Squared off\n");
            squaredOff++;

        } catch (err) {
            console.error(`  ❌ Error: ${err.message}\n`);
            errors++;
        }
    }

    // ── Summary ───────────────────────────────────────────────────────────────
    console.log("══════════════════════════════════════");
    console.log(`✅  Squared Off : ${squaredOff}`);
    console.log(`⏩  Skipped     : ${skipped}`);
    console.log(`❌  Errors      : ${errors}`);
    console.log("══════════════════════════════════════\n");

    // Write revert log
    if (createdIds.length > 0) {
        const logFile = path.join(__dirname, `sq_revert_${scriptName}_${moment().format("YYYYMMDD_HHmmss")}.json`);
        fs.writeFileSync(logFile, JSON.stringify(createdIds, null, 2));
        console.log(`📄 Revert log: ${logFile}`);
        const ids = createdIds.map(r => `ObjectId('${r._id}')`).join(", ");
        console.log(`   To revert:`);
        console.log(`   db.stocktransactions.updateMany({ _id: { $in: [${ids}] } }, { $set: { transactionStatus: 'DELETED' } })\n`);
    }

    setTimeout(() => process.exit(0), 3000);
};

run().catch(err => { console.error("Fatal:", err); process.exit(1); });
