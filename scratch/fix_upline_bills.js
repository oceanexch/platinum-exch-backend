const mongoose = require('mongoose');
require('dotenv').config();

const { generateFinalBills } = require('../src/services/FinalBillService');
const FinalBillModel = require('../src/models/FinalBillModel');

async function fixUplineBills() {
  try {
    await mongoose.connect(process.env.MONGODB_URI);
    console.log('Connected to MongoDB');

    const valanId = '69d0983a941ef7ebe0bef9d7'; // 06APR-11APR NSE_FO
    const marketId = '1'; // NSE_FO

    console.log(`\n=== BEFORE FIX ===`);
    
    // Check current bills for JAYMADI and uplines
    const currentBills = await FinalBillModel.find({
      valanId: new mongoose.Types.ObjectId(valanId),
      marketId: marketId
    }).lean();

    console.log(`Found ${currentBills.length} existing bills`);
    
    currentBills.forEach(bill => {
      console.log(`${bill.accountName} (${bill.accountCode}) - Level ${bill.level}: totalM2M = ${bill.totalM2M}, selfNetPrice = ${bill.selfNetPrice}`);
    });

    console.log(`\n=== REGENERATING BILLS ===`);
    
    // Regenerate bills with the fix
    const result = await generateFinalBills(valanId, marketId, { clean: true });
    
    console.log(`Generated ${result.count} bills`);

    console.log(`\n=== AFTER FIX ===`);
    
    // Check new bills
    const newBills = await FinalBillModel.find({
      valanId: new mongoose.Types.ObjectId(valanId),
      marketId: marketId
    }).lean();

    console.log(`Found ${newBills.length} new bills`);
    
    newBills.forEach(bill => {
      console.log(`${bill.accountName} (${bill.accountCode}) - Level ${bill.level}: totalM2M = ${bill.totalM2M}, selfNetPrice = ${bill.selfNetPrice}`);
    });

    // Find JAYMADI specifically
    const jaymadiBill = newBills.find(b => b.accountCode === '645324');
    if (jaymadiBill) {
      console.log(`\n=== JAYMADI DETAILS ===`);
      console.log(`totalM2M: ${jaymadiBill.totalM2M}`);
      console.log(`selfNetPrice: ${jaymadiBill.selfNetPrice}`);
      console.log(`Partnership breakdown:`, jaymadiBill.partnershipBreakdown);
    }

    // Find uplines
    const uplines = newBills.filter(b => b.level < 7);
    console.log(`\n=== UPLINE DETAILS ===`);
    uplines.forEach(upline => {
      console.log(`${upline.accountName} (Level ${upline.level}): totalM2M = ${upline.totalM2M}, selfNetPrice = ${upline.selfNetPrice}`);
    });

  } catch (error) {
    console.error('Error:', error);
  } finally {
    await mongoose.disconnect();
  }
}

fixUplineBills();