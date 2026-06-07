require('dotenv').config();
const mongoose = require('mongoose');
const moment = require('moment');

async function testInterestQuery() {
  try {
    await mongoose.connect(process.env.MONGODB_URI);
    console.log('Connected to MongoDB');

    const NseEqInterestModel = require('../src/models/NseEqInterestModel');
    const WeekValanModel = require('../src/models/WeekValanModel');

    const valanId = '69f58e1ff56f02356eae7578';
    const userId = '675bedff97549fa11ce0ad9f'; // Super Admin

    // Get valan dates
    const valan = await WeekValanModel.findById(valanId).lean();
    const valanStartDate = moment(valan.startDate);
    const saturday = valanStartDate.clone().subtract(2, 'days');
    const interestStartDate = saturday.format("YYYY-MM-DD");
    const interestEndDate = moment(valan.endDate).format("YYYY-MM-DD");

    console.log('\n=== DATE RANGE ===');
    console.log('Start:', interestStartDate);
    console.log('End:', interestEndDate);

    const targetId = new mongoose.Types.ObjectId(userId);
    const interestDateFilter = { $gte: interestStartDate, $lte: interestEndDate };

    // Test 1: Query WITH hierarchy filter (current code)
    console.log('\n=== TEST 1: WITH HIERARCHY FILTER ===');
    const interestOrConds = [{ parentIds: targetId }, { userId: targetId }];
    interestOrConds.push({ parentIds: userId });
    interestOrConds.push({ userId: userId });

    const result1 = await NseEqInterestModel.aggregate([
      { $match: { date: interestDateFilter, $or: interestOrConds } },
      {
        $group: {
          _id: "$userId",
          totalInterest: { $sum: "$interestAmount" },
        },
      },
    ]);

    console.log('Results:', result1.length, 'users');
    result1.forEach(r => console.log(`  User ${r._id}: ${r.totalInterest}`));

    // Test 2: Query WITHOUT hierarchy filter (what we need)
    console.log('\n=== TEST 2: WITHOUT HIERARCHY FILTER (ALL USERS) ===');
    const result2 = await NseEqInterestModel.aggregate([
      { $match: { date: interestDateFilter } },
      {
        $group: {
          _id: "$userId",
          totalInterest: { $sum: "$interestAmount" },
        },
      },
    ]);

    console.log('Results:', result2.length, 'users');
    result2.forEach(r => console.log(`  User ${r._id}: ${r.totalInterest}`));

    await mongoose.disconnect();
  } catch (error) {
    console.error('Error:', error);
    process.exit(1);
  }
}

testInterestQuery();
