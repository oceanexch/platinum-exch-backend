require('dotenv').config();
const mongoose = require('mongoose');

async function testSummary() {
  try {
    await mongoose.connect(process.env.MONGODB_URI);
    console.log('Connected to MongoDB');

    const { getProfitLossWithLivePrices } = require('../src/services/StockService');

    const match = {
      transactionStatus: 'COMPLETED',
      valanId: new mongoose.Types.ObjectId('69f58e1ff56f02356eae7578'),
      marketId: '12'
    };

    console.log('\n=== CALLING getProfitLossWithLivePrices ===');
    const result = await getProfitLossWithLivePrices(match, 7, '675bedff97549fa11ce0ad9f');

    console.log('\n=== RESULTS ===');
    console.log('Total users:', result.data.length);
    
    const mahadip = result.data.find(u => u.accountCode === '644381');
    if (mahadip) {
      console.log('\n=== MAHADIP EQ (644381) ===');
      console.log('userId:', mahadip.userId);
      console.log('m2m:', mahadip.m2m);
      console.log('interestAmount:', mahadip.interestAmount);
      console.log('bill:', mahadip.bill);
      console.log('selfNetPrice:', mahadip.selfNetPrice);
    } else {
      console.log('\n❌ MAHADIP EQ not found in results');
    }

    await mongoose.disconnect();
  } catch (error) {
    console.error('Error:', error);
    process.exit(1);
  }
}

testSummary();
