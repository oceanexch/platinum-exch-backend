/**
 * Position Diagnostics Script
 * 
 * Analyzes pending orders and open positions to help debug square-off issues
 * 
 * Usage:
 *   node scripts/diagnose_positions.js [accountCode]
 * 
 * Example:
 *   node scripts/diagnose_positions.js ACC001
 */

require('dotenv').config();
const mongoose = require('mongoose');
const UserModel = require('../src/models/UserModel');
const StockTransactionModel = require('../src/models/StockTransactionModel');
const WeekValanModel = require('../src/models/WeekValanModel');
const moment = require('moment');

// Parse command line arguments
const args = process.argv.slice(2);
const accountCode = args[0];

async function diagnoseMain() {
  try {
    console.log('='.repeat(80));
    console.log('POSITION DIAGNOSTICS');
    console.log('='.repeat(80));
    console.log();

    // Connect to database
    console.log('📡 Connecting to database...');
    await mongoose.connect(process.env.MONGODB_URI);
    console.log('✅ Connected successfully\n');

    // Get active valan
    const activeValan = await WeekValanModel.findOne({ status: true }).lean();
    if (!activeValan) {
      console.error('❌ No active valan found');
      process.exit(1);
    }
    console.log(`📅 Active Valan: ${activeValan.label} (ID: ${activeValan._id})`);
    console.log();

    // Build query
    let userQuery = {};
    let userId = null;
    
    if (accountCode) {
      const user = await UserModel.findOne({ accountCode: accountCode }).select('_id accountName accountCode').lean();
      if (!user) {
        console.error(`❌ User with account code ${accountCode} not found`);
        process.exit(1);
      }
      userId = user._id;
      userQuery = { userId: user._id };
      console.log(`👤 User: ${user.accountName} (${user.accountCode})`);
      console.log(`   User ID: ${user._id}`);
      console.log();
    } else {
      console.log('📊 Analyzing ALL users');
      console.log();
    }

    // ═══════════════════════════════════════════════════════════════════════════
    // 1. PENDING ORDERS ANALYSIS
    // ═══════════════════════════════════════════════════════════════════════════
    console.log('─'.repeat(80));
    console.log('1. PENDING ORDERS ANALYSIS');
    console.log('─'.repeat(80));
    console.log();

    const pendingQuery = {
      ...userQuery,
      transactionStatus: "PENDING"
    };

    const pendingOrders = await StockTransactionModel.find(pendingQuery)
      .select('userId marketId marketName scriptId scriptName label orderType transactionType orderPrice quantity lot createdAt')
      .lean();

    console.log(`Total Pending Orders: ${pendingOrders.length}`);
    console.log();

    if (pendingOrders.length > 0) {
      // Group by orderType
      const byOrderType = {};
      pendingOrders.forEach(order => {
        const type = order.orderType || 'UNKNOWN';
        if (!byOrderType[type]) byOrderType[type] = [];
        byOrderType[type].push(order);
      });

      console.log('Breakdown by Order Type:');
      Object.keys(byOrderType).forEach(type => {
        console.log(`  ${type}: ${byOrderType[type].length} orders`);
      });
      console.log();

      // Show sample pending orders
      console.log('Sample Pending Orders (first 10):');
      pendingOrders.slice(0, 10).forEach((order, idx) => {
        console.log(`  ${idx + 1}. ${order.transactionType} ${order.scriptName} | Type: ${order.orderType} | Qty: ${order.quantity} | Price: ${order.orderPrice} | Market: ${order.marketName}`);
      });
      console.log();

      // Check for case mismatches
      const limitVariants = pendingOrders.filter(o => 
        o.orderType && (o.orderType.toUpperCase() === 'LIMIT' || o.orderType.toUpperCase() === 'SL' || o.orderType.toUpperCase().includes('STOP'))
      );
      console.log(`⚠️  Orders that should be cancelled (Limit/SL/Stop Loss): ${limitVariants.length}`);
      
      const caseIssues = limitVariants.filter(o => o.orderType !== 'Limit');
      if (caseIssues.length > 0) {
        console.log(`⚠️  Orders with case mismatch (not "Limit"): ${caseIssues.length}`);
        console.log('   These might not be caught by the cancellation logic!');
        console.log('   Order types found:', [...new Set(caseIssues.map(o => o.orderType))].join(', '));
      }
      console.log();
    }

    // ═══════════════════════════════════════════════════════════════════════════
    // 2. OPEN POSITIONS ANALYSIS
    // ═══════════════════════════════════════════════════════════════════════════
    console.log('─'.repeat(80));
    console.log('2. OPEN POSITIONS ANALYSIS');
    console.log('─'.repeat(80));
    console.log();

    const completedQuery = {
      ...userQuery,
      transactionStatus: "COMPLETED",
      valanId: activeValan._id
    };

    const completedCount = await StockTransactionModel.countDocuments(completedQuery);
    console.log(`Total Completed Transactions: ${completedCount}`);
    console.log();

    // Aggregate to find open positions
    const pipeline = [
      {
        $match: completedQuery
      },
      {
        $group: {
          _id: {
            userId: "$userId",
            scriptId: "$scriptId",
            marketId: "$marketId",
            valanId: "$valanId"
          },
          marketName: { $first: "$marketName" },
          scriptName: { $first: "$scriptName" },
          label: { $first: "$label" },
          buyQuantity: {
            $sum: {
              $cond: [{ $eq: ["$transactionType", "BUY"] }, "$quantity", 0]
            }
          },
          sellQuantity: {
            $sum: {
              $cond: [{ $eq: ["$transactionType", "SELL"] }, "$quantity", 0]
            }
          },
          buyLot: {
            $sum: { $cond: [{ $eq: ["$transactionType", "BUY"] }, "$lot", 0] }
          },
          sellLot: {
            $sum: { $cond: [{ $eq: ["$transactionType", "SELL"] }, "$lot", 0] }
          },
          transactionCount: { $sum: 1 }
        }
      },
      {
        $match: {
          $expr: { $ne: ["$buyQuantity", "$sellQuantity"] }
        }
      },
      {
        $sort: { "_id.userId": 1, "_id.marketId": 1, "_id.scriptId": 1 }
      }
    ];

    const openPositions = await StockTransactionModel.aggregate(pipeline);

    console.log(`Total Open Positions: ${openPositions.length}`);
    console.log();

    if (openPositions.length > 0) {
      // Group by market
      const byMarket = {};
      openPositions.forEach(pos => {
        const market = pos.marketName || pos._id.marketId;
        if (!byMarket[market]) byMarket[market] = [];
        byMarket[market].push(pos);
      });

      console.log('Breakdown by Market:');
      Object.keys(byMarket).forEach(market => {
        console.log(`  ${market}: ${byMarket[market].length} open positions`);
      });
      console.log();

      // Show all open positions with details
      console.log('Open Positions Details:');
      console.log();
      
      openPositions.forEach((pos, idx) => {
        const netQty = pos.buyQuantity - pos.sellQuantity;
        const positionType = netQty > 0 ? 'LONG' : 'SHORT';
        const netLot = Math.abs(pos.buyLot - pos.sellLot);
        
        console.log(`${idx + 1}. ${positionType} Position:`);
        console.log(`   Script: ${pos.scriptName} (${pos.label || 'N/A'})`);
        console.log(`   Market: ${pos.marketName} (ID: ${pos._id.marketId})`);
        console.log(`   User ID: ${pos._id.userId}`);
        console.log(`   Valan ID: ${pos._id.valanId}`);
        console.log(`   Net Quantity: ${netQty} (Buy: ${pos.buyQuantity}, Sell: ${pos.sellQuantity})`);
        console.log(`   Net Lot: ${netLot} (Buy: ${pos.buyLot}, Sell: ${pos.sellLot})`);
        console.log(`   Transactions: ${pos.transactionCount}`);
        console.log();
      });

      // Check for valan mismatches
      const valanMismatches = openPositions.filter(pos => 
        pos._id.valanId && pos._id.valanId.toString() !== activeValan._id.toString()
      );
      
      if (valanMismatches.length > 0) {
        console.log(`⚠️  WARNING: ${valanMismatches.length} positions have different valan IDs!`);
        console.log('   These positions might not be squared off correctly.');
        console.log();
      }
    }

    // ═══════════════════════════════════════════════════════════════════════════
    // 3. TRANSACTION TYPE ANALYSIS
    // ═══════════════════════════════════════════════════════════════════════════
    console.log('─'.repeat(80));
    console.log('3. TRANSACTION TYPE ANALYSIS');
    console.log('─'.repeat(80));
    console.log();

    const typeAggregation = await StockTransactionModel.aggregate([
      { $match: { ...userQuery, valanId: activeValan._id } },
      {
        $group: {
          _id: {
            transactionStatus: "$transactionStatus",
            transactionType: "$transactionType",
            type: "$type"
          },
          count: { $sum: 1 },
          totalQuantity: { $sum: "$quantity" }
        }
      },
      { $sort: { "_id.transactionStatus": 1, "_id.transactionType": 1 } }
    ]);

    console.log('Transaction Breakdown:');
    typeAggregation.forEach(item => {
      console.log(`  ${item._id.transactionStatus} | ${item._id.transactionType} | Type: ${item._id.type || 'NRM'} | Count: ${item.count} | Total Qty: ${item.totalQuantity}`);
    });
    console.log();

    // ═══════════════════════════════════════════════════════════════════════════
    // 4. RECOMMENDATIONS
    // ═══════════════════════════════════════════════════════════════════════════
    console.log('─'.repeat(80));
    console.log('4. RECOMMENDATIONS');
    console.log('─'.repeat(80));
    console.log();

    const issues = [];
    const recommendations = [];

    if (pendingOrders.length > 0) {
      const caseIssues = pendingOrders.filter(o => 
        o.orderType && o.orderType !== 'Limit' && 
        (o.orderType.toUpperCase() === 'LIMIT' || o.orderType.toUpperCase() === 'SL')
      );
      
      if (caseIssues.length > 0) {
        issues.push(`${caseIssues.length} pending orders have case mismatches (e.g., "LIMIT" instead of "Limit")`);
        recommendations.push('The cancelPendingLimitOrders function has been updated to handle case variations');
      }
    }

    if (openPositions.length > 0) {
      issues.push(`${openPositions.length} positions are still open and need to be squared off`);
      recommendations.push('Run the intraday square-off manually or check if users have intraDayAutoSquare enabled');
      recommendations.push('Verify that Redis has current prices for all open position scripts');
      recommendations.push('Check the logs for "NO VALID PRICE AVAILABLE" warnings');
    }

    if (issues.length === 0) {
      console.log('✅ No issues detected! All positions are squared off and no pending orders remain.');
    } else {
      console.log('⚠️  Issues Detected:');
      issues.forEach((issue, idx) => {
        console.log(`   ${idx + 1}. ${issue}`);
      });
      console.log();
      
      console.log('💡 Recommendations:');
      recommendations.forEach((rec, idx) => {
        console.log(`   ${idx + 1}. ${rec}`);
      });
    }
    console.log();

    // ═══════════════════════════════════════════════════════════════════════════
    // 5. MANUAL FIX COMMANDS
    // ═══════════════════════════════════════════════════════════════════════════
    if (pendingOrders.length > 0 || openPositions.length > 0) {
      console.log('─'.repeat(80));
      console.log('5. MANUAL FIX COMMANDS');
      console.log('─'.repeat(80));
      console.log();

      if (pendingOrders.length > 0) {
        console.log('To manually cancel all pending orders:');
        console.log();
        if (userId) {
          console.log(`db.stock_transactions.updateMany(`);
          console.log(`  { userId: ObjectId("${userId}"), transactionStatus: "PENDING" },`);
          console.log(`  { $set: { transactionStatus: "DELETED", message: "Manual Cancellation" } }`);
          console.log(`);`);
        } else {
          console.log(`db.stock_transactions.updateMany(`);
          console.log(`  { transactionStatus: "PENDING" },`);
          console.log(`  { $set: { transactionStatus: "DELETED", message: "Manual Cancellation" } }`);
          console.log(`);`);
        }
        console.log();
      }

      if (openPositions.length > 0) {
        console.log('To manually trigger square-off via API:');
        console.log();
        console.log('Run the dynamic market operations cron:');
        console.log('  node runDynamicMarketOps.js');
        console.log();
        console.log('Or call the square-off functions directly in Node REPL:');
        console.log('  const MarketOps = require("./src/services/MarketOperationsService");');
        console.log('  await MarketOps.intradaySquareOff(null); // null = all markets');
        console.log();
      }
    }

    console.log('='.repeat(80));
    console.log('DIAGNOSTICS COMPLETE');
    console.log('='.repeat(80));
    console.log();

  } catch (error) {
    console.error('\n❌ Error during diagnostics:', error.message);
    console.error(error.stack);
    process.exit(1);
  } finally {
    await mongoose.connection.close();
    console.log('📡 Database connection closed');
  }
}

// Run diagnostics
diagnoseMain();
