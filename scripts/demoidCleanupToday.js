require("dotenv").config({
  path: require("path").resolve(__dirname, "../.env"),
});

const mongoose = require("mongoose");
const connectDB = require("../src/config/database");

const User = require("../src/models/UserModel");
const AlertSetting = require("../src/models/AlertSettingModel");
const BrokerageRefresh = require("../src/models/BrokerageRefreshModel");
const CashLedger = require("../src/models/CashLedgerModel");
const DepositWithdraw = require("../src/models/DepositWithdrawModel");
const JVLedger = require("../src/models/JVLedgerModel");
const Ledger = require("../src/models/LedgerModel");
const ProfitLossReport = require("../src/models/ProfitLossReport");
const Squareoff = require("../src/models/SquareoffModel");
const UserScript = require("../src/models/UserScriptModel");
const StockTransaction = require("../src/models/StockTransactionModel");
const QuantitySetting = require("../src/models/QuantitySettingModel");
const UserPosition = require("../src/models/UserPositionModel");
const UserQuantity = require("../src/models/UserQuantityModel");

async function cleanupDemoUsersBeforeToday() {
  // Midnight of today (IST = UTC+5:30)
  const now = new Date();
  const todayMidnightIST = new Date(
    Date.UTC(
      now.getUTCFullYear(),
      now.getUTCMonth(),
      now.getUTCDate(),
      0, 0, 0, 0
    ) - (5.5 * 60 * 60 * 1000) // subtract 5h30m to get IST midnight in UTC
  );

  console.log(`Cleaning demo users created before: ${todayMidnightIST.toISOString()} (IST midnight)`);

  const demoUsers = await User.find({
    demoid: true,
    createdAt: { $lt: todayMidnightIST },
  }).select("_id username");

  if (!demoUsers.length) {
    console.log("No demo users to clean up.");
    return;
  }

  const userIds = demoUsers.map(u => u._id);
  console.log(`Found ${userIds.length} demo user(s) to delete.`);

  await AlertSetting.deleteMany({ userId: { $in: userIds } });

  await BrokerageRefresh.deleteMany({
    $or: [{ userId: { $in: userIds } }, { createdBy: { $in: userIds } }],
  });

  await CashLedger.deleteMany({
    $or: [{ userId: { $in: userIds } }, { createdBy: { $in: userIds } }],
  });

  await DepositWithdraw.deleteMany({
    $or: [{ userId: { $in: userIds } }, { createdBy: { $in: userIds } }],
  });

  await JVLedger.deleteMany({
    $or: [
      { debitAccount: { $in: userIds } },
      { creditAccount: { $in: userIds } },
      { createdBy: { $in: userIds } },
    ],
  });

  await Ledger.deleteMany({
    $or: [
      { userId: { $in: userIds } },
      { parentIds: { $in: userIds } },
      { brokerIds: { $in: userIds } },
    ],
  });

  await ProfitLossReport.deleteMany({
    $or: [
      { userId: { $in: userIds } },
      { parentIds: { $in: userIds } },
      { brokerIds: { $in: userIds } },
    ],
  });

  await Squareoff.deleteMany({
    $or: [
      { userId: { $in: userIds } },
      { parentIds: { $in: userIds } },
    ],
  });

  await UserScript.deleteMany({ createdBy: { $in: userIds } });

  await StockTransaction.deleteMany({
    $or: [
      { userId: { $in: userIds } },
      { parentIds: { $in: userIds } },
      { brokerIds: { $in: userIds } },
      { createdBy: { $in: userIds } },
      { deletedBy: { $in: userIds } },
    ],
  });

  await QuantitySetting.deleteMany({
    $or: [
      { clientId: { $in: userIds } },
      { createdBy: { $in: userIds } },
    ],
  });

  await UserPosition.deleteMany({
    $or: [
      { userId: { $in: userIds } },
      { parentIds: { $in: userIds } },
    ],
  });

  await UserQuantity.deleteMany({ userId: { $in: userIds } });

  const result = await User.deleteMany({ _id: { $in: userIds } });

  console.log(`Done. Deleted ${result.deletedCount} demo user(s) and all their data.`);
}

(async () => {
  try {
    await connectDB();
    await cleanupDemoUsersBeforeToday();
    await mongoose.connection.close();
    process.exit(0);
  } catch (err) {
    console.error("Demo cleanup failed:", err);
    process.exit(1);
  }
})();
