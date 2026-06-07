/**
 * Test script for NSE-EQ Interest calculation with new ledger-based logic
 * 
 * This script tests both old and new interest calculation methods
 */

require('dotenv').config();
const mongoose = require('mongoose');
const { chargeNseEqDailyInterest } = require('../src/cron/nseEqInterestCron');
const UserModel = require('../src/models/UserModel');
const NseEqInterestModel = require('../src/models/NseEqInterestModel');
const moment = require('moment');

async function testInterestCalculation() {
  try {
    console.log('Connecting to database...');
    await mongoose.connect(process.env.MONGODB_URI);
    console.log('Connected successfully\n');

    // Get today's date
    const today = moment().format('YYYY-MM-DD');
    
    console.log('='.repeat(60));
    console.log('NSE-EQ INTEREST CALCULATION TEST - SINGLE USER');
    console.log('='.repeat(60));
    console.log(`Date: ${today}\n`);

    // Test for specific user only
    const testUserId = '69e71e7d1eb2c2810b5e4dea';
    
    console.log(`Testing for user ID: ${testUserId}\n`);

    // Check if today's interest already calculated
    const existingRecords = await NseEqInterestModel.find({ 
      userId: new mongoose.Types.ObjectId(testUserId),
      date: today 
    }).lean();

    if (existingRecords.length > 0) {
      console.log(`⚠️  Found ${existingRecords.length} existing interest record(s) for this user today.`);
      console.log('Deleting existing records...\n');
      
      await NseEqInterestModel.deleteMany({ 
        userId: new mongoose.Types.ObjectId(testUserId),
        date: today 
      });
      console.log('✓ Deleted existing records\n');
    }

    console.log('✓ Running calculation...\n');
    console.log('='.repeat(60));
    
    // Run the cron job
    const result = await chargeNseEqDailyInterest();
    
    console.log('='.repeat(60));
    console.log('\nCALCULATION RESULTS');
    console.log('='.repeat(60));
    console.log(`Processed: ${result.processed}`);
    console.log(`Skipped: ${result.skipped}`);
    console.log(`Errors: ${result.errors}`);
    
    // Show calculated record for this user
    const newRecord = await NseEqInterestModel.findOne({ 
      userId: new mongoose.Types.ObjectId(testUserId),
      date: today 
    })
      .populate('userId', 'accountCode accountName')
      .lean();
    
    if (newRecord) {
      console.log(`\n✅ Interest Record Created:`);
      console.log(`   User: ${newRecord.userId?.accountCode} - ${newRecord.userId?.accountName}`);
      console.log(`   Interest Amount: ₹${newRecord.interestAmount.toFixed(2)}`);
      console.log(`   Annual Rate: ${newRecord.annualInterestPer}%`);
      console.log(`   Max Limit: ₹${newRecord.maxLimit.toFixed(2)}`);
      console.log(`   Margin %: ${newRecord.marginPer}%`);
      console.log(`   Logic: ${newRecord.isLinkedWithLedger ? 'NEW (Ledger-based)' : 'OLD (Flat)'}`);
      
      if (newRecord.isLinkedWithLedger) {
        console.log(`   Holding Worth: ₹${newRecord.holdingWorth.toFixed(2)}`);
        console.log(`   Booked P&L: ₹${newRecord.bookedPnl.toFixed(2)}`);
        console.log(`   Interestable Amount: ₹${newRecord.interestableAmount.toFixed(2)}`);
      }
    } else {
      console.log(`\n⚠️  No interest record created for this user (may have been skipped)`);
    }

    console.log('\n' + '='.repeat(60));
    console.log('Test completed successfully');
    console.log('='.repeat(60));

  } catch (error) {
    console.error('Error during test:', error);
  } finally {
    await mongoose.connection.close();
    console.log('\nDatabase connection closed');
  }
}

// Run the test
testInterestCalculation();
