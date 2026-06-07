require('dotenv').config();
const mongoose = require('mongoose');
const moment = require('moment');

async function debugExpiryScript() {
  try {
    await mongoose.connect(process.env.MONGODB_URI);
    console.log('Connected to MongoDB');

    const { Script } = require('../src/models/MarketTypeModel');
    const StockTransaction = require('../src/models/StockTransactionModel');

    const scriptId = 'NIFTY26MAY24500CE';
    const todayStr = '2026-05-12';

    console.log('\n=== CHECKING SCRIPT DOCUMENT ===');
    console.log('ScriptId:', scriptId);
    console.log('Today:', todayStr);

    // Find the Script document
    const scriptDoc = await Script.findOne({
      'expiry.script_id': scriptId
    }).lean();

    if (!scriptDoc) {
      console.log('\n❌ No Script document found with this script_id in expiry array');
      await mongoose.disconnect();
      return;
    }

    console.log('\n✓ Found Script document:');
    console.log('  _id:', scriptDoc._id);
    console.log('  script_name:', scriptDoc.script_name);
    console.log('  market_type_id:', scriptDoc.market_type_id);

    // Find the specific expiry entry
    const expiryEntry = scriptDoc.expiry?.find(e => e.script_id === scriptId);

    if (!expiryEntry) {
      console.log('\n❌ No expiry entry found for this script_id');
      await mongoose.disconnect();
      return;
    }

    console.log('\n=== EXPIRY ENTRY ===');
    console.log('  script_id:', expiryEntry.script_id);
    console.log('  script_expiry_id:', expiryEntry.script_expiry_id);
    console.log('  symbol:', expiryEntry.symbol);
    console.log('  expiry_date:', expiryEntry.expiry_date);
    console.log('  tradeEndDate:', expiryEntry.tradeEndDate);
    console.log('  strike:', expiryEntry.strike);
    console.log('  option_type:', expiryEntry.option_type);

    console.log('\n=== COMPARISON ===');
    console.log('  tradeEndDate === today?', expiryEntry.tradeEndDate === todayStr);
    console.log('  Should be squared off?', expiryEntry.tradeEndDate === todayStr ? 'YES' : 'NO');

    // Check for open positions
    console.log('\n=== CHECKING OPEN POSITIONS ===');
    const { getActiveWeekValan } = require('../src/services/StockService');
    const activeValan = await getActiveWeekValan();

    const pipeline = [
      {
        $match: {
          scriptId: scriptId,
          valanId: activeValan._id,
          transactionStatus: "COMPLETED"
        }
      },
      {
        $group: {
          _id: {
            userId: "$userId",
            scriptId: "$scriptId",
            marketId: "$marketId",
            valanId: "$valanId"
          },
          buyQuantity: {
            $sum: {
              $cond: [{ $eq: ["$transactionType", "BUY"] }, "$quantity", 0]
            }
          },
          sellQuantity: {
            $sum: {
              $cond: [{ $eq: ["$transactionType", "SELL"] }, "$quantity", 0]
            }
          }
        }
      },
      {
        $match: {
          $expr: { $ne: ["$buyQuantity", "$sellQuantity"] }
        }
      }
    ];

    const openPositions = await StockTransaction.aggregate(pipeline);

    console.log('  Active Valan:', activeValan.label || activeValan._id);
    console.log('  Open positions:', openPositions.length);

    if (openPositions.length > 0) {
      openPositions.forEach(pos => {
        const netQty = pos.buyQuantity - pos.sellQuantity;
        console.log(`\n  Position:`);
        console.log(`    userId: ${pos._id.userId}`);
        console.log(`    buy: ${pos.buyQuantity}, sell: ${pos.sellQuantity}`);
        console.log(`    netQty: ${netQty} (${netQty > 0 ? 'LONG' : 'SHORT'})`);
      });
    }

    await mongoose.disconnect();
  } catch (error) {
    console.error('Error:', error);
    process.exit(1);
  }
}

debugExpiryScript();
