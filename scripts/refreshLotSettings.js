#!/usr/bin/env node
/**
 * Standalone script to refresh LotSettings from the trading API.
 * Upserts by (marketId, scriptName) — never deletes existing entries.
 *
 * Usage:
 *   node scripts/refreshLotSettings.js
 */

require("dotenv").config();
const mongoose = require("mongoose");
const axios = require("axios");
const LotSetting = require("../src/models/LotSettingModel");
const { MARKET_IDS, MARKET_NAMES, ALLOWED_MCX_SCRIPTS } = require("../src/config/marketConstants");

const MONGODB_URI = process.env.MONGODB_URI || process.env.DATABASE_URL;
const API_BASE_URL = process.env.NEW_API_URL || "https://feed.apollo.in.net/test/api";
const AUTH_TOKEN = process.env.NEW_API_TOKEN || "96e38803-3bf0-45fd-b0bc-49c1c3208b8a";
const SYSTEM_USER = new mongoose.Types.ObjectId("000000000000000000000000");

function resolveMarketKeys(itemName, exchangeKey, item) {
  const strike = Number(item.strike) || 0;
  if (itemName === "SENSEX") return ["NFUT"];
  if (
    (itemName === "BANKNIFTY" || itemName === "NIFTY") &&
    (exchangeKey === "NFUT" || exchangeKey === "NSE") &&
    strike === 0 &&
    item.expiry
  ) {
    return ["NFUT", "NOPT"];
  }
  if (exchangeKey === "NFUT" || exchangeKey === "NSE") {
    return item.expiry ? ["NSE"] : ["NSE_EQ"];
  }
  if (
    ["DOWJONES", "GIFTNIFTY", "S&P", "SPX", "S AND P", "NASDAQ", "GLOBAL"].some((g) =>
      itemName.includes(g)
    )
  ) {
    return ["GLOBAL"];
  }
  if (["GLOBAL", "FOREX", "FX", "LMAX"].includes(exchangeKey)) return ["FOREX"];
  if (exchangeKey === "NOPT") {
    return itemName === "NIFTY" || itemName === "BANKNIFTY" ? ["NOPT"] : [];
  }
  return [exchangeKey];
}

const main = async () => {
  if (!MONGODB_URI) throw new Error("MONGODB_URI or DATABASE_URL not set");

  await mongoose.connect(MONGODB_URI, {
    serverSelectionTimeoutMS: 10000,
    socketTimeoutMS: 60000,
  });
  console.log("[RefreshLotSettings] DB connected");

  console.log("[RefreshLotSettings] Fetching symbol data from API...");
  const response = await axios.get(`${API_BASE_URL}/symbol-info`, {
    headers: { Authorization: `Bearer ${AUTH_TOKEN}` },
    timeout: 60000,
  });

  const apiData = response.data?.data || response.data || [];
  if (!Array.isArray(apiData)) throw new Error("Invalid API response format");
  console.log(`[RefreshLotSettings] Got ${apiData.length} symbols from API`);

  // Apply COMEX transformation: remove CMX suffix and add -USD
  // Must match dailySymbolSync.js exactly so scriptName + marketId line up for frontend
  apiData.forEach(item => {
    if (item.exchange && item.exchange.toUpperCase() === 'COMEX') {
      if (item.name && item.name.toUpperCase().endsWith('CMX')) {
        item.name = item.name.substring(0, item.name.length - 3) + '-USD';
      }
    }
  });

  const lotMap = new Map(); // "marketId|scriptName" -> doc

  for (const item of apiData){
    if(item.segment == 'INDICES') continue;
    if (!item.lot_size || !item.name) continue;

    const itemName = (item.name || "").toUpperCase();
    const exchangeKey = (item.exchange || "OTHERS").toUpperCase();

    // Skip indices exchange — process via NFUT/NSE instead
    if (exchangeKey === "INDICES") continue;

    if (exchangeKey === "MCX" && !ALLOWED_MCX_SCRIPTS.includes(itemName)) continue;

    const marketKeys = resolveMarketKeys(itemName, exchangeKey, item);

    for (const mKey of marketKeys) {
      const marketId = MARKET_IDS[mKey];
      if (!marketId) continue;
      const marketName = MARKET_NAMES[marketId] || mKey;
      const mapKey = `${marketId}|${itemName}`;
      if (!lotMap.has(mapKey)) {
        lotMap.set(mapKey, {
          marketId,
          marketName,
          scriptName: itemName,
          quantity: item.lot_size,
        });
      }
    }
  }

  console.log(`[RefreshLotSettings] Upserting ${lotMap.size} unique lot settings...`);
  let upserted = 0;

  for (const doc of lotMap.values()) {
    await LotSetting.updateOne(
      { marketId: String(doc.marketId), scriptName: doc.scriptName },
      {
        $set: { quantity: Number(doc.quantity), marketName: doc.marketName },
        $setOnInsert: { createdBy: SYSTEM_USER },
      },
      { upsert: true }
    );
    upserted++;
  }

  console.log(`[RefreshLotSettings] Done. Upserted ${upserted} lot settings.`);
  await mongoose.disconnect();
  process.exit(0);
};

main().catch((err) => {
  console.error("[RefreshLotSettings] Fatal error:", err.message);
  process.exit(1);
});
