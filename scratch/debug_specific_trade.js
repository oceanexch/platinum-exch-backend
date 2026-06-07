const mongoose = require('mongoose');
const quantitySetting = require('../src/models/QuantitySettingModel');
const StockTransaction = require('../src/models/StockTransactionModel');
const UserModel = require('../src/models/UserModel');
require('dotenv').config();

// Connect to database
mongoose.connect(process.env.MONGODB_URI || process.env.DB_URL);

async function debugSpecificTrade() {
    console.log('=== SPECIFIC TRADE DEBUG ===\n');
    
    try {
        // 1. Find recent failed trades with "lot limit reached" message
        console.log('1. Finding recent failed trades with lot limit issues...');
        
        const recentFailedTrades = await StockTransaction.find({
            $or: [
                { message: /lot limit/i },
                { shortmsg: /lot limit/i },
                { transactionStatus: 'REJECTED' }
            ],
            createdAt: { $gte: new Date(Date.now() - 24 * 60 * 60 * 1000) } // Last 24 hours
        })
        .sort({ createdAt: -1 })
        .limit(10)
        .lean();
        
        console.log(`Found ${recentFailedTrades.length} recent failed trades`);
        
        if (recentFailedTrades.length > 0) {
            console.log('\nRecent failed trades:');
            recentFailedTrades.forEach((trade, index) => {
                console.log(`${index + 1}. User: ${trade.userId}, Script: ${trade.scriptId}, Lot: ${trade.lot}, Message: ${trade.message || trade.shortmsg}`);
            });
        }
        
        // 2. Find pending limit trades that might be affected
        console.log('\n2. Finding pending limit trades...');
        
        const pendingLimitTrades = await StockTransaction.find({
            transactionStatus: 'PENDING',
            orderType: { $in: ['Limit', 'SL', 'Stop Loss'] }
        })
        .sort({ createdAt: -1 })
        .limit(20)
        .lean();
        
        console.log(`Found ${pendingLimitTrades.length} pending limit trades`);
        
        if (pendingLimitTrades.length > 0) {
            console.log('\nPending limit trades:');
            for (const trade of pendingLimitTrades.slice(0, 5)) {
                console.log(`\nTrade ID: ${trade._id}`);
                console.log(`User: ${trade.userId}, Script: ${trade.scriptId}, Market: ${trade.marketId}`);
                console.log(`Lot: ${trade.lot}, Quantity: ${trade.quantity}, Price: ${trade.orderPrice}`);
                console.log(`Type: ${trade.transactionType}, Order: ${trade.orderType}`);
                
                // Check lot limits for this specific trade
                await checkTradeValidation(trade.userId, trade.scriptId, trade.marketId, trade.lot, trade.orderPrice);
            }
        }
        
        // 3. Check for users with very restrictive lot limits
        console.log('\n3. Finding users with restrictive lot limits (max < 1)...');
        
        const restrictiveLimits = await quantitySetting.find({
            qtySetting: 'Lot',
            maxOrder: { $lt: 1 }
        }).lean();
        
        if (restrictiveLimits.length > 0) {
            console.log(`Found ${restrictiveLimits.length} users with maxOrder < 1:`);
            restrictiveLimits.forEach(limit => {
                console.log(`User: ${limit.clientId}, Script: ${limit.scriptId}, Market: ${limit.marketId}, Max: ${limit.maxOrder}`);
            });
        }
        
        // 4. Check for users with minOrder > 1 (might cause issues with fractional lots)
        console.log('\n4. Finding users with high minimum lot requirements...');
        
        const highMinLimits = await quantitySetting.find({
            qtySetting: 'Lot',
            minOrder: { $gt: 1 }
        }).lean();
        
        if (highMinLimits.length > 0) {
            console.log(`Found ${highMinLimits.length} users with minOrder > 1:`);
            highMinLimits.slice(0, 10).forEach(limit => {
                console.log(`User: ${limit.clientId}, Script: ${limit.scriptId}, Market: ${limit.marketId}, Min: ${limit.minOrder}, Max: ${limit.maxOrder}`);
            });
        }
        
    } catch (error) {
        console.error('Error during analysis:', error);
    }
    
    mongoose.disconnect();
}

async function checkTradeValidation(userId, scriptId, marketId, lot, price) {
    console.log(`\n  Checking validation for lot: ${lot}`);
    
    // Replicate the exact logic from StockController
    let checkLimits = await quantitySetting
        .find({ clientId: userId, scriptId, marketId })
        .select({
            qtySetting: 1,
            minOrder: 1,
            maxOrder: 1,
            positionLimit: 1,
            isRange: 1,
            startRange: 1,
            endRange: 1
        })
        .lean();
    
    if (checkLimits.length === 0) {
        checkLimits = await quantitySetting
            .find({ clientId: userId, scriptId: '999', marketId })
            .select({
                qtySetting: 1,
                minOrder: 1,
                maxOrder: 1,
                positionLimit: 1,
                isRange: 1,
                startRange: 1,
                endRange: 1
            })
            .lean();
    }
    
    if (checkLimits.length === 0) {
        console.log(`  ❌ No limits found for user ${userId}`);
        return;
    }
    
    const lotLimits = checkLimits.find((lmt) => lmt.qtySetting === 'Lot');
    
    if (lotLimits) {
        console.log(`  Lot limits: Min ${lotLimits.minOrder}, Max ${lotLimits.maxOrder}`);
        
        const isValidLot = lot >= lotLimits.minOrder && lot <= lotLimits.maxOrder;
        console.log(`  Lot validation: ${isValidLot ? '✅ PASS' : '❌ FAIL'}`);
        
        if (!isValidLot) {
            console.log(`  ❌ Lot ${lot} is outside allowed range [${lotLimits.minOrder}, ${lotLimits.maxOrder}]`);
        }
        
        // Check range validation if applicable
        if (lotLimits.isRange && price) {
            const isValidRange = price >= lotLimits.startRange && price <= lotLimits.endRange;
            console.log(`  Range validation: ${isValidRange ? '✅ PASS' : '❌ FAIL'} (Price: ${price}, Range: ${lotLimits.startRange}-${lotLimits.endRange})`);
        }
    } else {
        console.log(`  ❌ No lot limits found in settings`);
    }
}

debugSpecificTrade();