/**
 * Cleanup Expired Scripts
 * 
 * This script removes expired entries from Script documents and deletes associated UserScript documents.
 * It does NOT perform any square-off operations - only cleanup.
 * 
 * Usage:
 *   node scripts/cleanupExpiredScripts.js [marketId] [date]
 * 
 * Examples:
 *   node scripts/cleanupExpiredScripts.js              # Clean all markets for today
 *   node scripts/cleanupExpiredScripts.js 12           # Clean market 12 for today
 *   node scripts/cleanupExpiredScripts.js 12 2026-04-28  # Clean market 12 for specific date
 */

const mongoose = require("mongoose");
const moment = require("moment");
require("dotenv").config();

// Import models
const { Script, MarketType } = require("../src/models/MarketTypeModel");
const UserScript = require("../src/models/UserScriptModel");
const { refreshMarketCache } = require("../src/services/ScriptService");

// Database connection
const connectDB = async () => {
    try {
        const dbURI = process.env.MONGODB_URI;
        
        if (!dbURI) {
            throw new Error("MONGODB_URI environment variable is not set");
        }
        
        await mongoose.connect(dbURI, {
            maxPoolSize: 50,
            minPoolSize: 10,
            socketTimeoutMS: 60000,
            serverSelectionTimeoutMS: 10000,
            heartbeatFrequencyMS: 10000,
        });
        console.log("✓ MongoDB connected successfully");
    } catch (error) {
        console.error("✗ MongoDB connection error:", error.message);
        process.exit(1);
    }
};

/**
 * Main cleanup function
 */
const cleanupExpiredScripts = async (marketId = null, targetDate = null) => {
    try {
        // Use provided date or today
        const dateToCheck = targetDate ? moment(targetDate).startOf('day') : moment().startOf('day');
        const dateStr = dateToCheck.format("YYYY-MM-DD");

        console.log("\n═══════════════════════════════════════════════════════");
        console.log("  EXPIRED SCRIPTS CLEANUP");
        console.log("═══════════════════════════════════════════════════════");
        console.log(`Date: ${dateStr}`);
        console.log(`Market: ${marketId || 'ALL'}`);
        console.log("═══════════════════════════════════════════════════════\n");

        // ── 1. Find scripts with expiry.tradeEndDate = dateStr ──────────
        const scriptQuery = {
            "expiry.tradeEndDate": dateStr
        };
        
        if (marketId) {
            scriptQuery.market_type_id = String(marketId);
        }

        console.log("Query:", JSON.stringify(scriptQuery, null, 2));

        const scriptsWithExpiry = await Script.find(scriptQuery).lean();

        if (scriptsWithExpiry.length === 0) {
            console.log(`\n✓ No expiring scripts found for market ${marketId || 'ALL'} on ${dateStr}.`);
            return {
                success: true,
                scriptsFound: 0,
                entriesRemoved: 0,
                userScriptsDeleted: 0
            };
        }

        console.log(`\n✓ Found ${scriptsWithExpiry.length} script(s) with expiring entries\n`);

        // ── 2. Extract scriptIds from matching expiry entries ──────────
        const scriptIdsToCleanup = new Set();
        const expiryEntriesToCleanup = [];

        console.log("Expiring entries found:");
        console.log("─────────────────────────────────────────────────────────");

        for (const script of scriptsWithExpiry) {
            if (Array.isArray(script.expiry)) {
                for (const exp of script.expiry) {
                    if (exp.tradeEndDate === dateStr) {
                        console.log(`  • ${exp.script_id}`);
                        console.log(`    Script Name: ${script.script_name}`);
                        console.log(`    Trade End Date: ${exp.tradeEndDate}`);
                        console.log(`    Expiry Date: ${exp.expiry_date}`);
                        console.log(`    Script Expiry ID: ${exp.script_expiry_id}`);
                        console.log("");
                        
                        scriptIdsToCleanup.add(exp.script_id);
                        expiryEntriesToCleanup.push({
                            scriptDocId: script._id,
                            scriptExpiryId: exp.script_expiry_id,
                            scriptId: exp.script_id,
                            scriptName: script.script_name,
                            tradeEndDate: exp.tradeEndDate,
                            expiryDate: exp.expiry_date
                        });
                    }
                }
            }
        }

        const uniqueScriptIds = [...scriptIdsToCleanup];
        console.log("─────────────────────────────────────────────────────────");
        console.log(`Total expiring entries: ${expiryEntriesToCleanup.length}`);
        console.log(`Unique script IDs: ${uniqueScriptIds.length}`);
        console.log(`Script IDs: ${uniqueScriptIds.join(', ')}\n`);

        // ── 3. Confirm before proceeding ──────────────────────────────
        if (process.argv.includes('--dry-run')) {
            console.log("🔍 DRY RUN MODE - No changes will be made");
            console.log("   (Cache refresh would also be skipped in dry-run mode)\n");
            return {
                success: true,
                dryRun: true,
                scriptsFound: scriptsWithExpiry.length,
                entriesFound: expiryEntriesToCleanup.length,
                scriptIds: uniqueScriptIds
            };
        }

        // ── 4. Cleanup ───────────────────────────────────────────────────
        console.log("Starting cleanup...\n");

        let userScriptsDeletedCount = 0;
        let expiryEntriesRemovedCount = 0;

        for (const entry of expiryEntriesToCleanup) {
            const { scriptDocId, scriptExpiryId, scriptId, scriptName } = entry;

            console.log(`Processing: ${scriptId} (${scriptName})`);

            // Delete UserScript docs
            try {
                const deleteResult = await UserScript.deleteMany({ scriptId: scriptId });
                userScriptsDeletedCount += deleteResult.deletedCount;
                console.log(`  ✓ Deleted ${deleteResult.deletedCount} UserScript document(s)`);
            } catch (err) {
                console.error(`  ✗ Error deleting UserScript for ${scriptId}:`, err.message);
            }

            // Pull expiry entry from Script.expiry[]
            try {
                const updateResult = await Script.updateOne(
                    { _id: scriptDocId },
                    { $pull: { expiry: { script_expiry_id: scriptExpiryId } } }
                );
                
                if (updateResult.modifiedCount > 0) {
                    expiryEntriesRemovedCount++;
                    console.log(`  ✓ Removed expiry entry ${scriptExpiryId} from Script document`);
                } else {
                    console.log(`  ⚠ Expiry entry ${scriptExpiryId} not found or already removed`);
                }
            } catch (err) {
                console.error(`  ✗ Error removing expiry entry from Script ${scriptDocId}:`, err.message);
            }

            console.log("");
        }

        console.log("═══════════════════════════════════════════════════════");
        console.log("  CLEANUP SUMMARY");
        console.log("═══════════════════════════════════════════════════════");
        console.log(`Scripts processed: ${scriptsWithExpiry.length}`);
        console.log(`Expiry entries removed: ${expiryEntriesRemovedCount}`);
        console.log(`UserScript documents deleted: ${userScriptsDeletedCount}`);
        console.log("═══════════════════════════════════════════════════════\n");

        // ── 5. Refresh Market Cache in Redis ──────────────────────────────
        console.log("Refreshing market caches in Redis...\n");
        
        try {
            // Get all markets to refresh
            const allMarkets = await MarketType.find({}).select('market_type_id name').lean();
            
            if (allMarkets.length === 0) {
                console.log("⚠ No markets found to refresh cache");
            } else {
                console.log(`Found ${allMarkets.length} markets to refresh`);
                
                let successCount = 0;
                let failCount = 0;
                
                for (const market of allMarkets) {
                    try {
                        console.log(`  Refreshing cache for: ${market.name} (ID: ${market.market_type_id})...`);
                        await refreshMarketCache(market.market_type_id);
                        successCount++;
                        console.log(`  ✓ Cache refreshed for ${market.name}`);
                    } catch (err) {
                        failCount++;
                        console.error(`  ✗ Error refreshing cache for ${market.name}:`, err.message);
                    }
                }
                
                console.log("\n─────────────────────────────────────────────────────────");
                console.log(`Cache Refresh Summary: ${successCount} succeeded, ${failCount} failed`);
                console.log("─────────────────────────────────────────────────────────\n");
            }
        } catch (cacheErr) {
            console.error("✗ Error during market cache refresh:", cacheErr.message);
        }

        return {
            success: true,
            scriptsFound: scriptsWithExpiry.length,
            entriesRemoved: expiryEntriesRemovedCount,
            userScriptsDeleted: userScriptsDeletedCount,
            scriptIds: uniqueScriptIds
        };

    } catch (error) {
        console.error("\n✗ Error during cleanup:", error);
        console.error(error.stack);
        return {
            success: false,
            error: error.message
        };
    }
};

/**
 * Main execution
 */
const main = async () => {
    try {
        // Parse command line arguments
        const args = process.argv.slice(2);
        const marketId = args[0] && args[0] !== '--dry-run' ? args[0] : null;
        const targetDate = args[1] && args[1] !== '--dry-run' ? args[1] : null;

        // Show help if requested
        if (args.includes('--help') || args.includes('-h')) {
            console.log(`
Cleanup Expired Scripts

Usage:
  node scripts/cleanupExpiredScripts.js [marketId] [date] [--dry-run]

Arguments:
  marketId    Optional market ID to filter (e.g., 12 for NSE-EQ)
  date        Optional date in YYYY-MM-DD format (defaults to today)
  --dry-run   Show what would be deleted without making changes

Examples:
  node scripts/cleanupExpiredScripts.js
    → Clean all markets for today

  node scripts/cleanupExpiredScripts.js 12
    → Clean market 12 for today

  node scripts/cleanupExpiredScripts.js 12 2026-04-28
    → Clean market 12 for specific date

  node scripts/cleanupExpiredScripts.js --dry-run
    → Preview cleanup for all markets today (no changes)

  node scripts/cleanupExpiredScripts.js 12 2026-04-28 --dry-run
    → Preview cleanup for market 12 on specific date (no changes)
            `);
            process.exit(0);
        }

        // Connect to database
        await connectDB();

        // Run cleanup
        const result = await cleanupExpiredScripts("2", targetDate);

        // Disconnect
        await mongoose.disconnect();
        console.log("✓ Database connection closed\n");

        // Exit with appropriate code
        process.exit(result.success ? 0 : 1);

    } catch (error) {
        console.error("\n✗ Fatal error:", error);
        process.exit(1);
    }
};

// Run if executed directly
if (require.main === module) {
    main();
}

module.exports = { cleanupExpiredScripts };
