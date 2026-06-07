const mongoose = require('mongoose');
const quantitySetting = require('../src/models/QuantitySettingModel');
const UserModel = require('../src/models/UserModel');
require('dotenv').config();

// Connect to database
mongoose.connect(process.env.MONGODB_URI || process.env.DB_URL);

async function checkLotIssue() {
    console.log('=== COMPREHENSIVE LOT LIMIT ANALYSIS ===\n');
    
    try {
        // 1. Find all users with lot settings
        console.log('1. Finding users with lot settings...');
        const lotSettings = await quantitySetting.find({ qtySetting: 'Lot' }).lean();
        console.log(`Found ${lotSettings.length} lot settings in database\n`);
        
        // 2. Group by user and show their lot limits
        const userLotMap = {};
        lotSettings.forEach(setting => {
            if (!userLotMap[setting.clientId]) {
                userLotMap[setting.clientId] = [];
            }
            userLotMap[setting.clientId].push(setting);
        });
        
        console.log('2. Lot settings by user:');
        for (const [userId, settings] of Object.entries(userLotMap)) {
            console.log(`\nUser: ${userId}`);
            settings.forEach(setting => {
                console.log(`  Script: ${setting.scriptId}, Market: ${setting.marketId}`);
                console.log(`  Min: ${setting.minOrder}, Max: ${setting.maxOrder}`);
                console.log(`  Range: ${setting.isRange ? 'Yes' : 'No'}, Start: ${setting.startRange}, End: ${setting.endRange}`);
            });
        }
        
        // 3. Check for common issues
        console.log('\n3. Checking for common issues:');
        
        // Issue 1: minOrder > maxOrder
        const invalidRanges = lotSettings.filter(s => s.minOrder > s.maxOrder);
        if (invalidRanges.length > 0) {
            console.log(`❌ Found ${invalidRanges.length} settings with minOrder > maxOrder:`);
            invalidRanges.forEach(s => {
                console.log(`  User: ${s.clientId}, Script: ${s.scriptId}, Min: ${s.minOrder}, Max: ${s.maxOrder}`);
            });
        }
        
        // Issue 2: Zero or negative limits
        const zeroLimits = lotSettings.filter(s => s.minOrder <= 0 || s.maxOrder <= 0);
        if (zeroLimits.length > 0) {
            console.log(`⚠️  Found ${zeroLimits.length} settings with zero/negative limits:`);
            zeroLimits.forEach(s => {
                console.log(`  User: ${s.clientId}, Script: ${s.scriptId}, Min: ${s.minOrder}, Max: ${s.maxOrder}`);
            });
        }
        
        // Issue 3: Very restrictive limits (max < 1)
        const restrictiveLimits = lotSettings.filter(s => s.maxOrder < 1);
        if (restrictiveLimits.length > 0) {
            console.log(`⚠️  Found ${restrictiveLimits.length} settings with maxOrder < 1:`);
            restrictiveLimits.forEach(s => {
                console.log(`  User: ${s.clientId}, Script: ${s.scriptId}, Min: ${s.minOrder}, Max: ${s.maxOrder}`);
            });
        }
        
        // 4. Show sample validation scenarios
        console.log('\n4. Sample validation scenarios:');
        const sampleSettings = lotSettings.slice(0, 3);
        
        for (const setting of sampleSettings) {
            console.log(`\nTesting setting: User ${setting.clientId}, Script ${setting.scriptId}`);
            console.log(`Limits: Min ${setting.minOrder}, Max ${setting.maxOrder}`);
            
            // Test different lot values
            const testLots = [0.5, 1, 2, 5, 10];
            testLots.forEach(lot => {
                const isValid = lot >= setting.minOrder && lot <= setting.maxOrder;
                const status = isValid ? '✅' : '❌';
                console.log(`  Lot ${lot}: ${status} ${isValid ? 'PASS' : 'FAIL'}`);
            });
        }
        
        // 5. Check for missing default (999) settings
        console.log('\n5. Checking for missing default settings:');
        const users = await UserModel.find({}).select('_id').lean();
        const markets = ['12', '2', '3']; // Common market IDs
        
        for (const market of markets) {
            const usersWithDefaults = await quantitySetting.distinct('clientId', {
                scriptId: '999',
                marketId: market,
                qtySetting: 'Lot'
            });
            
            const usersWithoutDefaults = users.filter(u => 
                !usersWithDefaults.some(uid => uid.toString() === u._id.toString())
            );
            
            if (usersWithoutDefaults.length > 0) {
                console.log(`Market ${market}: ${usersWithoutDefaults.length} users missing default lot settings`);
            }
        }
        
    } catch (error) {
        console.error('Error during analysis:', error);
    }
    
    mongoose.disconnect();
}

checkLotIssue();