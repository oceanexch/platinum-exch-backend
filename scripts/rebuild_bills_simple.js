/**
 * Simplified Bill Rebuild Script
 * 
 * This is a simplified version with minimal MongoDB connection options
 * for maximum compatibility across different Mongoose versions.
 * 
 * Usage: node scripts/rebuild_bills_simple.js [--valanId=<id>]
 */

const mongoose = require('mongoose');
const { generateFinalBills, generateMonthlyFinalBills } = require('../src/services/FinalBillService');
const WeekValanModel = require('../src/models/WeekValanModel');
const FinalBillModel = require('../src/models/FinalBillModel');
const MonthlyFinalBillModel = require('../src/models/MonthlyFinalBill');
require('dotenv').config();

// Parse arguments
const args = process.argv.slice(2);
const valanIdArg = args.find(a => a.startsWith('--valanId='));
const TARGET_VALAN_ID = valanIdArg ? valanIdArg.split('=')[1].trim() : null;

async function connectToMongoDB() {
    try {
        // Use minimal connection options for maximum compatibility
        await mongoose.connect(process.env.MONGODB_URI, {
            maxPoolSize: 10,
            serverSelectionTimeoutMS: 10000,
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

async function runRebuild() {
    try {
        console.log('='.repeat(60));
        if (TARGET_VALAN_ID) {
            console.log(`Starting SCOPED Bill Rebuild for valanId: ${TARGET_VALAN_ID}`);
        } else {
            console.log('Starting FULL Bill Rebuild Migration...');
        }
        console.log('='.repeat(60));

        // Connect to MongoDB
        const connected = await connectToMongoDB();
        if (!connected) {
            process.exit(1);
        }

        // Get current active valan
        const activeValan = await WeekValanModel.findOne({ status: true }).lean();
        if (activeValan) {
            console.log(`\n📌 Current Active Valan: ${activeValan.label} (${activeValan._id})`);
        }

        // Get unique markets
        const StockTransactionModel = require('../src/models/StockTransactionModel');
        const uniqueMarkets = await StockTransactionModel.distinct('marketId');
        const markets = uniqueMarkets.map(m => String(m)).filter(m => m && m !== 'null' && m !== 'undefined');
        console.log(`\nFound ${markets.length} unique markets: [${markets.join(', ')}]\n`);

        if (TARGET_VALAN_ID) {
            // SCOPED MODE: Single valan
            await processSingleValan(TARGET_VALAN_ID, markets);
        } else {
            // FULL MODE: All valans
            await processAllValans(markets);
        }

        console.log('\n' + '='.repeat(60));
        console.log('✅ Rebuild Completed Successfully!');
        console.log('='.repeat(60));

    } catch (error) {
        console.error('\n' + '='.repeat(60));
        console.error('❌ Rebuild Failed!');
        console.error('='.repeat(60));
        console.error('Error:', error.message);
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

async function processSingleValan(valanId, markets) {
    console.log('\n🔄 Processing Single Valan...');
    
    // Validate valan
    const valan = await WeekValanModel.findById(valanId).lean();
    if (!valan) {
        throw new Error(`Valan not found: ${valanId}`);
    }

    console.log(`Target Valan: ${valan.label}`);
    console.log(`Period: ${new Date(valan.startDate).toLocaleDateString()} - ${new Date(valan.endDate).toLocaleDateString()}`);

    // Delete existing bills for this valan
    const deleteResult = await FinalBillModel.deleteMany({
        valanId: new mongoose.Types.ObjectId(valanId)
    });
    console.log(`✓ Deleted ${deleteResult.deletedCount} existing bills`);

    // Check for transactions
    const StockTransactionModel = require('../src/models/StockTransactionModel');
    const txnCount = await StockTransactionModel.countDocuments({
        valanId: new mongoose.Types.ObjectId(valanId),
        transactionStatus: 'COMPLETED'
    });

    if (txnCount === 0) {
        console.log('⚠ No transactions found - nothing to bill');
        return;
    }

    console.log(`📊 Found ${txnCount} transactions`);

    // Generate bills for each market
    let totalGenerated = 0;
    let errors = 0;

    for (const marketId of markets) {
        try {
            const marketTxnCount = await StockTransactionModel.countDocuments({
                valanId: new mongoose.Types.ObjectId(valanId),
                marketId: String(marketId),
                transactionStatus: 'COMPLETED'
            });

            if (marketTxnCount === 0) {
                console.log(`  ⊘ Market ${marketId}: No transactions - skipping`);
                continue;
            }

            console.log(`  🔄 Market ${marketId}: Processing ${marketTxnCount} transactions...`);

            const result = await generateFinalBills(valanId, marketId, { 
                clean: false, 
                force: true 
            });

            if (result && result.count > 0) {
                console.log(`  ✓ Market ${marketId}: Generated ${result.count} bills`);
                totalGenerated += result.count;
            } else {
                console.log(`  ⚠ Market ${marketId}: No bills generated`);
            }

        } catch (error) {
            console.error(`  ✗ Market ${marketId}: ${error.message}`);
            errors++;
        }
    }

    console.log(`\n✓ Generated ${totalGenerated} bills with ${errors} errors`);
}

async function processAllValans(markets) {
    console.log('\n🔄 Processing All Valans...');

    // Delete all existing bills
    console.log('Deleting all existing bills...');
    const [finalDeleted, monthlyDeleted] = await Promise.all([
        FinalBillModel.deleteMany({}),
        MonthlyFinalBillModel.deleteMany({})
    ]);
    console.log(`✓ Deleted ${finalDeleted.deletedCount} final bills and ${monthlyDeleted.deletedCount} monthly bills`);

    // Get all valans in chronological order
    const valans = await WeekValanModel.find({})
        .sort({ endDate: 1 })
        .lean();

    console.log(`\n📌 Processing ${valans.length} valans in chronological order:`);
    valans.forEach((v, index) => {
        console.log(`   ${index + 1}. ${v.label} (${new Date(v.endDate).toLocaleDateString()})`);
    });

    // Generate weekly bills
    console.log('\n' + '='.repeat(40));
    console.log('STEP 1: Generating Weekly Bills');
    console.log('='.repeat(40));

    let processedCount = 0;
    let totalErrors = 0;

    for (const valan of valans) {
        console.log(`\n[${processedCount + 1}/${valans.length}] Processing: ${valan.label}`);

        const StockTransactionModel = require('../src/models/StockTransactionModel');
        const txnCount = await StockTransactionModel.countDocuments({
            valanId: valan._id,
            transactionStatus: 'COMPLETED'
        });

        if (txnCount === 0) {
            console.log('  ⚠ No transactions - skipping');
            processedCount++;
            continue;
        }

        console.log(`  📊 Found ${txnCount} transactions`);

        for (const marketId of markets) {
            try {
                const marketTxnCount = await StockTransactionModel.countDocuments({
                    valanId: valan._id,
                    marketId: String(marketId),
                    transactionStatus: 'COMPLETED'
                });

                if (marketTxnCount === 0) {
                    continue;
                }

                console.log(`  🔄 Market ${marketId}: ${marketTxnCount} transactions`);

                const result = await generateFinalBills(valan._id, marketId, { clean: false });
                if (result && result.count > 0) {
                    console.log(`  ✓ Market ${marketId}: Generated ${result.count} bills`);
                } else {
                    console.log(`  ⚠ Market ${marketId}: No bills generated`);
                }

            } catch (error) {
                console.error(`  ✗ Market ${marketId}: ${error.message}`);
                totalErrors++;
            }
        }

        processedCount++;
    }

    console.log(`\n✓ Processed ${processedCount} valans with ${totalErrors} errors`);

    // Generate monthly bills
    console.log('\n' + '='.repeat(40));
    console.log('STEP 2: Generating Monthly Bills');
    console.log('='.repeat(40));

    const valanMonths = await WeekValanModel.aggregate([
        {
            $group: {
                _id: {
                    $dateToString: { format: "%Y-%m", date: "$endDate" }
                }
            }
        },
        { $sort: { _id: 1 } }
    ]);

    const months = valanMonths
        .map(m => m._id)
        .filter(mKey => mKey && mKey !== 'null')
        .sort();

    console.log(`\nProcessing ${months.length} months: ${months.join(', ')}`);

    let monthlyProcessed = 0;
    let monthlyErrors = 0;

    for (const monthKey of months) {
        try {
            console.log(`\n[${monthlyProcessed + 1}/${months.length}] Generating: ${monthKey}`);
            const [y, m] = monthKey.split('-');
            const result = await generateMonthlyFinalBills(y, m);
            
            if (result && result.count > 0) {
                console.log(`  ✓ Generated ${result.count} monthly bills`);
            } else {
                console.log(`  ⚠ No bills generated`);
            }
            
            monthlyProcessed++;
        } catch (error) {
            console.error(`  ✗ Error: ${error.message}`);
            monthlyErrors++;
        }
    }

    console.log(`\n✓ Processed ${monthlyProcessed} months with ${monthlyErrors} errors`);

    // Final summary
    const finalBillCount = await FinalBillModel.countDocuments();
    const monthlyBillCount = await MonthlyFinalBillModel.countDocuments();
    
    console.log(`\n📊 Final Results:`);
    console.log(`✓ Weekly Bills: ${finalBillCount}`);
    console.log(`✓ Monthly Bills: ${monthlyBillCount}`);
    console.log(`✓ Total Errors: ${totalErrors + monthlyErrors}`);
}

// Handle process termination
process.on('SIGINT', async () => {
    console.log('\n\nReceived SIGINT, cleaning up...');
    try {
        await mongoose.disconnect();
        console.log('✓ Disconnected from MongoDB');
    } catch (err) {
        console.error('Error during cleanup:', err.message);
    }
    process.exit(0);
});

// Run the rebuild
runRebuild();