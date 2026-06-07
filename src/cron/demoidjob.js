require("dotenv").config({
  path: "/var/www/html/manish/metro_backend-main/.env",
});

const mongoose = require("mongoose");
const connectDB = require("../config/database"); // ⬅ IMPORT HERE

// MODELS
const User = require("../models/UserModel");
const AlertSetting = require("../models/AlertSettingModel");
const BrokerageRefresh = require("../models/BrokerageRefreshModel");
const CashLedger = require("../models/CashLedgerModel");
const DepositWithdraw = require("../models/DepositWithdrawModel");
const JVLedger = require("../models/JVLedgerModel");
const Ledger = require("../models/LedgerModel");
const ProfitLossReport = require("../models/ProfitLossReport");
const Squareoff = require("../models/SquareoffModel");
const UserScript = require("../models/UserScriptModel");
const StockTransaction = require("../models/StockTransactionModel");
const QuantitySetting = require("../models/QuantitySettingModel");
const UserPosition = require("../models/UserPositionModel");
const UserQuantity = require("../models/UserQuantityModel");

// ⏱ 48 hours
const EXPIRY_MS = 48 * 60 * 60 * 1000;

async function cleanupExpiredDemoUsers() {
  const expiryDate = new Date(Date.now() - EXPIRY_MS);

  // 🔹 1. Find expired demo users
  const demoUsers = await User.find({
    demoid: true,
    createdAt: { $lte: expiryDate },
  }).select("_id");

  if (!demoUsers.length) {
    // console.log("No expired demo users found");
    return;
  }

  const userIds = demoUsers.map(u => u._id);

  // console.log(`Found ${userIds.length} expired demo users`);

  // 🔹 2. Delete dependent data (ORDER MATTERS)

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

  // 🔹 3. Delete users LAST (Hard delete for demo accounts)
  const result = await User.deleteMany({ _id: { $in: userIds } });


  console.log(`Deleted users: ${result.deletedCount}`);
}

(async () => {
  try {
    // console.log("Demo cleanup cron started", new Date().toISOString());

    await connectDB(); // ✅ USE YOUR SHARED CONNECTION

    await cleanupExpiredDemoUsers();

    await mongoose.connection.close(); // ✅ CLEAN EXIT

    // console.log("Demo cleanup completed");
    process.exit(0);
  } catch (err) {
    console.error("Demo cleanup failed:", err);
    process.exit(1);
  }
})();
