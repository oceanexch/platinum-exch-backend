const mongoose = require('mongoose');
require('dotenv').config();

// Import all required models
const UserModel = require('../src/models/UserModel');
const FinalBillModel = require('../src/models/FinalBillModel');
const UserTypeModel = require('../src/models/UserTypeModel');

async function testLedgerSelfView() {
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
      console.log('Testing Self-View Logic:');
      console.log(`  Client: ${clientBill.accountName}`);
      console.log(`  User ID: ${clientBill.userId}`);
      console.log(`  Level: ${clientBill.level}`);
      console.log(`  Total M2M: ${clientBill.totalM2M}`);
      console.log(`  Self Net Price: ${clientBill.selfNetPrice}`);

      // Simulate the self-view condition
      const userId = clientBill.userId.toString();
      const requesterIdStr = clientBill.userId.toString(); // Same user viewing their own ledger
      const viewType = undefined; // No explicit viewType

      const isSelfView = viewType === 'self' || 
                        (viewType !== 'upline' && (userId === requesterIdStr || userId === requesterIdStr));
      
      console.log('\n🔍 Self-View Logic Test:');
      console.log(`  userId: ${userId}`);
      console.log(`  requesterIdStr: ${requesterIdStr}`);
      console.log(`  viewType: ${viewType}`);
      console.log(`  userId === requesterIdStr: ${userId === requesterIdStr}`);
      console.log(`  isSelfView: ${isSelfView}`);

      if (isSelfView) {
        console.log(`  ✅ Should return totalM2M: ${clientBill.totalM2M}`);
      } else {
        console.log(`  ❌ Would return partnership share instead of full M2M`);
      }

      // The issue: selfNetPrice in the bill itself is wrong
      console.log('\n🔍 Bill Generation Issue:');
      console.log(`  Expected selfNetPrice (for self-view): ${clientBill.totalM2M}`);
      console.log(`  Actual selfNetPrice in bill: ${clientBill.selfNetPrice}`);
      
      if (clientBill.selfNetPrice !== clientBill.totalM2M) {
        console.log(`  ❌ PROBLEM: Bill generation is storing wrong selfNetPrice!`);
        console.log(`  The issue is in FinalBillService.js, not ReportController.js`);
      } else {
        console.log(`  ✅ Bill selfNetPrice is correct`);
      }
    }

    await mongoose.disconnect();
    console.log('\nDisconnected from MongoDB');
  } catch (error) {
    console.error('Error:', error.message);
  }
}

testLedgerSelfView();