const mongoose = require('mongoose');
const quantitySetting = require('../src/models/QuantitySettingModel');
const StockTransaction = require('../src/models/StockTransactionModel');
require('dotenv').config();

// Connect to database
mongoose.connect(process.env.MONGODB_URI || process.env.DB_URL);

async function debugEditTradeLot() {
    console.log('=== EDIT TRADE LOT LIMIT DEBUG ===\n');
    
    try {
        // Get the specific trade that's failing
        console.log('Please provide the following information:');
        console.log('1. Trade ID that you are trying to edit');
        console.log('2. User ID');
        console.log('3. Script ID');
        console.log('4. Market ID');
        console.log('5. New lot value you are trying to set');
        console.log('6. New price value you are trying to set');
        
        // For now, let's test with the pending trade we found earlier
        const pendingTrade = await StockTransaction.findOne({
            transactionStatus: 'PENDING'
        }).lean();
        
        if (!pendingTrade) {
            console.log('No pending trades found to test with');
            return;
        }
        
        console.log('\nTesting with pending trade:');
        console.log(`Trade ID: ${pendingTrade._id}`);
        console.log(`User ID: ${pendingTrade.userId}`);
        console.log(`Script ID: ${pendingTrade.scriptId}`);
        console.log(`Market ID: ${pendingTrade.marketId}`);
        console.log(`Current Lot: ${pendingTrade.lot}`);
        console.log(`Current Price: ${pendingTrade.orderPrice || pendingTrade.price}`);
        
        // Simulate the exact editTrade validation logic
        await simulateEditTradeValidation(
            pendingTrade.userId,
            pendingTrade.scriptId,
            pendingTrade.marketId,
            pendingTrade.lot, // Try with same lot
            pendingTrade.orderPrice || pendingTrade.price
        );
        
        // Test with different lot values
        console.log('\n=== TESTING DIFFERENT LOT VALUES ===');
        const testLots = [0.5, 1, 1.5, 2, 5, 10];
        
        for (const testLot of testLots) {
            console.log(`\nTesting lot: ${testLot}`);
            await simulateEditTradeValidation(
                pendingTrade.userId,
                pendingTrade.scriptId,
                pendingTrade.marketId,
                testLot,
                pendingTrade.orderPrice || pendingTrade.price
            );
        }
        
    } catch (error) {
        console.error('Error during debug:', error);
    }
    
    mongoose.disconnect();
}

async function simulateEditTradeValidation(userId, scriptId, marketId, lot, price) {
    console.log(`\n  Simulating editTrade validation for lot: ${lot}, price: ${price}`);
    
    // Step 1: Replicate the exact checkLimits query from editTrade
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
    
    console.log(`  Found ${checkLimits.length} specific script limits`);
    
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
        
        console.log(`  Found ${checkLimits.length} default (999) limits`);
    }
    
    if (checkLimits.length === 0) {
        console.log('  ❌ No limits found - this would cause "Limit not exists" error');
        return;
    }
    
    // Step 2: Find lot limits (exact same logic as editTrade)
    const lotLimits = checkLimits.find((lmt) => lmt.qtySetting === 'Lot');
    
    if (lotLimits) {
        console.log(`  Lot limits found: Min ${lotLimits.minOrder}, Max ${lotLimits.maxOrder}`);
        
        // Step 3: Exact validation logic from editTrade
        if (lot < lotLimits.minOrder || lot > lotLimits.maxOrder) {
            console.log(`  ❌ VALIDATION FAILED: lot (${lot}) < minOrder (${lotLimits.minOrder}) OR lot (${lot}) > maxOrder (${lotLimits.maxOrder})`);
            console.log(`  This would return: "Lot limit reached"`);
            return false;
        }
        
        // Step 4: Range validation if applicable
        if (lotLimits.isRange) {
            console.log(`  Range validation enabled: ${lotLimits.startRange} - ${lotLimits.endRange}`);
            if (price < lotLimits.startRange || price > lotLimits.endRange) {
                console.log(`  ❌ RANGE VALIDATION FAILED: price (${price}) outside range [${lotLimits.startRange}, ${lotLimits.endRange}]`);
                console.log(`  This would return: "Range limit reached"`);
                return false;
            } else {
                console.log(`  ✅ Range validation passed`);
            }
        }
        
        console.log(`  ✅ Lot validation passed`);
        return true;
    } else {
        console.log(`  ⚠️  No lot limits found in settings (qtySetting !== 'Lot')`);
        console.log(`  Available settings:`, checkLimits.map(l => l.qtySetting));
        return true; // No lot limits means no restriction
    }
}

// Helper function to test with specific values
async function testSpecificTrade(tradeId, newLot, newPrice) {
    console.log(`\n=== TESTING SPECIFIC TRADE ===`);
    console.log(`Trade ID: ${tradeId}, New Lot: ${newLot}, New Price: ${newPrice}`);
    
    const trade = await StockTransaction.findById(tradeId).lean();
    if (!trade) {
        console.log('Trade not found');
        return;
    }
    
    await simulateEditTradeValidation(
        trade.userId,
        trade.scriptId,
        trade.marketId,
        newLot,
        newPrice
    );
}

debugEditTradeLot();

// Export for manual testing
module.exports = { testSpecificTrade };