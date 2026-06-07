/**
 * Recalculate NSE-EQ Interest for a specific user and date
 * 
 * Usage:
 *   node scratch/recalculate_nseeq_interest.js <userId> [date]
 * 
 * Examples:
 *   node scratch/recalculate_nseeq_interest.js 69e71e7d1eb2c2810b5e4dea
 *   node scratch/recalculate_nseeq_interest.js 69e71e7d1eb2c2810b5e4dea 2026-04-28
 */

require('dotenv').config();
const mongoose = require('mongoose');
const { calculateInterestForUser } = require('../src/cron/nseEqInterestCron');
const UserModel = require('../src/models/UserModel');
const NseEqInterestModel = require('../src/models/NseEqInterestModel');
const moment = require('moment');
const fs = require('fs');
const path = require('path');

// Parse command line arguments
const args = process.argv.slice(2);
const userId = args[0];
const dateArg = args[1] || moment().format('YYYY-MM-DD');

// Validate arguments
if (!userId) {
  console.error('❌ Error: User ID is required');
  console.log('\nUsage:');
  console.log('  node scratch/recalculate_nseeq_interest.js <userId> [date]');
  console.log('\nExamples:');
  console.log('  node scratch/recalculate_nseeq_interest.js 69e71e7d1eb2c2810b5e4dea');
  console.log('  node scratch/recalculate_nseeq_interest.js 69e71e7d1eb2c2810b5e4dea 2026-04-28');
  process.exit(1);
}

// Validate date format
if (!moment(dateArg, 'YYYY-MM-DD', true).isValid()) {
  console.error('❌ Error: Invalid date format. Use YYYY-MM-DD');
  process.exit(1);
}

// Validate ObjectId format
if (!mongoose.Types.ObjectId.isValid(userId)) {
  console.error('❌ Error: Invalid user ID format');
  process.exit(1);
}

const targetDate = dateArg;
const deletedRecords = [];
const createdRecords = [];

async function recalculateInterest() {
  try {
    console.log('='.repeat(70));
    console.log('NSE-EQ INTEREST RECALCULATION');
    console.log('='.repeat(70));
    console.log(`User ID: ${userId}`);
    console.log(`Date: ${targetDate}`);
    console.log('='.repeat(70));
    console.log();

    // Connect to database
    console.log('📡 Connecting to database...');
    await mongoose.connect(process.env.MONGODB_URI);
    console.log('✅ Connected successfully\n');

    // Verify user exists
    const user = await UserModel.findById(userId).lean();
    if (!user) {
      console.error(`❌ Error: User with ID ${userId} not found`);
      process.exit(1);
    }

    console.log(`👤 User Found: ${user.accountCode} - ${user.accountName}`);
    console.log(`   NSE-EQ Enabled: ${user.nseEqEnabled ? 'Yes' : 'No'}`);
    console.log(`   Max Limit: ₹${user.nseEqMaxLimit || 0}`);
    console.log();

    // Step 1: Find and backup existing records
    console.log('🔍 Checking for existing interest records...');
    const existingRecords = await NseEqInterestModel.find({
      userId: new mongoose.Types.ObjectId(userId),
      date: targetDate
    }).lean();

    if (existingRecords.length > 0) {
      console.log(`📋 Found ${existingRecords.length} existing record(s) for this date`);
      
      // Backup deleted records
      existingRecords.forEach(record => {
        deletedRecords.push({
          _id: record._id,
          userId: record.userId,
          date: record.date,
          interestAmount: record.interestAmount,
          annualInterestPer: record.annualInterestPer,
          maxLimit: record.maxLimit,
          marginPer: record.marginPer,
          isLinkedWithLedger: record.isLinkedWithLedger,
          holdingWorth: record.holdingWorth,
          bookedPnl: record.bookedPnl,
          interestableAmount: record.interestableAmount,
          createdAt: record.createdAt,
          updatedAt: record.updatedAt
        });
      });

      // Delete existing records
      console.log('🗑️  Deleting existing records...');
      const deleteResult = await NseEqInterestModel.deleteMany({
        userId: new mongoose.Types.ObjectId(userId),
        date: targetDate
      });
      console.log(`✅ Deleted ${deleteResult.deletedCount} record(s)\n`);
    } else {
      console.log('ℹ️  No existing records found for this date\n');
    }

    // Step 2: Recalculate interest
    console.log('🔄 Recalculating interest...');
    console.log('-'.repeat(70));

    // Call the calculation function (you'll need to export this from nseEqInterestCron.js)
    const result = await calculateInterestForUser(userId, targetDate);

    console.log('-'.repeat(70));
    console.log();

    if (result.success) {
      console.log('✅ Interest calculation completed successfully\n');

      // Fetch the newly created record
      const newRecord = await NseEqInterestModel.findOne({
        userId: new mongoose.Types.ObjectId(userId),
        date: targetDate
      }).lean();

      if (newRecord) {
        createdRecords.push(newRecord);

        console.log('📊 NEW INTEREST RECORD:');
        console.log('='.repeat(70));
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
        console.log('='.repeat(70));
        console.log();
      }
    } else {
      console.log(`⚠️  Interest calculation skipped: ${result.reason || 'Unknown reason'}\n`);
    }

    // Step 3: Generate revert commands
    console.log('📝 Generating MongoDB revert commands...');
    generateRevertCommands();

    console.log('\n✅ Recalculation completed successfully!');
    console.log('='.repeat(70));

  } catch (error) {
    console.error('\n❌ Error during recalculation:', error.message);
    console.error(error.stack);
    process.exit(1);
  } finally {
    await mongoose.connection.close();
    console.log('\n📡 Database connection closed');
  }
}

function generateRevertCommands() {
  const timestamp = moment().format('YYYY-MM-DD_HH-mm-ss');
  const revertFile = path.join(__dirname, `revert_nseeq_${userId}_${targetDate}_${timestamp}.js`);

  let revertScript = `/**
 * MongoDB Revert Commands
 * Generated: ${moment().format('YYYY-MM-DD HH:mm:ss')}
 * User ID: ${userId}
 * Date: ${targetDate}
 * 
 * To revert changes, run these commands in MongoDB shell or use this script
 */

// Connect to your database first:
// use your_database_name

`;

  // Add commands to delete newly created records
  if (createdRecords.length > 0) {
    revertScript += `// Step 1: Delete newly created records\n`;
    createdRecords.forEach(record => {
      revertScript += `db.nse_eq_interests.deleteOne({ _id: ObjectId("${record._id}") });\n`;
    });
    revertScript += '\n';
  }

  // Add commands to restore deleted records
  if (deletedRecords.length > 0) {
    revertScript += `// Step 2: Restore deleted records\n`;
    deletedRecords.forEach(record => {
      const recordJson = JSON.stringify({
        _id: { $oid: record._id.toString() },
        userId: { $oid: record.userId.toString() },
        date: record.date,
        interestAmount: record.interestAmount,
        annualInterestPer: record.annualInterestPer,
        maxLimit: record.maxLimit,
        marginPer: record.marginPer,
        isLinkedWithLedger: record.isLinkedWithLedger,
        holdingWorth: record.holdingWorth || 0,
        bookedPnl: record.bookedPnl || 0,
        interestableAmount: record.interestableAmount || 0,
        createdAt: { $date: record.createdAt },
        updatedAt: { $date: record.updatedAt }
      }, null, 2);

      revertScript += `db.nse_eq_interests.insertOne(${recordJson});\n\n`;
    });
  }

  if (deletedRecords.length === 0 && createdRecords.length === 0) {
    revertScript += `// No changes were made - nothing to revert\n`;
  }

  // Add verification commands
  revertScript += `\n// Verification: Check records for this user and date\n`;
  revertScript += `db.nse_eq_interests.find({ userId: ObjectId("${userId}"), date: "${targetDate}" }).pretty();\n`;

  // Write to file
  fs.writeFileSync(revertFile, revertScript);

  console.log(`✅ Revert commands saved to: ${revertFile}`);
  console.log();
  console.log('📋 SUMMARY:');
  console.log(`   Deleted Records: ${deletedRecords.length}`);
  console.log(`   Created Records: ${createdRecords.length}`);
  console.log();
  console.log('To revert changes:');
  console.log(`   1. Open MongoDB shell: mongosh "${process.env.MONGODB_URI}"`);
  console.log(`   2. Copy and paste commands from: ${path.basename(revertFile)}`);
  console.log('   OR');
  console.log(`   mongosh "${process.env.MONGODB_URI}" < ${revertFile}`);
}

// Run the recalculation
recalculateInterest();
