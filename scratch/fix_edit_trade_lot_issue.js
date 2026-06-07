const mongoose = require('mongoose');
const StockTransaction = require('../src/models/StockTransactionModel');
const quantitySetting = require('../src/models/QuantitySettingModel');
const { checkFreshLimitDisabledInHierarchy } = require('../src/services/MarketOperationsService');
require('dotenv').config();

// Connect to database
mongoose.connect(process.env.MONGODB_URI || process.env.DB_URL);

async function fixEditTradeLotIssue() {
    console.log('=== EDIT TRADE LOT ISSUE ANALYSIS & FIX ===\n');
    
    try {
        // Find a specific trade to test with
        const testTrade = await StockTransaction.findOne({
            transactionStatus: 'PENDING'
        }).lean();
        
        if (!testTrade) {
            console.log('No pending trades found to test with');
            return;
        }
        
        console.log('Testing with trade:');
        console.log(`Trade ID: ${testTrade._id}`);
        console.log(`User: ${testTrade.userId}`);
        console.log(`Script: ${testTrade.scriptId}`);
        console.log(`Market: ${testTrade.marketId}`);
        console.log(`Current Lot: ${testTrade.lot}`);
        
        // Test the fresh limit validation logic
        console.log('\n=== TESTING FRESH LIMIT VALIDATION ===');
        
        const isFreshLimitDisabled = await checkFreshLimitDisabledInHierarchy(
            testTrade.userId, 
            [], // parentIds - we'll get these from services
            testTrade.marketId
        );
        
        console.log(`Fresh limit disabled: ${isFreshLimitDisabled}`);
        
        if (isFreshLimitDisabled) {
            console.log('\n❌ FOUND THE ISSUE: Fresh limit is disabled for this user!');
            console.log('This means the user can only exit existing positions, not create new ones or increase existing ones.');
            console.log('The fresh limit validation has its own lot limit checks that might be more restrictive.');
            
            // Check if user has any positions
            const { getUserPosition } = require('../src/services/StockService');
            const WeekValanModel = require('../src/models/WeekValanModel');
            
            const getValan = await WeekValanModel.findOne({ isActive: true }).lean();
            
            const positions = await getUserPosition({
                userId: new mongoose.Types.ObjectId(testTrade.userId),
                valanId: getValan._id,
                marketId: String(testTrade.marketId),
                $or: [
                    { scriptId: String(testTrade.scriptId) },
                    { label: String(testTrade.label) },
                    { scriptName: String(testTrade.scriptName) }
                ]
            });
            
            console.log(`\nFound ${positions ? positions.length : 0} positions for this script`);
            
            if (positions && positions.length > 0) {
                let totalBuyQty = 0;
                let totalSellQty = 0;
                let totalBuyLot = 0;
                let totalSellLot = 0;
                
                positions.forEach(pos => {
                    totalBuyQty += Number(pos.buyQuantity) || 0;
                    totalSellQty += Number(pos.sellQuantity) || 0;
                    totalBuyLot += Number(pos.buyLot) || 0;
                    totalSellLot += Number(pos.sellLot) || 0;
                });
                
                const netQty = totalBuyQty - totalSellQty;
                const netLot = Number((totalBuyLot - totalSellLot).toFixed(4));
                
                console.log(`Net position: ${netQty} qty, ${netLot} lots`);
                
                if (netQty === 0 && netLot === 0) {
                    console.log('❌ User has no position but fresh limit is disabled - this will block all trades');
                } else {
                    console.log(`✅ User has position: ${netQty > 0 ? 'Long' : 'Short'} ${Math.abs(netQty)} qty`);
                }
            } else {
                console.log('❌ No positions found - fresh limit will block all trades');
            }
        } else {
            console.log('✅ Fresh limit is not disabled - issue must be elsewhere');
        }
        
        // Test the regular lot limit validation
        console.log('\n=== TESTING REGULAR LOT LIMIT VALIDATION ===');
        
        let checkLimits = await quantitySetting
            .find({ clientId: testTrade.userId, scriptId: testTrade.scriptId, marketId: testTrade.marketId })
            .lean();
        
        if (checkLimits.length === 0) {
            checkLimits = await quantitySetting
                .find({ clientId: testTrade.userId, scriptId: '999', marketId: testTrade.marketId })
                .lean();
        }
        
        const lotLimits = checkLimits.find(lmt => lmt.qtySetting === 'Lot');
        
        if (lotLimits) {
            console.log(`Regular lot limits: Min ${lotLimits.minOrder}, Max ${lotLimits.maxOrder}`);
            const isValidLot = testTrade.lot >= lotLimits.minOrder && testTrade.lot <= lotLimits.maxOrder;
            console.log(`Current lot ${testTrade.lot} validation: ${isValidLot ? '✅ PASS' : '❌ FAIL'}`);
        } else {
            console.log('No regular lot limits found');
        }
        
        // Provide solution
        console.log('\n=== SOLUTION ===');
        if (isFreshLimitDisabled) {
            console.log('The issue is with Fresh Limit validation. Solutions:');
            console.log('1. Enable fresh limit for this user (allow new positions)');
            console.log('2. Ensure user has existing positions to exit');
            console.log('3. Modify the fresh limit validation to be less restrictive for edits');
        } else {
            console.log('The issue might be in the lot limit validation logic or position limits');
        }
        
    } catch (error) {
        console.error('Error during analysis:', error);
    }
    
    mongoose.disconnect();
}

fixEditTradeLotIssue();