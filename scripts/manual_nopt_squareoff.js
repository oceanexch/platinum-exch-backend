/**
 * Manual NOPT Square-Off Script
 * 
 * Squares off NOPT positions even when Redis prices are not available
 * Uses fallback prices for testing purposes
 * 
 * Usage:
 *   node scripts/manual_nopt_squareoff.js [accountCode]
 * 
 * Example:
 *   node scripts/manual_nopt_squareoff.js 300784
 */

require('dotenv').config();
const mongoose = require('mongoose');
const UserModel = require('../src/models/UserModel');
const StockTransactionModel = require('../src/models/StockTransactionModel');
const WeekValanModel = require('../src/models/WeekValanModel');
const { saveTransaction, setUserPosition, updateUserQuantity, getUserQuantity } = require('../src/services/StockService');

// Parse command line arguments
const args = process.argv.slice(2);
const accountCode = args[0];

// Fallback price for testing (when Redis doesn't have the price)
const FALLBACK_PRICE = 100;

async function manualSquareOff() {
  try {
    console.log('='.repeat(80));
    console.log('MANUAL NOPT SQUARE-OFF');
    console.log('='.repeat(80));
    console.log();

    await mongoose.connect(process.env.MONGODB_URI);
    
    const activeValan = await WeekValanModel.findOne({ status: true }).lean();
    
    // Build match query
    let matchQuery = {
      marketId: '3',
      transactionStatus: 'COMPLETED',
      valanId: activeValan._id
    };
    
    let userId = null;
    
    // If account code provided, filter by user
    if (accountCode) {
      const user = await UserModel.findOne({ accountCode: accountCode })
        .select('_id accountName accountCode parentIds brokerIds partnership createdBy')
        .populate('parentIds', '_id')
        .lean();
        
      if (!user) {
        console.error(`❌ User with account code ${accountCode} not found`);
        process.exit(1);
      }
      
      matchQuery.userId = user._id;
      userId = user._id;
      
      console.log(`User: ${user.accountName} (${user.accountCode})`);
      console.log(`User ID: ${user._id}`);
    } else {
      console.log('Squaring off NOPT positions for ALL users');
    }
    
    console.log('='.repeat(80));
    console.log();
    
    // Get open NOPT positions
    const openPositions = await StockTransactionModel.aggregate([
      { $match: matchQuery },
      {
        $group: {
          _id: {
            userId: '$userId',
            scriptId: '$scriptId',
            marketId: '$marketId',
            valanId: '$valanId'
          },
          marketName: { $first: '$marketName' },
          scriptName: { $first: '$scriptName' },
          label: { $first: '$label' },
          symbol: { $first: '$symbol' },
          expiry: { $first: '$expiry' },
          lot: { $first: '$lot' },
          buyQuantity: {
            $sum: {
              $cond: [{ $eq: ['$transactionType', 'BUY'] }, '$quantity', 0]
            }
          },
          sellQuantity: {
            $sum: {
              $cond: [{ $eq: ['$transactionType', 'SELL'] }, '$quantity', 0]
            }
          },
          buyLot: {
            $sum: { $cond: [{ $eq: ['$transactionType', 'BUY'] }, '$lot', 0] }
          },
          sellLot: {
            $sum: { $cond: [{ $eq: ['$transactionType', 'SELL'] }, '$lot', 0] }
          }
        }
      },
      {
        $match: {
          $expr: { $ne: ['$buyQuantity', '$sellQuantity'] }
        }
      }
    ]);
    
    if (openPositions.length === 0) {
      console.log('✅ No open NOPT positions found!');
      await mongoose.connection.close();
      return;
    }
    
    console.log(`Found ${openPositions.length} open NOPT positions to square off`);
    console.log('='.repeat(80));
    console.log();
    
    let successCount = 0;
    let failCount = 0;
    
    for (let i = 0; i < openPositions.length; i++) {
      const pos = openPositions[i];
      
      try {
        const netQty = pos.buyQuantity - pos.sellQuantity;
        const qtyToClose = Math.abs(netQty);
        const transactionType = netQty > 0 ? 'SELL' : 'BUY';
        const positionType = netQty > 0 ? 'LONG' : 'SHORT';
        
        console.log(`${i + 1}/${openPositions.length} Squaring off ${positionType}: ${pos.scriptName} (${pos.label})`);
        console.log(`   Net Qty: ${netQty}, Closing with: ${transactionType} ${qtyToClose}`);
        
        // Fetch user details
        const user = await UserModel.findById(pos._id.userId)
          .select('parentIds brokerIds partnership loginIP createdBy')
          .populate('parentIds', '_id')
          .lean();
        
        if (!user) {
          console.log(`   ✗ User not found, skipping`);
          failCount++;
          continue;
        }
        
        // Use fallback price
        const currentPrice = FALLBACK_PRICE;
        
        // Calculate brokerage
        const BrokerageService = require('../src/services/BrokerageService');
        
        const brokerageResult = await BrokerageService.calculateBrokerage({
          userId: pos._id.userId,
          valanId: pos._id.valanId,
          marketId: pos._id.marketId,
          marketName: pos.marketName,
          scriptId: pos._id.scriptId,
          scriptName: pos.scriptName,
          symbol: pos.symbol,
          label: pos.label,
          lot: pos.lot || 1,
          quantity: qtyToClose,
          price: currentPrice,
          transactionType: transactionType,
          message: 'Manual Square Off (Testing)',
          type: 'NRM'
        }, {
          getMarket: null,
          basicDetails: user
        });
        
        // Create square-off transaction
        const stock = {
          userId: pos._id.userId,
          valanId: pos._id.valanId,
          marketId: pos._id.marketId,
          marketName: pos.marketName,
          scriptId: pos._id.scriptId,
          scriptName: pos.scriptName,
          symbol: pos.symbol,
          label: pos.label,
          expiry: pos.expiry || 'NA',
          lot: pos.lot || 1,
          quantity: qtyToClose,
          quantityType: brokerageResult.quantityType,
          orderPrice: currentPrice,
          totalOrderPrice: currentPrice * qtyToClose,
          netPrice: brokerageResult.netPrice,
          totalNetPrice: brokerageResult.totalNetPrice,
          m2mPrice: brokerageResult.m2mPrice,
          orderBrokerage: brokerageResult.orderBrokerage,
          netBrokerage: brokerageResult.netBrokerage,
          brokeragePercentage: brokerageResult.brokeragePercentage,
          brokeragePercentageType: brokerageResult.brokeragePercentageType,
          brokerTotalBrokerage: brokerageResult.brokerTotalBrokerage,
          brokerTotalPercentage: brokerageResult.brokerTotalPercentage,
          brockersBrokerage: brokerageResult.brockersBrokerage,
          otherBrokerage: brokerageResult.otherBrokerage,
          type: 'AUTO_SQ',
          transactionType: transactionType,
          transactionStatus: 'COMPLETED',
          orderType: 'Market',
          tradePosition: 'NRM',
          message: 'Manual Square Off (Testing)',
          shortmsg: 'Manual sq (Market)',
          ip: user.loginIP || '0.0.0.0',
          createdBy: pos._id.userId,
          parentIds: user.parentIds?.map(p => p._id) || [],
          brokerIds: user.brokerIds || [],
          partnership: user.partnership || [],
          myParent: user.createdBy?.userId
        };
        
        await saveTransaction(stock);
        
        // Update user position
        await setUserPosition(pos._id.userId, pos._id.scriptId, pos._id.valanId);
        
        // Update user quantity
        const checkQuantity = await getUserQuantity({
          userId: pos._id.userId,
          marketId: pos._id.marketId,
          marketName: pos.marketName,
          scriptId: pos._id.scriptId,
          scriptName: pos.scriptName,
          quantity: qtyToClose,
          transactionType: transactionType
        });
        
        await updateUserQuantity(
          { userId: pos._id.userId, scriptId: pos._id.scriptId, marketId: pos._id.marketId },
          { previous: checkQuantity.previous, current: checkQuantity.current }
        );
        
        console.log(`   ✓ Successfully squared off at price ${currentPrice}`);
        successCount++;
        
      } catch (err) {
        console.error(`   ✗ Error: ${err.message}`);
        failCount++;
      }
      
      console.log();
    }
    
    console.log('='.repeat(80));
    console.log('SUMMARY:');
    console.log(`  Total positions: ${openPositions.length}`);
    console.log(`  Successfully squared off: ${successCount}`);
    console.log(`  Failed: ${failCount}`);
    console.log('='.repeat(80));
    
  } catch (error) {
    console.error('Error:', error);
    console.error(error.stack);
  } finally {
    await mongoose.connection.close();
  }
}

manualSquareOff();
