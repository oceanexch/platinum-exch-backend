/**
 * forceSquareOffExpiring.js
 *
 * Matches the logic from MarketOperationsService.expiryPositionRollover
 * 1. Find scripts with tradeEndDate = today
 * 2. Aggregate open positions from StockTransaction (not UserPosition)
 * 3. Square off positions using executeSquareOff logic
 * 4. Cleanup: Delete UserScript docs and pull expiry entries
 *
 * Usage:
 *   node scripts/forceSquareOffExpiring.js
 *   node scripts/forceSquareOffExpiring.js --market 3
 *   node scripts/forceSquareOffExpiring.js --dry-run
 */

require("dotenv").config();
const mongoose = require("mongoose");
const moment = require("moment");
const fs = require("fs");
const path = require("path");

const args = process.argv.slice(2);
const dryRun = args.includes("--dry-run");
const mIdx = args.indexOf("--market");
const onlyMarket = mIdx !== -1 ? args[mIdx + 1] : null;
const ALL_MARKETS = ["1", "2", "3", "4", "6", "7", "8", "9", "10", "11", "12"];
const markets = onlyMarket ? [onlyMarket] : ALL_MARKETS;

const run = async () => {
    await mongoose.connect(process.env.MONGODB_URI);
    console.log("✅ MongoDB Connected");
    if (dryRun) console.log("⚠️  DRY RUN\n");

    const { Script } = require("../src/models/MarketTypeModel");
    const StockTransaction = require("../src/models/StockTransactionModel");
    const UserScript = require("../src/models/UserScriptModel");
    const User = require("../src/models/UserModel");
    const BrokerageService = require("../src/services/BrokerageService");
    const { saveTransaction, setUserPosition, updateUserQuantity, getUserQuantity, getActiveWeekValan } = require("../src/services/StockService");
    const { getSingleStockData } = require("../src/services/RedisService");
    const { StockTransactionEvent, DashboardStockEvent } = require("../src/services/RedisStockService");

    const today = moment().startOf("day");
    const todayStr = today.format("YYYY-MM-DD");
    const activeValan = await getActiveWeekValan();
    if (!activeValan) {
        console.error("❌ No active valan");
        process.exit(1);
    }

    console.log(`📅 Date: ${todayStr} | Valan: ${activeValan.label || activeValan._id}\n`);

    let squaredOff = 0, skipped = 0, errors = 0;
    const userCache = new Map();
    const createdIds = [];

    for (const marketId of markets) {
        console.log(`\n── Market ${marketId} ─────────────────────────────`);

        // ── STEP 1: Find scripts with expiry.tradeEndDate = todayStr ──────────
        const scriptQuery = {
            "expiry.tradeEndDate": todayStr,
            market_type_id: String(marketId)
        };

        const scriptsWithExpiry = await Script.find(scriptQuery).lean();

        if (scriptsWithExpiry.length === 0) {
            console.log(`   ℹ️  No expiring scripts found`);
            continue;
        }

        // ── STEP 2: Extract scriptIds from matching expiry entries ──────────
        const scriptIdsToClose = new Set();
        const expiryEntriesToCleanup = [];

        console.log(`   📌 Found expiring entries:`);

        for (const script of scriptsWithExpiry) {
            if (Array.isArray(script.expiry)) {
                for (const exp of script.expiry) {
                    if (exp.tradeEndDate === todayStr) {
                        console.log(`      - ${exp.script_id} (${script.script_name}) - tradeEndDate: ${exp.tradeEndDate}, expiryDate: ${exp.expiry_date}`);

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
        console.log(`   📂 Found ${expiryEntriesToCleanup.length} expiring entries. ScriptIds: ${uniqueScriptIds.join(', ')}`);

        // ── STEP 3: Aggregate open positions from StockTransaction ───────────────────
        const matchStage = {
            scriptId: { $in: uniqueScriptIds },
            valanId: activeValan._id,
            transactionStatus: "COMPLETED"
        };

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
            console.log(`   ℹ️  No open positions found`);
        } else {
            console.log(`   📊 Found ${openPositions.length} open positions`);

            // ── STEP 4: Square off each position ─────────────────────────────────
            for (const pos of openPositions) {
                const netQty = pos.buyQuantity - pos.sellQuantity;
                if (netQty === 0) {
                    skipped++;
                    continue;
                }

                const qtyToClose = Math.abs(netQty);
                const transactionType = netQty > 0 ? "SELL" : "BUY";
                const side = netQty > 0 ? "LONG" : "SHORT";

                console.log(`\n   [${side}] ${pos.scriptName} | ${pos.label}`);
                console.log(`      user=${pos._id.userId} | buy=${pos.buyQuantity} sell=${pos.sellQuantity} → ${transactionType} ${qtyToClose}`);

                if (dryRun) {
                    console.log("      ⏩ dry-run skip");
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
                        console.warn(`      ⚠️  user not found`);
                        skipped++;
                        continue;
                    }

                    // Fetch current price
                    let currentPrice = 0;
                    const keysToTry = [pos.symbol, pos._id?.scriptId, pos.scriptName, pos.label].filter(Boolean);

                    for (const key of keysToTry) {
                        try {
                            const redisData = await getSingleStockData(key);
                            if (redisData) {
                                const parsed = typeof redisData === 'string' ? JSON.parse(redisData) : redisData;

                                const bid = Number(parsed.SellPrice ?? parsed.bid ?? parsed.Ltp ?? 0);
                                const ask = Number(parsed.BuyPrice ?? parsed.ask ?? parsed.Ltp ?? 0);

                                currentPrice = transactionType === "SELL" ? bid : ask;

                                if (!currentPrice) {
                                    currentPrice = Number(parsed.ltp ?? parsed.Ltp ?? 0);
                                }

                                if (currentPrice) {
                                    break;
                                }
                            }
                        } catch (e) {
                            // Continue to next key
                        }
                    }

                    if (!currentPrice) {
                        console.warn(`      ⚠️  no live price — skip`);
                        skipped++;
                        continue;
                    }

                    console.log(`      💰 price: ${currentPrice}`);

                    const valanId = pos._id.valanId || activeValan._id;
                    const lot = Math.abs(pos.buyLot - pos.sellLot) || 1;
                    const getMarket = (user.marketAccess || []).find(m => String(m.marketId) == String(pos._id.marketId));

                    const brokerageResult = await BrokerageService.calculateBrokerage({
                        userId: pos._id.userId,
                        valanId: valanId,
                        marketId: pos._id.marketId,
                        marketName: pos.marketName,
                        scriptId: pos._id.scriptId,
                        scriptName: pos.scriptName,
                        symbol: pos.symbol,
                        label: pos.label,
                        lot: lot,
                        quantity: qtyToClose,
                        price: currentPrice,
                        transactionType: transactionType,
                        message: "FUTURE AUTO CLOSE",
                        type: "NRM"
                    }, {
                        getMarket,
                        basicDetails: user
                    });

                    const stock = {
                        userId: pos._id.userId,
                        valanId: valanId,
                        marketId: pos._id.marketId,
                        marketName: pos.marketName,
                        scriptId: pos._id.scriptId,
                        scriptName: pos.scriptName,
                        symbol: pos.symbol,
                        label: pos.label,
                        expiry: pos.expiry || "EXPIRED",
                        lot: lot,
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
                        transactionType: transactionType,
                        transactionStatus: "COMPLETED",
                        orderType: "Market",
                        tradePosition: "NRM",
                        message: "FUTURE AUTO CLOSE",
                        shortmsg: "FUTURE AUTO CLOSE",
                        ip: user.loginIP || "0.0.0.0",
                        createdBy: pos._id.userId,
                        parentIds: user.parentIds?.map(p => p._id) || [],
                        brokerIds: user.brokerIds || [],
                        partnership: user.partnership || [],
                        myParent: user.createdBy?.userId
                    };

                    const saved = await saveTransaction(stock);
                    console.log(`      🆔 txn _id: ${saved._id}`);
                    createdIds.push({
                        _id: saved._id,
                        userId: pos._id.userId,
                        scriptName: pos.scriptName,
                        label: pos.label,
                        transactionType,
                        quantity: qtyToClose,
                        price: currentPrice,
                        createdAt: new Date().toISOString(),
                    });

                    await setUserPosition(pos._id.userId, pos._id.scriptId, valanId);

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

                    try {
                        await StockTransactionEvent({
                            userId: pos._id.userId,
                            parentIds: stock.parentIds,
                            marketId: pos._id.marketId,
                            scriptId: pos._id.scriptId,
                            transactionType,
                            valanId: valanId,
                            userScriptId: null,
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
                            valanId: valanId,
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
                        console.warn(`      ⚠️  socket event: ${eventErr.message}`);
                    }

                    console.log(`      ✅ Squared off`);
                    squaredOff++;

                } catch (err) {
                    console.error(`      ❌ ${pos.scriptName} / ${pos._id.userId}:`, err.message);
                    errors++;
                }
            }
        }

        // ── STEP 5: Cleanup ───────────────────────────────────────────────────
        if (!dryRun) {
            for (const entry of expiryEntriesToCleanup) {
                const { scriptDocId, scriptExpiryId, scriptId } = entry;

                // Delete UserScript docs
                try {
                    await UserScript.deleteMany({ scriptId: scriptId });
                    console.log(`   🗑️  Deleted UserScript docs for scriptId=${scriptId}`);
                } catch (err) {
                    console.error(`   ❌ Error deleting UserScript for ${scriptId}:`, err);
                }

                // Pull expiry entry from Script.expiry[]
                try {
                    await Script.updateOne(
                        { _id: scriptDocId },
                        { $pull: { expiry: { script_expiry_id: scriptExpiryId } } }
                    );
                    console.log(`   🗑️  Pulled expiry entry ${scriptExpiryId} from Script doc ${scriptDocId}`);
                } catch (err) {
                    console.error(`   ❌ Error pulling expiry entry from Script ${scriptDocId}:`, err);
                }
            }
        }
    }

    console.log(`\n══════════════════════════════════════`);
    console.log(`✅  Squared Off : ${squaredOff}`);
    console.log(`⏩  Skipped     : ${skipped}`);
    console.log(`❌  Errors      : ${errors}`);
    console.log(`══════════════════════════════════════\n`);

    // Write revert log
    if (createdIds.length > 0) {
        const logFile = path.join(__dirname, `revert_ids_${moment().format("YYYYMMDD_HHmmss")}.json`);
        fs.writeFileSync(logFile, JSON.stringify(createdIds, null, 2));
        console.log(`📄 Revert log saved to: ${logFile}`);
        console.log(`   To revert, run in mongo shell:`);
        const ids = createdIds.map(r => `ObjectId('${r._id}')`).join(", ");
        console.log(`   db.stocktransactions.updateMany({ _id: { $in: [${ids}] } }, { $set: { transactionStatus: 'DELETED' } })\n`);
    }

    setTimeout(() => process.exit(0), 3000);
};

run().catch(err => { console.error("Fatal:", err); process.exit(1); });
