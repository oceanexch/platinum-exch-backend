const mongoose = require('mongoose');
const StockTransaction = require('../src/models/StockTransactionModel');
const { getSingleStockData } = require('../src/services/RedisService');
require('dotenv').config();

// Connect to database
mongoose.connect(process.env.MONGODB_URI || process.env.DB_URL);

async function testLimitExecution() {
    console.log('=== LIMIT EXECUTION TEST ===\n');
    
    try {
        // 1. Find the current pending limit trade
        const pendingTrade = await StockTransaction.findOne({
            transactionStatus: 'PENDING',
            orderType: { $in: ['Limit', 'SL', 'Stop Loss'] }
        }).lean();
        
        if (!pendingTrade) {
            console.log('No pending limit trades found');
            return;
        }
        
        console.log('Found pending trade:');
        console.log(`ID: ${pendingTrade._id}`);
        console.log(`User: ${pendingTrade.userId}`);
        console.log(`Script: ${pendingTrade.scriptId} (${pendingTrade.label})`);
        console.log(`Type: ${pendingTrade.transactionType} ${pendingTrade.tradePosition}`);
        console.log(`Order Price: ${pendingTrade.orderPrice}`);
        console.log(`Lot: ${pendingTrade.lot}, Quantity: ${pendingTrade.quantity}`);
        
        // 2. Check market data availability
        console.log('\n2. Checking market data...');
        
        const symbolKey = pendingTrade.scriptId.toUpperCase();
        let rawData = await getSingleStockData(symbolKey);
        
        if (!rawData && pendingTrade.label) {
            console.log(`No data for scriptId ${symbolKey}, trying label ${pendingTrade.label}`);
            rawData = await getSingleStockData(pendingTrade.label);
        }
        
        if (rawData) {
            try {
                const tick = JSON.parse(rawData);
                console.log('Market data found:');
                console.log(`BuyPrice: ${tick.BuyPrice}, SellPrice: ${tick.SellPrice}`);
                console.log(`LastTradePrice: ${tick.LastTradePrice}`);
                
                // 3. Test trigger conditions
                console.log('\n3. Testing trigger conditions...');
                const { transactionType, tradePosition, orderPrice } = pendingTrade;
                const { BuyPrice, SellPrice } = tick;
                
                let triggered = false;
                let conditionDesc = "";
                
                if (transactionType === "BUY") {
                    if (tradePosition === "UP") {
                        triggered = SellPrice >= orderPrice;
                        conditionDesc = `BUY UP | SellPrice(${SellPrice}) >= orderPrice(${orderPrice}) => ${triggered}`;
                    } else {
                        triggered = SellPrice <= orderPrice;
                        conditionDesc = `BUY DOWN | SellPrice(${SellPrice}) <= orderPrice(${orderPrice}) => ${triggered}`;
                    }
                } else if (transactionType === "SELL") {
                    if (tradePosition === "UP") {
                        triggered = BuyPrice >= orderPrice;
                        conditionDesc = `SELL UP | BuyPrice(${BuyPrice}) >= orderPrice(${orderPrice}) => ${triggered}`;
                    } else {
                        triggered = BuyPrice <= orderPrice;
                        conditionDesc = `SELL DOWN | BuyPrice(${BuyPrice}) <= orderPrice(${orderPrice}) => ${triggered}`;
                    }
                }
                
                console.log(`Condition: ${conditionDesc}`);
                console.log(`Should trigger: ${triggered ? '✅ YES' : '❌ NO'}`);
                
                if (triggered) {
                    console.log('\n4. This trade should execute! Checking why it might not be...');
                    
                    // Check if there are any validation issues that might prevent execution
                    console.log('Possible issues:');
                    console.log('- Brokerage calculation failure');
                    console.log('- Margin insufficient');
                    console.log('- Market status validation');
                    console.log('- Fresh limit restrictions');
                    console.log('- Position limits exceeded');
                }
                
            } catch (e) {
                console.error('Error parsing market data:', e);
                console.log('Raw data:', rawData);
            }
        } else {
            console.log('❌ No market data available for this script');
            console.log('This could be why the limit trade is not executing');
        }
        
        // 4. Check recent execution attempts
        console.log('\n4. Checking for recent execution logs...');
        
        // Look for any trades that were recently updated
        const recentUpdates = await StockTransaction.find({
            scriptId: pendingTrade.scriptId,
            userId: pendingTrade.userId,
            updatedAt: { $gte: new Date(Date.now() - 60 * 60 * 1000) } // Last hour
        })
        .sort({ updatedAt: -1 })
        .limit(5)
        .lean();
        
        if (recentUpdates.length > 0) {
            console.log(`Found ${recentUpdates.length} recent updates for this script/user:`);
            recentUpdates.forEach((trade, index) => {
                console.log(`${index + 1}. Status: ${trade.transactionStatus}, Message: ${trade.message || 'No message'}, Updated: ${trade.updatedAt}`);
            });
        }
        
    } catch (error) {
        console.error('Error during test:', error);
    }
    
    mongoose.disconnect();
}

testLimitExecution();