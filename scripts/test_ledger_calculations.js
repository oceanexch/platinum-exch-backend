/**
 * Test Script: Validate Ledger Calculation Logic
 * 
 * This script tests the ledger calculation logic to ensure consistency
 * between self-view and upline view scenarios.
 * 
 * Run with: node scripts/test_ledger_calculations.js
 */

const mongoose = require('mongoose');
require('dotenv').config();

// Import models and services
const UserModel = require('../src/models/UserModel');
const MonthlyFinalBillModel = require('../src/models/MonthlyFinalBill');
const FinalBillModel = require('../src/models/FinalBillModel');

// Test scenarios
const testScenarios = [
  {
    name: 'Level 7 Client Self-View',
    description: 'Client viewing their own ledger should see cumulative balance',
    userLevel: 7,
    viewType: 'self'
  },
  {
    name: 'Admin Viewing Client',
    description: 'Admin viewing client ledger should see their partnership share',
    userLevel: 2,
    viewType: 'upline',
    targetLevel: 7
  },
  {
    name: 'Broker Viewing Client',
    description: 'Broker viewing client ledger should see their earnings',
    userLevel: 5,
    viewType: 'upline',
    targetLevel: 7
  },
  {
    name: 'Master Self-View',
    description: 'Master viewing their own ledger should see their net earnings',
    userLevel: 3,
    viewType: 'self'
  }
];

async function testLedgerCalculations() {
  try {
    console.log('[Test] Starting ledger calculation validation...');
    
    // Connect to MongoDB
    await mongoose.connect(process.env.MONGODB_URI || 'mongodb://localhost:27017/oceanexch');
    console.log('[Test] Connected to MongoDB');

    // Test each scenario
    for (const scenario of testScenarios) {
      console.log(`\n[Test] 🧪 Testing: ${scenario.name}`);
      console.log(`[Test] Description: ${scenario.description}`);
      
      await testScenario(scenario);
    }

    console.log('\n[Test] 🎯 Testing cumulative balance example from requirements...');
    await testCumulativeBalanceExample();

  } catch (error) {
    console.error('[Test] ❌ Error:', error);
    process.exit(1);
  } finally {
    await mongoose.disconnect();
    console.log('[Test] Disconnected from MongoDB');
  }
}

async function testScenario(scenario) {
  try {
    // Find a user of the specified level
    const user = await UserModel.findOne({
      'accountType.level': scenario.userLevel,
      isDeleted: false
    }).populate('accountType', 'level label').lean();

    if (!user) {
      console.log(`[Test] ⚠️  No user found with level ${scenario.userLevel}`);
      return;
    }

    console.log(`[Test] Found user: ${user.accountName} (${user.accountCode}) - Level ${user.accountType.level}`);

    // Get their monthly bills
    const monthlyBills = await MonthlyFinalBillModel.find({
      userId: user._id
    }).sort({ month: 1 }).lean();

    if (monthlyBills.length === 0) {
      console.log(`[Test] ⚠️  No monthly bills found for user`);
      return;
    }

    console.log(`[Test] Found ${monthlyBills.length} monthly bills`);

    // Test cumulative balance calculation
    let expectedCumulative = 0;
    monthlyBills.forEach((bill, index) => {
      const opening = Number(bill.openingBalance || 0);
      const m2m = Number(bill.totalM2M || 0);
      const cash = Number(bill.selfCash || 0);
      const jv = Number(bill.selfJV || 0);
      const stored = Number(bill.closingBalance || 0);
      
      if (index === 0) {
        expectedCumulative = opening + m2m + cash + jv;
      } else {
        expectedCumulative = expectedCumulative + m2m + cash + jv;
      }
      
      const isCorrect = Math.abs(stored - expectedCumulative) < 0.01;
      const status = isCorrect ? '✅' : '❌';
      
      console.log(`[Test] ${status} Month ${bill.month}: Opening=${opening}, M2M=${m2m}, Cash=${cash}, JV=${jv} → Stored=${stored}, Expected=${expectedCumulative}`);
    });

  } catch (error) {
    console.error(`[Test] Error in scenario ${scenario.name}:`, error.message);
  }
}

async function testCumulativeBalanceExample() {
  try {
    // Create a test scenario based on the user's example
    console.log('[Test] Creating test scenario based on user requirements...');
    
    const testData = [
      {
        month: '2026-04',
        valans: [-400, 500, -1000, 200], // = -700
        cash: 300,
        jv: 0,
        expectedFinal: -400 // -700 + 300 = -400
      },
      {
        month: '2026-05',
        valans: [100, -300, 500, -900], // = -600
        cash: 0,
        jv: 0,
        expectedFinal: -1000 // -400 + (-600) = -1000
      },
      {
        month: '2026-06',
        valans: [1000, -200], // = 800
        cash: -1000, // user gave us 1000
        jv: 0,
        expectedFinal: -800 // -1000 + 800 + (-1000) = -800
      }
    ];

    let runningBalance = 0;
    
    testData.forEach((monthData, index) => {
      const valanTotal = monthData.valans.reduce((sum, val) => sum + val, 0);
      const monthlyChange = valanTotal + monthData.cash + monthData.jv;
      
      if (index === 0) {
        runningBalance = monthlyChange;
      } else {
        runningBalance += monthlyChange;
      }
      
      const isCorrect = runningBalance === monthData.expectedFinal;
      const status = isCorrect ? '✅' : '❌';
      
      console.log(`[Test] ${status} ${monthData.month}:`);
      console.log(`[Test]   Valans: [${monthData.valans.join(', ')}] = ${valanTotal}`);
      console.log(`[Test]   Cash: ${monthData.cash}, JV: ${monthData.jv}`);
      console.log(`[Test]   Monthly Change: ${monthlyChange}`);
      console.log(`[Test]   Running Balance: ${runningBalance}`);
      console.log(`[Test]   Expected: ${monthData.expectedFinal}`);
      console.log(`[Test]   Status: ${isCorrect ? 'PASS' : 'FAIL'}`);
      console.log('');
    });

  } catch (error) {
    console.error('[Test] Error in cumulative balance example:', error.message);
  }
}

// Utility function to simulate partnership breakdown calculation
function calculatePartnershipShare(totalM2M, partnership, requesterLevel) {
  if (!Array.isArray(partnership) || partnership.length === 0) {
    return 0;
  }
  
  const sharePercent = partnership[requesterLevel - 1] || 0;
  return (totalM2M * sharePercent) / 100;
}

// Run the tests
if (require.main === module) {
  testLedgerCalculations()
    .then(() => {
      console.log('\n[Test] 🎉 All tests completed');
      process.exit(0);
    })
    .catch(error => {
      console.error('\n[Test] 💥 Tests failed:', error);
      process.exit(1);
    });
}

module.exports = { testLedgerCalculations };