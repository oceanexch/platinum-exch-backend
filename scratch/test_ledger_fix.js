const mongoose = require('mongoose');
require('dotenv').config();

const { generateFinalBills } = require('../src/services/FinalBillService');
const FinalBillModel = require('../src/models/FinalBillModel');
const UserModel = require('../src/models/UserModel');

async function testLedgerFix() {
  try {
    await mongoose.connect(process.env.MONGODB_URI);
    console.log('Connected to MongoDB');

    const valanId = '69d0983a941ef7ebe0bef9d7'; // 06APR-11APR NSE_FO
    const marketId = '1'; // NSE_FO

    console.log(`\n=== REGENERATING BILLS FOR VALAN ${valanId} ===`);
    
    // Regenerate bills with the fix
    const result = await generateFinalBills(valanId, marketId, { clean: true });
    console.log(`Generated ${result.count} bills`);

    console.log(`\n=== CHECKING JAYMADI AND UPLINES ===`);
    
    // Find JAYMADI
    const jaymadiBill = await FinalBillModel.findOne({
      valanId: new mongoose.Types.ObjectId(valanId),
      marketId: marketId,
      accountCode: '645324'
    }).lean();

    if (jaymadiBill) {
      console.log(`\nJAYMADI (Client - Level ${jaymadiBill.level}):`);
      console.log(`  totalM2M: ${jaymadiBill.totalM2M}`);
      console.log(`  selfNetPrice: ${jaymadiBill.selfNetPrice}`);
      
      // Find JAYMADI's uplines from partnership breakdown
      if (jaymadiBill.partnershipBreakdown) {
        console.log(`\nJAYMADI's Partnership Breakdown:`);
        for (const pb of jaymadiBill.partnershipBreakdown) {
          const uplineUser = await UserModel.findById(pb.userId).select('accountCode accountName accountType').populate('accountType').lean();
          if (uplineUser) {
            console.log(`  ${uplineUser.accountName} (${uplineUser.accountCode}) - Level ${uplineUser.accountType?.level}: ${pb.partnership}% = ${pb.amount}`);
          }
        }
        
        console.log(`\nUpline Bills:`);
        // Check each upline's bill
        for (const pb of jaymadiBill.partnershipBreakdown) {
          const uplineBill = await FinalBillModel.findOne({
            valanId: new mongoose.Types.ObjectId(valanId),
            marketId: marketId,
            userId: pb.userId
          }).lean();
          
          if (uplineBill) {
            console.log(`  ${uplineBill.accountName} (Level ${uplineBill.level}):`);
            console.log(`    totalM2M: ${uplineBill.totalM2M} (should be full client M2M)`);
            console.log(`    selfNetPrice: ${uplineBill.selfNetPrice} (should be their partnership share)`);
          }
        }
      }
    } else {
      console.log('JAYMADI bill not found');
    }

  } catch (error) {
    console.error('Error:', error);
  } finally {
    await mongoose.disconnect();
  }
}

testLedgerFix();