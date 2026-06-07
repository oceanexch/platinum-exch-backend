const cron = require("node-cron");
const moment = require("moment");
const mongoose = require("mongoose");
const fs = require("fs");
const path = require("path");

const { redisClient, redisSubscriber } = require("./config/redis");
const { deactivateNoActivityUsers } = require("./cron/deactivateInactiveUsers");
const { resetUserAttempts } = require("./cron/resetAttemptsCron");
const { generateMonthlyBillsJob } = require("./cron/monthlyBillCron");
const { resetWeeklyLimitOverrides } = require("./cron/weeklyLimitResetCron");


// const SYMBOLS = require("./scriptName.json"); // Removed to prevent crash and memory overhead

const {
  getUserPendingQuantity,
  setGetNextValanDetails,
  getProfitLossReport,
  getActiveWeekValan,
  getUserPosition,
} = require("./services/StockService");

const {
  getStockData,
  getMultipleStockData,
  hgetall,
  getData,
} = require("./services/RedisService");

const StockTransaction = require("./models/StockTransactionModel");
const UserModel = require("./models/UserModel");
const { getFilterExpiries } = require("./services/SettingService");
const { setRollOver } = require("./controllers/StockController");
const {
  saveReport,
  saveLedger,
} = require("./services/ProfitLossService");

const { captureSundayBhavcopy } = require("./cron/sundayBhavcopyCapture");
const { runUserBehaviorCron } = require("./cron/userBehaviorCron");

// ─── CRON SCHEDULES ────────────────────────────────────────────────────────────

// Uncomment the ones you need
// cron.schedule("45 15 * * *", () => {
//   rollOverEntries();
// });

// DISABLED: Bill generation is now done manually via the /generateBill API
// cron.schedule("0 11 * * 6", () => {
//   generateCFBFReport();
// });

// Market close ops (cancelPendingLimitOrders, intradaySquareOff, weeklySquareOff, expiryPositionRollover),
// price capture, and closing-rate polls are all handled dynamically by
// runDynamicMarketOps.js → dynamicMarketOperations.js

// Every night at 12:00 AM – deactivate users with no trades in 15 days and no position
cron.schedule("0 0 * * *", async () => {
  try {
    console.log("Deactivate no-activity users cron started at", new Date().toISOString());
    const result = await deactivateNoActivityUsers();
    console.log("Deactivate no-activity users cron finished. Deactivated:", result.deactivated);
  } catch (err) {
    console.error("Deactivate no-activity users cron failed:", err);
  }
});

// Every night at 1:00 AM – reset user login and rejection attempts
cron.schedule("0 1 * * *", async () => {
  try {
    console.log("Reset user attempts cron job triggered at 1:00 AM");
    await resetUserAttempts();
  } catch (err) {
    console.error("Reset user attempts cron job failed:", err);
  }
});

// NSE-EQ daily interest + delivery commission are handled by dynamicMarketOperations.js
// when market 12 closes (triggered by runDynamicMarketOps.js)

// Every Sunday at 11:00 PM IST – compute and store user behavior analysis for last closed valan
cron.schedule("30 17 * * 0", async () => {
  // 17:30 UTC = 23:00 IST (UTC+5:30)
  try {
    console.log("User behavior analysis cron triggered (Sunday 11 PM IST)");
    await runUserBehaviorCron();
  } catch (err) {
    console.error("User behavior analysis cron failed:", err);
  }
});

// Every Saturday at midnight – restore user limit fields changed during the week
cron.schedule("0 0 * * 6", async () => {
  try {
    console.log("Weekly limit reset cron triggered");
    await resetWeeklyLimitOverrides();
  } catch (err) {
    console.error("Weekly limit reset cron failed:", err);
  }
});

// Every month on the 1st at 00:05 AM – generate monthly final bills
cron.schedule("5 0 1 * *", async () => {
  try {
    console.log("Monthly Final Bill generation cron triggered at 00:05 AM");
    await generateMonthlyBillsJob();
  } catch (err) {
    console.error("Monthly Final Bill generation cron failed:", err);
  }
});

// Every night at 12:15 AM – cleanup chat media and voice recordings
cron.schedule("15 0 * * *", async () => {
  try {
    console.log("Daily Media Cleanup cron job triggered at 12:15 AM");
    const uploadDirs = [
      path.join(__dirname, "../uploads/chat/images"),
      path.join(__dirname, "../uploads/chat/videos"),
      path.join(__dirname, "../uploads/voice_recordings"),
    ];

    for (const dir of uploadDirs) {
      if (fs.existsSync(dir)) {
        const files = fs.readdirSync(dir);
        for (const file of files) {
          const fullPath = path.join(dir, file);
          try {
            if (fs.lstatSync(fullPath).isDirectory()) {
              // For directories like voice_recordings/{userId}
              fs.rmSync(fullPath, { recursive: true, force: true });
            } else {
              fs.unlinkSync(fullPath);
            }
          } catch (err) {
            console.error(`Error deleting ${fullPath}:`, err.message);
          }
        }
        console.log(`Cleaned directory: ${dir}`);
      }
    }
    console.log("Daily Media Cleanup finished at", new Date().toISOString());
  } catch (err) {
    console.error("Daily Media Cleanup cron job failed:", err);
  }
});

// ─── HELPER FUNCTIONS ──────────────────────────────────────────────────────────

/**
 * Generic function to fetch users based on a match and projection.
 */
const getFilterUsers = async (match, project) => {
  try {
    return await UserModel.find({ ...match, deletedAt: null }).select(project).lean();
  } catch (error) {
    console.error("Error in getFilterUsers:", error);
    return [];
  }
};

/**
 * Helper to fetch live stock data and return a map with InstrumentIdentifier as key.
 */
const getStockMap = async (scriptNames) => {
  const liveStock = await getMultipleStockData(scriptNames);
  if (!liveStock || liveStock.length === 0) return null;
  const instrumentSet = new Set(
    liveStock.map((stock) => stock.InstrumentIdentifier)
  );
  const allExist = scriptNames.every((scriptName) =>
    instrumentSet.has(scriptName)
  );
  if (!allExist) return null;
  return new Map(liveStock.map((item) => [item.InstrumentIdentifier, item]));
};

/**
 * Processes the results from Promise.allSettled into categorized arrays.
 */
const processPromiseResults = (results) => {
  const success = [];
  const failed = [];
  const rejected = [];
  results.forEach((result) => {
    if (result.status === "fulfilled") {
      if (result.value.status === "true") {
        success.push(result.value);
      } else {
        failed.push(result.value);
      }
    } else {
      rejected.push({
        status: "false",
        message: result.reason?.message,
        error: result.reason,
      });
    }
  });
  return { success, failed, rejected };
};

/**
 * Generic function to get users with auto square off settings.
 */
const getAutoSquareUsers = async (field) => {
  const users = await getFilterUsers({ [field]: 1 }, { [field]: 1 });
  if (!users || users.length === 0) {
    //console.log(`Execution stopped: no users with ${field}`);
    return [];
  }
  return users.map((user) => user._id);
};

// ─── AUTO SQUARE OFF FUNCTIONS ───────────────────────────────────────────────

const squareOff = async (userIds, marketIds) => {
  try {
    const currentValan = await getActiveWeekValan();
    if (!currentValan) {
      //console.log("Execution stopped: active week valan not exists");
      return;
    }

    const openPositions = await getUserPosition({
      userId: { $in: userIds },
      valanId: currentValan._id,
      marketId: { $in: marketIds },
    });

    if (openPositions.length == 0) {
      //console.log("Execution stopped: no positions exists");
      return;
    }
    const scriptNames = openPositions.map((pos) => pos.scriptName);
    const stockMap = await getStockMap(scriptNames);
    if (!stockMap) {
      //console.log("No stock exists for some script names.");
      return;
    }

    // Prepare positions for rollover
    const duplicateOpenPositions = openPositions.map((txn) => {
      const remQty = txn.buyQuantity - txn.sellQuantity;
      const { SellPrice, BuyPrice } = stockMap.get(txn.scriptName);
      const price = remQty < 0 ? SellPrice : BuyPrice;
      return {
        userId: txn.userId,
        marketId: txn.marketId,
        marketName: txn.marketName,
        scriptId: txn.scriptId,
        scriptName: txn.scriptName,
        label: txn.label,
        lot: +Math.abs(txn.buyLot - txn.sellLot).toFixed(2),
        quantity: Math.abs(remQty),
        price,
        transactionType: remQty < 0 ? "BUY" : "SELL",
        orderType: "Market",
      };
    });

    const rollOverResults = await Promise.allSettled(
      duplicateOpenPositions.map((tx, index) =>
        setRollOver(
          tx,
          tx.userId,
          index,
          currentValan._id,
          ""
        )
      )
    );

    const { success, failed, rejected } =
      processPromiseResults(rollOverResults);
    // console.log("SquareOff - Success:", success);
    // console.log("SquareOff - Failed:", failed);
    // console.log("SquareOff - Rejected:", rejected);
  } catch (error) {
    console.error("Error in squareOff:", error);
  }
};

//execute every day
const getIntradayUsers = async (marketId) => {
  const userIds = await getAutoSquareUsers("accountDetails.intraDayAutoSquare");
  if (userIds.length) await squareOff(userIds, marketId);
};

//execute every week day
const getWeeklyUsers = async (marketId) => {
  const userIds = await getAutoSquareUsers("accountDetails.weeklyAutoSquare");
  if (userIds.length) await squareOff(userIds, marketId);
};

// ─── LOSS & LEDGER REPORT FUNCTIONS ───────────────────────────────────────────

const areObjectIdsEqual = (id1, id2) => id1.toString() === id2.toString();

function sumFirstN(arr, start, end) {
  return arr.slice(start, end).reduce((acc, val) => acc + val, 0);
}

// ─── LOSS & LEDGER REPORT WATCHER (DEPRECATED: Moved to M2MWatcher.js) ───────────────────────────────────────────

// const M2MService = require("./services/M2MService");
// const AutoSquareService = require("./services/AutoSquareService");

/**
 * Background task to check M2M limits for all users
 * and trigger auto square-off if limits are exceeded.
 * MOVED TO M2MWatcher.js
 */
const getLossUsers = async () => {
  // This is now handled by M2MWatcher.js
};

const convertTime = (time) => {
  const currentDate = moment().format("YYYY-MM-DD");
  const dateTimeStr = `${currentDate} ${time}`;
  const dateTime = moment(dateTimeStr, "YYYY-MM-DD HH:mm:ss");
  return dateTime.valueOf();
};

// ─── PENDING & ROLLOVER FUNCTIONS ─────────────────────────────────────────────
const getNewEntry = (
  lastTransaction,
  valanId,
  lot,
  qty,
  orderPrice,
  transactionType,
  type,
  message
) => {
  return {
    ...lastTransaction,
    valanId,
    lot,
    quantity: qty,
    orderPrice,
    totalOrderPrice: orderPrice * qty,
    netPrice: orderPrice,
    totalNetPrice: orderPrice * qty,
    orderBrokerage: 0,
    netBrokerage: 0,
    brokeragePercentage: 0,
    type,
    transactionType,
    transactionStatus: "COMPLETED",
    orderType: "Market",
    ip: "0",
    message,
    shortmsg: type,
    quantityType: { intraday: qty, delivery: 0 },
    m2mPrice: orderPrice * qty,
    brokerTotalBrokerage: 0,
    brokeragePercentageType: { intraday: 0, delivery: 0 },
    brokerTotalPercentage: 0,
    otherBrokerage: { totalOrderBrokerage: 0, totalBrokerPercentage: 0 },
  };
};

const getStockParseInfo = (stock) => (stock ? JSON.parse(stock) : null);

const generateCFBFReport = async () => {
  try {
    //console.log("checkUserQuantity: Execution started");
    const stocks = await getStockData("stocks");
    const currentValan = await getActiveWeekValan();
    const nextValan = await setGetNextValanDetails();
    if (!currentValan || !nextValan) {
      //console.log("Execution stopped: Valan details missing.");
      return;
    }
    const match = { transactionStatus: "COMPLETED", valanId: currentValan._id };
    const pendingQuantity = await getUserPendingQuantity(match);
    const usersWithPositions = pendingQuantity.filter(
      (item) => item.BUY_QTY !== item.SELL_QTY
    );

    if (usersWithPositions.length === 0) {
      //console.log("No users with pending positions.");
      await getClientProfitLossReport(currentValan);
      return;
    }

    const pendingEntries = [];
    for (let entry of usersWithPositions) {
      // Remove unwanted fields from the last transaction
      delete entry.lastTransaction._id;
      delete entry.lastTransaction.createdAt;
      delete entry.lastTransaction.updatedAt;
      delete entry.lastTransaction.__v;

      const stockInfo = getStockParseInfo(
        stocks[entry.lastTransaction.scriptName]
      );
      const transactionType = entry.BUY_QTY > entry.SELL_QTY ? "SELL" : "BUY";
      const qty = Math.abs(entry.BUY_QTY - entry.SELL_QTY);
      const lot = Math.abs(entry.BUY_LOT - entry.SELL_LOT);
      const orderPrice =
        transactionType === "BUY" ? stockInfo.BuyPrice : stockInfo.SellPrice;
      const lastEntry = { ...entry.lastTransaction };

      // Create carry forward and B forward entries
      pendingEntries.push(
        getNewEntry(
          lastEntry,
          currentValan._id,
          lot,
          qty,
          orderPrice,
          transactionType,
          "CF",
          "Carry Forward"
        )
      );
      pendingEntries.push(
        getNewEntry(
          lastEntry,
          nextValan._id,
          lot,
          qty,
          orderPrice,
          transactionType === "BUY" ? "SELL" : "BUY",
          "BF",
          "B Forward"
        )
      );
    }

    //console.log("Pending entries:", pendingEntries);
    await StockTransaction.insertMany(pendingEntries);
    await getClientProfitLossReport(currentValan);
    //console.log("checkUserQuantity: Execution ended");
  } catch (error) {
    console.error("Error in checkUserQuantity:", error);
  }
};

// ─── PROFIT/LOSS REPORT & LEDGER FUNCTIONS ─────────────────────────────────────
const getClientProfitLossReport = async (getValan) => {
  try {
    const match = { transactionStatus: "COMPLETED", valanId: getValan._id };
    const response = await getProfitLossReport(match);

    // Process each document to compute brokerwise net brokerage
    response.forEach((doc) => {
      const brokerwiseNetBrokerage = {};
      doc.allOtherBrokerage.forEach((ob) => {
        for (const [key, val] of Object.entries(ob)) {
          if (key === "totalOrderBrokerage" || key === "totalBrokerPercentage")
            continue;
          const net = val?.netBrokerage || 0;
          const partnership = val?.partnership || 0;
          if (!brokerwiseNetBrokerage[key]) {
            brokerwiseNetBrokerage[key] = { brokerage: 0, myShare: 0 };
          }
          brokerwiseNetBrokerage[key].brokerage += net;
          if (brokerwiseNetBrokerage[key].myShare === 0) {
            brokerwiseNetBrokerage[key].myShare +=
              (doc.m2m * partnership * -1) / 100;
          }
        }
      });
      doc.otherBrokerShare = brokerwiseNetBrokerage;
      delete doc.allOtherBrokerage;
    });

    // Append valan details and create ledger entries
    const newResponse = response.map((item) => ({
      ...item,
      valanId: getValan._id,
      valanName: getValan.label,
    }));
    const ledgerResponse = newResponse.map(
      ({
        parentIds,
        brokerIds,
        scriptId,
        scriptName,
        marketId,
        marketName,
        label,
        valanId,
        valanName,
        m2m,
        otherBrokerShare,
        userId,
      }) => ({
        parentIds,
        brokerIds,
        scriptId,
        scriptName,
        marketId,
        marketName,
        label,
        valanId,
        valanName,
        amount: m2m,
        uplineAmount: -m2m,
        downlineAmount: 0,
        otherBrokerShare,
        userId,
        transactionType: "BILL",
        level: 7,
      })
    );

    await saveReport(newResponse);
    await saveLedger(ledgerResponse);
    await generateMasterReport(newResponse);
    await generateBrokerReport(newResponse);

    //update valan report status: billStatus: true
  } catch (error) {
    console.error("Error in getClientProfitLossReport:", error);
  }
};

const generateMasterReport = async (reports) => {
  try {
    const parentIds = [...new Set(reports.flatMap((doc) => doc.parentIds))];
    const masters = await UserModel.find({ _id: { $in: parentIds } })
      .populate("accountType", "label level")
      .select({ accountName: 1, accountCode: 1, accountType: 1, parentIds: 1 })
      .lean();

    for (let master of masters) {
      const level = master.accountType.level;
      const getReport = reports.filter((rep) =>
        rep.parentIds.some((id) => areObjectIdsEqual(id, master._id))
      );
      const groupedData = getReport.reduce((acc, record) => {
        const {
          scriptId,
          scriptName,
          marketId,
          marketName,
          label,
          valanId,
          valanName,
          uplineM2M,
          otherBrokerShare,
        } = record;
        const value = uplineM2M[level - 1] || 0;
        if (!acc[marketId]) {
          acc[marketId] = {
            scriptId,
            scriptName,
            marketId,
            marketName,
            label,
            valanId,
            valanName,
            amount: 0,
            uplineAmount: 0,
            downlineAmount: 0,
            userId: master._id,
            transactionType: "BILL",
            level,
            parentIds: master.parentIds,
            otherBrokerShare: {},
            brokerIds: [],
          };
        }
        acc[marketId].amount += value;
        acc[marketId].uplineAmount += sumFirstN(uplineM2M, 0, level - 1);
        acc[marketId].downlineAmount += sumFirstN(
          uplineM2M,
          level,
          uplineM2M.length
        );
        for (let bkg in otherBrokerShare) {
          if (!acc[marketId].otherBrokerShare[bkg]) {
            acc[marketId].otherBrokerShare[bkg] = { brokerage: 0, myShare: 0 };
            acc[marketId].brokerIds.push(new mongoose.Types.ObjectId(bkg));
          }
          acc[marketId].otherBrokerShare[bkg].brokerage +=
            otherBrokerShare[bkg].brokerage;
          acc[marketId].otherBrokerShare[bkg].myShare +=
            otherBrokerShare[bkg].myShare;
        }
        acc[marketId].brokerIds = [...new Set(acc[marketId].brokerIds)];
        return acc;
      }, {});
      const ledger = Object.values(groupedData);
      await saveLedger(ledger);
    }
  } catch (error) {
    console.error("Error in generateMasterReport:", error);
  }
};

const generateBrokerReport = async (reports) => {
  try {
    const brokerIds = [...new Set(reports.flatMap((doc) => doc.brokerIds))];
    const brokers = await UserModel.find({ _id: { $in: brokerIds } })
      .populate("accountType", "label level")
      .select({ accountName: 1, accountCode: 1, accountType: 1, parentIds: 1 })
      .lean();

    for (let broker of brokers) {
      const level = broker.accountType.level;
      const getReport = reports.filter((rep) =>
        rep.brokerIds.some((id) => areObjectIdsEqual(id, broker._id))
      );
      const groupedData = getReport.reduce((acc, record) => {
        const {
          scriptId,
          scriptName,
          marketId,
          marketName,
          label,
          valanId,
          valanName,
          uplineM2M,
          otherBrokerShare,
        } = record;
        const value = uplineM2M[level - 1] || 0;
        if (!acc[marketId]) {
          acc[marketId] = {
            scriptId,
            scriptName,
            marketId,
            marketName,
            label,
            valanId,
            valanName,
            amount: 0,
            uplineAmount: 0,
            downlineAmount: 0,
            userId: broker._id,
            transactionType: "BILL",
            level,
            parentIds: broker.parentIds,
            otherBrokerShare: {},
            brokerIds: [broker._id],
          };
        }
        if (otherBrokerShare[broker._id.toString()]) {
          acc[marketId].amount +=
            otherBrokerShare[broker._id.toString()].myShare;
        }
        acc[marketId].uplineAmount += sumFirstN(uplineM2M, 0, level - 1);
        acc[marketId].downlineAmount += sumFirstN(
          uplineM2M,
          level,
          uplineM2M.length
        );
        for (let bkg in otherBrokerShare) {
          if (bkg === broker._id.toString()) {
            if (!acc[marketId].otherBrokerShare[bkg]) {
              acc[marketId].otherBrokerShare[bkg] = {
                brokerage: 0,
                myShare: 0,
              };
              acc[marketId].brokerIds.push(new mongoose.Types.ObjectId(bkg));
            }
            acc[marketId].otherBrokerShare[bkg].brokerage +=
              otherBrokerShare[bkg].brokerage;
            acc[marketId].otherBrokerShare[bkg].myShare +=
              otherBrokerShare[bkg].myShare;
          }
        }
        return acc;
      }, {});
      const ledger = Object.values(groupedData);
      await saveLedger(ledger);
    }
  } catch (error) {
    console.error("Error in generateBrokerReport:", error);
  }
};

// ─── ROLLOVER FUNCTION ─────────────────────────────────────────────────────────
const rollOverEntries = async () => {
  try {
    const currentTime = moment().format("YYYY-MM-DD");
    const scriptExpiries = await getFilterExpiries({ expiryDate: currentTime });
    if (!scriptExpiries || scriptExpiries.length === 0) {
      //console.log("No script expiries found for the current date.");
      return;
    }
    const currentValan = await getActiveWeekValan();
    if (!currentValan) {
      //console.log("Execution stopped: active week valan not exists.");
      return;
    }
    const scriptIds = scriptExpiries.map((scp) => scp.scriptId);
    const scriptNames = scriptExpiries.map((scp) => scp.scriptName);
    const stockMap = await getStockMap(scriptNames);
    if (!stockMap) {
      //console.log("No stock exists for some script names.");
      return;
    }

    const match = {
      transactionStatus: "COMPLETED",
      valanId: currentValan._id,
      scriptId: { $in: scriptIds },
    };

    const userQuantities = await getUserPendingQuantity(match);
    const usersWithPositions = userQuantities.filter(
      (item) => item.BUY_QTY !== item.SELL_QTY
    );
    if (usersWithPositions.length === 0) {
      //console.log("No users with pending positions.");
      return;
    }

    const rollOverEntries = usersWithPositions.map((item) => {
      const { lastTransaction, BUY_QTY, SELL_QTY, BUY_LOT, SELL_LOT } = item;
      const { scriptName, scriptId, userId, marketId, marketName, label } =
        lastTransaction;
      const qty = BUY_QTY - SELL_QTY;
      const lot = BUY_LOT - SELL_LOT;
      const { SellPrice, BuyPrice } = stockMap.get(scriptName);
      // User requirement: Buy position (SELL tx) -> SellPrice, Sell position (BUY tx) -> BuyPrice
      const price = qty < 0 ? BuyPrice : SellPrice;
      return {
        userId,
        marketId,
        marketName,
        scriptId,
        scriptName,
        label,
        quantity: Math.abs(qty),
        lot: Math.abs(lot).toFixed(2),
        transactionType: qty < 0 ? "BUY" : "SELL",
        orderType: "Market",
        message: "Auto Close (Exp)",
        price,
      };
    });

    const rollOverResults = await Promise.allSettled(
      rollOverEntries.map((tx, index) =>
        setRollOver(
          tx,
          tx.userId,
          index,
          currentValan._id,
          "",
          false
        )
      )
    );

    const { success, failed, rejected } =
      processPromiseResults(rollOverResults);
    // console.log("Rollover - Success:", success);
    // console.log("Rollover - Failed:", failed);
    // console.log("Rollover - Rejected:", rejected);
  } catch (error) {
    console.error("Error in rollOverEntries:", error);
  }
};

// ─── REDIS SUBSCRIPTION FUNCTION ─────────────────────────────────────────────────────────
(async () => {
  try {
    let symbols = [];
    const cachedSymbols = await getData("symbols");
    if (cachedSymbols) {
      const parsed = JSON.parse(cachedSymbols);
      symbols = Array.isArray(parsed) ? parsed : [];
    }

    // Only subscribe to a safe amount to keep the scheduler light
    const safeSymbols = symbols.slice(0, 5000);

    if (safeSymbols.length > 0) {
      redisSubscriber.subscribe(...safeSymbols, (err, count) => {
        if (err) {
          console.error("Failed to subscribe:", err);
        } else {
          console.log(`Scheduler subscribed to ${count} channel(s).`);
        }
      });
    }
  } catch (err) {
    console.error("❌ Scheduler subscription initialization failed:", err.message);
  }
})();

// getLossUsers is now handled by M2MWatcher.js in server.js master process
// setInterval(() => {
//   getLossUsers();
// }, 5000);

const getSquareOffExecution = async () => {
  try {
    const currentTime = moment().format("HH:mm");
    const currentDay = moment().format("dddd");
    const getIntradayExecution = await hgetall("intraday_squareoff_time");
    const getWeeklyExecution = await hgetall("weekly_squareoff_time");

    const intradayMarketIds = Object.keys(getIntradayExecution);
    const weeklyMarketIds = Object.keys(getWeeklyExecution);
    const getMarkets = intradayMarketIds.reduce((acc, item) => {
      if (
        getIntradayExecution[item] &&
        currentTime == getIntradayExecution[item]
      ) {
        acc.push(item);
      }
      return acc;
    }, []);

    const getWeeklyMarkets = weeklyMarketIds.reduce((acc, item) => {
      if (
        getWeeklyExecution[item] &&
        currentDay == "Friday" &&
        currentTime == getWeeklyExecution[item]
      ) {
        acc.push(item);
      }
      return acc;
    }, []);

    if (getMarkets.length > 0) {
      getIntradayUsers(getMarkets);
    }

    if (getWeeklyMarkets.length > 0) {
      getWeeklyUsers(getWeeklyMarkets);
    }
  } catch (error) {
    console.error("Error in fetching getSquareOffExecution:", error);
  }
};

setInterval(() => {
  getSquareOffExecution();
}, 1000 * 60);
