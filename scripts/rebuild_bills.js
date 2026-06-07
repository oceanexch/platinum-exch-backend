const mongoose = require('mongoose');
const { generateFinalBills, generateMonthlyFinalBills } = require('../src/services/FinalBillService');
const { migrateClosingBalance } = require('./migrate_closing_balance');
const { validateBillAccuracy } = require('./validate_bill_accuracy');
const WeekValanModel = require('../src/models/WeekValanModel');
const FinalBillModel = require('../src/models/FinalBillModel');
const MonthlyFinalBillModel = require('../src/models/MonthlyFinalBill');
require('dotenv').config();

// Usage: node rebuild_bills.js [--valanId=<id>] [--marketId=<id>] [--skipMigration] [--skipValidation]
// --valanId       Only delete+regenerate bills for this specific valan (force=true, skip monthly)
// --marketId      Only process this specific market (requires --valanId)
// --skipMigration Skip the closingBalance migration step
// --skipValidation Skip the bill accuracy validation step
const args = process.argv.slice(2);
const valanIdArg = args.find(a => a.startsWith('--valanId='));
const marketIdArg = args.find(a => a.startsWith('--marketId='));
const TARGET_VALAN_ID = valanIdArg ? valanIdArg.split('=')[1].trim() : null;
const TARGET_MARKET_ID = marketIdArg ? marketIdArg.split('=')[1].trim() : null;
const SKIP_MIGRATION = args.includes('--skipMigration');
const SKIP_VALIDATION = args.includes('--skipValidation');

// Validate that marketId is only used with valanId
if (TARGET_MARKET_ID && !TARGET_VALAN_ID) {
    console.error('❌ Error: --marketId can only be used together with --valanId');
    console.log('Usage: node rebuild_bills.js --valanId=<id> --marketId=<id>');
    process.exit(1);
}

// Connection health check function
async function ensureConnection() {
    if (mongoose.connection.readyState !== 1) {
        console.log('⚠ Connection lost, reconnecting...');
        await connectWithRetry();
    }
    
    // Test the connection with a simple ping
    try {
        await mongoose.connection.db.admin().ping();
    } catch (pingError) {
        console.log('⚠ Connection ping failed, reconnecting...');
        await connectWithRetry();
    }
}

async function connectWithRetry(maxRetries = 5) {
    for (let i = 0; i < maxRetries; i++) {
        try {
            // Close existing connection if any
            if (mongoose.connection.readyState !== 0) {
                await mongoose.disconnect();
                await new Promise(r => setTimeout(r, 1000));
            }
            
            const dbURI = process.env.MONGODB_URI;
            await mongoose.connect(dbURI, {
                maxPoolSize: 50,           // Maximum number of connections in the pool
                minPoolSize: 10,           // Minimum number of connections
                socketTimeoutMS: 60000,    // Close sockets after 60 seconds of inactivity
                serverSelectionTimeoutMS: 10000, // Timeout for server selection
                heartbeatFrequencyMS: 10000,     // Check server health every 10 seconds
            });
            
            // Test the connection
            await mongoose.connection.db.admin().ping();
            console.log("✓ Connected to MongoDB.");
            
            // Set up connection event handlers
            mongoose.connection.on('error', (err) => {
                console.error('MongoDB connection error:', err.message);
            });
            
            mongoose.connection.on('disconnected', () => {
                console.log('MongoDB disconnected');
            });
            
            return;
        } catch (err) {
            console.error(`Connection attempt ${i + 1} failed:`, err.message);
            if (i === maxRetries - 1) throw err;
            const delay = Math.min(2000 * Math.pow(2, i), 10000); // Exponential backoff
            console.log(`Retrying in ${delay}ms...`);
            await new Promise(r => setTimeout(r, delay));
        }
    }
}

async function runMigration() {
    try {
        console.log("=".repeat(60));
        if (TARGET_VALAN_ID) {
            if (TARGET_MARKET_ID) {
                console.log(`Starting SCOPED Bill Rebuild for valanId: ${TARGET_VALAN_ID}, marketId: ${TARGET_MARKET_ID}`);
            } else {
                console.log(`Starting SCOPED Bill Rebuild for valanId: ${TARGET_VALAN_ID}`);
            }
        } else {
            console.log("Starting FULL Bill Rebuild Migration...");
        }
        console.log("=".repeat(60));

        await connectWithRetry();

        // 1. Get current active valan (informational)
        const activeValan = await WeekValanModel.findOne({ status: true }).lean();
        if (activeValan) {
            console.log(`\n📌 Current Active Valan: ${activeValan.label} (${activeValan._id})`);
        } else {
            console.log("\n⚠ No active valan found.");
        }

        // 4. Get all unique market IDs from the system (needed by both paths)
        await ensureConnection();
        const StockTransactionModel = require('../src/models/StockTransactionModel');
        
        let markets;
        if (TARGET_MARKET_ID) {
            // Use only the specified market
            markets = [String(TARGET_MARKET_ID)];
            console.log(`\nUsing specified market: ${TARGET_MARKET_ID}\n`);
        } else {
            // Get all unique markets
            const uniqueMarkets = await StockTransactionModel.distinct('marketId');
            markets = uniqueMarkets.map(m => String(m)).filter(m => m && m !== 'null' && m !== 'undefined');
            console.log(`\nFound ${markets.length} unique markets: [${markets.join(', ')}]\n`);
        }

        // ── SCOPED MODE: one specific valan ──────────────────────────────────
        if (TARGET_VALAN_ID) {
            const targetValan = await WeekValanModel.findById(TARGET_VALAN_ID).lean();
            if (!targetValan) {
                console.error(`✗ Valan not found: ${TARGET_VALAN_ID}`);
                process.exit(1);
            }

            console.log(`\n📌 Target Valan: ${targetValan.label} (${targetValan._id})`);
            console.log(`   Period: ${new Date(targetValan.startDate).toLocaleDateString()} - ${new Date(targetValan.endDate).toLocaleDateString()}`);
            if (targetValan.status) console.log("   ⚠  This is the ACTIVE valan — forcing generation.");
            if (TARGET_MARKET_ID) console.log(`   🎯 Target Market: ${TARGET_MARKET_ID}`);

            // Delete only this valan's bills (and optionally only for specific market)
            console.log("\nDeleting existing bills for this valan...");
            
            // Check connection before deletion
            if (mongoose.connection.readyState !== 1) {
                console.log('Connection lost before deletion, reconnecting...');
                await connectWithRetry();
            }
            
            try {
                const deleteQuery = { valanId: new mongoose.Types.ObjectId(TARGET_VALAN_ID) };
                if (TARGET_MARKET_ID) {
                    deleteQuery.marketId = String(TARGET_MARKET_ID);
                }
                
                const delResult = await FinalBillModel.deleteMany(deleteQuery);
                
                if (TARGET_MARKET_ID) {
                    console.log(`✓ Deleted ${delResult.deletedCount} final bills for this valan and market ${TARGET_MARKET_ID}\n`);
                } else {
                    console.log(`✓ Deleted ${delResult.deletedCount} final bills for this valan\n`);
                }
            } catch (deleteError) {
                console.error('Error during deletion:', deleteError.message);
                if (deleteError.message.includes('connection') || deleteError.message.includes('pool')) {
                    console.log('Reconnecting and retrying deletion...');
                    await connectWithRetry();
                    
                    const deleteQuery = { valanId: new mongoose.Types.ObjectId(TARGET_VALAN_ID) };
                    if (TARGET_MARKET_ID) {
                        deleteQuery.marketId = String(TARGET_MARKET_ID);
                    }
                    
                    const delResult = await FinalBillModel.deleteMany(deleteQuery);
                    
                    if (TARGET_MARKET_ID) {
                        console.log(`✓ Deleted ${delResult.deletedCount} final bills for this valan and market ${TARGET_MARKET_ID}\n`);
                    } else {
                        console.log(`✓ Deleted ${delResult.deletedCount} final bills for this valan\n`);
                    }
                } else {
                    throw deleteError;
                }
            }

            console.log("=".repeat(60));
            if (TARGET_MARKET_ID) {
                console.log("Generating Weekly Final Bills (scoped to valan + market)");
            } else {
                console.log("Generating Weekly Final Bills (scoped to valan)");
            }
            console.log("=".repeat(60));

            // Check connection health before each operation
            if (mongoose.connection.readyState !== 1) {
                console.log(`  ⚠ Connection lost, reconnecting...`);
                await connectWithRetry();
            }
            
            const txnCountQuery = {
                valanId: new mongoose.Types.ObjectId(TARGET_VALAN_ID),
                transactionStatus: 'COMPLETED'
            };
            if (TARGET_MARKET_ID) {
                txnCountQuery.marketId = String(TARGET_MARKET_ID);
            }
            
            const txnCount = await StockTransactionModel.countDocuments(txnCountQuery);
            
            if (TARGET_MARKET_ID) {
                console.log(`\n📊 Found ${txnCount} COMPLETED transactions for this valan and market ${TARGET_MARKET_ID}`);
            } else {
                console.log(`\n📊 Found ${txnCount} COMPLETED transactions for this valan`);
            }

            if (txnCount === 0) {
                console.log("⚠ No transactions — skipping bill generation.");
                await mongoose.connection.close();
                process.exit(0);
            }

            let errorCount = 0;
            for (const marketId of markets) {
                try {
                    // Double-check connection before each market
                    if (mongoose.connection.readyState !== 1) {
                        console.log(`  ⚠ Connection lost before market ${marketId}, reconnecting...`);
                        await connectWithRetry();
                    }
                    
                    const marketTxnCount = await StockTransactionModel.countDocuments({
                        valanId: new mongoose.Types.ObjectId(TARGET_VALAN_ID),
                        marketId: String(marketId),
                        transactionStatus: 'COMPLETED'
                    });
                    if (marketTxnCount === 0) {
                        console.log(`  ⊘ Market ${marketId}: No transactions — skipping`);
                        continue;
                    }
                    console.log(`  🔄 Market ${marketId}: Processing ${marketTxnCount} transactions...`);
                    
                    // force:true so active valans are also processed
                    const result = await generateFinalBills(targetValan._id, marketId, { clean: false, force: true });
                    if (result && result.count > 0) {
                        console.log(`  ✓ Market ${marketId}: Generated ${result.count} bills`);
                    } else {
                        console.log(`  ⚠ Market ${marketId}: No bills generated`);
                    }
                } catch (err) {
                    console.error(`  ✗ Market ${marketId}: ${err.message}`);
                    errorCount++;
                    
                    // If it's a connection error, try to reconnect and retry once
                    if (err.message.includes('connection') || err.message.includes('pool') || err.message.includes('closed')) {
                        console.log(`  🔄 Attempting to reconnect and retry market ${marketId}...`);
                        try {
                            await connectWithRetry();
                            const retryResult = await generateFinalBills(targetValan._id, marketId, { clean: false, force: true });
                            if (retryResult && retryResult.count > 0) {
                                console.log(`  ✓ Market ${marketId}: Generated ${retryResult.count} bills (retry successful)`);
                                errorCount--; // Remove the error count since retry succeeded
                            } else {
                                console.log(`  ⚠ Market ${marketId}: No bills generated (retry)`);
                            }
                        } catch (retryErr) {
                            console.error(`  ✗ Market ${marketId}: Retry failed - ${retryErr.message}`);
                        }
                    }
                }
                
                // Small delay between markets to prevent overwhelming the connection
                await new Promise(r => setTimeout(r, 200));
            }

            const finalBillCount = await FinalBillModel.countDocuments({ 
                valanId: new mongoose.Types.ObjectId(TARGET_VALAN_ID),
                ...(TARGET_MARKET_ID && { marketId: String(TARGET_MARKET_ID) })
            });
            
            if (TARGET_MARKET_ID) {
                console.log(`\n✓ Total bills generated for this valan and market ${TARGET_MARKET_ID}: ${finalBillCount}`);
            } else {
                console.log(`\n✓ Total bills generated for this valan: ${finalBillCount}`);
            }
            
            if (errorCount) console.log(`⚠ Errors: ${errorCount}`);
            console.log("\n(Monthly bills skipped in scoped mode — run without --valanId to rebuild monthly bills)");
            console.log("\n" + "=".repeat(60));
            console.log("Scoped Rebuild Complete!");
            console.log("=".repeat(60));
            
            // Close connection gracefully
            try {
                await mongoose.connection.close();
                console.log("✓ Database connection closed.");
            } catch (closeErr) {
                console.error("Warning: Error closing connection:", closeErr.message);
            }
            
            process.exit(0);
        }

        // ── FULL MODE: all valans ─────────────────────────────────────────────

        // 2. Truncate old bills in batches to avoid timeout
        console.log("Truncating old bills...");

        let deletedFinalCount = 0;
        let deletedMonthlyCount = 0;

        try {
            const batchSize = 10000;
            let hasMore = true;

            while (hasMore) {
                const result = await FinalBillModel.deleteMany({}).limit(batchSize);
                deletedFinalCount += result.deletedCount;
                hasMore = result.deletedCount === batchSize;
                if (hasMore) {
                    console.log(`  Deleted ${deletedFinalCount} final bills so far...`);
                    await new Promise(r => setTimeout(r, 100));
                }
            }

            hasMore = true;
            while (hasMore) {
                const result = await MonthlyFinalBillModel.deleteMany({}).limit(batchSize);
                deletedMonthlyCount += result.deletedCount;
                hasMore = result.deletedCount === batchSize;
                if (hasMore) {
                    console.log(`  Deleted ${deletedMonthlyCount} monthly bills so far...`);
                    await new Promise(r => setTimeout(r, 100));
                }
            }
        } catch (deleteErr) {
            console.error("Error during deletion:", deleteErr.message);
            console.log("Attempting to continue with bill generation...");
        }

        console.log(`✓ Deleted ${deletedFinalCount} final bills`);
        console.log(`✓ Deleted ${deletedMonthlyCount} monthly bills\n`);

        // 3. Get ALL valans sorted oldest first (CRITICAL: chronological order for cumulative balance)
        const valans = await WeekValanModel.find({})
            .sort({ endDate: 1 })  // MUST be chronological for proper cumulative balance calculation
            .lean();

        if (valans.length === 0) {
            console.log("⚠ No valans found. Exiting.");
            process.exit(0);
        }

        console.log(`\n📌 Processing ALL ${valans.length} valans in CHRONOLOGICAL ORDER (critical for cumulative balance):`);
        valans.forEach((v, index) => {
            const isActive = activeValan && String(v._id) === String(activeValan._id);
            console.log(`   ${index + 1}. ${v.label} (${new Date(v.endDate).toLocaleDateString()})${isActive ? ' ← ACTIVE' : ''}`);
        });
        console.log();

        console.log("=".repeat(60));
        console.log("STEP 1: Generating Weekly Final Bills");
        console.log("=".repeat(60));

        let processedCount = 0;
        let errorCount = 0;

        for (const valan of valans) {
            console.log(`\n[${processedCount + 1}/${valans.length}] Processing Valan: ${valan.label}`);
            console.log(`  ID: ${valan._id}`);
            console.log(`  Period: ${new Date(valan.startDate).toLocaleDateString()} - ${new Date(valan.endDate).toLocaleDateString()}`);
            
            // DEBUG: Check if there are transactions for this valan
            const StockTransactionModel = require('../src/models/StockTransactionModel');
            const txnCount = await StockTransactionModel.countDocuments({
                valanId: valan._id,
                transactionStatus: 'COMPLETED'
            });
            console.log(`  📊 Found ${txnCount} COMPLETED transactions for this valan`);
            
            if (txnCount === 0) {
                console.log(`  ⚠ No transactions found - skipping bill generation`);
                processedCount++;
                continue;
            }
            
            // DEBUG: Show sample transaction
            const sampleTxn = await StockTransactionModel.findOne({
                valanId: valan._id,
                transactionStatus: 'COMPLETED'
            }).lean();
            
            if (sampleTxn) {
                console.log(`  📝 Sample transaction:`);
                console.log(`     User: ${sampleTxn.userId}`);
                console.log(`     Market: ${sampleTxn.marketId}`);
                console.log(`     Script: ${sampleTxn.scriptName}`);
                console.log(`     Type: ${sampleTxn.transactionType}`);
                console.log(`     Qty: ${sampleTxn.quantity}`);
                console.log(`     Price: ${sampleTxn.orderPrice}`);
            }
            
            for (const marketId of markets) {
                try {
                    // Check connection health before each operation
                    await ensureConnection();
                    
                    // DEBUG: Check transactions for this market
                    const marketTxnCount = await StockTransactionModel.countDocuments({
                        valanId: valan._id,
                        marketId: String(marketId),
                        transactionStatus: 'COMPLETED'
                    });
                    
                    if (marketTxnCount === 0) {
                        console.log(`  ⊘ Market ${marketId}: No transactions - skipping`);
                        continue;
                    }
                    
                    console.log(`  🔄 Market ${marketId}: Processing ${marketTxnCount} transactions...`);
                    
                    const result = await generateFinalBills(valan._id, marketId, { clean: false });
                    if (result && result.count > 0) {
                        console.log(`  ✓ Market ${marketId}: Generated ${result.count} bills`);
                        
                        // VALIDATION: Check sample bill for proper structure
                        const sampleBill = await FinalBillModel.findOne({
                            valanId: valan._id,
                            marketId: String(marketId)
                        }).lean();
                        
                        if (sampleBill) {
                            console.log(`     📋 Sample bill for ${sampleBill.accountName} (Level ${sampleBill.level}):`);
                            console.log(`       totalM2M: ${sampleBill.totalM2M}`);
                            console.log(`       selfNetPrice: ${sampleBill.selfNetPrice}`);
                            console.log(`       selfCash: ${sampleBill.selfCash}, selfJV: ${sampleBill.selfJV}`);
                            
                            // Check partnership breakdown
                            if (Array.isArray(sampleBill.partnershipBreakdown) && sampleBill.partnershipBreakdown.length > 0) {
                                console.log(`       partnershipBreakdown: ${sampleBill.partnershipBreakdown.length} entries`);
                                sampleBill.partnershipBreakdown.forEach((pb, idx) => {
                                    console.log(`         ${idx + 1}. User ${pb.userId}: ${pb.partnership}% = ${pb.amount}`);
                                });
                            } else {
                                console.log(`       partnershipBreakdown: None (may be normal for some user levels)`);
                            }
                            
                            // Check broker brokerage
                            if (Array.isArray(sampleBill.brockersBrokerage) && sampleBill.brockersBrokerage.length > 0) {
                                console.log(`       brockersBrokerage: ${sampleBill.brockersBrokerage.length} entries`);
                            }
                        }
                    } else {
                        console.log(`  ⚠ Market ${marketId}: No bills generated (result: ${JSON.stringify(result)})`);
                    }
                } catch (error) {
                    console.error(`  ✗ Market ${marketId}: Error - ${error.message}`);
                    errorCount++;
                    
                    // If it's a connection error, try to reconnect and retry once
                    if (error.message.includes('connection') || error.message.includes('pool') || error.message.includes('closed')) {
                        console.log(`  🔄 Attempting to reconnect and retry market ${marketId}...`);
                        try {
                            await connectWithRetry();
                            const retryResult = await generateFinalBills(valan._id, marketId, { clean: false });
                            if (retryResult && retryResult.count > 0) {
                                console.log(`  ✓ Market ${marketId}: Generated ${retryResult.count} bills (retry successful)`);
                                errorCount--; // Remove the error count since retry succeeded
                            } else {
                                console.log(`  ⚠ Market ${marketId}: No bills generated (retry)`);
                            }
                        } catch (retryErr) {
                            console.error(`  ✗ Market ${marketId}: Retry failed - ${retryErr.message}`);
                        }
                    }
                }
            }
            
            processedCount++;
            
            // Small delay between valans to prevent overwhelming the connection
            await new Promise(r => setTimeout(r, 500));
        }

        console.log(`\n✓ Processed ${processedCount} valans with ${errorCount} errors\n`);

        // 6. Wait for bills to persist
        console.log("Waiting for bills to persist...");
        await new Promise(r => setTimeout(r, 1000));

        // 7. Re-generate Monthly Bills (CRITICAL: must be in chronological order)
        console.log("\n" + "=".repeat(60));
        console.log("STEP 2: Generating Monthly Bills (Chronological Order)");
        console.log("=".repeat(60));

        // Find distinct months from valan endDates — this is the canonical rule:
        // a valan belongs to the month its endDate falls in.
        const valanMonths = await WeekValanModel.aggregate([
            {
                $group: {
                    _id: {
                        $dateToString: { format: "%Y-%m", date: "$endDate" }
                    }
                }
            },
            { $sort: { _id: 1 } }  // CRITICAL: chronological order for cumulative balance
        ]);

        console.log(`\nDebug: Found ${valanMonths.length} distinct months from valan endDates:`, valanMonths.map(m => m._id));

        const months = valanMonths
            .map(m => m._id)
            .filter(mKey => mKey && mKey !== 'null')
            .sort();  // Ensure chronological order

        if (months.length === 0) {
            console.log("\n⚠ No complete months found for monthly bill generation.");
        } else {
            console.log(`\nFound ${months.length} complete months to process IN CHRONOLOGICAL ORDER:`);
            months.forEach((m, index) => console.log(`  ${index + 1}. ${m}`));
            console.log("\n⚠️  IMPORTANT: Monthly bills MUST be generated in chronological order for accurate cumulative balance calculation!");
            console.log();

            let monthlyProcessed = 0;
            let monthlyErrors = 0;

            for (const monthKey of months) {
                try {
                    console.log(`[${monthlyProcessed + 1}/${months.length}] Generating Monthly Bill for: ${monthKey}`);
                    const [y, m] = monthKey.split('-');
                    const result = await generateMonthlyFinalBills(y, m);
                    
                    if (result && result.count > 0) {
                        console.log(`  ✓ Generated ${result.count} monthly bills with cumulative balances`);
                        
                        // Verify a sample monthly bill has closingBalance
                        const sampleMonthlyBill = await MonthlyFinalBillModel.findOne({ month: monthKey }).lean();
                        if (sampleMonthlyBill) {
                            console.log(`  📊 Sample: Opening=${sampleMonthlyBill.openingBalance}, M2M=${sampleMonthlyBill.totalM2M}, Closing=${sampleMonthlyBill.closingBalance}`);
                        }
                    } else {
                        console.log(`  ⚠ No bills generated (no data for this month)`);
                    }
                    
                    monthlyProcessed++;
                } catch (error) {
                    console.error(`  ✗ Error: ${error.message}`);
                    monthlyErrors++;
                }
            }

            console.log(`\n✓ Processed ${monthlyProcessed} months with ${monthlyErrors} errors`);
            
            // 8. Run closingBalance migration if needed
            if (!SKIP_MIGRATION && monthlyProcessed > 0) {
                console.log("\n" + "=".repeat(60));
                console.log("STEP 3: Migrating closingBalance field for existing records");
                console.log("=".repeat(60));
                
                try {
                    await migrateClosingBalance({ manageConnection: false });
                    console.log("✓ closingBalance migration completed successfully");
                } catch (migrationError) {
                    console.error("⚠ closingBalance migration failed:", migrationError.message);
                    console.log("  You may need to run: node scripts/migrate_closing_balance.js manually");
                }
            } else if (SKIP_MIGRATION) {
                console.log("\n⚠ Skipping closingBalance migration (--skipMigration flag used)");
            }
        }

        // 8. Summary with validation
        console.log("\n" + "=".repeat(60));
        console.log("Migration Summary & Validation");
        console.log("=".repeat(60));
        
        // Ensure connection is still active before validation
        await ensureConnection();
        
        // Validate bill generation
        console.log("\n🔍 Validating generated bills...");
        
        // Ensure connection before each validation query
        await ensureConnection();
        const finalBillCount = await FinalBillModel.countDocuments();
        
        await ensureConnection();
        const monthlyBillCount = await MonthlyFinalBillModel.countDocuments();
        
        // Check for bills with partnership breakdown
        await ensureConnection();
        const billsWithPartnership = await FinalBillModel.countDocuments({
          'partnershipBreakdown.0': { $exists: true }
        });
        
        // Check for monthly bills with closingBalance
        await ensureConnection();
        const monthlyBillsWithClosing = await MonthlyFinalBillModel.countDocuments({
          closingBalance: { $exists: true, $ne: null }
        });
        
        console.log(`\n📊 Bill Generation Results:`);
        console.log(`✓ Total Weekly Bills Generated: ${finalBillCount}`);
        console.log(`✓ Weekly Bills with Partnership Breakdown: ${billsWithPartnership}`);
        console.log(`✓ Total Monthly Bills Generated: ${monthlyBillCount}`);
        console.log(`✓ Monthly Bills with Closing Balance: ${monthlyBillsWithClosing}`);
        console.log(`✓ Valans Processed: ${processedCount}`);
        console.log(`✓ Months Processed: ${months.length}`);
        
        // Sample validation
        if (finalBillCount > 0) {
            console.log(`\n🔍 Sample Weekly Bill Validation:`);
            await ensureConnection();
            const sampleWeeklyBill = await FinalBillModel.findOne().lean();
            if (sampleWeeklyBill) {
                console.log(`   User: ${sampleWeeklyBill.accountName} (Level ${sampleWeeklyBill.level})`);
                console.log(`   Total M2M: ${sampleWeeklyBill.totalM2M}`);
                console.log(`   Self Net Price: ${sampleWeeklyBill.selfNetPrice}`);
                console.log(`   Partnership Breakdown: ${sampleWeeklyBill.partnershipBreakdown ? sampleWeeklyBill.partnershipBreakdown.length + ' entries' : 'None'}`);
                console.log(`   Cash: ${sampleWeeklyBill.selfCash}, JV: ${sampleWeeklyBill.selfJV}`);
            }
        }
        
        if (monthlyBillCount > 0) {
            console.log(`\n🔍 Sample Monthly Bill Validation:`);
            await ensureConnection();
            const sampleMonthlyBill = await MonthlyFinalBillModel.findOne().lean();
            if (sampleMonthlyBill) {
                console.log(`   User: ${sampleMonthlyBill.accountName} (${sampleMonthlyBill.month})`);
                console.log(`   Opening Balance: ${sampleMonthlyBill.openingBalance}`);
                console.log(`   Total M2M: ${sampleMonthlyBill.totalM2M}`);
                console.log(`   Self Cash: ${sampleMonthlyBill.selfCash}`);
                console.log(`   Self JV: ${sampleMonthlyBill.selfJV}`);
                console.log(`   Closing Balance: ${sampleMonthlyBill.closingBalance}`);
                
                // Validate calculation
                const expectedClosing = (sampleMonthlyBill.openingBalance || 0) + 
                                      (sampleMonthlyBill.totalM2M || 0) + 
                                      (sampleMonthlyBill.selfCash || 0) + 
                                      (sampleMonthlyBill.selfJV || 0);
                const actualClosing = sampleMonthlyBill.closingBalance || 0;
                const isCorrect = Math.abs(expectedClosing - actualClosing) < 0.01;
                console.log(`   Calculation Check: ${isCorrect ? '✅ CORRECT' : '❌ INCORRECT'} (Expected: ${expectedClosing}, Actual: ${actualClosing})`);
            }
        }
        
        // Validation warnings
        if (billsWithPartnership === 0 && finalBillCount > 0) {
            console.log(`\n⚠️  WARNING: No bills have partnership breakdown - this may indicate an issue with partnership calculation`);
        }
        
        if (monthlyBillsWithClosing < monthlyBillCount) {
            console.log(`\n⚠️  WARNING: ${monthlyBillCount - monthlyBillsWithClosing} monthly bills missing closingBalance field`);
        }
        
        if (errorCount > 0) {
            console.log(`\n⚠ Errors Encountered: ${errorCount}`);
        }
        
        console.log("\n" + "=".repeat(60));
        if (errorCount === 0 && billsWithPartnership > 0 && monthlyBillsWithClosing === monthlyBillCount) {
            console.log("✅ Migration Completed Successfully with Accurate Bills!");
        } else {
            console.log("⚠️  Migration Completed with Warnings - Please Review");
        }
        console.log("=".repeat(60));
        
        // 9. Run comprehensive validation
        if (!SKIP_VALIDATION && finalBillCount > 0) {
            console.log("\n" + "=".repeat(60));
            console.log("STEP 4: Running Comprehensive Bill Accuracy Validation");
            console.log("=".repeat(60));
            
            try {
                // Ensure connection before validation
                await ensureConnection();
                await validateBillAccuracy({ manageConnection: false });
                console.log("✅ Bill accuracy validation completed successfully");
            } catch (validationError) {
                console.error("⚠ Bill accuracy validation failed:", validationError.message);
                console.log("  Bills were generated but may have accuracy issues");
            }
        } else if (SKIP_VALIDATION) {
            console.log("\n⚠ Skipping bill accuracy validation (--skipValidation flag used)");
        } else {
            console.log("\n⚠ Skipping validation (no bills generated)");
        }
        
        // Close connection gracefully
        await mongoose.connection.close();
        console.log("\n✓ Database connection closed.");
        
        process.exit(0);
    } catch (error) {
        console.error("\n" + "=".repeat(60));
        console.error("Migration Failed!");
        console.error("=".repeat(60));
        console.error("Error:", error.message);
        console.error("Stack:", error.stack);
        
        // Try to close connection
        try {
            await mongoose.connection.close();
        } catch (closeErr) {
            console.error("Error closing connection:", closeErr.message);
        }
        
        process.exit(1);
    }
}

// Handle process termination
process.on('SIGINT', async () => {
    console.log('\n\nReceived SIGINT, closing connections...');
    try {
        await mongoose.connection.close();
        console.log('Connection closed.');
    } catch (err) {
        console.error('Error closing connection:', err);
    }
    process.exit(0);
});

process.on('SIGTERM', async () => {
    console.log('\n\nReceived SIGTERM, closing connections...');
    try {
        await mongoose.connection.close();
        console.log('Connection closed.');
    } catch (err) {
        console.error('Error closing connection:', err);
    }
    process.exit(0);
});

runMigration();
