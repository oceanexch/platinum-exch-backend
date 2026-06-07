// Regenerate bills for active valan ONLY

require('dotenv').config();
const mongoose = require('mongoose');
const { generateFinalBills } = require('../src/services/FinalBillService');
const WeekValanModel = require('../src/models/WeekValanModel');

const MARKET_IDS = ["1", "2", "3", "4", "5", "6", "7", "8", "9", "10", "11", "12", "13", "14"];

async function regenerateActiveValan() {
  try {
    console.log('🔗 Connecting to DB...');
    await mongoose.connect(process.env.MONGODB_URI || process.env.MONGO_URI);
    console.log('✅ Connected\n');

    // Get active valan
    const activeValan = await WeekValanModel.findOne({ status: true }).lean();
    
    if (!activeValan) {
      console.log('❌ No active valan found');
      process.exit(1);
    }

    console.log(`📊 Active Valan: ${activeValan.label} (${activeValan._id})\n`);
    console.log('⚠️  WARNING: This will DELETE and REGENERATE all bills for the active valan!\n');

    // Regenerate for all markets
    for (const marketId of MARKET_IDS) {
      console.log(`\n🔄 Processing Market ${marketId}...`);
      
      try {
        await generateFinalBills(activeValan._id, marketId, {
          force: true,
          clean: true
        });
        console.log(`✅ Market ${marketId} complete`);
      } catch (error) {
        console.error(`❌ Market ${marketId} failed:`, error.message);
      }
    }

    console.log('\n✅ REGENERATION COMPLETE!');
    console.log('\n📋 Now check broker bills:');
    console.log('   node scratch/check_broker_bills.js\n');

    process.exit(0);
  } catch (error) {
    console.error('❌ Error:', error.message);
    console.error(error.stack);
    process.exit(1);
  }
}

regenerateActiveValan();
