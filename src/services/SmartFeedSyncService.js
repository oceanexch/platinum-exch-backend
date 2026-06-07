const axios = require('axios');
const http = require('http');
const https = require('https');
const mongoose = require('mongoose');
const moment = require('moment');

// Force IPv4
const httpAgent = new http.Agent({ family: 4 });
const httpsAgent = new https.Agent({ family: 4 });
const { MarketType, Script } = require('../models/MarketTypeModel');
const ExpiryModel = require('../models/ExpiryModel');
const LotSetting = require('../models/LotSettingModel');
const RedisService = require('../services/RedisService');
const SmartFeedAuthService = require('../services/SmartFeedAuthService');
const { MARKET_IDS, MARKET_NAMES, MARKET_ORDER, ALLOWED_MCX_SCRIPTS } = require('../config/marketConstants');
const cron = require('node-cron');

const SMARTFEED_BASE_URL = process.env.SMARTFEED_BASE_URL || 'https://smartfeed.getlivefeed.xyz/api/v1';

/**
 * Service to sync symbols and markets from SmartFeed
 */
const syncSmartFeedSymbols = async () => {
    console.log('🚀 [SmartFeedSync] Starting Symbol Sync from SmartFeed API...');
    try {
        const token = await SmartFeedAuthService.getAccessToken();
        
        console.log('Fetching exchanges...');
        const exchangeResponse = await axios.get(`${SMARTFEED_BASE_URL}/Instrument/getExchanges`, {
            headers: { 
                'Authorization': `Bearer ${token}`,
                'Content-Type': 'application/json',
                'X-IP-Version': 'IPv4'
            },
            httpAgent,
            httpsAgent
        });

        if (!exchangeResponse.data.succeeded) {
            throw new Error('Failed to fetch exchanges');
        }

        const exchanges = exchangeResponse.data.data.map(e => e.exchangeName).join(',');
        console.log(`Exchanges found: ${exchanges}`);

        console.log('Fetching instrument list...');
        const instrumentResponse = await axios.post(`${SMARTFEED_BASE_URL}/Instrument/instrumentList`, 
            { exchanges },
            { 
                headers: { 
                    'Authorization': `Bearer ${token}`,
                    'Content-Type': 'application/json',
                    'X-IP-Version': 'IPv4'
                },
                httpAgent,
                httpsAgent
            }
        );

        const apiData = instrumentResponse.data?.data || [];
        if (!Array.isArray(apiData) || apiData.length === 0) {
            console.error('Invalid or empty data from instrumentList API');
            return;
        }

        console.log(`Fetched ${apiData.length} symbols from API`);

        console.log(`Fetched ${apiData.length} symbols from API`);

        // PRE-SYNC: Capture existing decimal settings to carry forward
        const existingScripts = await Script.find({}, { script_name: 1, dacimal: 1 }).lean();
        const decimalMap = {};
        existingScripts.forEach(s => {
            if (s.script_name) decimalMap[s.script_name.toUpperCase()] = s.dacimal;
        });
        console.log(`Captured decimal settings for ${Object.keys(decimalMap).length} unique script names.`);

        // 1. Clear Collections
        console.log('Clearing existing data...');
        await MarketType.deleteMany({});
        await Script.deleteMany({});
        await ExpiryModel.deleteMany({});
        await LotSetting.deleteMany({});

        const marketGroups = {};
        const exchangeToMarketInfo = {};
        const marketExpiryDedup = {}; // Track unique expiry dates for NSE/NOPT markets
        let nextDynamicId = 100; // Start dynamic IDs higher to avoid overlap

        // 2. Process Symbols
        for (const item of apiData) {
            const itemName = (item.name || '').toUpperCase();
            const exchangeKey = (item.exchange || 'OTHERS').toUpperCase();

            // MCX Filter
            if (exchangeKey === 'MCX' && !ALLOWED_MCX_SCRIPTS.includes(itemName)) {
                continue;
            }

            // Indices list
            const isIndex = [
                'NIFTY', 'BANKNIFTY', 'SENSEX', 'INDIAVIX', 
                'FINNIFTY', 'MIDCPNIFTY', 'NIFTYNXT50', 'NIFTY50'
            ].includes(itemName);
            const hasStrike = Number(item.strike) > 0;
            const hasExpiry = !!item.expiry;

            // Refined Sorting Logic based on User Requirements
            let targetMarketKeys = [];
            
            if (exchangeKey === 'MCX') {
                targetMarketKeys = ['MCX'];
            } else if (isIndex) {
                if (hasStrike) {
                    targetMarketKeys = ['NOPT']; // Index Options
                } else if (hasExpiry) {
                    targetMarketKeys = ['NFUT']; // Index Futures / Index Spot
                }
            } else {
                // Not an index (Stocks)
                if (hasExpiry) {
                    targetMarketKeys = ['NSE'];  // Stock F&O (Both FUT and OPT as per request)
                } else {
                    targetMarketKeys = ['NSE_EQ']; // Stock Cash
                }
            }

            for (const currentKey of targetMarketKeys) {
                if (!exchangeToMarketInfo[currentKey]) {
                    let mId = MARKET_IDS[currentKey];
                    let mName = MARKET_NAMES[mId] || currentKey;
                    let mOrder = MARKET_ORDER[mId] || 99;

                    if (!mId) {
                        mId = nextDynamicId.toString();
                        nextDynamicId++;
                        mOrder = 100 + parseInt(mId);
                    }

                    exchangeToMarketInfo[currentKey] = { id: mId, name: mName, order: mOrder.toString() };
                }

                const { id: marketId, name: marketName, order: marketOrder } = exchangeToMarketInfo[currentKey];

                if (!marketGroups[marketId]) {
                    marketGroups[marketId] = {
                        meta: { id: marketId, name: marketName, order: marketOrder },
                        scripts: [],
                        expiryDocs: [],
                        lotSettingDocs: []
                    };
                }

                // Refined Naming as requested by User:
                // script_name: Actual name of script (GOLD, NIFTY)
                // script_id & symbol: instrument_token (Ensures absolute mapping)
                const scriptData = {
                    script_name: item.name || itemName,
                    script_id: item.instrument_token,
                    market_type_id: marketId,
                    symbol: item.instrument_token,
                    last_price: item.last_price || 0,
                    closing_price: item.closing_price || 0,
                    lot_size: item.lot_size || 1,
                    tick_size: item.tick_size || 0.05,
                    instrument_type: item.instrument_type,
                    option_type: item.instrument_type === 'CE' ? 'CE' : (item.instrument_type === 'PE' ? 'PE' : 'FUT'),
                    strike: Number(item.strike) || 0,
                    exchange: item.exchange,
                    dacimal: decimalMap[itemName] !== undefined ? decimalMap[itemName] : true,
                    expiry: [
                        {
                            script_expiry_id: item.instrument_token,
                            script_id: item.instrument_token,
                            expiry_date: item.expiry || 'NA',
                            script_expiry_type: item.instrument_type || '',
                            script_data_key: "",
                            script_lot_qty: item.lot_size || null,
                            expiry_date_orginal: item.expiry || 'NA',
                            symbol: item.instrument_token
                        }
                    ]
                };

                marketGroups[marketId].scripts.push(scriptData);

                // Add LotSetting
                marketGroups[marketId].lotSettingDocs.push({
                    marketId: marketId,
                    marketName: marketName,
                    scriptId: item.instrument_token,
                    scriptName: item.name || itemName,
                    quantity: item.lot_size || 1,
                    createdBy: new mongoose.Types.ObjectId("000000000000000000000000")
                });

                // Add Expiry Doc
                if (item.expiry) {
                    const isSharedExpiryMarket = (marketId === MARKET_IDS.NSE || marketId === MARKET_IDS.NOPT);
                    const formattedExpiry = moment(item.expiry, "DD-MMM-YYYY").format('YYYY-MM-DD');

                    if (isSharedExpiryMarket) {
                        if (!marketExpiryDedup[marketId]) {
                            marketExpiryDedup[marketId] = new Set();
                        }
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
                                ip: "auto"
                            });
                        }
                    } else {
                        marketGroups[marketId].expiryDocs.push({
                            marketId: marketId,
                            marketName: marketName,
                            scriptId: item.instrument_token,
                            scriptName: item.name || itemName,
                            tradeStartDate: moment().format('YYYY-MM-DD'),
                            tradeEndDate: formattedExpiry,
                            expiryDate: formattedExpiry,
                            ip: "auto"
                        });
                    }
                }
            }
        }

        // 3. Save to Database
        let totalScriptsCount = 0;
        const sortedMarketIds = Object.keys(marketGroups).sort((a, b) => {
            const oa = MARKET_ORDER[a] ?? 999;
            const ob = MARKET_ORDER[b] ?? 999;
            return oa - ob;
        });

        for (const marketId of sortedMarketIds) {
            const group = marketGroups[marketId];
            
            const savedScripts = await Script.insertMany(group.scripts);
            totalScriptsCount += savedScripts.length;

            if (group.expiryDocs.length > 0) {
                await ExpiryModel.insertMany(group.expiryDocs);
            }

            if (group.lotSettingDocs.length > 0) {
                await LotSetting.insertMany(group.lotSettingDocs);
            }

            const marketDoc = new MarketType({
                market_type_name: group.meta.name,
                name: group.meta.name,
                market_type_id: marketId,
                id: marketId,
                order: group.meta.order,
                scripts: savedScripts.map(s => s._id)
            });
            await marketDoc.save();

            // Refresh market cache
            try {
                const { refreshMarketCache } = require('../services/ScriptService');
                await refreshMarketCache(marketId);
            } catch (e) {
                console.warn(`Could not refresh cache for market ${marketId}`);
            }
        }

        console.log(`✅ [SmartFeedSync] Sync complete! Total Scripts: ${totalScriptsCount}`);

        // 4. Store symbols in Redis for Polling Service
        const allTokens = apiData.map(item => item.instrument_token).filter(Boolean);
        if (allTokens.length > 0) {
            const allTokensStr = JSON.stringify(allTokens);
            await RedisService.setData('smartfeed_tokens', allTokensStr);
            await RedisService.setData('symbols', allTokensStr); // Support legacy code
            console.log(`Stored ${allTokens.length} instrument tokens in Redis.`);
        }

    } catch (error) {
        console.error('❌ [SmartFeedSync] Error during sync:', error.message);
    }
};

// Schedule: Once a day at 8 AM
cron.schedule('0 8 * * *', () => {
    syncSmartFeedSymbols();
});

module.exports = { syncSmartFeedSymbols };
