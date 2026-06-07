#!/usr/bin/env node

/**
 * Standalone script to run dynamic market operations
 * Designed for crontab execution - keeps DB connection persistent
 * 
 * Usage:
 *   node runDynamicMarketOps.js
 *   
 * Crontab:
 *   * * * * * cd /var/www/ocean-code/OceanExch_staging && node runDynamicMarketOps.js >> /var/log/ocean-exch/market-ops.log 2>&1
 */

require('dotenv').config();
const mongoose = require('mongoose');
const { checkAndExecuteMarketOperations } = require('./src/cron/dynamicMarketOperations');

// Configuration
const MONGODB_URI = process.env.MONGODB_URI || process.env.DATABASE_URL;
const EXECUTION_TIMEOUT = 5 * 60 * 1000; // 5 minutes max execution time

let timeoutHandle;

// Main execution
const main = async () => {
  try {
    // Set execution timeout
    timeoutHandle = setTimeout(() => {
      console.error('[RunDynamicMarketOps] ✗ Execution timeout after 5 minutes');
      process.exit(1);
    }, EXECUTION_TIMEOUT);

    // Connect to database if not already connected
    if (!MONGODB_URI) {
      throw new Error('MONGODB_URI or DATABASE_URL not found in environment variables');
    }

    // Only connect if not already connected (keeps connection persistent across cron runs)
    if (mongoose.connection.readyState !== 1) {
      await mongoose.connect(MONGODB_URI, {
        serverSelectionTimeoutMS: 10000,
        socketTimeoutMS: 60000,
        maxPoolSize: 10,
        minPoolSize: 2,
      });
      ////console.log('[RunDynamicMarketOps] ✓ Database connected');
    } else {
      // Connection exists, verify it's alive
      try {
        await mongoose.connection.db.admin().ping();
      } catch (err) {
        console.warn('[RunDynamicMarketOps] Connection lost, reconnecting...');
        await mongoose.connect(MONGODB_URI, {
          serverSelectionTimeoutMS: 10000,
          socketTimeoutMS: 60000,
          maxPoolSize: 10,
          minPoolSize: 2,
        });
        ////console.log('[RunDynamicMarketOps] ✓ Database reconnected');
      }
    }

    // Execute market operations check (only logs when operations are triggered)
    await checkAndExecuteMarketOperations();

    // Clear timeout and exit successfully
    // DO NOT close DB connection - keep it persistent for next cron run
    if (timeoutHandle) clearTimeout(timeoutHandle);
    process.exit(0);
  } catch (error) {
    console.error('[RunDynamicMarketOps] ✗ Fatal error:', error.message);
    console.error(error.stack);
    
    if (timeoutHandle) clearTimeout(timeoutHandle);
    process.exit(1);
  }
};

// Handle process signals gracefully
process.on('SIGINT', () => {
  ////console.log('[RunDynamicMarketOps] Received SIGINT, exiting...');
  if (timeoutHandle) clearTimeout(timeoutHandle);
  process.exit(0);
});

process.on('SIGTERM', () => {
  ////console.log('[RunDynamicMarketOps] Received SIGTERM, exiting...');
  if (timeoutHandle) clearTimeout(timeoutHandle);
  process.exit(0);
});

process.on('unhandledRejection', (reason, promise) => {
  console.error('[RunDynamicMarketOps] Unhandled Rejection:', reason);
  if (timeoutHandle) clearTimeout(timeoutHandle);
  process.exit(1);
});

process.on('uncaughtException', (error) => {
  console.error('[RunDynamicMarketOps] Uncaught Exception:', error);
  if (timeoutHandle) clearTimeout(timeoutHandle);
  process.exit(1);
});

// Start execution
main();
