#!/usr/bin/env node

/**
 * Populate symbols in Redis from database
 * Use this if Redis symbols are empty or corrupted
 * 
 * Usage:
 *   node populateSymbols.js
 */

require('dotenv').config();
const mongoose = require('mongoose');
const RedisService = require('./src/services/RedisService');
const { Script } = require('./src/models/MarketTypeModel');

const MONGODB_URI = process.env.MONGODB_URI || process.env.DATABASE_URL;

const populateSymbols = async () => {
  try {
    console.log('[PopulateSymbols] Starting...');
    
    // Connect to MongoDB
    if (mongoose.connection.readyState !== 1) {
      console.log('[PopulateSymbols] Connecting to database...');
      await mongoose.connect(MONGODB_URI, {
        serverSelectionTimeoutMS: 10000,
        socketTimeoutMS: 60000,
      });
      console.log('[PopulateSymbols] ✓ Database connected');
    }

    // Fetch all scripts from database
    console.log('[PopulateSymbols] Fetching scripts from database...');
    const scripts = await Script.find({}).lean();
    console.log(`[PopulateSymbols] Found ${scripts.length} scripts in database`);

    // Extract all symbols
    const symbols = new Set();
    
    scripts.forEach(script => {
      // Add main script symbol (for NSE-EQ and other non-expiry scripts)
      if (script.script_id) {
        symbols.add(script.script_id);
      }

      // Add all expiry symbols
      if (script.expiry && Array.isArray(script.expiry)) {
        script.expiry.forEach(exp => {
          if (exp.script_id) {
            symbols.add(exp.script_id);
          }
        });
      }
    });

    const symbolArray = Array.from(symbols);
    console.log(`[PopulateSymbols] Extracted ${symbolArray.length} unique symbols`);

    // Store in Redis
    if (symbolArray.length > 0) {
      await RedisService.setData('symbols', JSON.stringify(symbolArray));
      console.log(`[PopulateSymbols] ✓ Stored ${symbolArray.length} symbols in Redis`);
      
      // Verify
      const stored = await RedisService.getData('symbols');
      const parsed = JSON.parse(stored);
      console.log(`[PopulateSymbols] ✓ Verified: ${parsed.length} symbols in Redis`);
      
      // Show sample
      console.log(`[PopulateSymbols] Sample symbols:`, parsed.slice(0, 10));
    } else {
      console.error('[PopulateSymbols] ✗ No symbols found in database!');
      process.exit(1);
    }

    console.log('[PopulateSymbols] ✓ Complete!');
    process.exit(0);
  } catch (error) {
    console.error('[PopulateSymbols] ✗ Error:', error.message);
    console.error(error.stack);
    process.exit(1);
  }
};

populateSymbols();
