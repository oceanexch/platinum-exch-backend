// src/tests/finalbills.js

require('dotenv').config({
  path: require('path').resolve(__dirname, '../../.env')
});

const mongoose = require('mongoose');

// 🔹 MODELS
const FinalBillModel = require('../models/FinalBillModel');
const MonthlyFinalBillModel = require('../models/MonthlyFinalBill');
const WeekValanModel = require('../models/WeekValanModel');

// 🔹 SERVICES (MAKE SURE PATH IS CORRECT)
const {
  generateFinalBills,
  rebuildMonthlyFinalBillsFromMonth
} = require('../services/FinalBillService');

// 🔥 MARKET IDS
const MARKET_IDS = {
  MCX: "1",
  NSE: "2",
  NOPT: "3",
  GLOBAL: "4",
  OTHERS: "5",
  FOREX: "6",
  COMEX: "7",
  CDS: "8",
  NCDEX: "9",
  NFUT: "10",
  CRYPTO: "11",
  NSE_EQ: "12",
  GIFT: "13",
  USSTOCKS: "14"
};

const MARKET_LIST = Object.values(MARKET_IDS);

// 🔹 HELPERS
function getMonthKey(date) {
  const d = new Date(date);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
}

// 🔥 REBUILD SINGLE VALAN
async function rebuildValan(valan) {
  const valanId = valan._id;

  console.log(`\n🔁 Processing Valan: ${valanId}`);

  for (const marketId of MARKET_LIST) {
    console.log(`   → Market ${marketId}`);

    // 🔥 DELETE OLD DATA
    await FinalBillModel.deleteMany({
      valanId: new mongoose.Types.ObjectId(valanId),
      marketId: String(marketId)
    });

    // 🔥 GENERATE NEW
    await generateFinalBills(valanId, marketId, {
      force: true,
      clean: false
    });
  }

  // 🔥 MONTHLY REBUILD
  const monthKey = getMonthKey(valan.endDate || valan.startDate || new Date());

  console.log(`   → Rebuilding monthly from ${monthKey}`);

  await MonthlyFinalBillModel.deleteMany({
    marketId: 'ALL',
    month: { $gte: monthKey }
  });

  await rebuildMonthlyFinalBillsFromMonth(monthKey);

  console.log(`✅ Completed Valan ${valanId}`);
}

// 🔥 MAIN EXECUTION
async function main() {
  try {
    console.log("🚀 STARTING FULL REBUILD...\n");

    // 🔥 DB URI FIX (IMPORTANT)
    const DB_URI = process.env.MONGODB_URI || process.env.MONGO_URI;

    if (!DB_URI) {
      throw new Error("❌ No DB URI found in env (MONGODB_URI or MONGO_URI)");
    }

    console.log("🔗 Connecting to DB...");
    await mongoose.connect(DB_URI);

    console.log("🟢 Mongo Connected");

    // 🔥 FETCH VALANS (OLD → NEW)
    const valans = await WeekValanModel.find({})
      .sort({ startDate: 1 })
      .lean();

    console.log(`📊 Total Valans: ${valans.length}`);

    for (const valan of valans) {
      // ❌ SKIP ACTIVE
      if (valan.status === true) {
        console.log(`⏭️ Skipping active valan ${valan._id}`);
        continue;
      }

      await rebuildValan(valan);
    }

    console.log("\n🎉 FULL REBUILD COMPLETE");
    process.exit(0);

  } catch (error) {
    console.error("\n❌ ERROR:", error);
    process.exit(1);
  }
}

// 🔥 RUN SCRIPT
if (require.main === module) {
  main();
}

// 🔥 EXPORT (OPTIONAL)
module.exports = {
  rebuildValan,
  main
};