/**
 * Recalculate NSE-EQ Interest for a specific user and date
 * 
 * Usage:
 *   node scripts/recalculate_nseeq_interest.js <userId> [date]
 * 
 * Examples:
 *   node scripts/recalculate_nseeq_interest.js 69e71e7d1eb2c2810b5e4dea
 *   node scripts/recalculate_nseeq_interest.js 69e71e7d1eb2c2810b5e4dea 2026-04-28
 */

require('dotenv').config();
const mongoose = require('mongoose');
const UserModel = require('../src/models/UserModel');
const NseEqInterestModel = require('../src/models/NseEqInterestModel');
const WeekValanModel = require('../src/models/WeekValanModel');
const StockTransactionModel = require('../src/models/StockTransactionModel');
const { getSingleStockData } = require('../src/services/RedisService');
const moment = require('moment');
const fs = require('fs');
const path = require('path');

// NSE-EQ market ID
const NSE_EQ_MARKET_ID = '12';

// Parse command line arguments
const args = process.argv.slice(2);
const userId = args[0];
const dateArg = args[1] || moment().format('YYYY-MM-DD');

// Validate arguments
if (!userId) {
  console.error('❌ Error: User ID is required');
  console.log('\nUsage:');
  console.log('  node scripts/recalculate_nseeq_interest.js <userId> [date]');
  console.log('\nExamples:');
  console.log('  node scripts/recalculate_nseeq_interest.js 69e71e7d1eb2c2810b5e4dea');
  console.log('  node scripts/recalculate_nseeq_interest.js 69e71e7d1eb2c2810b5e4dea 2026-04-28');
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

/**
 * Get current market price for a script from Redis
 */
async function getCurrentPrice(scriptName) {
  try {
    const stockData = await getSingleStockData(scriptName);
    if (stockData) {
      const parsed = typeof stockData === 'string' ? JSON.parse(stockData) : stockData;
      return Number(parsed.SellPrice || parsed.Ltp || parsed.BuyPrice || 0);
    }
    return 0;
  } catch (err) {
    console.error(`Error getting price for ${scriptName}:`, err.message);
    return 0;
  }
}

/**
 * Calculate holding worth and booked P&L for a user
 */
async function calculateHoldingAndBookedPnL(userId, valanId, date) {
  try {
    const startOfDay = moment(date).startOf('day').toDate();
    const endOfDay = moment(date).endOf('day').toDate();

    const transactions = await StockTransactionModel.find({
      userId,
      valanId,
      marketId: NSE_EQ_MARKET_ID,
      transactionStatus: 'COMPLETED',
      createdAt: { $gte: startOfDay, $lte: endOfDay }
    }).lean();

    const scriptMap = new Map();

    for (const txn of transactions) {
      const scriptId = txn.scriptId.toString();
      if (!scriptMap.has(scriptId)) {
        scriptMap.set(scriptId, {
          scriptId: txn.scriptId,
          scriptName: txn.scriptName,
          buyQty: 0,
          sellQty: 0,
          buyTotal: 0,
          sellTotal: 0
        });
      }

      const script = scriptMap.get(scriptId);
      const totalNetPrice = Number(txn.totalNetPrice || 0);
      const qty = Number(txn.quantity || 0);

      if (txn.transactionType === 'BUY') {
        script.buyQty += qty;
        script.buyTotal += totalNetPrice;
      } else if (txn.transactionType === 'SELL') {
        script.sellQty += qty;
        script.sellTotal += totalNetPrice;
      }
    }

    let totalHoldingWorth = 0;
    let totalBookedPnl = 0;

    for (const [scriptIdKey, data] of scriptMap) {
      const netQty = data.buyQty - data.sellQty;
      const closedQty = Math.min(data.buyQty, data.sellQty);

      // Calculate booked P&L for closed portion
      if (closedQty > 0) {
        const avgBuyPrice = data.buyTotal / data.buyQty;
        const avgSellPrice = data.sellTotal / data.sellQty;
        const realizedPnL = closedQty * (avgSellPrice - avgBuyPrice);
        const bookedPnl = -realizedPnL;
        totalBookedPnl += bookedPnl;
      }

      // Calculate holding worth for open portion
      if (netQty !== 0) {
        const remainingQty = Math.abs(netQty);
        
        if (netQty > 0) {
          // Long position
          const avgBuyPrice = data.buyTotal / data.buyQty;
          const currentPrice = await getCurrentPrice(data.scriptName);
          const unrealizedPnL = (currentPrice - avgBuyPrice) * remainingQty;
          const holdingValue = (remainingQty * avgBuyPrice) - unrealizedPnL;
          totalHoldingWorth += holdingValue;
        } else {
          // Short position
          const avgSellPrice = data.sellTotal / data.sellQty;
          const currentPrice = await getCurrentPrice(data.scriptName);
          const unrealizedPnL = (avgSellPrice - currentPrice) * remainingQty;
          const holdingValue = (remainingQty * avgSellPrice) - unrealizedPnL;
          totalHoldingWorth += holdingValue;
        }
      }
    }

    return {
      holdingWorth: Math.max(0, totalHoldingWorth),
      bookedPnl: totalBookedPnl
    };
  } catch (err) {
    console.error(`Error calculating holding/PnL for user ${userId}:`, err.message);
    return { holdingWorth: 0, bookedPnl: 0 };
  }
}

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

    // Get current valan
    const currentValan = await WeekValanModel.findOne({ status: true }).lean();
    if (!currentValan) {
      console.error('❌ Error: No active valan found');
      process.exit(1);
    }

    console.log(`📅 Using valan: ${currentValan.label}`);

    // Find the NSE-EQ market config for this user
    const nseEqMarket = (user.marketAccess || []).find(
      (m) => m.marketId === NSE_EQ_MARKET_ID && m.isSelected
    );

    if (!nseEqMarket) {
      console.log('⚠️  User does not have NSE-EQ market access enabled');
      console.log('-'.repeat(70));
      console.log();
      return;
    }

    const totalMargin = Number(nseEqMarket.margin?.totalMargin) || 0;
    if (totalMargin <= 0) {
      console.log('⚠️  User has no maximum limit set (totalMargin <= 0)');
      console.log('-'.repeat(70));
      console.log();
      return;
    }

    const marginPer = Math.min(
      Math.max(Number(nseEqMarket.margin?.marginPer) || 0, 0),
      100
    );

    const annualInterestPer = Number(user.basicDetails?.nseEqAnnualInterest) || 0;

    if (annualInterestPer <= 0) {
      console.log('⚠️  User has no annual interest rate set (annualInterestPer <= 0)');
      console.log('-'.repeat(70));
      console.log();
      return;
    }

    // Check if new ledger-based logic should be used
    const isLinkedWithLedger = Number(user.accountDetails?.nseeqinterestLinkedwithLedger) === 1;

    let interestAmount = 0;
    let interestableAmount = 0;
    let holdingWorth = 0;
    let bookedPnl = 0;

    console.log(`   Max Limit: ₹${totalMargin.toFixed(2)}`);
    console.log(`   Margin %: ${marginPer}%`);
    console.log(`   Annual Interest: ${annualInterestPer}%`);
    console.log(`   Logic: ${isLinkedWithLedger ? 'NEW (Ledger-based)' : 'OLD (Flat)'}`);
    console.log();

    if (isLinkedWithLedger) {
      // NEW LOGIC: Calculate based on actual loan usage
      console.log('   Calculating holding worth and booked P&L...');
      const result = await calculateHoldingAndBookedPnL(user._id, currentValan._id, targetDate);
      holdingWorth = result.holdingWorth;
      bookedPnl = result.bookedPnl;

      const availableMargin = totalMargin * (marginPer / 100);
      interestableAmount = Math.max(0, holdingWorth - availableMargin + bookedPnl);

      console.log(`   Holding Worth: ₹${holdingWorth.toFixed(2)}`);
      console.log(`   Available Margin: ₹${availableMargin.toFixed(2)}`);
      console.log(`   Booked P&L: ₹${bookedPnl.toFixed(2)}`);
      console.log(`   Interestable Amount: ₹${interestableAmount.toFixed(2)}`);

      if (interestableAmount <= 0.01) {
        console.log('   ⚠️  Interestable amount too low, no interest charged');
        console.log('-'.repeat(70));
        console.log();
        return;
      }

      interestAmount = interestableAmount * (annualInterestPer / 365 / 100);
    } else {
      // OLD LOGIC: Flat interest on loan amount
      const loanAmount = totalMargin * (1 - marginPer / 100);

      console.log(`   Loan Amount: ₹${loanAmount.toFixed(2)}`);

      if (loanAmount <= 0.01) {
        console.log('   ⚠️  Loan amount too low, no interest charged');
        console.log('-'.repeat(70));
        console.log();
        return;
      }

      interestAmount = loanAmount * (annualInterestPer / 365 / 100);
    }

    console.log(`   Daily Interest: ₹${interestAmount.toFixed(2)}`);

    // Create the interest record
    const newRecord = await NseEqInterestModel.create({
      userId: user._id,
      parentIds: user.parentIds || [],
      annualInterestPer: Number(annualInterestPer.toFixed(2)),
      maxLimit: Number(totalMargin.toFixed(2)),
      marginPer: Number(marginPer.toFixed(2)),
      interestAmount: Number(interestAmount.toFixed(2)),
      date: targetDate,
      isLinkedWithLedger: isLinkedWithLedger ? 1 : 0,
      bookedPnl: Number(bookedPnl.toFixed(2)),
      holdingWorth: Number(holdingWorth.toFixed(2)),
      interestableAmount: Number(interestableAmount.toFixed(2))
    });

    createdRecords.push(newRecord.toObject());

    console.log('-'.repeat(70));
    console.log();

    console.log('✅ Interest calculation completed successfully\n');

    // Fetch the newly created record
    const displayRecord = await NseEqInterestModel.findOne({
      userId: new mongoose.Types.ObjectId(userId),
      date: targetDate
    }).lean();

    if (displayRecord) {
      console.log('📊 NEW INTEREST RECORD:');
      console.log('='.repeat(70));
      console.log(`   Interest Amount: ₹${displayRecord.interestAmount.toFixed(2)}`);
      console.log(`   Annual Rate: ${displayRecord.annualInterestPer}%`);
      console.log(`   Max Limit: ₹${displayRecord.maxLimit.toFixed(2)}`);
      console.log(`   Margin %: ${displayRecord.marginPer}%`);
      console.log(`   Logic: ${displayRecord.isLinkedWithLedger ? 'NEW (Ledger-based)' : 'OLD (Flat)'}`);
      
      if (displayRecord.isLinkedWithLedger) {
        console.log(`   Holding Worth: ₹${displayRecord.holdingWorth.toFixed(2)}`);
        console.log(`   Booked P&L: ₹${displayRecord.bookedPnl.toFixed(2)}`);
        console.log(`   Interestable Amount: ₹${displayRecord.interestableAmount.toFixed(2)}`);
      }
      console.log('='.repeat(70));
      console.log();
    } else {
      console.log(`⚠️  No interest record created for this user (may have been skipped)\n`);
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
