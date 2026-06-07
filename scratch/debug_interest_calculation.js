require('dotenv').config();
const mongoose = require('mongoose');
const moment = require('moment');

const NseEqInterestModel = require('../src/models/NseEqInterestModel');
const WeekValanModel = require('../src/models/WeekValanModel');

async function debugInterestCalculation() {
  try {
    await mongoose.connect(process.env.MONGODB_URI);
    console.log('Connected to MongoDB');

    const valanId = '69f58e1ff56f02356eae7578';
    const userId = '69d66514605714774e5ae94e';

    // Get valan dates
    const valan = await WeekValanModel.findById(valanId).lean();
    console.log('\n=== VALAN INFO ===');
    console.log('Valan ID:', valanId);
    console.log('Start Date:', valan.startDate);
    console.log('End Date:', valan.endDate);

    // Calculate interest date range (including weekend before)
    const valanStartDate = moment(valan.startDate);
    const saturday = valanStartDate.clone().subtract(2, 'days');
    const interestStartDate = saturday.format("YYYY-MM-DD");
    const interestEndDate = moment(valan.endDate).format("YYYY-MM-DD");

    console.log('\n=== INTEREST DATE RANGE ===');
    console.log('Interest Start Date:', interestStartDate);
    console.log('Interest End Date:', interestEndDate);

    // Fetch interest records for this user
    const interestRecords = await NseEqInterestModel.find({
      userId: new mongoose.Types.ObjectId(userId),
      date: { $gte: interestStartDate, $lte: interestEndDate }
    }).sort({ date: 1 }).lean();

    console.log('\n=== INTEREST RECORDS ===');
    console.log('Total Records:', interestRecords.length);
    
    let totalInterest = 0;
    interestRecords.forEach(record => {
      console.log(`\nDate: ${record.date}`);
      console.log(`  Interest Amount: ${record.interestAmount}`);
      console.log(`  Annual Interest %: ${record.annualInterestPer}`);
      console.log(`  Max Limit: ${record.maxLimit}`);
      console.log(`  Margin %: ${record.marginPer}`);
      console.log(`  Linked with Ledger: ${record.isLinkedWithLedger}`);
      console.log(`  Booked PnL: ${record.bookedPnl}`);
      console.log(`  Holding Worth: ${record.holdingWorth}`);
      console.log(`  Interestable Amount: ${record.interestableAmount}`);
      totalInterest += record.interestAmount;
    });

    console.log('\n=== TOTAL INTEREST ===');
    console.log('Sum of all interest records:', totalInterest);
    console.log('Expected from summary report: 1841.12');
    console.log('Currently stored in bill: 1380.84');

    await mongoose.disconnect();
  } catch (error) {
    console.error('Error:', error);
    process.exit(1);
  }
}

debugInterestCalculation();
