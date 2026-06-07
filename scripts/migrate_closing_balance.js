/**
 * Migration Script: Populate closingBalance field in MonthlyFinalBill collection
 * 
 * This script calculates and populates the closingBalance field for existing
 * MonthlyFinalBill records to support the new cumulative balance tracking.
 * 
 * Run with: node scripts/migrate_closing_balance.js
 */

const mongoose = require('mongoose');
require('dotenv').config();

// Import models
const MonthlyFinalBillModel = require('../src/models/MonthlyFinalBill');

async function migrateClosingBalance(options = {}) {
  const { manageConnection = true } = options;
  
  try {
    console.log('[Migration] Starting closingBalance field population...');
    
    // Connect to MongoDB only if we need to manage the connection
    if (manageConnection) {
      await mongoose.connect(process.env.MONGODB_URI || 'mongodb://localhost:27017/oceanexch');
      console.log('[Migration] Connected to MongoDB');
    } else {
      // Verify existing connection
      if (mongoose.connection.readyState !== 1) {
        throw new Error('MongoDB connection required but not available');
      }
      console.log('[Migration] Using existing MongoDB connection');
    }

    // Get all monthly bills ordered by month
    const allBills = await MonthlyFinalBillModel.find({})
      .sort({ userId: 1, marketId: 1, month: 1 })
      .lean();

    console.log(`[Migration] Found ${allBills.length} monthly bills to process`);

    // Group by userId + marketId to process each user's timeline
    const userMarketGroups = new Map();
    
    allBills.forEach(bill => {
      const key = `${bill.userId}_${bill.marketId}`;
      if (!userMarketGroups.has(key)) {
        userMarketGroups.set(key, []);
      }
      userMarketGroups.get(key).push(bill);
    });

    console.log(`[Migration] Processing ${userMarketGroups.size} user-market combinations`);

    let updatedCount = 0;
    const bulkOps = [];

    // Process each user-market timeline
    for (const [key, bills] of userMarketGroups.entries()) {
      let runningBalance = 0;
      
      // Sort bills by month to ensure chronological order
      bills.sort((a, b) => a.month.localeCompare(b.month));
      
      for (const bill of bills) {
        // Calculate closing balance: openingBalance + totalM2M + selfCash + selfJV
        const openingBalance = Number(bill.openingBalance || 0);
        const totalM2M = Number(bill.totalM2M || 0);
        const selfCash = Number(bill.selfCash || 0);
        const selfJV = Number(bill.selfJV || 0);
        
        // For the first month, use the calculated opening balance
        // For subsequent months, use the running balance from previous month
        if (runningBalance === 0 && openingBalance !== 0) {
          runningBalance = openingBalance;
        }
        
        // Calculate this month's closing balance
        const closingBalance = runningBalance + totalM2M + selfCash + selfJV;
        
        // Add to bulk operations if closingBalance is missing or different
        if (!bill.closingBalance || Math.abs(bill.closingBalance - closingBalance) > 0.01) {
          bulkOps.push({
            updateOne: {
              filter: { _id: bill._id },
              update: { $set: { closingBalance: closingBalance } }
            }
          });
          updatedCount++;
        }
        
        // Update running balance for next iteration
        runningBalance = closingBalance;
      }
    }

    // Execute bulk operations
    if (bulkOps.length > 0) {
      console.log(`[Migration] Updating ${bulkOps.length} records...`);
      
      // Process in batches of 1000
      const batchSize = 1000;
      for (let i = 0; i < bulkOps.length; i += batchSize) {
        const batch = bulkOps.slice(i, i + batchSize);
        await MonthlyFinalBillModel.bulkWrite(batch);
        console.log(`[Migration] Processed batch ${Math.floor(i / batchSize) + 1}/${Math.ceil(bulkOps.length / batchSize)}`);
      }
      
      console.log(`[Migration] ✅ Successfully updated ${updatedCount} records`);
    } else {
      console.log('[Migration] ✅ No records needed updating - all closingBalance fields are already populated');
    }

    // Verify the migration
    const verificationCount = await MonthlyFinalBillModel.countDocuments({ 
      closingBalance: { $exists: true, $ne: null } 
    });
    
    console.log(`[Migration] 🔍 Verification: ${verificationCount} records now have closingBalance field`);
    
    // Sample verification - show a few records
    const sampleRecords = await MonthlyFinalBillModel.find({})
      .select('userId accountName month marketId openingBalance totalM2M selfCash selfJV closingBalance')
      .limit(5)
      .lean();
    
    console.log('\n[Migration] 📋 Sample records after migration:');
    sampleRecords.forEach(record => {
      const calculated = (record.openingBalance || 0) + (record.totalM2M || 0) + (record.selfCash || 0) + (record.selfJV || 0);
      console.log(`  ${record.accountName} (${record.month}): Opening=${record.openingBalance}, M2M=${record.totalM2M}, Cash=${record.selfCash}, JV=${record.selfJV} → Closing=${record.closingBalance} (calc: ${calculated})`);
    });

  } catch (error) {
    console.error('[Migration] ❌ Error:', error);
    if (manageConnection) {
      process.exit(1);
    } else {
      throw error; // Re-throw for parent script to handle
    }
  } finally {
    if (manageConnection) {
      await mongoose.disconnect();
      console.log('[Migration] Disconnected from MongoDB');
    }
  }
}

// Run the migration
if (require.main === module) {
  migrateClosingBalance()
    .then(() => {
      console.log('[Migration] 🎉 Migration completed successfully');
      process.exit(0);
    })
    .catch(error => {
      console.error('[Migration] 💥 Migration failed:', error);
      process.exit(1);
    });
}

module.exports = { migrateClosingBalance };