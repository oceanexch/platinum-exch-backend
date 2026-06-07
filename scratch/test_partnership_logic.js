const mongoose = require('mongoose');
require('dotenv').config();

// Import all required models
const UserModel = require('../src/models/UserModel');
const FinalBillModel = require('../src/models/FinalBillModel');
const UserTypeModel = require('../src/models/UserTypeModel');

async function testPartnershipLogic() {
  try {
    // Connect to MongoDB
    await mongoose.connect(process.env.MONGODB_URI || 'mongodb://localhost:27017/your_database');
    console.log('Connected to MongoDB');

    // Find a Level 7 client to test with
    const client = await FinalBillModel.findOne({
      level: 7,
      totalM2M: { $ne: 0 }
    }).lean();

    if (client) {
      console.log('Testing with client bill:');
      console.log(`  Account: ${client.accountName}`);
      console.log(`  Level: ${client.level}`);
      console.log(`  Total M2M: ${client.totalM2M}`);
      console.log(`  Self Net Price: ${client.selfNetPrice}`);
      console.log(`  Upline Net Price: ${client.uplineNetPrice}`);
      
      console.log('\nPartnership Breakdown:');
      if (Array.isArray(client.partnershipBreakdown)) {
        client.partnershipBreakdown.forEach(pb => {
          console.log(`  User ${pb.userId}: ${pb.partnership}% = ${pb.amount}`);
        });
      }

      // The issue: selfNetPrice should be FULL totalM2M for self-view
      // But it's showing 0, which means partnership breakdown is being applied incorrectly
      console.log('\n🔍 ANALYSIS:');
      console.log(`  Expected selfNetPrice (self-view): ${client.totalM2M}`);
      console.log(`  Actual selfNetPrice: ${client.selfNetPrice}`);
      console.log(`  Issue: ${client.selfNetPrice === 0 ? 'selfNetPrice is 0 - partnership breakdown applied incorrectly!' : 'selfNetPrice looks correct'}`);

      // Check what the user should see vs what uplines should see
      const totalBreakdownAmount = client.partnershipBreakdown?.reduce((sum, pb) => sum + pb.amount, 0) || 0;
      console.log(`  Total partnership breakdown: ${totalBreakdownAmount}`);
      console.log(`  Remaining for user: ${client.totalM2M - totalBreakdownAmount}`);
    }

    await mongoose.disconnect();
    console.log('\nDisconnected from MongoDB');
  } catch (error) {
    console.error('Error:', error.message);
  }
}

testPartnershipLogic();