/**
 * Check CF/BF transactions for a user and script
 * 
 * Usage:
 *   node scratch/check_cf_bf_transactions.js <userId> <scriptId> <valanId>
 */

require('dotenv').config();
const mongoose = require('mongoose');
const StockTransaction = require('../src/models/StockTransactionModel');

const checkCFBFTransactions = async (userId, scriptId, valanId) => {
  try {
    console.log('🔍 Checking transactions...');
    console.log(`   User ID: ${userId}`);
    console.log(`   Script ID: ${scriptId}`);
    console.log(`   Valan ID: ${valanId}`);
    console.log('');

    const transactions = await StockTransaction.find({
      userId: new mongoose.Types.ObjectId(userId),
      scriptId: scriptId,
      valanId: new mongoose.Types.ObjectId(valanId)
    })
    .select('transactionType quantity lot type transactionStatus createdAt')
    .sort({ createdAt: 1 })
    .lean();

    console.log(`📊 Found ${transactions.length} transactions:`);
    console.log('');

    let totalBuy = 0;
    let totalSell = 0;
    let totalBuyLot = 0;
    let totalSellLot = 0;

    transactions.forEach((txn, index) => {
      console.log(`${index + 1}. ${txn.transactionType} - ${txn.quantity} qty (${txn.lot} lot)`);
      console.log(`   Type: ${txn.type}`);
      console.log(`   Status: ${txn.transactionStatus}`);
      console.log(`   Date: ${txn.createdAt}`);
      console.log('');

      if (txn.transactionStatus === 'COMPLETED') {
        if (txn.transactionType === 'BUY') {
          totalBuy += txn.quantity;
          totalBuyLot += txn.lot;
        } else {
          totalSell += txn.quantity;
          totalSellLot += txn.lot;
        }
      }
    });

    console.log('📈 Summary (COMPLETED only):');
    console.log(`   Total BUY: ${totalBuy} qty (${totalBuyLot} lot)`);
    console.log(`   Total SELL: ${totalSell} qty (${totalSellLot} lot)`);
    console.log(`   Net Position: ${totalBuy - totalSell} qty (${totalBuyLot - totalSellLot} lot)`);
    console.log('');

    const cfTransactions = transactions.filter(t => t.type === 'CF');
    const bfTransactions = transactions.filter(t => t.type === 'BF');

    console.log(`🔄 CF (Carry Forward) transactions: ${cfTransactions.length}`);
    console.log(`🔄 BF (B Forward) transactions: ${bfTransactions.length}`);

    if (cfTransactions.length === 0 && (totalBuy !== totalSell)) {
      console.log('');
      console.log('⚠️  WARNING: Position is not squared off and no CF transaction found!');
      console.log('   This valan should have a CF transaction to close the position.');
    }

    return { transactions, totalBuy, totalSell, cfTransactions, bfTransactions };
  } catch (error) {
    console.error('❌ Error:', error.message);
    throw error;
  }
};

// Main execution
const main = async () => {
  const args = process.argv.slice(2);

  if (args.length < 3) {
    console.error('❌ Error: Missing required arguments');
    console.log('');
    console.log('Usage:');
    console.log('  node scratch/check_cf_bf_transactions.js <userId> <scriptId> <valanId>');
    console.log('');
    console.log('Example:');
    console.log('  node scratch/check_cf_bf_transactions.js 69c36e1b4e7c406cb57a33ec MARUTI26APRFUT 69d0983a941ef7ebe0bef9d7');
    process.exit(1);
  }

  const [userId, scriptId, valanId] = args;

  try {
    // Connect to MongoDB
    console.log('🔌 Connecting to MongoDB...');
    await mongoose.connect(process.env.MONGO_URI || process.env.DATABASE_URL, {
      useNewUrlParser: true,
      useUnifiedTopology: true,
    });
    console.log('✅ Connected to MongoDB');
    console.log('');

    // Run the check
    await checkCFBFTransactions(userId, scriptId, valanId);

    console.log('✅ Check completed!');
  } catch (error) {
    console.error('❌ Check failed:', error);
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

module.exports = { checkCFBFTransactions };
