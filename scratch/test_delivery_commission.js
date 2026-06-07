/**
 * Test script for NSE-EQ Delivery Commission functionality
 * 
 * This script tests the delivery commission application logic for NSE-EQ positions
 * held overnight.
 * 
 * Usage: node scratch/test_delivery_commission.js
 */

require('dotenv').config();
const mongoose = require('mongoose');
const moment = require('moment');
const { applyNseEqDeliveryCommission } = require('../src/cron/nseEqDeliveryCommissionCron');

// Connect to MongoDB
mongoose.connect(process.env.MONGO_URI, {
  useNewUrlParser: true,
  useUnifiedTopology: true,
})
.then(() => console.log('✓ MongoDB connected'))
.catch(err => {
  console.error('✗ MongoDB connection error:', err);
  process.exit(1);
});

async function runTest() {
  try {
    console.log('\n========================================');
    console.log('NSE-EQ Delivery Commission Test');
    console.log('========================================\n');

    // Test for today's date
    const testDate = moment().format('YYYY-MM-DD');
    console.log(`Testing for date: ${testDate}\n`);

    // Run the delivery commission cron
    const result = await applyNseEqDeliveryCommission(testDate);

    console.log('\n========================================');
    console.log('Test Results:');
    console.log('========================================');
    console.log(`Processed: ${result.processed} transactions`);
    console.log(`Skipped: ${result.skipped} users`);
    console.log(`Errors: ${result.errors}`);
    console.log(`Total Delivery Brokerage: ₹${result.totalDelBrokerage?.toFixed(2) || 0}`);
    console.log('========================================\n');

    // Verify a sample transaction
    const StockTransactionModel = require('../src/models/StockTransactionModel');
    const sampleTxn = await StockTransactionModel.findOne({
      marketId: '12', // NSE-EQ
      'delDetails.delApplied': true,
      createdAt: {
        $gte: moment(testDate).startOf('day').toDate(),
        $lte: moment(testDate).endOf('day').toDate(),
      }
    }).lean();

    if (sampleTxn) {
      console.log('Sample Transaction with Delivery Commission:');
      console.log('----------------------------------------');
      console.log(`Transaction ID: ${sampleTxn._id}`);
      console.log(`Script: ${sampleTxn.scriptName}`);
      console.log(`Type: ${sampleTxn.transactionType}`);
      console.log(`Quantity: ${sampleTxn.quantity}`);
      console.log(`Order Price: ₹${sampleTxn.orderPrice}`);
      console.log(`\nBrokerage Details:`);
      console.log(`  - Net Brokerage: ₹${sampleTxn.netBrokerage?.toFixed(4)}`);
      console.log(`  - Order Brokerage: ₹${sampleTxn.orderBrokerage?.toFixed(4)}`);
      console.log(`\nDelivery Details:`);
      console.log(`  - Del Applied: ${sampleTxn.delDetails?.delApplied}`);
      console.log(`  - Applied Qty: ${sampleTxn.delDetails?.appliedQty}`);
      console.log(`  - Del Brokerage: ₹${sampleTxn.delDetails?.delBrokerage?.toFixed(4)}`);
      console.log(`  - Applied At: ${sampleTxn.delDetails?.appliedAt}`);
      console.log(`  - Broker Share: ${JSON.stringify(sampleTxn.delDetails?.delBrokerBrokerage, null, 2)}`);
      console.log('----------------------------------------\n');
    } else {
      console.log('No transactions found with delivery commission applied.\n');
    }

  } catch (err) {
    console.error('Test failed:', err);
  } finally {
    await mongoose.connection.close();
    console.log('✓ MongoDB connection closed');
    process.exit(0);
  }
}

// Run the test
runTest();
