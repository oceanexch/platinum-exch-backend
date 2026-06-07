#!/usr/bin/env node

/**
 * Update Market Time Settings Script
 *
 * Default: Sets market start time to +3 mins, market end time to +15 mins
 * With --reverse: Sets market end time to +2 mins, market start time to +13 mins
 *
 * Usage:
 *   node updateTimeSettings.js              (normal mode)
 *   node updateTimeSettings.js --reverse    (reverse mode: close first, then start)
 */

require('dotenv').config();
const mongoose = require('mongoose');
const TimeSetting = require('../src/models/TimeSettingModel');

const MONGODB_URI = process.env.MONGODB_URI || process.env.DATABASE_URL;

// Check for --reverse flag
const isReverseMode = process.argv.includes('--reverse');

// Format time as HH:MM:SS
const formatTime = (date) => {
  const hours = String(date.getHours()).padStart(2, '0');
  const minutes = String(date.getMinutes()).padStart(2, '0');
  const seconds = String(date.getSeconds()).padStart(2, '0');
  return `${hours}:${minutes}:${seconds}`;
};

const main = async () => {
  try {
    // Connect to MongoDB
    if (!MONGODB_URI) {
      throw new Error('MONGODB_URI or DATABASE_URL not found in environment variables');
    }

    console.log('[TimeSettingsUpdate] Connecting to MongoDB...');
    await mongoose.connect(MONGODB_URI, {
      serverSelectionTimeoutMS: 10000,
      socketTimeoutMS: 60000,
      maxPoolSize: 5,
      minPoolSize: 1,
    });
    console.log('[TimeSettingsUpdate] ✓ Connected to MongoDB');

    // Get current time
    const now = new Date();
    console.log(`[TimeSettingsUpdate] Current time: ${formatTime(now)}`);
    console.log(`[TimeSettingsUpdate] Mode: ${isReverseMode ? 'REVERSE' : 'NORMAL'}`);

    // Calculate new times based on mode
    let marketStartTime, marketEndTime, startMsg, endMsg;

    if (isReverseMode) {
      // Reverse mode: close first (2 mins), then start 15 mins later (17 mins)
      marketEndTime = new Date(now.getTime() + 2 * 60 * 1000);    // +2 minutes (close)
      marketStartTime = new Date(now.getTime() + 17 * 60 * 1000); // +17 minutes (start = close + 15)
      startMsg = `in 17 minutes`;
      endMsg = `in 2 minutes`;
    } else {
      // Normal mode: start early (3 mins), close 15 mins later (18 mins)
      marketStartTime = new Date(now.getTime() + 3 * 60 * 1000);  // +3 minutes (start)
      marketEndTime = new Date(now.getTime() + 18 * 60 * 1000);   // +18 minutes (close = start + 15)
      startMsg = `in 3 minutes`;
      endMsg = `in 18 minutes`;
    }

    const startTimeStr = formatTime(marketStartTime);
    const endTimeStr = formatTime(marketEndTime);

    console.log(`[TimeSettingsUpdate] New start time: ${startTimeStr} (${startMsg})`);
    console.log(`[TimeSettingsUpdate] New end time:   ${endTimeStr} (${endMsg})`);

    // Update all market time settings
    const result = await TimeSetting.updateMany(
      {}, // Match all documents
      {
        $set: {
          marketStartTime: startTimeStr,
          marketEndTime: endTimeStr,
        },
      }
    );

    console.log(`[TimeSettingsUpdate] ✓ Updated ${result.modifiedCount} time settings`);
    console.log(`[TimeSettingsUpdate] Matched ${result.matchedCount} documents`);

    // Fetch and display updated settings
    const updated = await TimeSetting.find({}).select('marketId marketName marketStartTime marketEndTime').lean();

    console.log(`\n[TimeSettingsUpdate] Updated settings (${isReverseMode ? 'REVERSE MODE' : 'NORMAL MODE'}):\n`);
    updated.forEach(setting => {
      console.log(`  ${setting.marketName} (${setting.marketId})`);
      if (isReverseMode) {
        console.log(`    Close (End):   ${setting.marketEndTime}`);
        console.log(`    Start (Open):  ${setting.marketStartTime}`);
      } else {
        console.log(`    Start (Open):  ${setting.marketStartTime}`);
        console.log(`    Close (End):   ${setting.marketEndTime}`);
      }
    });

    console.log(`\n[TimeSettingsUpdate] ✓ All time settings updated successfully`);
    process.exit(0);
  } catch (error) {
    console.error('[TimeSettingsUpdate] ✗ Fatal error:', error.message);
    console.error(error.stack);
    process.exit(1);
  }
};

main();
