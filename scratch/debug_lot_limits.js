const mongoose = require('mongoose');
const quantitySetting = require('../src/models/QuantitySettingModel');
require('dotenv').config();

// Connect to database
mongoose.connect(process.env.MONGODB_URI || process.env.DB_URL);

async function debugLotLimits(userId, scriptId, marketId, lot) {
    console.log('=== LOT LIMIT DEBUG ===');
    console.log(`Checking for userId: ${userId}, scriptId: ${scriptId}, marketId: ${marketId}, lot: ${lot}`);
    
    // First, try to find specific script limits
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
    
    console.log('\n1. Specific script limits found:', checkLimits.length);
    if (checkLimits.length > 0) {
        console.log('Specific limits:', JSON.stringify(checkLimits, null, 2));
    }
    
    // If no specific limits, try default (999) limits
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
        
        console.log('\n2. Default (999) limits found:', checkLimits.length);
        if (checkLimits.length > 0) {
            console.log('Default limits:', JSON.stringify(checkLimits, null, 2));
        }
    }
    
    // Find lot limits specifically
    const lotLimits = checkLimits.find((lmt) => lmt.qtySetting === 'Lot');
    
    console.log('\n3. Lot limits extracted:');
    if (lotLimits) {
        console.log('Lot limits:', JSON.stringify(lotLimits, null, 2));
        
        // Check the validation logic
        console.log('\n4. Validation check:');
        console.log(`lot (${lot}) < minOrder (${lotLimits.minOrder}): ${lot < lotLimits.minOrder}`);
        console.log(`lot (${lot}) > maxOrder (${lotLimits.maxOrder}): ${lot > lotLimits.maxOrder}`);
        
        if (lot < lotLimits.minOrder || lot > lotLimits.maxOrder) {
            console.log('❌ VALIDATION FAILED: Lot limit reached');
            console.log(`Allowed range: ${lotLimits.minOrder} to ${lotLimits.maxOrder}`);
        } else {
            console.log('✅ VALIDATION PASSED: Lot is within limits');
        }
    } else {
        console.log('No lot limits found');
    }
    
    // Also check all quantity settings for this user/market
    console.log('\n5. All quantity settings for this user/market:');
    const allSettings = await quantitySetting
        .find({ clientId: userId, marketId })
        .lean();
    
    console.log(`Found ${allSettings.length} total settings:`);
    allSettings.forEach((setting, index) => {
        console.log(`${index + 1}. Script: ${setting.scriptId}, Type: ${setting.qtySetting}, Min: ${setting.minOrder}, Max: ${setting.maxOrder}`);
    });
    
    mongoose.disconnect();
}

// Usage: node scratch/debug_lot_limits.js <userId> <scriptId> <marketId> <lot>
const args = process.argv.slice(2);
if (args.length < 4) {
    console.log('Usage: node debug_lot_limits.js <userId> <scriptId> <marketId> <lot>');
    console.log('Example: node debug_lot_limits.js 507f1f77bcf86cd799439011 RELIANCE 12 1');
    process.exit(1);
}

const [userId, scriptId, marketId, lot] = args;
debugLotLimits(userId, scriptId, marketId, parseFloat(lot))
    .catch(console.error);