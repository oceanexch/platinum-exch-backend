const mongoose = require('mongoose');
require('dotenv').config();

// Import all required models
const UserModel = require('../src/models/UserModel');
const FinalBillModel = require('../src/models/FinalBillModel');
const UserTypeModel = require('../src/models/UserTypeModel');

async function checkRamnikAG() {
  try {
    // Connect to MongoDB
    await mongoose.connect(process.env.MONGODB_URI || 'mongodb://localhost:27017/your_database');
    console.log('Connected to MongoDB');

    // Find RAMNIK AG user
    const ramnikUser = await UserModel.findOne({
      accountName: 'RAMNIK AG'
    }).populate('accountType').lean();

    if (ramnikUser) {
      console.log('RAMNIK AG User Details:');
      console.log(`  ID: ${ramnikUser._id}`);
      console.log(`  Account Code: ${ramnikUser.accountCode}`);
      console.log(`  Level: ${ramnikUser.accountType?.level}`);
      console.log(`  Partnership: ${JSON.stringify(ramnikUser.partnership)}`);

      // Find all bills for RAMNIK AG
      const ramnikBills = await FinalBillModel.find({
        userId: ramnikUser._id
      }).lean();

      console.log(`\nRAMNIK AG's Bills (${ramnikBills.length} total):`);
      let totalM2M = 0;
      let totalGross = 0;
      let totalBrokerage = 0;

      ramnikBills.forEach((bill, index) => {
        console.log(`Bill ${index + 1}:`);
        console.log(`  Market: ${bill.marketId}`);
        console.log(`  Total M2M: ${bill.totalM2M}`);
        console.log(`  Gross: ${bill.gross}`);
        console.log(`  Brokerage: ${bill.brokerage}`);
        console.log(`  Self Net Price: ${bill.selfNetPrice}`);
        console.log(`  Upline Net Price: ${bill.uplineNetPrice}`);
        console.log(`  Partnership breakdown:`);
        
        if (Array.isArray(bill.partnershipBreakdown)) {
          bill.partnershipBreakdown.forEach(pb => {
            console.log(`    User ${pb.userId}: ${pb.partnership}% = ${pb.amount}`);
          });
        } else {
          console.log(`    None`);
        }
        
        totalM2M += Number(bill.totalM2M || 0);
        totalGross += Number(bill.gross || 0);
        totalBrokerage += Number(bill.brokerage || 0);
        console.log('---');
      });

      console.log(`\nRAMNIK AG TOTALS:`);
      console.log(`  Total M2M: ${totalM2M}`);
      console.log(`  Total Gross: ${totalGross}`);
      console.log(`  Total Brokerage: ${totalBrokerage}`);
      console.log(`  Expected Total: ${totalGross + totalBrokerage}`);

      // Check if there are bills where RAMNIK AG appears in partnershipBreakdown
      const uplineBills = await FinalBillModel.find({
        'partnershipBreakdown.userId': ramnikUser._id
      }).limit(5).lean();

      console.log(`\nBills where RAMNIK AG appears in partnership breakdown (${uplineBills.length} found):`);
      uplineBills.forEach((bill, index) => {
        console.log(`Bill ${index + 1} (User: ${bill.accountName || 'Unknown'}):`);
        console.log(`  User ID: ${bill.userId}`);
        console.log(`  Total M2M: ${bill.totalM2M}`);
        const ramnikShare = bill.partnershipBreakdown.find(pb => pb.userId.toString() === ramnikUser._id.toString());
        if (ramnikShare) {
          console.log(`  RAMNIK AG's share: ${ramnikShare.partnership}% = ${ramnikShare.amount}`);
        }
      });

      // Find RAMNIK AG's upline to check their view
      if (Array.isArray(ramnikUser.parentIds) && ramnikUser.parentIds.length > 0) {
        const uplineId = ramnikUser.parentIds[ramnikUser.parentIds.length - 1];
        const uplineUser = await UserModel.findById(uplineId).populate('accountType').lean();
        
        if (uplineUser) {
          console.log(`\nRAMNIK AG's Upline: ${uplineUser.accountName} (Level ${uplineUser.accountType?.level})`);
          
          // Calculate what upline should see (15% of RAMNIK AG's total M2M)
          const expectedUplineShare = totalM2M * 0.15; // Assuming 15% partnership
          console.log(`  Expected upline share (15%): ${expectedUplineShare}`);
        }
      }

    } else {
      console.log('RAMNIK AG user not found');
    }

    await mongoose.disconnect();
    console.log('\nDisconnected from MongoDB');
  } catch (error) {
    console.error('Error:', error.message);
    console.error(error.stack);
  }
}

checkRamnikAG();