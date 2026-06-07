/**
 * Verify that positions are correctly calculated in both old and new valans after bill generation
 * 
 * Usage:
 *   node scratch/verify_valan_positions.js <userId> <scriptId> <oldValanId> <newValanId>
 */

require('dotenv').config();
const mongoose = require('mongoose');
const StockTransaction = require('../src/models/StockTransactionModel');
const UserPosition = require('../src/models/UserPositionModel');

const verifyValanPositions = async (userId, scriptId, oldValanId, newValanId) => {
  try {
    console.log('🔍 Verifying positions across valans...');
    console.log(`   User ID: ${userId}`);
    console.log(`   Script ID: ${scriptId}`);
    console.log(`   Old Valan ID: ${oldValanId}`);
    console.log(`   New Valan ID: ${newValanId}`);
    console.log('');

    // Check OLD valan
    console.log('📊 OLD VALAN Analysis:');
    console.log('─'.repeat(60));
    
    const oldTxns = await StockTransaction.find({
      userId: new mongoose.Types.ObjectId(userId),
      scriptId: scriptId,
      valanId: new mongoose.Types.ObjectId(oldValanId),
      transactionStatus: 'COMPLETED'
    })
    .select('transactionType quantity lot type createdAt')
    .sort({ createdAt: 1 })
    .lean();

    let oldBuy = 0, oldSell = 0, oldBuyLot = 0, oldSellLot = 0;
    let hasCF = false;

    console.log(`   Found ${oldTxns.length} transactions:`);
    oldTxns.forEach((txn, i) => {
      console.log(`   ${i + 1}. ${txn.type} - ${txn.transactionType} ${txn.quantity} qty (${txn.lot} lot)`);
      if (txn.transactionType === 'BUY') {
        oldBuy += txn.quantity;
        oldBuyLot += txn.lot;
      } else {
        oldSell += txn.quantity;
        oldSellLot += txn.lot;
      }
      if (txn.type === 'CF') hasCF = true;
    });

    console.log('');
    console.log(`   Total BUY: ${oldBuy} qty (${oldBuyLot} lot)`);
    console.log(`   Total SELL: ${oldSell} qty (${oldSellLot} lot)`);
    console.log(`   Net: ${oldBuy - oldSell} qty (${oldBuyLot - oldSellLot} lot)`);
    console.log(`   Has CF: ${hasCF ? '✅ Yes' : '❌ No'}`);

    const oldPosition = await UserPosition.findOne({
      userId: new mongoose.Types.ObjectId(userId),
      scriptId: scriptId,
      valanId: new mongoose.Types.ObjectId(oldValanId)
    }).lean();

    console.log('');
    console.log('   UserPosition Record:');
    if (oldPosition) {
      console.log(`   BUY: ${oldPosition.buyQuantity} qty (${oldPosition.buyLot} lot)`);
      console.log(`   SELL: ${oldPosition.sellQuantity} qty (${oldPosition.sellLot} lot)`);
      console.log(`   Net: ${oldPosition.buyQuantity - oldPosition.sellQuantity} qty`);
      
      const isSquared = oldPosition.buyQuantity === oldPosition.sellQuantity;
      if (isSquared) {
        console.log(`   Status: ✅ SQUARED OFF`);
      } else {
        console.log(`   Status: ⚠️  OPEN POSITION`);
      }
    } else {
      console.log(`   ❌ No position record found`);
    }

    // Check NEW valan
    console.log('');
    console.log('📊 NEW VALAN Analysis:');
    console.log('─'.repeat(60));
    
    const newTxns = await StockTransaction.find({
      userId: new mongoose.Types.ObjectId(userId),
      scriptId: scriptId,
      valanId: new mongoose.Types.ObjectId(newValanId),
      transactionStatus: 'COMPLETED'
    })
    .select('transactionType quantity lot type createdAt')
    .sort({ createdAt: 1 })
    .lean();

    let newBuy = 0, newSell = 0, newBuyLot = 0, newSellLot = 0;
    let hasBF = false;

    console.log(`   Found ${newTxns.length} transactions:`);
    newTxns.forEach((txn, i) => {
      console.log(`   ${i + 1}. ${txn.type} - ${txn.transactionType} ${txn.quantity} qty (${txn.lot} lot)`);
      if (txn.transactionType === 'BUY') {
        newBuy += txn.quantity;
        newBuyLot += txn.lot;
      } else {
        newSell += txn.quantity;
        newSellLot += txn.lot;
      }
      if (txn.type === 'BF') hasBF = true;
    });

    console.log('');
    console.log(`   Total BUY: ${newBuy} qty (${newBuyLot} lot)`);
    console.log(`   Total SELL: ${newSell} qty (${newSellLot} lot)`);
    console.log(`   Net: ${newBuy - newSell} qty (${newBuyLot - newSellLot} lot)`);
    console.log(`   Has BF: ${hasBF ? '✅ Yes' : '❌ No'}`);

    const newPosition = await UserPosition.findOne({
      userId: new mongoose.Types.ObjectId(userId),
      scriptId: scriptId,
      valanId: new mongoose.Types.ObjectId(newValanId)
    }).lean();

    console.log('');
    console.log('   UserPosition Record:');
    if (newPosition) {
      console.log(`   BUY: ${newPosition.buyQuantity} qty (${newPosition.buyLot} lot)`);
      console.log(`   SELL: ${newPosition.sellQuantity} qty (${newPosition.sellLot} lot)`);
      console.log(`   Net: ${newPosition.buyQuantity - newPosition.sellQuantity} qty`);
      
      const isSquared = newPosition.buyQuantity === newPosition.sellQuantity;
      if (isSquared) {
        console.log(`   Status: ✅ SQUARED OFF`);
      } else {
        console.log(`   Status: ⚠️  OPEN POSITION`);
      }
    } else {
      console.log(`   ❌ No position record found`);
    }

    // Validation
    console.log('');
    console.log('🔍 VALIDATION:');
    console.log('─'.repeat(60));

    const issues = [];

    // Old valan should be squared if CF exists
    if (hasCF && oldBuy !== oldSell) {
      issues.push('❌ Old valan has CF but position is not squared');
    } else if (hasCF && oldBuy === oldSell) {
      console.log('✅ Old valan is correctly squared with CF');
    }

    // New valan should have BF if old had CF
    if (hasCF && !hasBF) {
      issues.push('❌ Old valan has CF but new valan has no BF');
    } else if (hasCF && hasBF) {
      console.log('✅ New valan has BF matching old valan CF');
    }

    // Position records should match transaction totals
    if (oldPosition && (oldPosition.buyQuantity !== oldBuy || oldPosition.sellQuantity !== oldSell)) {
      issues.push('❌ Old valan position record does not match transactions');
    } else if (oldPosition) {
      console.log('✅ Old valan position record matches transactions');
    }

    if (newPosition && (newPosition.buyQuantity !== newBuy || newPosition.sellQuantity !== newSell)) {
      issues.push('❌ New valan position record does not match transactions');
    } else if (newPosition) {
      console.log('✅ New valan position record matches transactions');
    }

    if (issues.length > 0) {
      console.log('');
      console.log('⚠️  ISSUES FOUND:');
      issues.forEach(issue => console.log(`   ${issue}`));
      return false;
    } else {
      console.log('');
      console.log('✅ All validations passed!');
      return true;
    }

  } catch (error) {
    console.error('❌ Error:', error.message);
    throw error;
  }
};

// Main execution
const main = async () => {
  const args = process.argv.slice(2);

  if (args.length < 4) {
    console.error('❌ Error: Missing required arguments');
    console.log('');
    console.log('Usage:');
    console.log('  node scratch/verify_valan_positions.js <userId> <scriptId> <oldValanId> <newValanId>');
    console.log('');
    console.log('Example:');
    console.log('  node scratch/verify_valan_positions.js 69c36e1b4e7c406cb57a33ec MARUTI26APRFUT 69d0983a941ef7ebe0bef9d7 69d9d5aa8a513ba15416a33b');
    process.exit(1);
  }

  const [userId, scriptId, oldValanId, newValanId] = args;

  try {
    // Connect to MongoDB
    console.log('🔌 Connecting to MongoDB...');
    await mongoose.connect(process.env.MONGO_URI || process.env.DATABASE_URL, {
      useNewUrlParser: true,
      useUnifiedTopology: true,
    });
    console.log('✅ Connected to MongoDB');
    console.log('');

    // Run verification
    const isValid = await verifyValanPositions(userId, scriptId, oldValanId, newValanId);

    console.log('');
    if (isValid) {
      console.log('✅ Verification completed successfully!');
    } else {
      console.log('⚠️  Verification completed with issues!');
    }
  } catch (error) {
    console.error('❌ Verification failed:', error);
    process.exit(1);
  } finally {
    // Close MongoDB connection
    await mongoose.connection.close();
    console.log('');
    console.log('🔌 MongoDB connection closed');
  }
};

// Run if called directly
if (require.main === module) {
  main();
}

module.exports = { verifyValanPositions };
