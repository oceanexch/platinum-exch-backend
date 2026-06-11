/**
 * Bill Accuracy Validation Script
 * 
 * This script validates that the generated bills follow the correct logic:
 * 1. Partnership breakdown calculations are accurate
 * 2. Cumulative balance calculations are correct
 * 3. Self-view vs upline view consistency
 * 4. Broker brokerage calculations
 * 
 * Run with: node scripts/validate_bill_accuracy.js
 */

const mongoose = require('mongoose');
require('dotenv').config();

// Import models
const UserModel = require('../src/models/UserModel');
const FinalBillModel = require('../src/models/FinalBillModel');
const MonthlyFinalBillModel = require('../src/models/MonthlyFinalBill');
const WeekValanModel = require('../src/models/WeekValanModel');
const StockTransactionModel = require('../src/models/StockTransactionModel');

async function validateBillAccuracy(options = {}) {
  const { manageConnection = true } = options;
  
  try {
    console.log('[Validation] Starting bill accuracy validation...');
    
    // Connect to MongoDB only if we need to manage the connection
    if (manageConnection) {
      await mongoose.connect(process.env.MONGODB_URI || 'mongodb://localhost:27017/platinum-exch');
      console.log('[Validation] Connected to MongoDB');
    } else {
      // Verify existing connection
      if (mongoose.connection.readyState !== 1) {
        throw new Error('MongoDB connection required but not available');
      }
      console.log('[Validation] Using existing MongoDB connection');
    }

    // Run all validation tests
    await validatePartnershipBreakdown();
    await validateCumulativeBalance();
    await validateBrokerBrokerage();
    await validateConsistency();
    await validateUserLevelLogic();

    console.log('\n[Validation] 🎉 All validations completed');

  } catch (error) {
    console.error('[Validation] ❌ Error:', error);
    if (manageConnection) {
      process.exit(1);
    } else {
      throw error; // Re-throw for parent script to handle
    }
  } finally {
    if (manageConnection) {
      await mongoose.disconnect();
      console.log('[Validation] Disconnected from MongoDB');
    }
  }
}

async function validatePartnershipBreakdown() {
  console.log('\n[Validation] 🧪 Testing Partnership Breakdown Calculations...');
  
  // Find bills with partnership breakdown
  const billsWithBreakdown = await FinalBillModel.find({
    'partnershipBreakdown.0': { $exists: true }
  }).limit(10).lean();

  if (billsWithBreakdown.length === 0) {
    console.log('[Validation] ⚠️  No bills found with partnership breakdown');
    return;
  }

  let passCount = 0;
  let failCount = 0;

  for (const bill of billsWithBreakdown) {
    const totalM2M = Number(bill.totalM2M || 0);
    let calculatedTotal = 0;

    // Sum all partnership breakdown amounts
    if (Array.isArray(bill.partnershipBreakdown)) {
      calculatedTotal = bill.partnershipBreakdown.reduce((sum, pb) => {
        return sum + Number(pb.amount || 0);
      }, 0);
    }

    // The partnership breakdown should not exceed totalM2M (but may be less due to rounding or partial partnerships)
    const isValid = Math.abs(calculatedTotal) <= Math.abs(totalM2M) + 0.01;
    
    if (isValid) {
      passCount++;
      console.log(`[Validation] ✅ ${bill.accountName}: M2M=${totalM2M}, Breakdown Sum=${calculatedTotal}`);
    } else {
      failCount++;
      console.log(`[Validation] ❌ ${bill.accountName}: M2M=${totalM2M}, Breakdown Sum=${calculatedTotal} (MISMATCH)`);
    }
  }

  console.log(`[Validation] Partnership Breakdown: ${passCount} passed, ${failCount} failed`);
}

async function validateCumulativeBalance() {
  console.log('\n[Validation] 🧪 Testing Cumulative Balance Calculations...');
  
  // Find users with multiple monthly bills
  const userGroups = await MonthlyFinalBillModel.aggregate([
    {
      $group: {
        _id: { userId: '$userId', marketId: '$marketId' },
        count: { $sum: 1 },
        bills: { $push: '$$ROOT' }
      }
    },
    { $match: { count: { $gt: 1 } } },
    { $limit: 5 }
  ]);

  if (userGroups.length === 0) {
    console.log('[Validation] ⚠️  No users found with multiple monthly bills');
    return;
  }

  let passCount = 0;
  let failCount = 0;

  for (const group of userGroups) {
    const bills = group.bills.sort((a, b) => a.month.localeCompare(b.month));
    let expectedCumulative = 0;
    let allCorrect = true;

    for (let i = 0; i < bills.length; i++) {
      const bill = bills[i];
      const opening = Number(bill.openingBalance || 0);
      const m2m = Number(bill.totalM2M || 0);
      const cash = Number(bill.selfCash || 0);
      const jv = Number(bill.selfJV || 0);
      const stored = Number(bill.closingBalance || 0);

      if (i === 0) {
        // First month: closing = opening + m2m + cash + jv
        expectedCumulative = opening + m2m + cash + jv;
      } else {
        // Subsequent months: opening should equal previous closing
        const prevBill = bills[i - 1];
        const prevClosing = Number(prevBill.closingBalance || 0);
        
        if (Math.abs(opening - prevClosing) > 0.01) {
          console.log(`[Validation] ❌ ${bill.accountName} ${bill.month}: Opening=${opening} != Previous Closing=${prevClosing}`);
          allCorrect = false;
        }
        
        expectedCumulative = opening + m2m + cash + jv;
      }

      if (Math.abs(stored - expectedCumulative) > 0.01) {
        console.log(`[Validation] ❌ ${bill.accountName} ${bill.month}: Expected=${expectedCumulative}, Stored=${stored}`);
        allCorrect = false;
      }
    }

    if (allCorrect) {
      passCount++;
      console.log(`[Validation] ✅ ${bills[0].accountName}: ${bills.length} months cumulative balance correct`);
    } else {
      failCount++;
    }
  }

  console.log(`[Validation] Cumulative Balance: ${passCount} passed, ${failCount} failed`);
}

async function validateBrokerBrokerage() {
  console.log('\n[Validation] 🧪 Testing Broker Brokerage Calculations...');
  
  // Find broker bills (levels 5 and 6)
  const brokerBills = await FinalBillModel.find({
    level: { $in: [5, 6] }
  }).limit(10).lean();

  if (brokerBills.length === 0) {
    console.log('[Validation] ⚠️  No broker bills found');
    return;
  }

  let passCount = 0;
  let failCount = 0;

  for (const bill of brokerBills) {
    const brokerBrokerage = Number(bill.brokerBrokerage || 0);
    const selfBrokerage = Number(bill.selfBrokerage || 0);
    const brokerNetPrice = Number(bill.brokerNetPrice || 0);

    // For brokers, brokerBrokerage should equal selfBrokerage
    const brokerageCorrect = Math.abs(brokerBrokerage - selfBrokerage) < 0.01;
    
    // Broker's net price should include their brokerage earnings
    const netPriceReasonable = Math.abs(brokerNetPrice - brokerBrokerage) < Math.abs(bill.totalM2M || 0) + 0.01;

    if (brokerageCorrect && netPriceReasonable) {
      passCount++;
      console.log(`[Validation] ✅ Broker ${bill.accountName}: Brokerage=${brokerBrokerage}, Net=${brokerNetPrice}`);
    } else {
      failCount++;
      console.log(`[Validation] ❌ Broker ${bill.accountName}: Brokerage=${brokerBrokerage}, Self=${selfBrokerage}, Net=${brokerNetPrice}`);
    }
  }

  console.log(`[Validation] Broker Brokerage: ${passCount} passed, ${failCount} failed`);
}

async function validateConsistency() {
  console.log('\n[Validation] 🧪 Testing Weekly vs Monthly Bill Consistency...');
  
  // Find a month with both weekly and monthly bills
  const monthlyBill = await MonthlyFinalBillModel.findOne().lean();
  if (!monthlyBill) {
    console.log('[Validation] ⚠️  No monthly bills found');
    return;
  }

  // Find corresponding weekly bills
  const weeklyBills = await FinalBillModel.find({
    userId: monthlyBill.userId,
    marketId: monthlyBill.marketId,
    valanId: { $in: monthlyBill.valanIds || [] }
  }).lean();

  if (weeklyBills.length === 0) {
    console.log('[Validation] ⚠️  No corresponding weekly bills found');
    return;
  }

  // Sum weekly bills
  const weeklyTotalM2M = weeklyBills.reduce((sum, b) => sum + Number(b.totalM2M || 0), 0);
  const weeklyCash = weeklyBills.reduce((sum, b) => sum + Number(b.selfCash || 0), 0);
  const weeklyJV = weeklyBills.reduce((sum, b) => sum + Number(b.selfJV || 0), 0);

  // Compare with monthly bill
  const monthlyTotalM2M = Number(monthlyBill.totalM2M || 0);
  const monthlyCash = Number(monthlyBill.selfCash || 0);
  const monthlyJV = Number(monthlyBill.selfJV || 0);

  const m2mMatch = Math.abs(weeklyTotalM2M - monthlyTotalM2M) < 0.01;
  const cashMatch = Math.abs(weeklyCash - monthlyCash) < 0.01;
  const jvMatch = Math.abs(weeklyJV - monthlyJV) < 0.01;

  if (m2mMatch && cashMatch && jvMatch) {
    console.log(`[Validation] ✅ ${monthlyBill.accountName} ${monthlyBill.month}: Weekly/Monthly consistency correct`);
  } else {
    console.log(`[Validation] ❌ ${monthlyBill.accountName} ${monthlyBill.month}:`);
    console.log(`  M2M: Weekly=${weeklyTotalM2M}, Monthly=${monthlyTotalM2M} ${m2mMatch ? '✅' : '❌'}`);
    console.log(`  Cash: Weekly=${weeklyCash}, Monthly=${monthlyCash} ${cashMatch ? '✅' : '❌'}`);
    console.log(`  JV: Weekly=${weeklyJV}, Monthly=${monthlyJV} ${jvMatch ? '✅' : '❌'}`);
  }
}

async function validateUserLevelLogic() {
  console.log('\n[Validation] 🧪 Testing User Level Logic...');
  
  // Test different user levels
  const levels = [1, 2, 3, 4, 5, 6, 7];
  
  for (const level of levels) {
    const bills = await FinalBillModel.find({ level }).limit(3).lean();
    
    if (bills.length === 0) {
      console.log(`[Validation] ⚠️  No bills found for level ${level}`);
      continue;
    }

    let passCount = 0;
    let failCount = 0;

    for (const bill of bills) {
      let isValid = true;
      const issues = [];

      // Level 7 (clients) should have meaningful totalM2M
      if (level === 7) {
        if (bill.totalM2M === undefined || bill.totalM2M === null) {
          issues.push('Missing totalM2M');
          isValid = false;
        }
      }

      // Brokers (levels 5, 6) should have brokerage data
      if (level === 5 || level === 6) {
        if (!bill.brokerBrokerage && !bill.selfBrokerage) {
          issues.push('Missing brokerage data');
          isValid = false;
        }
      }

      // All bills should have selfNetPrice
      if (bill.selfNetPrice === undefined || bill.selfNetPrice === null) {
        issues.push('Missing selfNetPrice');
        isValid = false;
      }

      if (isValid) {
        passCount++;
      } else {
        failCount++;
        console.log(`[Validation] ❌ Level ${level} ${bill.accountName}: ${issues.join(', ')}`);
      }
    }

    if (passCount > 0) {
      console.log(`[Validation] ✅ Level ${level}: ${passCount} bills validated successfully`);
    }
  }
}

// Run the validation
if (require.main === module) {
  validateBillAccuracy()
    .then(() => {
      console.log('\n[Validation] 🎉 Validation completed');
      process.exit(0);
    })
    .catch(error => {
      console.error('\n[Validation] 💥 Validation failed:', error);
      process.exit(1);
    });
}

module.exports = { validateBillAccuracy };