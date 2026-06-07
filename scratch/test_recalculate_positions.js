/**
 * Test script for recalculating user positions
 * 
 * Usage:
 *   node scratch/test_recalculate_positions.js <userId> <valanId>
 * 
 * Example:
 *   node scratch/test_recalculate_positions.js 507f1f77bcf86cd799439011 507f191e810c19729de860ea
 */

require('dotenv').config();
const mongoose = require('mongoose');
const { recalculateUserPositions } = require('../src/services/StockService');

const testRecalculatePositions = async (userId, valanId) => {
  try {
    console.log('🔄 Starting position recalculation...');
    console.log(`   User ID: ${userId}`);
    console.log(`   Valan ID: ${valanId}`);
    console.log('');

    const result = await recalculateUserPositions(userId, valanId);

    console.log('✅ Recalculation completed!');
    console.log('');
    console.log('📊 Results:');
    console.log(`   Message: ${result.message}`);
    console.log(`   Recalculated: ${result.recalculated}`);
    console.log(`   Total Scripts: ${result.total}`);
    console.log('');

    if (result.scripts && result.scripts.length > 0) {
      console.log('📝 Recalculated Scripts:');
      result.scripts.forEach((script, index) => {
        console.log(`   ${index + 1}. ${script.scriptName} (${script.marketName})`);
        console.log(`      Script ID: ${script.scriptId}`);
        console.log(`      Market ID: ${script.marketId}`);
        console.log(`      Status: ${script.status}`);
      });
      console.log('');
    }

    if (result.errors && result.errors.length > 0) {
      console.log('❌ Errors:');
      result.errors.forEach((error, index) => {
        console.log(`   ${index + 1}. ${error.scriptName} (${error.marketName})`);
        console.log(`      Script ID: ${error.scriptId}`);
        console.log(`      Error: ${error.error}`);
      });
      console.log('');
    }

    return result;
  } catch (error) {
    console.error('❌ Error during recalculation:', error.message);
    throw error;
  }
};

// Main execution
const main = async () => {
  const args = process.argv.slice(2);

  if (args.length < 2) {
    console.error('❌ Error: Missing required arguments');
    console.log('');
    console.log('Usage:');
    console.log('  node scratch/test_recalculate_positions.js <userId> <valanId>');
    console.log('');
    console.log('Example:');
    console.log('  node scratch/test_recalculate_positions.js 507f1f77bcf86cd799439011 507f191e810c19729de860ea');
    process.exit(1);
  }

  const [userId, valanId] = args;

  try {
    // Connect to MongoDB
    console.log('🔌 Connecting to MongoDB...');
    await mongoose.connect(process.env.MONGO_URI || process.env.DATABASE_URL, {
      useNewUrlParser: true,
      useUnifiedTopology: true,
    });
    console.log('✅ Connected to MongoDB');
    console.log('');

    // Run the test
    await testRecalculatePositions(userId, valanId);

    console.log('✅ Test completed successfully!');
  } catch (error) {
    console.error('❌ Test failed:', error);
    process.exit(1);
  } finally {
    // Close MongoDB connection
    await mongoose.connection.close();
    console.log('');
    console.log('🔌 MongoDB connection closed');
  }
};

// Run if called directly
if (require.main === module) {
  main();
}

module.exports = { testRecalculatePositions };
