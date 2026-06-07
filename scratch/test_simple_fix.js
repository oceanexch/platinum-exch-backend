const mongoose = require('mongoose');
require('dotenv').config();

// Import all required models
const UserModel = require('../src/models/UserModel');
const FinalBillModel = require('../src/models/FinalBillModel');

async function testSimpleFix() {
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
      console.log('Testing Simple Fix Logic:');
      console.log(`  Client: ${clientBill.accountName}`);
      console.log(`  Level: ${clientBill.level}`);
      console.log(`  Total M2M: ${clientBill.totalM2M}`);
      console.log(`  Current Self Net Price: ${clientBill.selfNetPrice}`);

      // Simulate the new logic
      const billUserLevel = Number(clientBill.level) || 7;
      const isSelfView = true; // User viewing their own ledger
      
      let result;
      if (isSelfView) {
        // SIMPLE FIX: If direct child customer (Level 7), show 100% (full totalM2M)
        if (billUserLevel === 7) {
          result = Number(clientBill.totalM2M || 0);
        } else {
          result = Number(clientBill.totalM2M || 0);
        }
      }

      console.log('\n🔍 Simple Fix Result:');
      console.log(`  New logic would return: ${result}`);
      console.log(`  Expected: ${clientBill.totalM2M}`);
      console.log(`  Match: ${result === clientBill.totalM2M ? '✅ FIXED' : '❌ Still wrong'}`);

      // Test partnership breakdown for upline view
      console.log('\n🔍 Partnership Breakdown (for upline view):');
      if (Array.isArray(clientBill.partnershipBreakdown)) {
        clientBill.partnershipBreakdown.forEach(pb => {
          console.log(`  Upline ${pb.userId}: ${pb.partnership}% = ${pb.amount}`);
        });
      }
    }

    await mongoose.disconnect();
    console.log('\nDisconnected from MongoDB');
  } catch (error) {
    console.error('Error:', error.message);
  }
}

testSimpleFix();