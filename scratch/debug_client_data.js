const mongoose = require('mongoose');
require('dotenv').config();

// Import all required models and services
const UserModel = require('../src/models/UserModel');
const FinalBillModel = require('../src/models/FinalBillModel');
const WeekValanModel = require('../src/models/WeekValanModel');
const StockService = require('../src/services/StockService');

async function debugClientData() {
  try {
    // Connect to MongoDB
    await mongoose.connect(process.env.MONGODB_URI || 'mongodb://localhost:27017/your_database');
    console.log('Connected to MongoDB');

    // Find a Level 7 client bill
    const clientBill = await FinalBillModel.findOne({
      level: 7,
      totalM2M: { $ne: 0 }
    }).lean();

    if (clientBill) {
      console.log('Client Bill from Database:');
      console.log(`  Account: ${clientBill.accountName}`);
      console.log(`  User ID: ${clientBill.userId}`);
      console.log(`  Valan ID: ${clientBill.valanId}`);
      console.log(`  Market ID: ${clientBill.marketId}`);
      console.log(`  Total M2M: ${clientBill.totalM2M}`);
      console.log(`  Self Net Price: ${clientBill.selfNetPrice}`);

      // Get the user details
      const user = await UserModel.findById(clientBill.userId).populate('accountType').lean();
      console.log(`\nUser Details:`);
      console.log(`  Level: ${user.accountType?.level}`);
      console.log(`  Partnership: ${JSON.stringify(user.partnership)}`);

      // Call StockService to see what clientData looks like
      try {
        const clientData = await StockService.getProfitLossWithLivePrices(
          { userId: clientBill.userId, valanId: clientBill.valanId },
          user.accountType?.level || 7,
          clientBill.userId
        );

        console.log('\nStockService clientData:');
        if (clientData && clientData.data && clientData.data.length > 0) {
          const firstResult = clientData.data[0];
          console.log(`  m2m: ${firstResult.m2m}`);
          console.log(`  selfNetPrice: ${firstResult.selfNetPrice}`);
          console.log(`  uplineNetPrice: ${firstResult.uplineNetPrice}`);
          console.log(`  myShare: ${firstResult.myShare}`);
          console.log(`  uplineShare: ${firstResult.uplineShare}`);

          console.log('\n🔍 ANALYSIS:');
          console.log(`  Bill totalM2M: ${clientBill.totalM2M}`);
          console.log(`  Bill selfNetPrice: ${clientBill.selfNetPrice}`);
          console.log(`  StockService m2m: ${firstResult.m2m}`);
          console.log(`  StockService selfNetPrice: ${firstResult.selfNetPrice}`);

          if (firstResult.m2m === clientBill.totalM2M) {
            console.log(`  ✅ StockService m2m matches bill totalM2M`);
          } else {
            console.log(`  ❌ StockService m2m doesn't match bill totalM2M`);
          }

          if (firstResult.selfNetPrice === clientBill.selfNetPrice) {
            console.log(`  ✅ StockService selfNetPrice matches bill selfNetPrice`);
            console.log(`  This means the issue is in StockService calculation`);
          } else {
            console.log(`  ❌ StockService selfNetPrice doesn't match bill selfNetPrice`);
            console.log(`  This means the issue is in bill generation logic`);
          }
        } else {
          console.log('  No data returned from StockService');
        }

      } catch (error) {
        console.log(`  Error calling StockService: ${error.message}`);
      }
    }

    await mongoose.disconnect();
    console.log('\nDisconnected from MongoDB');
  } catch (error) {
    console.error('Error:', error.message);
    console.error(error.stack);
  }
}

debugClientData();