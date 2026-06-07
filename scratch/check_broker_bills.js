// Check if broker bills exist in database

require('dotenv').config();
const mongoose = require('mongoose');

async function check() {
  try {
    await mongoose.connect(process.env.MONGODB_URI || process.env.MONGO_URI);
    console.log('✅ Connected to DB\n');

    const FinalBillModel = require('../src/models/FinalBillModel');
    
    // Check broker bills (level 5 or 6)
    const brokerBills = await FinalBillModel.find({ level: { $in: [5, 6] } }).lean();
    
    console.log(`📊 Total broker bills in database: ${brokerBills.length}\n`);
    
    if (brokerBills.length === 0) {
      console.log('❌ NO BROKER BILLS FOUND!');
      console.log('\n🔧 You MUST run bill generation first:');
      console.log('   node src/tests/finalbills.js\n');
    } else {
      console.log('✅ Broker bills exist:\n');
      brokerBills.slice(0, 5).forEach(b => {
        console.log(`   - ${b.accountName} (${b.accountCode})`);
        console.log(`     Level: ${b.level}, M2M: ${b.totalM2M}, Brokerage: ${b.brokerBrokerage}`);
      });
    }
    
    process.exit(0);
  } catch (error) {
    console.error('❌ Error:', error.message);
    process.exit(1);
  }
}

check();
