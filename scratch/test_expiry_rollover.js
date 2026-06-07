/**
 * Test script for expiryPositionRollover function
 * This script allows manual testing of the expiry rollover process for specific markets
 */

const mongoose = require('mongoose');
const moment = require('moment');
require('dotenv').config();

// Import the MarketOperationsService
const MarketOperationsService = require('../src/services/MarketOperationsService');

// Database connection
const connectDB = async () => {
    try {
        await mongoose.connect(process.env.MONGODB_URI || process.env.DB_CONNECTION_STRING, {
            useNewUrlParser: true,
            useUnifiedTopology: true,
        });
        console.log('MongoDB connected successfully');
    } catch (error) {
        console.error('MongoDB connection error:', error);
        process.exit(1);
    }
};

// Test function
const testExpiryRollover = async (marketId) => {
    try {
        console.log(`\n=== Testing Expiry Rollover for Market ID: ${marketId} ===`);
        console.log(`Current Date: ${moment().format('YYYY-MM-DD HH:mm:ss')}`);
        console.log(`Testing Date: ${moment().format('YYYY-MM-DD')} (today)`);
        
        // Call the expiryPositionRollover function
        await MarketOperationsService.expiryPositionRollover(marketId);
        
        console.log(`✅ Expiry rollover completed for market ${marketId}`);
    } catch (error) {
        console.error(`❌ Error in expiry rollover for market ${marketId}:`, error);
    }
};

// Main execution function
const main = async () => {
    await connectDB();
    
    console.log('🚀 Starting Expiry Rollover Test Script');
    console.log('=====================================');
    
    // Get market ID from command line arguments or use default test markets
    const args = process.argv.slice(2);
    
    if (args.length > 0) {
        // Test specific market IDs provided as arguments
        for (const marketId of args) {
            await testExpiryRollover(marketId);
        }
    } else {
        // Default test - test common market IDs
        console.log('No market ID provided. Testing common markets:');
        console.log('Usage: node scratch/test_expiry_rollover.js <marketId1> <marketId2> ...');
        console.log('Example: node scratch/test_expiry_rollover.js 1 2');
        console.log('\nTesting default markets:');
        
        // Test MCX (Market ID 1)
        await testExpiryRollover('1');
        
        // Test NSE-FO (Market ID 2) 
        // await testExpiryRollover('2');
        
        // Test NSE-EQ (Market ID 3) if needed
        // await testExpiryRollover('3');
    }
    
    console.log('\n🏁 Test completed');
    process.exit(0);
};

// Handle process termination
process.on('SIGINT', () => {
    console.log('\n⚠️  Process interrupted');
    mongoose.connection.close();
    process.exit(0);
});

process.on('unhandledRejection', (error) => {
    console.error('Unhandled rejection:', error);
    mongoose.connection.close();
    process.exit(1);
});

// Run the test
main().catch((error) => {
    console.error('Fatal error:', error);
    mongoose.connection.close();
    process.exit(1);
});