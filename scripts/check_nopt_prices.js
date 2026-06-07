/**
 * Check NOPT Price Availability in Redis
 * 
 * Usage:
 *   node scripts/check_nopt_prices.js [accountCode]
 * 
 * Example:
 *   node scripts/check_nopt_prices.js 300784
 */

require('dotenv').config();
const mongoose = require('mongoose');
const UserModel = require('../src/models/UserModel');
const StockTransactionModel = require('../src/models/StockTransactionModel');
const WeekValanModel = require('../src/models/WeekValanModel');
const { getSingleStockData } = require('../src/services/RedisService');

// Parse command line arguments
const args = process.argv.slice(2);
const accountCode = args[0];

async function checkNoptPrices() {
  try {
    await mongoose.connect(process.env.MONGODB_URI);
    
    const activeValan = await WeekValanModel.findOne({ status: true }).lean();
    
    // Build match query
    let matchQuery = {
      marketId: '3',
      transactionStatus: 'COMPLETED',
      valanId: activeValan._id
    };
    
    // If account code provided, filter by user
    if (accountCode) {
      const user = await UserModel.findOne({ accountCode: accountCode }).select('_id accountName accountCode').lean();
      if (!user) {
        console.error(`❌ User with account code ${accountCode} not found`);
        process.exit(1);
      }
      matchQuery.userId = user._id;
      console.log(`Checking NOPT positions for: ${user.accountName} (${user.accountCode})`);
      console.log(`User ID: ${user._id}`);
    } else {
      console.log('Checking NOPT positions for ALL users');
    }
    
    console.log('='.repeat(80));
    console.log();
    
    // Get NOPT positions (only open positions)
    const noptPositions = await StockTransactionModel.aggregate([
      { $match: matchQuery },
      {
        $group: {
          _id: {
            userId: "$userId",
            scriptId: "$scriptId",
            marketId: "$marketId",
            valanId: "$valanId"
          },
          scriptName: { $first: "$scriptName" },
          label: { $first: "$label" },
          symbol: { $first: "$symbol" },
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
      },
      { $sort: { "_id.scriptId": 1 } }
    ]);
    
    if (noptPositions.length === 0) {
      console.log('✅ No open NOPT positions found!');
      await mongoose.connection.close();
      return;
    }
    
    console.log(`Found ${noptPositions.length} open NOPT positions`);
    console.log('='.repeat(80));
    console.log();
    
    let foundCount = 0;
    let notFoundCount = 0;
    const notFoundScripts = [];
    
    for (let i = 0; i < noptPositions.length; i++) {
      const pos = noptPositions[i];
      const scriptId = pos._id.scriptId;
      const label = pos.label;
      const symbol = pos.symbol;
      const netQty = pos.buyQuantity - pos.sellQuantity;
      const positionType = netQty > 0 ? 'LONG' : 'SHORT';
      
      console.log(`${i + 1}. ${positionType} Position: ${pos.scriptName}`);
      console.log(`   Net Qty: ${netQty} (Buy: ${pos.buyQuantity}, Sell: ${pos.sellQuantity})`);
      console.log(`   scriptId: ${scriptId}`);
      console.log(`   label: ${label || 'N/A'}`);
      console.log(`   symbol: ${symbol || 'N/A'}`);
      
      // Try all possible keys
      const keys = [symbol, scriptId, label, pos.scriptName].filter(Boolean);
      let found = false;
      let foundKey = null;
      let priceData = null;
      
      for (const key of keys) {
        try {
          const data = await getSingleStockData(key);
          if (data) {
            const parsed = typeof data === 'string' ? JSON.parse(data) : data;
            if (parsed && (parsed.BuyPrice || parsed.SellPrice || parsed.Ltp || parsed.ltp)) {
              foundKey = key;
              priceData = parsed;
              found = true;
              foundCount++;
              break;
            }
          }
        } catch (e) {
          // Skip
        }
      }
      
      if (found) {
        console.log(`   ✓ Found in Redis with key: "${foundKey}"`);
        console.log(`     BuyPrice: ${priceData.BuyPrice || 'N/A'}, SellPrice: ${priceData.SellPrice || 'N/A'}, Ltp: ${priceData.Ltp || priceData.ltp || 'N/A'}`);
      } else {
        console.log(`   ✗ NOT FOUND in Redis`);
        console.log(`     Tried keys: ${keys.join(', ')}`);
        notFoundCount++;
        notFoundScripts.push({
          scriptName: pos.scriptName,
          scriptId: scriptId,
          label: label,
          symbol: symbol,
          netQty: netQty
        });
      }
      console.log();
    }
    
    console.log('='.repeat(80));
    console.log('SUMMARY:');
    console.log(`  Total open positions: ${noptPositions.length}`);
    console.log(`  Found in Redis: ${foundCount} (${((foundCount/noptPositions.length)*100).toFixed(1)}%)`);
    console.log(`  NOT Found in Redis: ${notFoundCount} (${((notFoundCount/noptPositions.length)*100).toFixed(1)}%)`);
    console.log('='.repeat(80));
    
    if (notFoundCount > 0) {
      console.log();
      console.log('⚠️  ISSUE IDENTIFIED:');
      console.log(`   ${notFoundCount} NOPT positions cannot be squared off because prices are NOT in Redis!`);
      console.log();
      console.log('Scripts without prices:');
      notFoundScripts.slice(0, 20).forEach((script, idx) => {
        console.log(`  ${idx + 1}. ${script.scriptName} (${script.label || script.scriptId}) - Net: ${script.netQty}`);
      });
      if (notFoundScripts.length > 20) {
        console.log(`  ... and ${notFoundScripts.length - 20} more`);
      }
      console.log();
      console.log('💡 ROOT CAUSE:');
      console.log('   The square-off function tries these keys in order:');
      console.log('   1. pos.symbol');
      console.log('   2. pos._id.scriptId (or pos.scriptId)');
      console.log('   3. pos.scriptName');
      console.log('   4. pos.label');
      console.log();
      console.log('   If NONE of these keys exist in Redis, the position is SKIPPED.');
      console.log();
      console.log('💡 SOLUTIONS:');
      console.log('   1. Ensure WebSocket is subscribed to NOPT symbols');
      console.log('   2. Check if the symbol format in Redis matches what we are looking for');
      console.log('   3. Verify populateSymbols.js includes NOPT market (ID: 3)');
      console.log('   4. Check WebSocket connection logs for NOPT data');
    } else {
      console.log();
      console.log('✅ All NOPT positions have prices in Redis!');
      console.log('   The square-off should work correctly.');
      console.log();
      console.log('   If positions are still not being squared off, check:');
      console.log('   1. User has intraDayAutoSquare enabled');
      console.log('   2. Market close time is configured correctly');
      console.log('   3. Check logs for square-off execution errors');
    }
    
  } catch (error) {
    console.error('Error:', error);
    console.error(error.stack);
  } finally {
    await mongoose.connection.close();
  }
}

checkNoptPrices();
