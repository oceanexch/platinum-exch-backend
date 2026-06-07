#!/usr/bin/env node
/**
 * ─────────────────────────────────────────────────────────────────────────────
 * 🔄 Weekly Limit Reset - Standalone Runner
 * ─────────────────────────────────────────────────────────────────────────────
 * Run manually: node runWeeklyLimitReset.js
 * Import in code: const { runWeeklyLimitReset } = require('./runWeeklyLimitReset');
 * 
 * This script restores weekly limit overrides to their original values.
 * Typically scheduled to run every Monday at 00:00 via cron.
 * ─────────────────────────────────────────────────────────────────────────────
 */

require('dotenv').config();
const mongoose = require('mongoose');
const { resetWeeklyLimitOverrides } = require('./src/cron/weeklyLimitResetCron');

/**
 * Main function to run the weekly limit reset
 * Can be called programmatically or from command line
 * @param {Object} options - Configuration options
 * @param {boolean} options.silent - If true, suppress console output
 * @param {boolean} options.exitOnComplete - If true, exit process when done (default: true for CLI, false for import)
 * @returns {Promise<Object>} Result object with success status and message
 */
async function runWeeklyLimitReset(options = {}) {
  const { silent = false, exitOnComplete = false } = options;
  
  const log = (...args) => !silent && console.log(...args);
  const error = (...args) => !silent && console.error(...args);
  
  log('═'.repeat(70));
  log('🔄 Weekly Limit Reset Script');
  log('═'.repeat(70));
  log(`Started at: ${new Date().toISOString()}`);
  log('');

  try {
    // Check if MongoDB is already connected
    const isConnected = mongoose.connection.readyState === 1;
    
    if (!isConnected) {
      log('Connecting to MongoDB...');
      await mongoose.connect(process.env.MONGODB_URI);
      log('✅ MongoDB connected');
      log('');
    } else {
      log('✅ Using existing MongoDB connection');
      log('');
    }
    
    // Run the reset function
    await resetWeeklyLimitOverrides();
    
    log('');
    log('═'.repeat(70));
    log('✅ Weekly limit reset completed successfully');
    log(`Finished at: ${new Date().toISOString()}`);
    log('═'.repeat(70));
    
    if (exitOnComplete) {
      process.exit(0);
    }
    
    return { success: true, message: 'Weekly limit reset completed successfully' };
    
  } catch (err) {
    error('');
    error('═'.repeat(70));
    error('❌ Weekly limit reset failed');
    error('Error:', err.message);
    error('Stack:', err.stack);
    error('═'.repeat(70));
    
    if (exitOnComplete) {
      process.exit(1);
    }
    
    return { success: false, message: err.message, error: err };
  }
}

// Export for programmatic use
module.exports = { runWeeklyLimitReset };

// Run directly if this file is executed (not imported)
if (require.main === module) {
  // Handle unexpected errors
  process.on('unhandledRejection', (err) => {
    console.error('');
    console.error('❌ Unhandled Promise Rejection:');
    console.error(err);
    process.exit(1);
  });

  process.on('uncaughtException', (err) => {
    console.error('');
    console.error('❌ Uncaught Exception:');
    console.error(err);
    process.exit(1);
  });

  // Run with CLI options
  runWeeklyLimitReset({ exitOnComplete: true }).catch((err) => {
    console.error('❌ MongoDB connection failed');
    console.error('Error:', err.message);
    console.error('');
    console.error('Please check:');
    console.error('  1. MONGODB_URI is set in .env file');
    console.error('  2. MongoDB server is running');
    console.error('  3. Network connectivity to MongoDB');
    console.error('');
    process.exit(1);
  });
}
