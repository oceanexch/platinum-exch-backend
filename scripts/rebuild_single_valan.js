/**
 * Simple Single Valan Bill Rebuild Script
 * 
 * This is a simplified version focused on rebuilding bills for a single valan
 * with robust connection handling and detailed error reporting.
 * 
 * Usage: node scripts/rebuild_single_valan.js <valanId>
 */

const mongoose = require('mongoose');
const { generateFinalBills } = require('../src/services/FinalBillService');
const WeekValanModel = require('../src/models/WeekValanModel');
const FinalBillModel = require('../src/models/FinalBillModel');
const StockTransactionModel = require('../src/models/StockTransactionModel');
require('dotenv').config();

const TARGET_VALAN_ID = process.argv[2];

if (!TARGET_VALAN_ID) {
    console.error('Usage: node scripts/rebuild_single_valan.js <valanId>');
    process.exit(1);
}

async function connectToMongoDB() {
    try {
        // Use simpler connection options
        await mongoose.connect(process.env.MONGODB_URI, {
            maxPoolSize: 10,
            serverSelectionTimeoutMS: 5000,
            socketTimeoutMS: 45000
        });
        
        // Test connection
        await mongoose.connection.db.admin().ping();
        console.log('✓ Connected to MongoDB');
        
        return true;
    } catch (error) {
        console.error('✗ MongoDB connection failed:', error.message);
        return false;
    }
}

async function rebuildSingleValan() {
    try {
        console.log('='.repeat(60));
        console.log(`Rebuilding Bills for Valan: ${TARGET_VALAN_ID}`);
        console.log('='.repeat(60));

        // Connect to MongoDB
        const connected = await connectToMongoDB();
        if (!connected) {
            process.exit(1);
        }

        // Validate valan exists
        console.log('\n1. Validating valan...');
        const valan = await WeekValanModel.findById(TARGET_VALAN_ID).lean();
        if (!valan) {
            console.error(`✗ Valan not found: ${TARGET_VALAN_ID}`);
            process.exit(1);
        }

        console.log(`✓ Found valan: ${valan.label}`);
        console.log(`  Period: ${new Date(valan.startDate).toLocaleDateString()} - ${new Date(valan.endDate).toLocaleDateString()}`);
        console.log(`  Status: ${valan.status ? 'ACTIVE' : 'INACTIVE'}`);

        // Check for transactions
        console.log('\n2. Checking transactions...');
        const txnCount = await StockTransactionModel.countDocuments({
            valanId: new mongoose.Types.ObjectId(TARGET_VALAN_ID),
            transactionStatus: 'COMPLETED'
        });

        console.log(`✓ Found ${txnCount} completed transactions`);
        
        if (txnCount === 0) {
            console.log('⚠ No transactions found - nothing to bill');
            await mongoose.disconnect();
            process.exit(0);
        }

        // Get unique markets
        console.log('\n3. Finding markets...');
        const markets = await StockTransactionModel.distinct('marketId', {
            valanId: new mongoose.Types.ObjectId(TARGET_VALAN_ID),
            transactionStatus: 'COMPLETED'
        });

        console.log(`✓ Found ${markets.length} markets: [${markets.join(', ')}]`);

        // Delete existing bills
        console.log('\n4. Cleaning existing bills...');
        const deleteResult = await FinalBillModel.deleteMany({
            valanId: new mongoose.Types.ObjectId(TARGET_VALAN_ID)
        });
        console.log(`✓ Deleted ${deleteResult.deletedCount} existing bills`);

        // Generate bills for each market
        console.log('\n5. Generating new bills...');
        let totalGenerated = 0;
        let errors = 0;

        for (const marketId of markets) {
            try {
                console.log(`\n  Processing Market ${marketId}:`);
                
                // Check transactions for this market
                const marketTxnCount = await StockTransactionModel.countDocuments({
                    valanId: new mongoose.Types.ObjectId(TARGET_VALAN_ID),
                    marketId: String(marketId),
                    transactionStatus: 'COMPLETED'
                });

                console.log(`    Transactions: ${marketTxnCount}`);

                if (marketTxnCount === 0) {
                    console.log(`    ⊘ Skipping (no transactions)`);
                    continue;
                }

                // Generate bills
                const result = await generateFinalBills(TARGET_VALAN_ID, marketId, { 
                    clean: false, 
                    force: true 
                });

                if (result && result.count > 0) {
                    console.log(`    ✓ Generated ${result.count} bills`);
                    totalGenerated += result.count;

                    // Show sample bill
                    const sampleBill = await FinalBillModel.findOne({
                        valanId: new mongoose.Types.ObjectId(TARGET_VALAN_ID),
                        marketId: String(marketId)
                    }).lean();

                    if (sampleBill) {
                        console.log(`    📋 Sample: ${sampleBill.accountName} (L${sampleBill.level})`);
                        console.log(`       M2M: ${sampleBill.totalM2M}, NetPrice: ${sampleBill.selfNetPrice}`);
                        console.log(`       Cash: ${sampleBill.selfCash}, JV: ${sampleBill.selfJV}`);
                        
                        if (sampleBill.partnershipBreakdown && sampleBill.partnershipBreakdown.length > 0) {
                            console.log(`       Partnership: ${sampleBill.partnershipBreakdown.length} entries`);
                        }
                    }
                } else {
                    console.log(`    ⚠ No bills generated`);
                }

            } catch (error) {
                console.error(`    ✗ Error: ${error.message}`);
                errors++;
            }
        }

        // Final summary
        console.log('\n' + '='.repeat(60));
        console.log('REBUILD SUMMARY');
        console.log('='.repeat(60));
        console.log(`✓ Valan: ${valan.label}`);
        console.log(`✓ Markets Processed: ${markets.length}`);
        console.log(`✓ Bills Generated: ${totalGenerated}`);
        console.log(`✓ Errors: ${errors}`);

        // Verify final count
        const finalCount = await FinalBillModel.countDocuments({
            valanId: new mongoose.Types.ObjectId(TARGET_VALAN_ID)
        });
        console.log(`✓ Final Bill Count: ${finalCount}`);

        if (finalCount > 0) {
            console.log('\n✅ SUCCESS: Bills generated successfully!');
        } else {
            console.log('\n⚠ WARNING: No bills were generated');
        }

    } catch (error) {
        console.error('\n❌ FAILED:', error.message);
        console.error('Stack:', error.stack);
        process.exit(1);
    } finally {
        try {
            await mongoose.disconnect();
            console.log('\n✓ Disconnected from MongoDB');
        } catch (err) {
            console.error('Warning: Error disconnecting:', err.message);
        }
    }
}

// Handle process termination
process.on('SIGINT', async () => {
    console.log('\n\nReceived SIGINT, cleaning up...');
    try {
        await mongoose.disconnect();
    } catch (err) {
        console.error('Error during cleanup:', err.message);
    }
    process.exit(0);
});

// Run the rebuild
rebuildSingleValan();