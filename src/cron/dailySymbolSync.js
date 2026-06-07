const fs = require('fs');
const path = require('path');
const cron = require('node-cron');
const mongoose = require('mongoose');
const { MarketType, Script } = require('../models/MarketTypeModel');
const ExpiryModel = require('../models/ExpiryModel');
const moment = require('moment');
const RedisService = require('../services/RedisService');
const LotSetting = require('../models/LotSettingModel');
const axios = require('axios');
const User = require('../models/UserModel');
;
const BhavCopy
 = require('../models/BhavCopyModel');
require('dotenv').config();

const { MARKET_IDS, MARKET_NAMES, MARKET_ORDER, ALLOWED_MCX_SCRIPTS } = require('../config/marketConstants');
const { refreshMarketCache } = require('../services/ScriptService');
const API_BASE_URL = process.env.NEW_API_URL || `https://feed.apollo.in.net/test/api`;
const AUTH_TOKEN = process.env.NEW_API_TOKEN || '96e38803-3bf0-45fd-b0bc-49c1c3208b8a';
console.log("Url :", API_BASE_URL);
const syncSymbolsFromFile = async () => {
    console.log('Starting Symbol Sync from live API...');
    try {
        console.log('Fetching symbol data from live API...');
        console.log(`${API_BASE_URL}/symbol-info`);
        const response = await axios.get(`${API_BASE_URL}/symbol-info`, {
            headers: {
                Authorization: `Bearer ${AUTH_TOKEN}`
            },
            timeout: 60000
        });

        const apiData = response.data?.data || response.data || [];

        if (!Array.isArray(apiData)) {
            console.error('Invalid data format from /symbol-info API');
            return;
        }
        // Apply COMEX transformation: remove CMX and add -USD
        apiData.forEach(item => {
            if (item.exchange && item.exchange.toUpperCase() === 'COMEX') {
                if (item.name && item.name.toUpperCase().endsWith('CMX')) {
                    item.name = item.name.substring(0, item.name.length - 3) + '-USD';
                }

            }
        });

        console.log(`Fetched ${apiData.length} symbols from API`);

        // -------------------------------------------------------------
        // PRE-CALCULATION: Filter Expiries Logic
        // -------------------------------------------------------------
        const scriptExpiriesMap = {}; // Key: Name_Exchange -> Set of dates
        apiData.forEach(item => {
            if (item.name && item.expiry) {
                const name = item.name.toUpperCase();
                const exchange = (item.exchange || 'OTHERS').toUpperCase();
                // Map exchange for consistency with main loop (though raw exchange is safer for uniqueness here)
                // We'll use raw item.exchange to distinguish NFUT vs NSE

                // Composite key to separate Futures (NFUT) from Options (NSE)
                const key = `${name}_${exchange}`;

                const expDate = moment(item.expiry).format('YYYY-MM-DD');
                if (!scriptExpiriesMap[key]) scriptExpiriesMap[key] = new Set();
                scriptExpiriesMap[key].add(expDate);
            }
        });

        const allowedExpiriesMap = {};
        const todayStr = moment().format('YYYY-MM-DD');

        Object.keys(scriptExpiriesMap).forEach(key => {
            const dates = Array.from(scriptExpiriesMap[key]).sort((a, b) => moment(a).valueOf() - moment(b).valueOf());

            // If only one expiry exists, allow it
            if (dates.length <= 1) {
                allowedExpiriesMap[key] = new Set(dates);
                return;
            }

            const isTodayExpiry = dates.includes(todayStr);
            const isMcx = key.toUpperCase().endsWith('_MCX');
            const futureDates = dates.filter(d => moment(d).isSameOrAfter(todayStr));

            // Special Case: NIFTY/BANKNIFTY Options (NOPT) - Filter exactly one Weekly and one Monthly
            const isNiftyBankNiftyNopt = (key === 'NIFTY_NOPT' || key === 'BANKNIFTY_NOPT');

            if (isNiftyBankNiftyNopt && futureDates.length > 0) {
                // futureDates  = dates >= today  (today-inclusive), sorted ascending
                // strictFuture = dates strictly after today
                const strictFuture = futureDates.filter(d => moment(d).isAfter(todayStr));

                // Helper: find the monthly expiry in a given pool
                // Monthly = first date where the NEXT Thursday (7 days later) falls in a different month
                const findMonthly = (pool) => pool.find(d => {
                    const next = moment(d).add(7, 'days');
                    return next.month() !== moment(d).month();
                });

                // ── Weekly ──────────────────────────────────────────────────
                const weekly = futureDates[0];     // nearest (could be today)
                const nextWeekly = strictFuture[1] || strictFuture[0];    // NEXT weekly after current

                // ── Monthly ─────────────────────────────────────────────────
                const monthly = findMonthly(futureDates);   // current (could be today)
                // Find next monthly AFTER the current monthly
                const monthlyIndex = futureDates.indexOf(monthly);
                const nextMonthly = monthlyIndex >= 0 ? findMonthly(futureDates.slice(monthlyIndex + 1)) : null;

                // ── Same rule for BOTH ───────────────────────────────────────
                // Always add current expiry
                // If expiry day OR 1 day before → also add the NEXT one of that type
                const allowedSet = new Set();

                const daysToWeekly = weekly ? moment(weekly).diff(moment(todayStr), 'days') : 999;
                const daysToMonthly = monthly ? moment(monthly).diff(moment(todayStr), 'days') : 999;

                if (weekly) allowedSet.add(weekly);
                // Open next weekly if current weekly expires today or tomorrow
                if (daysToWeekly <= 1 && nextWeekly) allowedSet.add(nextWeekly);

                if (monthly) allowedSet.add(monthly);
                // Open next monthly if current monthly expires today or tomorrow
                if (daysToMonthly <= 1 && nextMonthly) allowedSet.add(nextMonthly);

                allowedExpiriesMap[key] = allowedSet;
                console.log(`[FILTER] ${key}: Weekly=${weekly || 'None'} (${daysToWeekly}d), Monthly=${monthly || 'None'} (${daysToMonthly}d), NextWeekly=${nextWeekly || 'None'}, NextMonthly=${nextMonthly || 'None'}, Allowed=[${[...allowedSet].join(', ')}]`);
            } else {
                // Default Logic for other scripts/markets
                const daysToExpiry = futureDates.length > 0 ? moment(futureDates[0]).startOf('day').diff(moment(todayStr).startOf('day'), 'days') : -1;
                const isNoptNfutNse = key.toUpperCase().endsWith('_NOPT') || key.toUpperCase().endsWith('_NFUT') || key.toUpperCase().endsWith('_NSE');

                if (isTodayExpiry || (daysToExpiry > 0 && daysToExpiry <= 3)) {
                    // If today is expiry (or near it), open next expiry too
                    if (isMcx) {
                        allowedExpiriesMap[key] = new Set(futureDates.slice(0, 2));
                    } else if (isNoptNfutNse) {
                        allowedExpiriesMap[key] = new Set(futureDates.slice(0, 2));
                    } else {
                        allowedExpiriesMap[key] = new Set(futureDates.slice(0, 2));
                    }
                } else {
                    // Keep only the NEAREST future expiry, unless it's an active market
                    if (isNoptNfutNse) {
                        allowedExpiriesMap[key] = new Set(futureDates.slice(0, 2));
                    } else if (futureDates.length > 0) {
                        allowedExpiriesMap[key] = new Set([futureDates[0]]);
                    } else {
                        allowedExpiriesMap[key] = new Set();
                    }
                }
            }
        });
        console.log("Expiry Filtering Rules Applied (Grouped by Script+Exchange).");
        // -------------------------------------------------------------

        // -------------------------------------------------------------
        // PRE-SYNC: Capture existing decimal settings to carry forward
        // -------------------------------------------------------------
        const existingScripts = await Script.find({}, { script_name: 1, dacimal: 1 }).lean();
        const decimalMap = {};
        existingScripts.forEach(s => {
            if (s.script_name) decimalMap[s.script_name.toUpperCase()] = s.dacimal;
        });
        console.log(`Captured decimal settings for ${Object.keys(decimalMap).length} unique script names.`);

        // -------------------------------------------------------------
        // FETCH LATEST CLOSING PRICES FROM BHAVCOPY (newest record per InstrumentIdentifier)
        // -------------------------------------------------------------
        console.log('Fetching latest closing prices from BhavCopy (newest record per InstrumentIdentifier)...');

        // Fetch all BhavCopy records grouped by scriptId, then pick the best closing price.
        // Priority per scriptId:
        //   1. Sunday's record   (dayOfWeek === 0)
        //   2. Saturday's record (dayOfWeek === 6)
        //   3. Most recent record (fallback)
        // BhavCopy.scriptId matches item.symbol from the API (e.g. "ALUMINIUM26MAYFUT")
        const bhavCopyAgg = await BhavCopy.aggregate([
            { $match: { scriptId: { $exists: true, $ne: null } } },
            { $sort: { createdAt: -1 } }, // newest first so $first gives latest as fallback
            {
                $group: {
                    _id: { $toUpper: '$scriptId' },
                    // Collect all records (capped — we only need a handful per script)
                    records: {
                        $push: {
                            closingPrice: '$closingPrice',
                            createdAt: '$createdAt'
                        }
                    }
                }
            }
        ]);

        console.log(`Found ${bhavCopyAgg.length} unique scriptIds in BhavCopy.`);

        // Pick the best closing price per scriptId based on priority: Sunday > Saturday > latest
        const bhavCopyMap = {};
        bhavCopyAgg.forEach(entry => {
            if (!entry._id || !entry.records.length) return;

            let sundayRecord   = null;
            let saturdayRecord = null;
            let latestRecord   = entry.records[0]; // already sorted newest-first

            for (const rec of entry.records) {
                if (!rec.createdAt) continue;
                const dow = new Date(rec.createdAt).getDay(); // 0=Sun, 6=Sat
                if (dow === 0 && !sundayRecord)   sundayRecord   = rec;
                if (dow === 6 && !saturdayRecord) saturdayRecord = rec;
                if (sundayRecord && saturdayRecord) break; // found both, stop early
            }

            const chosen = sundayRecord || saturdayRecord || latestRecord;
            if (chosen && chosen.closingPrice !== undefined && chosen.closingPrice !== null) {
                bhavCopyMap[entry._id] = parseFloat(chosen.closingPrice.toFixed(2));
            }
        });

        console.log(`Built BhavCopy map for ${Object.keys(bhavCopyMap).length} unique scriptIds.`);

        // Log first few records for debugging
        if (bhavCopyAgg.length > 0) {
            console.log('Sample BhavCopy records (priority: Sunday > Saturday > latest):');
            bhavCopyAgg.slice(0, 3).forEach(entry => {
                const val = bhavCopyMap[entry._id];
                console.log(`  - scriptId: ${entry._id}, chosenClosingPrice: ${val ? val[0] : 'N/A'}`);
            });
        }

        // Log first few mapped entries for debugging
        if (Object.keys(bhavCopyMap).length > 0) {
            console.log('Sample BhavCopy map entries (scriptId -> closingPrice):');
            Object.keys(bhavCopyMap).slice(0, 5).forEach(key => {
                console.log(`  - ${key}: ${bhavCopyMap[key][0]}`);
            });
        }

        // NOW Clear Collections - only after we have valid data from API
        console.log('Clearing existing data...');
        await MarketType.deleteMany({});
        await Script.deleteMany({});
        await ExpiryModel.deleteMany({});
        // await LotSetting.deleteMany({}); // LotSettings are now managed via refreshLotSettings endpoint/script
        console.log('Existing data cleared. Starting fresh insert...');

        // 3. Dynamic Market Discovery and Grouping
        const marketGroups = {};
        const exchangeToMarketInfo = {};
        const scriptsMap = {}; // Key: name_strike_type_marketId -> Script doc pointer
        const marketExpiryDedup = {}; // Track unique expiry dates for NSE-FO (market 2) ALL/ALL docs

        // Find existing IDs to avoid conflicts
        const usedIds = new Set(Object.values(MARKET_IDS).map(v => parseInt(v)).filter(v => !isNaN(v)));
        let nextDynamicId = 1;

        for (const item of apiData) {
            // Apply Expiry Filter
            if (item.expiry) {
                const fName = (item.name || '').toUpperCase();
                const fExchange = (item.exchange || 'OTHERS').toUpperCase();
                const fDate = moment(item.expiry).format('YYYY-MM-DD');
                // Construct the same composite key
                const key = `${fName}_${fExchange}`;

                if (allowedExpiriesMap[key] && !allowedExpiriesMap[key].has(fDate)) {
                    continue; // Skip this expiry as it's not the allowed one(s)
                }
            }

            const itemName = (item.name || '').toUpperCase();
            const strike = Number(item.strike) || 0;

            let exchangeKey = (item.exchange || 'OTHERS').toUpperCase();

            // MCX Filter: Only allow specific MCX scripts
            if (exchangeKey === 'MCX' && !ALLOWED_MCX_SCRIPTS.includes(itemName)) {
                // console.log(`[DEBUG] Skipping MCX item ${itemName} as it's not in ALLOWED_MCX_SCRIPTS`);
                continue;
            }


            let targetExchangeKeys = [exchangeKey];

            // Custom mapping rules for INDEX market
            if (itemName === 'SENSEX') {
                targetExchangeKeys = ['NFUT']; // Force SENSEX to INDEX market
            } else if ((itemName === 'BANKNIFTY' || itemName === 'NIFTY') && (exchangeKey === 'NFUT' || exchangeKey === 'NSE') && strike === 0 && item.expiry) {
                // NIFTY/BANKNIFTY Futures (Strike 0 + Expiry) go to both INDEX (NFUT) and NOPT (NOPT)
                targetExchangeKeys = ['NFUT', 'NOPT'];
            } else if (exchangeKey === 'NFUT' || exchangeKey === 'NSE') {
                // Categorize based on presence of expiry
                if (!item.expiry) {
                    targetExchangeKeys = ['NSE_EQ']; // Scripts without expiry go to NSE-EQ (ID 12)
                } else {
                    targetExchangeKeys = ['NSE'];    // Scripts with expiry go to NSE (ID 2)
                }
            } else if (itemName.includes('DOWJONES') || itemName.includes('GIFTNIFTY') || itemName.includes('S&P') || itemName.includes('SPX') || itemName.includes('S AND P') || itemName.includes('NASDAQ') || itemName.includes('GLOBAL')) {
                // Specific global indices go to GLOBAL market
                targetExchangeKeys = ['GLOBAL'];
            } else if (exchangeKey === 'GLOBAL' || exchangeKey === 'FOREX' || exchangeKey === 'FX' || exchangeKey === 'LMAX') {
                // Other global items go to FOREX
                targetExchangeKeys = ['FOREX'];
            } else if (exchangeKey === 'NOPT') {
                // Logic handled inside loop below
                targetExchangeKeys = ['NOPT'];
            }

            for (const currentKey of targetExchangeKeys) {
                if (currentKey === 'NOPT') {
                    // Only keep NIFTY and BANKNIFTY for NOPT, discard others
                    if (itemName !== 'BANKNIFTY' && itemName !== 'NIFTY') {
                        continue;
                    }
                }

                const rawExchange = exchangeToMarketInfo[currentKey]?.name || item.exchange || 'OTHERS';

                if (!exchangeToMarketInfo[currentKey]) {
                    let mId = MARKET_IDS[currentKey];
                    let mName = item.exchange || 'OTHERS';
                    let mOrder = 99;

                    if (mId) {
                        mName = MARKET_NAMES[mId] || mName;
                        mOrder = MARKET_ORDER[mId] || 99;
                    } else {
                        // Find next available ID
                        while (usedIds.has(nextDynamicId)) {
                            nextDynamicId++;
                        }
                        mId = nextDynamicId.toString();
                        usedIds.add(nextDynamicId);
                        mName = rawExchange;
                        mOrder = 100 + nextDynamicId;
                    }
                    exchangeToMarketInfo[currentKey] = {
                        id: mId,
                        name: mName,
                        // Always derive order from MARKET_ORDER constant; fallback to dynamic
                        order: (mId && MARKET_ORDER[mId] ? MARKET_ORDER[mId] : (100 + parseInt(mId || nextDynamicId))).toString()
                    };
                }

                const { id: marketId, name: marketName, order: marketOrder } = exchangeToMarketInfo[currentKey];

                if (!marketGroups[marketId]) {
                    marketGroups[marketId] = {
                        meta: { id: marketId, name: marketName, order: marketOrder },
                        scripts: [],
                        expiryDocs: [],
                        // lotSettingDocs: [] // LotSettings managed separately
                    };
                }

                // Grouping key: Name + Strike + InstrumentType + MarketId
                // We combine different expiries of the same contract into one document
                const scriptKey = `${item.name}_${strike}_${item.instrument_type}_${marketId}`;
                let scriptData = scriptsMap[scriptKey];

                if (!scriptData) {
                    // Use the first symbol found as the primary script_id to allow real-time price lookup
                    const primaryScriptId = item.symbol;

                    // Find matching BhavCopy closing price by scriptId (priority: Sunday > Saturday > latest)
                    const lastWeekClosing = bhavCopyMap[primaryScriptId?.toUpperCase()] ?? 0;
                    
                    // Debug log for first few scripts
               
                    scriptData = {
                        script_name: itemName.trim(), // Use normalized uppercase itemName
                        script_id: primaryScriptId,
                        market_type_id: marketId,
                        symbol: primaryScriptId,
                        last_price: item.last_price || 0,
                        closing_price: item.closing_price || 0,
                        lot_size: item.lot_size || 1,
                        tick_size: item.tick_size || 0.05,
                        instrument_type: item.instrument_type,
                        option_type: item.instrument_type === 'CE' ? 'CE' : (item.instrument_type === 'PE' ? 'PE' : 'FUT'),
                        strike: strike,
                        exchange: item.exchange,
                        dacimal: decimalMap[itemName] !== undefined ? decimalMap[itemName] : true,
                        lastWeekClosing: lastWeekClosing,
                        expiry: []
                    };
                    scriptsMap[scriptKey] = scriptData;
                    marketGroups[marketId].scripts.push(scriptData);
                }

                // Prevent duplicates in expiry array
                const exists = scriptData.expiry.some(e => e.symbol === item.symbol);
                if (!exists) {
                    if (item.expiry) {
                        scriptData.expiry.push({
                            script_expiry_id: item.symbol,
                            script_id: item.symbol,
                            expiry_date: item.actual_expiry || item.expiry || 'NA',
                            tradeEndDate: item.tradeEndDate || item.expiry || "NA",
                            script_expiry_type: item.instrument_type || '',
                            script_data_key: "",
                            script_lot_qty: item.lot_size || null,
                            expiry_date_orginal: item.actual_expiry || item.expiry || 'NA',
                            symbol: item.symbol
                        });
                    }

                    // LotSettings are now managed via refreshLotSettings endpoint/script — not inserted here
                    if (item.expiry) {
                        const formattedExpiry = moment(item.expiry).format('YYYY-MM-DD');

                        // Market 2 (NSE-FO): keep one shared ALL/ALL expiry doc per unique date
                        // Market 3 (NOPT) and all others: per-script expiry doc so every opened expiry is recorded
                        const isNseFoMarket = (marketId === MARKET_IDS.NSE);

                        if (isNseFoMarket) {
                            if (!marketExpiryDedup[marketId]) marketExpiryDedup[marketId] = new Set();
                            const dedupKey = `${marketId}_${formattedExpiry}`;
                            if (!marketExpiryDedup[marketId].has(dedupKey)) {
                                marketExpiryDedup[marketId].add(dedupKey);
                                marketGroups[marketId].expiryDocs.push({
                                    marketId: marketId,
                                    marketName: marketName,
                                    scriptId: 'ALL',
                                    scriptName: 'ALL',
                                    tradeStartDate: moment().format('YYYY-MM-DD'),
                                    tradeEndDate: formattedExpiry,
                                    expiryDate: formattedExpiry,
                                    actualExpiry: item.actual_expiry || item.expiry,
                                    ip: "auto"
                                });
                            }
                        } else if (marketId === '3') {
                            // NOPT (market 3): Deduplicate per scriptName (e.g. NIFTY)
                            // Use script name as scriptId to satisfy the unique index (marketId_1_scriptId_1_expiryDate_1)
                            // while still keeping the expiry count low.
                            if (!marketExpiryDedup[marketId]) marketExpiryDedup[marketId] = new Set();
                            const dedupKey = `${marketId}_${item.name}_${formattedExpiry}`;
                            if (!marketExpiryDedup[marketId].has(dedupKey)) {
                                marketExpiryDedup[marketId].add(dedupKey);
                                marketGroups[marketId].expiryDocs.push({
                                    marketId: marketId,
                                    marketName: marketName,
                                    scriptId: item.name,
                                    scriptName: item.name,
                                    tradeStartDate: moment().format('YYYY-MM-DD'),
                                    tradeEndDate: formattedExpiry,
                                    expiryDate: formattedExpiry,
                                    actualExpiry: item.actual_expiry || item.expiry,
                                    ip: "auto"
                                });
                            }
                        } else {
                            // All other markets: real scriptId/scriptName per expiry (per-contract)
                            marketGroups[marketId].expiryDocs.push({
                                marketId: marketId,
                                marketName: marketName,
                                scriptId: scriptData.script_id,
                                scriptName: item.name,
                                tradeStartDate: moment().format('YYYY-MM-DD'),
                                tradeEndDate: formattedExpiry,
                                expiryDate: formattedExpiry,
                                actualExpiry: item.actual_expiry || item.expiry,
                                ip: "auto"
                            });
                        }
                    }
                }
            }
        }

        // 4. Save to Database — iterate in canonical MARKET_ORDER
        let totalScriptsCount = 0;
        const sortedMarketIds = Object.keys(marketGroups).sort((a, b) => {
            const oa = MARKET_ORDER[a] ?? 999;
            const ob = MARKET_ORDER[b] ?? 999;
            return oa - ob;
        });
        for (const marketId of sortedMarketIds) {
            const group = marketGroups[marketId];
            const marketName = group.meta.name;
            // Always use canonical order from MARKET_ORDER constant
            const marketOrder = (MARKET_ORDER[marketId] ?? parseInt(group.meta.order) ?? 99).toString();


            // Batch insert Scripts
            const savedScripts = await Script.insertMany(group.scripts);
            totalScriptsCount += savedScripts.length;

            // Batch insert ExpiryModel
            if (group.expiryDocs.length > 0) {
                await ExpiryModel.insertMany(group.expiryDocs);
            }

            // LotSettings are now managed via refreshLotSettings endpoint/script — not inserted here

            // Create/Save MarketType doc
            const scriptObjectIds = savedScripts.map(s => s._id);
            const marketDoc = new MarketType({
                market_type_name: marketName,
                name: marketName,
                market_type_id: marketId,
                id: marketId,
                selected: false,
                order: marketOrder,
                scripts: scriptObjectIds
            });
            await marketDoc.save();
        }

        // 5. Post-sync Refresh: Update Redis cache sequentially for all markets
        console.log('Refreshing market caches in Redis...');
        for (const marketId of sortedMarketIds) {
            try {
                await refreshMarketCache(marketId);
            } catch (err) {
                console.error(`Error refreshing cache for market ID ${marketId}:`, err);
            }
        }

        console.log(`Sync complete! Total Scripts saved: ${totalScriptsCount}`);

        // 5. Store symbols in Redis
        const expirySymbols = [];
        for (const marketId of sortedMarketIds) {

            const group = marketGroups[marketId];

            for (const script of group.scripts) {
                if (marketId == "12") {
                    expirySymbols.push(script.script_id);
                }
                if (script.expiry && Array.isArray(script.expiry)) {
                    for (const exp of script.expiry) {
                        if (exp.script_id) {
                            expirySymbols.push(exp.script_id);
                        }
                    }
                }
            }
        }

        if (expirySymbols.length > 0) {
            await RedisService.setData('symbols', JSON.stringify(expirySymbols));
            console.log(`Stored ${expirySymbols.length} expiry symbols in Redis (reduced from ${apiData.length} total symbols).`);
            console.log("expirySymbols",expirySymbols);
        }

        // 6. Reconnect WebSocket with updated symbols (FAST - no full reconnect)
        console.log('🔄 Triggering WebSocket resubscription with updated symbols...');
        try {
            const SymbolManagementService = require('../services/SymbolManagementService');
            const resubscribed = await SymbolManagementService.refreshAllSymbolsAndResubscribe();
            
            if (resubscribed) {
                console.log('✓ WebSocket resubscribed successfully with new symbols');
            } else {
                console.warn('⚠️ WebSocket resubscription failed - will auto-reconnect on next cycle');
            }
        } catch (err) {
            console.error('❌ Error during WebSocket resubscription:', err.message);
        }

        // 6. Update Super Admin Market Access
        // console.log('Updating Super Admin market access...');
        // const superAdmin = await User.findOne({ accountCode: '649688' });
        // if (superAdmin) {
        //     const allMarkets = await MarketType.find({}).lean();
        //     let updated = false;

        //     for (const m of allMarkets) {
        //         const existingIndex = superAdmin.marketAccess.findIndex(ma => ma.marketId === m.market_type_id);
        //         if (existingIndex === -1) {
        //             // Add new market access with default settings
        //             superAdmin.marketAccess.push({
        //                 marketId: m.market_type_id,
        //                 marketName: m.name,
        //                 isSelected: true,
        //                 brokerage: {
        //                     minPercentageWiseBrokerage: "",
        //                     minScriptRate: "",
        //                     minLotWiseBrokerage: "",
        //                     type: "",
        //                     deliveryCommission: "",
        //                     intradayCommission: "",
        //                     scriptWiseBrokerage: [{ script: "", deliveryCommission: "", intradayCommission: "" }]
        //                 },
        //                 margin: {
        //                     lotOrAmount: "lot",
        //                     totalLotWise: 10000,
        //                     totalMargin: 10000000000,
        //                     maximumLimit: 10000000000
        //                 },
        //                 other: {
        //                     allowOrBlock: "allow",
        //                     allowScript: [""],
        //                     blockScript: [""],
        //                     minRateScriptBlock: "",
        //                     scriptCount: "",
        //                     shortSellAllowed: "",
        //                     freshLimitAllowed: 0,
        //                     orderBetweenHighLowDisabled: 0
        //                 }
        //             });
        //             updated = true;
        //             console.log(`Added market ${m.name} (ID: ${m.market_type_id}) to Super Admin.`);
        //         } else {
        //             // Update name if mismatch
        //             if (superAdmin.marketAccess[existingIndex].marketName !== m.name) {
        //                 superAdmin.marketAccess[existingIndex].marketName = m.name;
        //                 updated = true;
        //                 console.log(`Updated market name to ${m.name} for ID ${m.market_type_id} in Super Admin.`);
        //             }
        //         }
        //     }

        //     if (updated) {
        //         superAdmin.markModified('marketAccess');
        //         await superAdmin.save();
        //         console.log('Super Admin market access updated successfully.');
        //     }
        // } else {
        //     console.log('Super Admin user (649688) not found.');
        // }

    } catch (error) {
        console.error('Error during symbol sync:', error);
    }
};
// Load env vars if running directly
if (require.main === module) {
    const dotenv = require('dotenv');
    dotenv.config({ path: path.join(__dirname, '..', '..', '.env') });
}

const connectDB = require('../config/database');

// syncSymbolsFromFile(); // Removed auto-run
// Schedule: Twice a day at 8:45 AM and 11:45 AM
cron.schedule('45 8 * * *', () => {
    syncSymbolsFromFile();
});

if (require.main === module) {
    (async () => {
        try {
            await connectDB();
            console.log('Starting symbol sync...');
            await syncSymbolsFromFile();
            console.log('Symbol sync completed successfully!');
            process.exit(0);
        } catch (error) {
            console.error('Symbol sync failed:', error);
            process.exit(1);
        }
    })();
}

module.exports = { syncSymbolsFromFile };
