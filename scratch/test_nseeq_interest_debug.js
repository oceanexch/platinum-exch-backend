/**
 * Debug script for NSE-EQ Interest - specifically for user 909999
 */

require('dotenv').config();
const mongoose = require('mongoose');
const UserModel = require('../src/models/UserModel');
const NseEqInterestModel = require('../src/models/NseEqInterestModel');
const StockTransactionModel = require('../src/models/StockTransactionModel');
const WeekValanModel = require('../src/models/WeekValanModel');
const StockModel = require('../src/models/StockModel');
const { redisClient } = require('../src/config/redis');
const moment = require('moment');

/**
 * Get current market price for a script from Redis or database
 */
async function getCurrentPrice(scriptId) {
  try {
    if (redisClient && redisClient.isOpen) {
      const priceData = await redisClient.get(`price:${scriptId}`);
      if (priceData) {
        const parsed = JSON.parse(priceData);
        return Number(parsed.ltp || parsed.lastPrice || 0);
      }
    }
    const script = await StockModel.findOne({ _id: scriptId }).lean();
    return Number(script?.lastPrice || 0);
  } catch (err) {
    console.error(`[getCurrentPrice] Error for script ${scriptId}:`, err.message);
    return 0;
  }
}

async function debugUser() {
  try {
    console.log('Connecting to database...');
    await mongoose.connect(process.env.MONGODB_URI);
    console.log('Connected\n');

    const today = moment().format('YYYY-MM-DD');
    
    console.log('='.repeat(70));
    console.log('DEBUG: User 909999 (interestT)');
    console.log('='.repeat(70));
    
    // Find the user
    const user = await UserModel.findOne({ accountCode: '909999' })
      .select('_id accountCode accountName accountDetails basicDetails marketAccess parentIds')
      .lean();

    if (!user) {
      console.log('❌ User not found!');
      await mongoose.connection.close();
      return;
    }

    console.log('\n✅ User Found');
    console.log(`   ID: ${user._id}`);
    console.log(`   Name: ${user.accountName}`);
    console.log(`   Code: ${user.accountCode}`);
    
    // Check parent IDs
    console.log(`\n📋 Parent IDs Check:`);
    console.log(`   Has Parents: ${user.parentIds && user.parentIds.length > 0 ? '✅ YES' : '❌ NO'}`);
    if (user.parentIds && user.parentIds.length > 0) {
      console.log(`   Count: ${user.parentIds.length}`);
      console.log(`   IDs: ${user.parentIds.map(p => p.toString()).join(', ')}`);
    } else {
      console.log('   ⚠️  NO PARENTS - Will be skipped!');
    }
    
    // Check NSE-EQ market
    console.log(`\n📊 NSE-EQ Market Check:`);
    const nseEqMarket = user.marketAccess?.find(m => m.marketId === '12');
    if (nseEqMarket) {
      console.log(`   Enabled: ✅ YES`);
      console.log(`   Total Margin: ₹${nseEqMarket.margin?.totalMargin || 0}`);
      console.log(`   Margin %: ${nseEqMarket.margin?.marginPer || 0}%`);
      console.log(`   Maximum Limit: ₹${nseEqMarket.margin?.maximumLimit || 0}`);
      const availableMargin = (nseEqMarket.margin?.totalMargin || 0) * ((nseEqMarket.margin?.marginPer || 0) / 100);
      console.log(`   Available Margin: ₹${availableMargin.toFixed(2)}`);
      
      if ((nseEqMarket.margin?.totalMargin || 0) <= 0) {
        console.log('   ⚠️  Total Margin is 0 - Will be skipped!');
      }
    } else {
      console.log(`   Enabled: ❌ NO - Will be skipped!`);
    }
    
    // Check interest settings
    console.log(`\n💰 Interest Settings:`);
    console.log(`   Annual Rate: ${user.basicDetails?.nseEqAnnualInterest || 0}%`);
    console.log(`   Linked with Ledger: ${user.accountDetails?.nseeqinterestLinkedwithLedger === 1 ? '✅ YES (New Logic)' : '❌ NO (Old Logic)'}`);
    
    if ((user.basicDetails?.nseEqAnnualInterest || 0) <= 0) {
      console.log('   ⚠️  Interest rate is 0 - Will be skipped!');
    }
    
    // Check valan
    console.log(`\n📅 Valan Check:`);
    const currentValan = await WeekValanModel.findOne({ status: true }).lean();
    if (currentValan) {
      console.log(`   Active Valan: ✅ ${currentValan.label}`);
      console.log(`   ID: ${currentValan._id}`);
      console.log(`   Period: ${moment(currentValan.startDate).format('YYYY-MM-DD')} to ${moment(currentValan.endDate).format('YYYY-MM-DD')}`);
      
      // Check today's transactions
      console.log(`\n📈 Today's Transactions Check:`);
      const startOfDay = moment(today).startOf('day').toDate();
      const endOfDay = moment(today).endOf('day').toDate();
      
      const transactions = await StockTransactionModel.find({
        userId: user._id,
        valanId: currentValan._id,
        marketId: '12',
        transactionStatus: 'COMPLETED',
        createdAt: { $gte: startOfDay, $lte: endOfDay }
      }).lean();
      
      console.log(`   Count: ${transactions.length}`);
      
      if (transactions.length > 0) {
        // Group by script
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
        
        console.log(`\n   Script-wise Breakdown:`);
        
        for (const [scriptIdKey, data] of scriptMap) {
          const netQty = data.buyQty - data.sellQty;
          const closedQty = Math.min(data.buyQty, data.sellQty);
          
          console.log(`\n   - ${data.scriptName}:`);
          console.log(`     Buy: ${data.buyQty} qty @ ₹${(data.buyTotal / data.buyQty).toFixed(2)} avg = ₹${data.buyTotal.toFixed(2)} total`);
          console.log(`     Sell: ${data.sellQty} qty @ ₹${data.sellQty > 0 ? (data.sellTotal / data.sellQty).toFixed(2) : '0.00'} avg = ₹${data.sellTotal.toFixed(2)} total`);
          console.log(`     Net Qty: ${netQty}`);
          console.log(`     Closed Qty: ${closedQty}`);
          
          // Booked P&L
          if (closedQty > 0) {
            const avgBuyPrice = data.buyTotal / data.buyQty;
            const avgSellPrice = data.sellTotal / data.sellQty;
            const realizedPnL = closedQty * (avgSellPrice - avgBuyPrice);
            const bookedPnl = -realizedPnL; // Invert: positive = loss, negative = profit
            totalBookedPnl += bookedPnl;
            console.log(`     Booked P&L: ₹${bookedPnl.toFixed(2)} ${bookedPnl > 0 ? '(Loss)' : '(Profit)'}`);
          }
          
          // Holding worth with unrealized P&L
          if (netQty !== 0) {
            const remainingQty = Math.abs(netQty);
            const currentPrice = await getCurrentPrice(data.scriptId);
            
            if (netQty > 0) {
              // Long position
              const avgBuyPrice = data.buyTotal / data.buyQty;
              const unrealizedPnL = (currentPrice - avgBuyPrice) * remainingQty;
              const holdingValue = (remainingQty * avgBuyPrice) - unrealizedPnL;
              totalHoldingWorth += holdingValue;
              
              console.log(`     Current Sell Price: ₹${currentPrice.toFixed(2)}`);
              console.log(`     Unrealized P&L: ₹${unrealizedPnL.toFixed(2)} ${unrealizedPnL > 0 ? '(Profit)' : '(Loss)'}`);
              console.log(`     Holding Worth: ₹${holdingValue.toFixed(2)}`);
            } else {
              // Short position
              const avgSellPrice = data.sellTotal / data.sellQty;
              const unrealizedPnL = (avgSellPrice - currentPrice) * remainingQty;
              const holdingValue = (remainingQty * avgSellPrice) - unrealizedPnL;
              totalHoldingWorth += holdingValue;
              
              console.log(`     Current Buy Price: ₹${currentPrice.toFixed(2)}`);
              console.log(`     Unrealized P&L: ₹${unrealizedPnL.toFixed(2)} ${unrealizedPnL > 0 ? '(Profit)' : '(Loss)'}`);
              console.log(`     Holding Worth: ₹${holdingValue.toFixed(2)}`);
            }
          }
        }
        
        console.log(`\n   📊 Summary:`);
        console.log(`   Total Holding Worth: ₹${totalHoldingWorth.toFixed(2)}`);
        console.log(`   Total Booked P&L: ₹${totalBookedPnl.toFixed(2)} ${totalBookedPnl > 0 ? '(Loss)' : '(Profit)'}`);
        
        // Calculate expected interest
        if (user.accountDetails?.nseeqinterestLinkedwithLedger === 1 && nseEqMarket) {
          const availableMargin = (nseEqMarket.margin?.totalMargin || 0) * ((nseEqMarket.margin?.marginPer || 0) / 100);
          const interestableAmount = Math.max(0, totalHoldingWorth - availableMargin + totalBookedPnl);
          const dailyInterest = interestableAmount * ((user.basicDetails?.nseEqAnnualInterest || 0) / 365 / 100);
          
          console.log(`\n💡 Expected Calculation (New Logic):`);
          console.log(`   Holding Worth: ₹${totalHoldingWorth.toFixed(2)}`);
          console.log(`   Available Margin: ₹${availableMargin.toFixed(2)}`);
          console.log(`   Booked P&L: ₹${totalBookedPnl.toFixed(2)}`);
          console.log(`   Interestable Amount: ₹${interestableAmount.toFixed(2)}`);
          console.log(`   Daily Interest: ₹${dailyInterest.toFixed(2)}`);
          
          if (interestableAmount <= 0.01) {
            console.log(`   ⚠️  Interestable amount is too low - Will be skipped!`);
          }
        }
      } else {
        console.log(`   ⚠️  No transactions found today - Holding worth will be 0`);
      }
    } else {
      console.log(`   Active Valan: ❌ NONE - Will be skipped!`);
    }
    
    // Check existing record
    console.log(`\n📝 Existing Record Check:`);
    const existingRecord = await NseEqInterestModel.findOne({
      userId: user._id,
      date: today
    }).lean();
    
    if (existingRecord) {
      console.log(`   Status: ⚠️  ALREADY EXISTS`);
      console.log(`   Interest: ₹${existingRecord.interestAmount.toFixed(2)}`);
      console.log(`   Logic: ${existingRecord.isLinkedWithLedger ? 'New' : 'Old'}`);
      if (existingRecord.isLinkedWithLedger) {
        console.log(`   Holding Worth: ₹${existingRecord.holdingWorth.toFixed(2)}`);
        console.log(`   Booked P&L: ₹${existingRecord.bookedPnl.toFixed(2)}`);
        console.log(`   Loan Used: ₹${existingRecord.interestableAmount.toFixed(2)}`);
      }
      console.log(`\n   To recalculate, delete this record:`);
      console.log(`   db.nseeqinterests.deleteOne({ _id: ObjectId("${existingRecord._id}") })`);
    } else {
      console.log(`   Status: ✅ NO RECORD - Ready to calculate`);
    }
    
    console.log('\n' + '='.repeat(70));
    console.log('Run the full cron to process this user');
    console.log('='.repeat(70));

  } catch (error) {
    console.error('Error:', error);
  } finally {
    await mongoose.connection.close();
    console.log('\nConnection closed');
  }
}

debugUser();
