const mongoose = require('mongoose');
require('dotenv').config();

// Import all required models
const UserModel = require('../src/models/UserModel');
const FinalBillModel = require('../src/models/FinalBillModel');
const UserTypeModel = require('../src/models/UserTypeModel');
const StockService = require('../src/services/StockService');

async function debugClientBillGeneration() {
  try {
    // Connect to MongoDB
    await mongoose.connect(process.env.MONGODB_URI || 'mongodb://localhost:27017/your_database');
    console.log('Connected to MongoDB');

    // Find a Level 7 client with M2M
    const clientBill = await FinalBillModel.findOne({
      level: 7,
      totalM2M: { $ne: 0 }
    }).lean();

    if (clientBill) {
      console.log('Client Bill Analysis:');
      console.log(`  Account: ${clientBill.accountName}`);
      console.log(`  User ID: ${clientBill.userId}`);
      console.log(`  Level: ${clientBill.level}`);
      console.log(`  Total M2M: ${clientBill.totalM2M}`);
      console.log(`  Self Net Price: ${clientBill.selfNetPrice}`);
      console.log(`  Partnership: ${JSON.stringify(clientBill.partnership)}`);

      // Get the raw data from StockService to see what's being passed to bill generation
      try {
        const stockData = await StockService.getProfitLossWithLivePrices(
          clientBill.userId,
          clientBill.valanId,
          clientBill.marketId
        );

        console.log('\nRaw Stock Service Data:');
        console.log(`  M2M: ${stockData.m2m}`);
        console.log(`  Self Net Price: ${stockData.selfNetPrice}`);
        console.log(`  Upline Net Price: ${stockData.uplineNetPrice}`);
        console.log(`  My Share: ${stockData.myShare}`);
        console.log(`  Upline Share: ${stockData.uplineShare}`);

        console.log('\n🔍 ISSUE ANALYSIS:');
        console.log(`  Stock Service M2M: ${stockData.m2m}`);
        console.log(`  Stock Service selfNetPrice: ${stockData.selfNetPrice}`);
        console.log(`  Bill totalM2M: ${clientBill.totalM2M}`);
        console.log(`  Bill selfNetPrice: ${clientBill.selfNetPrice}`);
        
        if (stockData.selfNetPrice !== stockData.m2m) {
          console.log(`  ❌ PROBLEM: StockService.selfNetPrice (${stockData.selfNetPrice}) != StockService.m2m (${stockData.m2m})`);
          console.log(`  This means partnership breakdown is being applied in StockService, not just in view logic!`);
        } else {
          console.log(`  ✅ StockService data looks correct`);
        }

      } catch (error) {
        console.log(`  Error getting stock data: ${error.message}`);
      }

      console.log('\nPartnership Breakdown:');
      if (Array.isArray(clientBill.partnershipBreakdown)) {
        let totalPartnershipAmount = 0;
        clientBill.partnershipBreakdown.forEach(pb => {
          console.log(`  User ${pb.userId}: ${pb.partnership}% = ${pb.amount}`);
          totalPartnershipAmount += pb.amount;
        });
        console.log(`  Total Partnership Amount: ${totalPartnershipAmount}`);
        console.log(`  User's Remaining: ${clientBill.totalM2M - totalPartnershipAmount}`);
      }
    }

    await mongoose.disconnect();
    console.log('\nDisconnected from MongoDB');
  } catch (error) {
    console.error('Error:', error.message);
    console.error(error.stack);
  }
}

debugClientBillGeneration();