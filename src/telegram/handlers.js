"use strict";
/**
 * handlers.js — Data-fetching helpers for Ocean Exchange Bot.
 * Each exported function fetches data and returns { textLines, pdfSections, title, subtitle }
 * which the bot.js uses for PDF responses.
 */

const mongoose = require("mongoose");
const moment = require("moment");

const UserModel = require("../models/UserModel");
const WeekValanModel = require("../models/WeekValanModel");
const CashLedgerModel = require("../models/CashLedgerModel");
const JVLedgerModel = require("../models/JVLedgerModel");
const StockTx = require("../models/StockTransactionModel");
const { MarketType: MarketModel } = require("../models/MarketTypeModel");

const {
  getProfitLossWithLivePrices,
  getScriptSummaryReport,
  getActiveWeekValan,
  getValanById,
  activeUsers,
  noActiveUsers,
} = require("../services/StockService");
const { getMarginManagementData, getMarketAccess } = require("../services/UserService");
const { translate, t } = require("./i18n");

// ── Helper: ObjectId ─────────────────────────────────────────────────────────
const oid = (v) => new mongoose.Types.ObjectId(v);
// ── Legacy Markdown Escaping ──────────────────────────────────────────────────
// Only escape symbols special to legacy Markdown (*, _, `, [) to avoid "\" in names/numbers.
const esc = (s) => String(s ?? "").replace(/([_*`\[\\])/g, "\\$1");

// ── Helper: date from DD-MM-YYYY ─────────────────────────────────────────────
function parseDate(str) {
  const m = moment(str, "DD-MM-YYYY", true);
  return m.isValid() ? m.toDate() : null;
}

// ── Helper: safe number format ───────────────────────────────────────────────
const fmt = (n) => (typeof n === "number" ? n.toFixed(2) : "0.00");
const sign = (n) => (n >= 0 ? "🟢 +" : "🔴 ");

const getTotalSum = (data, id) => {
  if (!id)
    return {
      brokerage: 0,
      bill: 0,
      m2m: 0,
      brokerBrokerage: 0,
      gross: 0,
      selfBrokerage: 0,
      selfNetPrice: 0,
      uplineNetPrice: 0,
      downlineNetPrice: 0,
    };
  const idString = id.toString();
  const initialValues = {
    brokerage: 0,
    bill: 0,
    m2m: 0,
    brokerBrokerage: 0,
    gross: 0,
    selfBrokerage: 0,
    selfNetPrice: 0,
    uplineNetPrice: 0,
    downlineNetPrice: 0,
  };
  return data.reduce(
    (acc, item) => {
      if (
        item.parentIds &&
        item.parentIds.some((pid) => pid?.toString() === idString)
      ) {
        for (const key in initialValues) {
          const val = item[key];
          if (val !== undefined && val !== null) {
            const n = typeof val === "number" ? val : parseFloat(val);
            if (!isNaN(n)) acc[key] += n;
          }
        }
      }
      return acc;
    },
    { ...initialValues },
  );
};

// ── 1. ALL TRADES ─────────────────────────────────────────────────────────────
async function buildAllTrades(user, lang = "en") {


  const valan = await getActiveWeekValan();
  if (!valan) throw new Error("No active valan found.");

  const query = {
    $or: [{ userId: oid(user._id) }, { parentIds: oid(user._id) }],
    valanId: oid(valan._id),
    transactionStatus: "COMPLETED",
  };
  const trades = await StockTx.find(query)
    .populate("userId", "accountName accountCode")
    .populate("createdBy", "accountName accountCode")
    .sort({ createdAt: -1 })
    .limit(200)
    .lean();

  const title = await translate("This Valan's Trades", lang);
  const subtitle = `${user.accountName} | ${valan.label}`;
  const columns = [
    "#",
    await translate("Client", lang),
    await translate("Creator", lang),
    await translate("Script", lang),
    await translate("Type", lang),
    await translate("Qty", lang),
    await translate("Rate", lang),
    await translate("Time", lang),
  ];
  const [rBuy, rSell] = await Promise.all([
    translate("BUY", lang),
    translate("SELL", lang),
  ]);
  const rows = trades.map((t, i) => [
    i + 1,
    t.userId
      ? `${t.userId.accountName || ""} (${t.userId.accountCode || ""})`
      : "-",
    t.createdBy
      ? `${t.createdBy.accountName || ""} (${t.createdBy.accountCode || ""})`
      : "-",
    t.label || t.scriptName || "-",
    t.transactionType === "BUY" ? rBuy : rSell,
    t.quantity,
    fmt(t.orderPrice ?? t.netPrice),
    moment(t.createdAt).format("DD-MM-YY HH:mm"),
  ]);
  const rowColors = trades.map((t) =>
    t.transactionType === "BUY" ? "buy" : "sell",
  );

  const textLines = [
    `📈 *${title} — ${esc(valan.label)}*`,
    `_${esc(user.accountName)}_`,
    "",
    ...trades
      .slice(0, 50)
      .map(
        (t, i) =>
          `${i + 1}. *${esc(t.label || t.scriptName)}* | ${t.transactionType === "BUY" ? rBuy : rSell} | Qty: ${t.quantity} | @${fmt(t.orderPrice ?? t.netPrice)} | Client: ${esc(t.userId?.accountName || "-")}`,
      ),
    "",
    `_Total: ${trades.length} ${await translate("trade(s) in this valan", lang)}_`,
  ];

  return {
    title,
    subtitle,
    textLines,
    pdfSections: [{ table: { columns, rows, rowColors } }],
  };
}

// ── 2. SUMMARY REPORT ────────────────────────────────────────────────────────
async function buildSummaryReport(user, lang = "en") {
  const valan = await getActiveWeekValan();
  if (!valan) throw new Error("No active valan found.");

  const level = user.accountType?.level ?? 1;
  const filterKey = level === 6 ? "brokerIds" : "parentIds";

  const match = {
    [filterKey]: oid(user._id),
    valanId: oid(valan._id),
    transactionStatus: "COMPLETED",
  };

  const res = await getProfitLossWithLivePrices(
    match,
    level,
    user._id.toString(),
  );
  let response = res?.data || [];
  if (!response.length) throw new Error("No downline summary data found.");

  const responseMap = new Map(
    response.map((item) => [item.userId?.toString(), item]),
  );

  // Grouping: Identify unique immediate descendants relative to caller
  const directChildIds = new Set(
    response
      .map((u) => u.parentIds[level]?.toString() || u.userId?.toString())
      .filter(Boolean),
  );

  const dataObjects = await UserModel.find({
    _id: { $in: Array.from(directChildIds).map(oid) },
  })
    .populate("accountType", "label level")
    .lean();

  const data = dataObjects.map((u) => {
    const isClient = (u.accountType?.level ?? 7) === 7;
    const partnership = u.partnership || [];
    const uplineShare = partnership
      .slice(0, level - 1)
      .reduce((acc, v) => acc + (Number(v) || 0), 0);
    const selfShare = Number(partnership[level - 1]) || 0;
    const brokerShare = Number(partnership[5]) || 0;
    const totalSelfShare = selfShare + brokerShare;
    const downlineShare = 100 - selfShare - uplineShare;

    if (isClient) {
      const dt = responseMap.get(u._id.toString()) || {};
      const totalM2M = Number(dt.m2m) || 0;

      const sNet = (totalM2M * totalSelfShare * -1) / 100;
      const sBrok =
        ((Number(dt.brokerage || 0) - Number(dt.brokerBrokerage || 0)) *
          totalSelfShare) /
        100;
      const uplineNet = (totalM2M * uplineShare * -1) / 100;
      const downlineNet = (totalM2M * downlineShare * -1) / 100;

      return {
        ...u,
        ...dt,
        selfNetPrice: sNet,
        selfBrokerage: sBrok,
        uplineNetPrice: uplineNet,
        downlineNetPrice: downlineNet,
      };
    } else {
      const sum = getTotalSum(response, u._id);
      const totalM2M = sum.m2m || 0;

      const sNet = (totalM2M * totalSelfShare * -1) / 100;
      const sBrok =
        ((sum.brokerage - sum.brokerBrokerage) * totalSelfShare) / 100;
      const uplineNet = (totalM2M * uplineShare * -1) / 100;
      const downlineNet = (totalM2M * downlineShare * -1) / 100;

      return {
        ...u,
        ...sum,
        selfNetPrice: sNet,
        selfBrokerage: sBrok,
        uplineNetPrice: uplineNet,
        downlineNetPrice: downlineNet,
      };
    }
  });

  const title = await translate("Summary Report", lang);
  const subtitle = `${user.accountName} | ${valan.label}`;

  const columns = [
    await translate("User", lang),
    await translate("Gross P&L", lang),
    await translate("Cal Brokerage", lang),
    await translate("Bill", lang),
    await translate("Brokers Brok", lang),
    await translate("Total M2M", lang),
    await translate("Self Brok", lang),
    await translate("Self", lang),
    await translate("Upline", lang),
    await translate("Downline", lang),
  ];
  const rows = data.map((u) => [
    `${u.accountName} (${u.accountCode})`,
    fmt(u.gross),
    fmt(u.brokerage),
    fmt(u.bill),
    fmt(u.brokerBrokerage),
    fmt(u.m2m),
    fmt(u.selfBrokerage),
    fmt(u.selfNetPrice),
    fmt(u.uplineNetPrice),
    fmt(u.downlineNetPrice),
  ]);

  const [
    rGross,
    rBill,
    rM2m,
    rSelf,
    rUp,
    rDown,
    rCalBrok,
    rBrokBrok,
    rSelfBrok,
  ] = await Promise.all([
    translate("Gross", lang),
    translate("Bill", lang),
    translate("M2M", lang),
    translate("Self", lang),
    translate("Up", lang),
    translate("Down", lang),
    translate("Cal Brok", lang),
    translate("Broker Brok", lang),
    translate("Self Brok", lang),
  ]);

  const textLines = [
    `📋 *${title} — ${esc(valan.label)}*`,
    `_${esc(user.accountName)}_`,
    "",
    ...data.map(
      (u) =>
        `👤 *${esc(u.accountName)}* (${esc(u.accountCode)})\n` +
        `   ${rGross}: ${sign(u.gross)}₹${fmt(Math.abs(u.gross))} | ${rCalBrok}: ₹${fmt(u.brokerage)}\n` +
        `   ${rBill}: ${sign(u.bill)}₹${fmt(Math.abs(u.bill))} | ${rBrokBrok}: ₹${fmt(u.brokerBrokerage)}\n` +
        `   ${rM2m}: ${sign(u.m2m)}₹${fmt(Math.abs(u.m2m))} | ${rSelfBrok}: ₹${fmt(u.selfBrokerage)}\n` +
        `   ${rSelf}: ${sign(u.selfNetPrice)}₹${fmt(Math.abs(u.selfNetPrice))} | ${rUp}: ${sign(u.uplineNetPrice)}₹${fmt(Math.abs(u.uplineNetPrice))} | ${rDown}: ${sign(u.downlineNetPrice)}₹${fmt(Math.abs(u.downlineNetPrice))}`,
    ),
    "",
    `_Total: ${data.length} ${await translate("grouped rows", lang)}_`,
  ];

  return {
    title,
    subtitle,
    textLines,
    pdfSections: [{ table: { columns, rows } }],
  };
}

// ── 2A. SCRIPT WISE SUMMARY ──────────────────────────────────────────────────
async function buildScriptWiseSummary(user, lang = "en") {
  const valan = await getActiveWeekValan();
  if (!valan) throw new Error("No active valan found.");

  const level = user.accountType?.level ?? 1;
  const filterKey = level === 6 ? "brokerIds" : "parentIds";

  const match = {
    [filterKey]: oid(user._id),
    valanId: oid(valan._id),
    transactionStatus: "COMPLETED",
  };

  const data = await getScriptSummaryReport(match, level, user._id.toString());
  if (!data || !data.length) throw new Error("No script summary data found.");

  const title = await translate("Script Wise Summary", lang);
  const subtitle = `${user.accountName} | ${valan.label}`;

  // Format numbers properly, optionally handling lots
  const customFmt = (n) => {
    if (typeof n !== "number") n = parseFloat(n) || 0;
    return n.toLocaleString("en-IN", {
      minimumFractionDigits: 2,
      maximumFractionDigits: 2,
    });
  };
  const lotFmt = (qty, lot) =>
    lot ? `${customFmt(qty)} (${customFmt(lot)})` : customFmt(qty);

  const columns = [
    "Sr No.",
    await translate("Market Name", lang),
    await translate("Script Name", lang),
    await translate("Buy Qty", lang),
    await translate("Buy Avg. Rate", lang),
    await translate("Sell Qty", lang),
    await translate("Sell Avg. Rate", lang),
    await translate("Net Qty", lang),
    await translate("Self Qty", lang),
    await translate("C.R", lang),
    await translate("Self M2M", lang),
    await translate("Upline M2M", lang),
    await translate("Downline M2M", lang),
    await translate("Total M2M", lang),
  ];

  let tBuyQty = 0,
    tBuyLot = 0,
    tSellQty = 0,
    tSellLot = 0,
    tNetQty = 0,
    tSelfQty = 0;
  let tSelfM2M = 0,
    tUpM2M = 0,
    tDownM2M = 0,
    tTotalM2M = 0;

  const dataRows = data.map((r, i) => {
    tBuyQty += r.buyQuantity || 0;
    tBuyLot += r.buyLot || 0;
    tSellQty += r.sellQuantity || 0;
    tSellLot += r.sellLot || 0;
    tNetQty += r.remainingQty || 0;
    tSelfQty += r.selfQty || 0;
    tSelfM2M += r.selfNetPrice || 0;
    tUpM2M += r.uplineNetPrice || 0;
    tDownM2M += r.downlineNetPrice || 0;
    tTotalM2M += r.m2m || 0;

    return [
      i + 1,
      r.marketName || "-",
      r.label || r.scriptName || "-",
      lotFmt(r.buyQuantity, r.buyLot),
      customFmt(r.buyNetAveragePrice),
      lotFmt(r.sellQuantity, r.sellLot),
      customFmt(r.sellNetAveragePrice),
      customFmt(r.remainingQty),
      customFmt(r.selfQty),
      customFmt(r.livePrice),
      customFmt(r.selfNetPrice),
      customFmt(r.uplineNetPrice),
      customFmt(r.downlineNetPrice),
      customFmt(r.m2m),
    ];
  });

  const bottomRow = [
    "Total",
    "",
    "",
    lotFmt(tBuyQty, tBuyLot),
    "",
    lotFmt(tSellQty, tSellLot),
    "",
    customFmt(tNetQty),
    customFmt(tSelfQty),
    customFmt(0),
    customFmt(tSelfM2M),
    customFmt(tUpM2M),
    customFmt(tDownM2M),
    customFmt(tTotalM2M),
  ];

  const rows = [...dataRows, bottomRow];

  const [rBuy, rSell, rNet, rM2m] = await Promise.all([
    translate("Buy", lang),
    translate("Sell", lang),
    translate("Net", lang),
    translate("Total M2M", lang),
  ]);

  const textLines = [
    `📋 *${title} — ${esc(valan.label)}*`,
    `_${esc(user.accountName)}_`,
    "",
    ...data
      .slice(0, 50)
      .map(
        (r) =>
          `📜 *${esc(r.label || r.scriptName)}* (${esc(r.marketName)})\n` +
          `   ${rBuy}: ${customFmt(r.buyQuantity)} | ${rSell}: ${customFmt(r.sellQuantity)} | ${rNet}: ${customFmt(r.remainingQty)}\n` +
          `   ${rM2m}: ${sign(r.m2m)}₹${customFmt(Math.abs(r.m2m))}`,
      ),
    "",
    `_Total: ${data.length} ${await translate("scripts", lang)}_`,
  ];

  return {
    title,
    subtitle,
    textLines,
    pdfSections: [{ table: { columns, rows } }],
  };
}

// ── 3. ALL POSITIONS ─────────────────────────────────────────────────────────
async function buildAllPositions(user, lang = "en") {

  const valan = await getActiveWeekValan();
  if (!valan) throw new Error("No active valan found.");

  const result = await StockTx.aggregate([
    {
      $match: {
        $or: [{ userId: oid(user._id) }, { parentIds: oid(user._id) }],
        valanId: oid(valan._id),
        transactionStatus: "COMPLETED",
      },
    },
    {
      $group: {
        _id: { userId: "$userId", scriptId: "$scriptId", label: "$label" },
        buyQty: {
          $sum: {
            $cond: [{ $eq: ["$transactionType", "BUY"] }, "$quantity", 0],
          },
        },
        sellQty: {
          $sum: {
            $cond: [{ $eq: ["$transactionType", "SELL"] }, "$quantity", 0],
          },
        },
        buyVal: {
          $sum: {
            $cond: [
              { $eq: ["$transactionType", "BUY"] },
              {
                $multiply: [
                  "$quantity",
                  { $ifNull: ["$orderPrice", "$netPrice"] },
                ],
              },
              0,
            ],
          },
        },
        sellVal: {
          $sum: {
            $cond: [
              { $eq: ["$transactionType", "SELL"] },
              {
                $multiply: [
                  "$quantity",
                  { $ifNull: ["$orderPrice", "$netPrice"] },
                ],
              },
              0,
            ],
          },
        },
        label: { $first: "$label" },
        scriptName: { $first: "$scriptName" },
        marketName: { $first: "$marketName" },
      },
    },
    {
      $lookup: {
        from: "users",
        localField: "_id.userId",
        foreignField: "_id",
        as: "u",
      },
    },
    { $unwind: "$u" },
    {
      $addFields: {
        netQty: { $subtract: ["$buyQty", "$sellQty"] },
        avgBuy: { $cond: ["$buyQty", { $divide: ["$buyVal", "$buyQty"] }, 0] },
        avgSell: {
          $cond: ["$sellQty", { $divide: ["$sellVal", "$sellQty"] }, 0],
        },
      },
    },
    { $match: { netQty: { $ne: 0 } } },
    { $sort: { "u.accountName": 1, label: 1 } },
    { $limit: 200 },
  ]);

  const title = await translate("This Valan's Open Positions", lang);
  const subtitle = `${user.accountName} | ${valan.label}`;
  const columns = [
    await translate("Client", lang),
    await translate("Script", lang),
    await translate("Market", lang),
    await translate("Dir", lang),
    await translate("Net Qty", lang),
    await translate("Avg Buy", lang),
    await translate("Avg Sell", lang),
  ];
  const [rLong, rShort, rQty, rClient] = await Promise.all([
    translate("LONG", lang),
    translate("SHORT", lang),
    translate("Qty", lang),
    translate("Client", lang),
  ]);
  const pdfRows = result.map((r) => [
    `${r.u?.accountName || ""} (${r.u?.accountCode || ""})`,
    r.label || r.scriptName || "-",
    r.marketName || "-",
    r.netQty > 0 ? `${rLong} 🟢` : `${rShort} 🔴`,
    Math.abs(r.netQty),
    fmt(r.avgBuy),
    fmt(r.avgSell),
  ]);

  const textLines = [
    `📌 *${await translate("Open Positions", lang)} — ${esc(valan.label)}*`,
    `_${esc(user.accountName)}_`,
    "",
    ...result.slice(0, 50).map((r) => {
      const dir = r.netQty > 0 ? `${rLong} 🟢` : `${rShort} 🔴`;
      const client = `${r.u?.accountName || ""} (${r.u?.accountCode || ""})`;
      return `*${esc(r.label || r.scriptName)}* | ${dir} | ${rQty}: ${Math.abs(r.netQty)} | ${rClient}: ${esc(client)}`;
    }),
    "",
    `_${result.length} ${await translate("open position(s)", lang)}_`,
  ];
  return {
    title,
    subtitle,
    textLines,
    pdfSections: [{ table: { columns, rows: pdfRows } }],
  };
}

// ── 4. MARGIN MANAGEMENT ──────────────────────────────────────────────────────
async function buildMarginMgmt(user, lang = "en") {
  const userId = user._id.toString();
  const userLevel = user.accountType?.level;

  // Get marketIds from user's own marketAccess (same as API controller)
  let marketIds = [];
  const userAccess = await getMarketAccess(userId);
  if (userAccess && userAccess.length > 0 && userAccess[0].marketAccess) {
    marketIds = userAccess[0].marketAccess.map((m) => String(m.marketId));
  } else {
    marketIds = ["10", "2", "1", "3"];
  }

  const result = await getMarginManagementData(userId, marketIds, userLevel);
  const { usersLimit, grandTotal } = result;
  const me = (usersLimit || [])[0];
  if (!me) throw new Error("No margin data found.");

  const markets = me.markets || [];

  const titleText = await translate("Margin Management", lang);
  const subtitleText = `${user.accountName} (${user.accountCode})`;

  const [colMarket, colLimit, colUsed, colAvail, colType] = await Promise.all([
    translate("Market", lang),
    translate("Limit", lang),
    translate("Used", lang),
    translate("Available", lang),
    translate("Type", lang),
  ]);

  const columns = [colMarket, colType, colLimit, colUsed, colAvail];
  const pdfRows = markets.map((m) => {
    const isLot = m.lotOrAmount !== "amount";
    const limit = isLot ? (m.totalLotWiseSum || 0) : (m.totalMarginSum || 0);
    const used  = isLot ? (m.usedLotWiseSum  || 0) : (m.usedMarginSum  || 0);
    return [
      m.marketName || m.marketId,
      m.lotOrAmount || "lot",
      fmt(limit),
      fmt(used),
      fmt(limit - used),
    ];
  });

  // Grand total row
  pdfRows.push([
    await translate("TOTAL", lang),
    "-",
    fmt(grandTotal.totalLotWiseSum || grandTotal.totalMarginSum || 0),
    fmt(grandTotal.usedLotWiseSum  || grandTotal.usedMarginSum  || 0),
    "-",
  ]);

  const textLines = [
    `💰 *${titleText}*`,
    `_${subtitleText}_`,
    "",
    ...markets.map((m) => {
      const isLot = m.lotOrAmount !== "amount";
      const limit = isLot ? (m.totalLotWiseSum || 0) : (m.totalMarginSum || 0);
      const used  = isLot ? (m.usedLotWiseSum  || 0) : (m.usedMarginSum  || 0);
      return `• *${esc(m.marketName || String(m.marketId))}* (${m.lotOrAmount}): ${colLimit} ${fmt(limit)} | ${colUsed} ${fmt(used)} | ${colAvail} ${fmt(limit - used)}`;
    }),
  ];

  return {
    title: titleText,
    subtitle: subtitleText,
    textLines,
    pdfSections: [{ table: { columns, rows: pdfRows } }],
  };
}

// ── 5 & 6. T&D USERS / T&D MASTERS ──────────────────────────────────────────
async function buildTDReport(user, dir, valanId, mastersOnly, lang = "en") {
  const valan = valanId
    ? await getValanById(valanId)
    : await getActiveWeekValan();
  if (!valan) throw new Error("No active valan found.");

  const level = user.accountType?.level ?? 1;
  const filterKey = level === 6 ? "brokerIds" : "parentIds";

  const match = {
    [filterKey]: oid(user._id),
    valanId: oid(valan._id),
    transactionStatus: "COMPLETED",
  };

  const res = await getProfitLossWithLivePrices(
    match,
    level,
    user._id.toString(),
  );
  let response = res?.data || [];
  if (!response.length)
    throw new Error("No downline data found in current valan.");

  let data = [];
  if (mastersOnly) {
    const masterIds = [
      ...new Set(response.flatMap((u) => u.parentIds.slice(level))),
    ]
      .map((id) => id?.toString())
      .filter(Boolean);
    const masterObjects = await UserModel.find({
      _id: { $in: masterIds.map(oid) },
    })
      .populate("accountType", "label level")
      .lean();

    data = masterObjects
      .map((m) => {
        const sum = getTotalSum(response, m._id);
        const partnership = m.partnership || [];
        const selfShare = Number(partnership[level - 1]) || 0;
        const brokerShare = Number(partnership[5]) || 0;
        const totalSelfShare = selfShare + brokerShare;

        const sNet = (sum.m2m * totalSelfShare * -1) / 100;
        const sBrok =
          ((sum.brokerage - sum.brokerBrokerage) * totalSelfShare) / 100;

        return {
          ...m,
          ...sum,
          selfNetPrice: sNet,
          selfBrokerage: sBrok,
          userId: m._id,
          level: m.accountType?.level || 7,
        };
      })
      .filter((u) => u.m2m !== 0 || u.selfNetPrice !== 0);
  } else {
    const allUserIds = response.map((u) => u.userId).filter(Boolean);
    const userObjects = await UserModel.find({
      _id: { $in: allUserIds },
    }).lean();
    const userMap = new Map(userObjects.map((u) => [u._id.toString(), u]));

    data = response
      .map((u) => {
        const uObj = userMap.get(u.userId?.toString());
        const partnership = uObj?.partnership || [];
        const selfShare = Number(partnership[level - 1]) || 0;
        const brokerShare = Number(partnership[5]) || 0;
        const totalSelfShare = selfShare + brokerShare;

        const sNet = (u.m2m * totalSelfShare * -1) / 100;
        const sBrok =
          ((Number(u.brokerage || 0) - Number(u.brokerBrokerage || 0)) *
            totalSelfShare) /
          100;

        return {
          ...u,
          accountName: uObj?.accountName || u.accountName,
          accountCode: uObj?.accountCode || u.accountCode,
          selfNetPrice: sNet,
          selfBrokerage: sBrok,
          userId: u.userId,
          level: 7,
        };
      })
      .filter((u) => u.m2m !== 0 || u.selfNetPrice !== 0);
  }

  if (!data.length)
    throw new Error(`No ${mastersOnly ? "Masters" : "Users"} found with data.`);

  if (dir === "top") {
    data = data.filter((r) => r.selfNetPrice > 0);
  } else {
    data = data.filter((r) => r.selfNetPrice < 0);
  }

  if (!data.length)
    throw new Error(
      `No ${mastersOnly ? "Masters" : "Users"} found with ${dir === "top" ? "Profit" : "Loss"}.`,
    );

  data.sort((a, b) =>
    dir === "top"
      ? b.selfNetPrice - a.selfNetPrice
      : a.selfNetPrice - b.selfNetPrice,
  );
  data = data.slice(0, 15);

  const label =
    dir === "top"
      ? await translate("Top 15 (Most Profit)", lang)
      : await translate("Down 15 (Most Loss)", lang);
  const reportT = mastersOnly
    ? await translate("T&D Masters", lang)
    : await translate("T&D Users", lang);
  const title = `${reportT} — ${label}`;
  const subtitle = `${await translate("Valan", lang)}: ${valan.label}`;
  const columns = [
    "#",
    await translate("Account", lang),
    await translate("Code", lang),
    await translate("Gross P&L", lang),
    await translate("Brok", lang),
    await translate("Net P&L (M2M)", lang),
  ];
  const pdfRows = data.map((r, i) => [
    i + 1,
    r.accountName || "-",
    r.accountCode || "-",
    fmt(r.gross),
    fmt(r.selfBrokerage),
    fmt(r.selfNetPrice),
  ]);

  const textLines = [
    `${mastersOnly ? "🎯" : "🏆"} *${title}*`,
    `_${subtitle}_`,
    "",
    ...data.map(
      (r, i) =>
        `${i + 1}. *${esc(r.accountName)}* (${esc(r.accountCode)}) | ${sign(r.selfNetPrice)}₹${fmt(Math.abs(r.selfNetPrice))}`,
    ),
    "",
    `_${data.length} ${await translate("user(s) shown", lang)}_`,
  ];

  return {
    title,
    subtitle,
    textLines,
    pdfSections: [{ table: { columns, rows: pdfRows } }],
  };
}

// ── 7. ACTIVE / NOT ACTIVE USERS ─────────────────────────────────────────────
async function buildActiveUsersReport(user, isActive, lang = "en") {
  const valan = await getActiveWeekValan();
  if (!valan) throw new Error("No active valan found.");

  // Get all descendant IDs of this requester for downline filtering
  const downlineUsers = await UserModel.find(
    { parentIds: new mongoose.Types.ObjectId(user._id), isDeleted: false },
    { _id: 1 },
  ).lean();
  const downlineIdSet = new Set(downlineUsers.map((u) => u._id.toString()));
  downlineIdSet.add(user._id.toString());

  let rawData;
  if (isActive) {
    rawData = await activeUsers(valan._id.toString(), user.demoid === true);
  } else {
    rawData = await noActiveUsers(valan._id.toString(), user.demoid === true);
  }
  if (!rawData) rawData = { clients: [], masters: [], brokers: [] };

  // Filter to requester's downline only
  const filterDownline = (arr) =>
    (arr || []).filter((u) => downlineIdSet.has(u._id.toString()));
  const data = {
    clients: filterDownline(rawData.clients),
    masters: filterDownline(rawData.masters),
    brokers: filterDownline(rawData.brokers),
  };

  const [rClient, rMaster, rBroker] = await Promise.all([
    translate("Client", lang),
    translate("Master", lang),
    translate("Broker", lang),
  ]);

  const all = [
    ...(data.clients || []).map((u) => ({ ...u, type: rClient })),
    ...(data.masters || []).map((u) => ({ ...u, type: rMaster })),
    ...(data.brokers || []).map((u) => ({ ...u, type: rBroker })),
  ];

  const label = isActive
    ? await translate("Active Users", lang)
    : await translate("Inactive Users", lang);
  const icon = isActive ? "✅" : "❌";
  const title = `${label} — ${valan.label}`;
  const subtitle = `${user.accountName} | ${await translate("Current Week", lang)}`;
  const columns = [
    "#",
    await translate("Account Name", lang),
    await translate("Code", lang),
    await translate("Type", lang),
  ];
  const pdfRows = all.map((u, i) => [
    i + 1,
    u.accountName || "-",
    u.accountCode || "-",
    u.type,
  ]);

  const textLines = [
    `${icon} *${label} — ${esc(valan.label)}*`,
    `_${await translate("Current week", lang)}_`,
    "",
    ...all
      .slice(0, 50)
      .map(
        (u, i) =>
          `${i + 1}. *${esc(u.accountName)}* (${esc(u.accountCode)}) — ${u.type}`,
      ),
    "",
    `_${await translate("Total", lang)}: ${all.length}_`,
  ];

  return {
    title,
    subtitle,
    textLines,
    pdfSections: [{ table: { columns, rows: pdfRows } }],
  };
}

// ── 8. LEDGER ─────────────────────────────────────────────────────────────────
async function buildLedger(user, type, fromStr, toStr, lang = "en") {
  const from = parseDate(fromStr);
  const toRaw = parseDate(toStr);
  if (!from || !toRaw) throw new Error("Invalid date format. Use DD-MM-YYYY.");
  // End of day
  const to = new Date(toRaw);
  to.setHours(23, 59, 59, 999);
  const dateMatch = { createdAt: { $gte: from, $lte: to } };

  let title, columns, rows, subtitle;
  subtitle = `${user.accountName} | ${fromStr} → ${toStr}`;

  if (type === "cash") {
    title = await translate("Cash Ledger", lang);
    columns = [
      await translate("Date", lang),
      await translate("Type", lang),
      await translate("Amount", lang),
      await translate("Remarks", lang),
      await translate("Balance", lang),
    ];
    const docs = await CashLedgerModel.find({
      userId: user._id,
      ...dateMatch,
    })
      .sort({ createdAt: 1 })
      .lean();
    const [rDebit, rCredit] = await Promise.all([
      translate("DEBIT", lang),
      translate("CREDIT", lang),
    ]);
    rows = docs.map((d) => [
      moment(d.date || d.createdAt).format("DD-MM-YY"),
      (d.transactionType === "DEBIT"
        ? rDebit
        : d.transactionType === "CREDIT"
          ? rCredit
          : d.transactionType) || "-",
      d.amount ?? 0,
      d.remarks || "-",
      d.ledger ?? "-",
    ]);
  } else if (type === "jv") {
    title = await translate("JV Ledger", lang);
    columns = [
      await translate("Date", lang),
      await translate("Type", lang),
      await translate("Amount", lang),
      await translate("Remarks", lang),
      await translate("Balance", lang),
    ];
    const docs = await JVLedgerModel.find({
      $or: [{ debitAccount: user._id }, { creditAccount: user._id }],
      ...dateMatch,
    })
      .sort({ createdAt: 1 })
      .lean();
    const [rDebit, rCredit] = await Promise.all([
      translate("DEBIT", lang),
      translate("CREDIT", lang),
    ]);
    rows = docs.map((d) => [
      moment(d.date || d.createdAt).format("DD-MM-YY"),
      (d.transactionType === "DEBIT"
        ? rDebit
        : d.transactionType === "CREDIT"
          ? rCredit
          : d.transactionType) || "-",
      d.amount ?? 0,
      d.remarks || "-",
      d.ledger ?? "-",
    ]);
  } else {
    // trade ledger
    title = await translate("Trade Ledger", lang);
    columns = [
      await translate("Date", lang),
      await translate("Creator", lang),
      await translate("Script", lang),
      await translate("Type", lang),
      await translate("Qty", lang),
      await translate("Rate", lang),
      await translate("Order Prc", lang),
      await translate("Brok", lang),
      await translate("Net Prc", lang),
    ];
    const docs = await StockTx.find({
      $or: [{ userId: user._id }, { parentIds: oid(user._id) }],
      transactionStatus: "COMPLETED",
      ...dateMatch,
    })
      .populate("createdBy", "accountName accountCode")
      .sort({ createdAt: 1 })
      .lean();
    const [rBuy, rSell] = await Promise.all([
      translate("BUY", lang),
      translate("SELL", lang),
    ]);
    rows = docs.map((d) => [
      moment(d.createdAt).format("DD-MM-YY HH:mm"),
      d.createdBy?.accountName || d.createdBy?.accountCode || "-",
      d.label || d.scriptName || "-",
      d.transactionType === "BUY" ? rBuy : rSell,
      d.quantity,
      fmt(d.orderPrice),
      fmt(d.totalOrderPrice),
      fmt(d.netBrokerage || d.brokerage),
      fmt(d.totalNetPrice),
    ]);
  }

  if (!rows.length)
    throw new Error("No ledger entries found for the selected date range.");

  const textLines = [
    `📒 *${title}*`,
    `_${subtitle}_`,
    "",
    ...rows.slice(0, 30).map((r, i) => `${i + 1}. ${r.join(" | ")}`),
    "",
    `_${rows.length} ${await translate("entries", lang)}_`,
  ];

  return {
    title,
    subtitle,
    textLines,
    pdfSections: [{ table: { columns, rows: rows.slice(0, 500) } }],
  };
}

// ── 9. USER MANAGEMENT SUB-REPORTS ──────────────────────────────────────────
async function buildUserMgmtReport(targetUser, reportCode, lang = "en") {


  const valan = await getActiveWeekValan();
  const lastValan = await WeekValanModel.findOne({ status: false })
    .sort({ endDate: -1 })
    .lean();

  let title, subtitle, textLines, pdfSections;

  if (reportCode === "tpos" || reportCode === "wtrd" || reportCode === "ttrd") {
    const isMaster = (targetUser.accountType?.level ?? 7) < 7;
    let match = {
      $or: [{ userId: oid(targetUser._id) }, { parentIds: oid(targetUser._id) }],
      transactionStatus: "COMPLETED",
    };

    if (reportCode === "tpos") {
      if (valan) match.valanId = oid(valan._id);
      const result = await StockTx.aggregate([
        { $match: match },
        {
          $group: {
            _id: "$scriptId",
            label: { $first: "$label" },
            marketName: { $first: "$marketName" },
            buyQty: {
              $sum: {
                $cond: [{ $eq: ["$transactionType", "BUY"] }, "$quantity", 0],
              },
            },
            sellQty: {
              $sum: {
                $cond: [{ $eq: ["$transactionType", "SELL"] }, "$quantity", 0],
              },
            },
          },
        },
        { $addFields: { netQty: { $subtract: ["$buyQty", "$sellQty"] } } },
        { $match: { netQty: { $ne: 0 } } },
      ]);
      title = await translate("This Valan's Positions", lang);
      subtitle = targetUser.accountName;
      const colScript = await translate("Script", lang);
      const colMarket = await translate("Market", lang);
      const colDirection = await translate("Direction", lang);
      const colNetQty = await translate("Net Qty", lang);

      pdfSections = [
        {
          table: {
            columns: [colScript, colMarket, colDirection, colNetQty],
            rows: result.map((r) => [
              r.label || r._id,
              r.marketName || "-",
              r.netQty > 0 ? "LONG" : "SHORT",
              Math.abs(r.netQty),
            ]),
          },
        },
      ];
      const [rLong, rShort] = await Promise.all([
        translate("LONG", lang),
        translate("SHORT", lang),
      ]);
      textLines = [
        `📌 *${title} — ${esc(targetUser.accountName)}*`,
        "",
        ...result
          .slice(0, 50)
          .map(
            (r) =>
              `*${esc(r.label || r._id)}* | ${r.netQty > 0 ? rLong : rShort} | Qty: ${Math.abs(r.netQty)}`,
          ),
        "",
        `_${result.length} ${await translate("position(s)", lang)}_`,
      ];
    } else if (reportCode === "ttrd" || reportCode === "wtrd") {
      match = {
        $or: [{ userId: oid(targetUser._id) }, { parentIds: oid(targetUser._id) }],
        valanId: oid(valan._id),
        transactionStatus: "COMPLETED",
      };
      const trades = await StockTx.find(match)
        .populate("createdBy", "accountName accountCode")
        .sort({ createdAt: -1 })
        .limit(100)
        .lean();

      title =
        reportCode === "ttrd"
          ? await translate("This Valan's Trades", lang)
          : await translate("This Week's Trades", lang);
      subtitle = targetUser.accountName;
      const [rBuy, rSell] = await Promise.all([
        t("buy_lbl", lang),
        t("sell_lbl", lang),
      ]);
      const tRows = trades.map((t, i) => [
        i + 1,
        t.createdBy?.accountName || t.createdBy?.accountCode || "-",
        t.label || t.scriptName || "-",
        t.transactionType === "BUY" ? rBuy : rSell,
        t.quantity,
        fmt(t.orderPrice ?? t.netPrice),
        moment(t.createdAt).format("DD-MM-YY HH:mm"),
      ]);
      const tColors = trades.map((t) =>
        t.transactionType === "BUY" ? "buy" : "sell",
      );
      const columns = [
        "#",
        await t("creator_lbl", lang),
        await t("script_lbl", lang),
        await t("type_lbl", lang),
        await t("qty_lbl", lang),
        await t("rate_lbl", lang),
        await t("time_lbl", lang),
      ];
      pdfSections = [{ table: { columns, rows: tRows, rowColors: tColors } }];
      textLines = [
        `📈 *${title} — ${esc(targetUser.accountName)}*`,
        "",
        ...trades
          .slice(0, 50)
          .map(
            (t, i) =>
              `${i + 1}. *${esc(t.label || t.scriptName)}* | ${t.transactionType === "BUY" ? rBuy : rSell} | ${t.quantity}`,
          ),
        "",
        `_${trades.length} ${await t("trade_lbl", lang)}_`,
      ];
    }
  } else {
    // Bills: tbil / wbil / lbil
    const valanObj = reportCode === "lbil" ? lastValan : valan;
    if (!valanObj) throw new Error("No valan found.");

    const isMaster = (targetUser.accountType?.level ?? 7) < 7;
    const filterKey = isMaster
      ? targetUser.accountType.level === 6
        ? "brokerIds"
        : "parentIds"
      : "userId";
    const match = {
      $or: [
        { [filterKey]: oid(targetUser._id) },
        { userId: oid(targetUser._id) }
      ],
      valanId: oid(valanObj._id),
      transactionStatus: "COMPLETED",
    };

    const res = await getProfitLossWithLivePrices(
      match,
      targetUser.accountType?.level ?? 7,
      targetUser._id.toString(),
    );
    const data = res?.data || [];

    let totalGross = 0,
      totalBrok = 0,
      totalBill = 0,
      totalM2M = 0;
    data.forEach((u) => {
      totalGross += u.gross || 0;
      totalBrok += u.brokerage || 0;
      totalBill += u.bill || 0;
      totalM2M += u.m2m || 0;
    });

    const labelMap = {
      tbil: await translate("This Valan's Bill", lang),
      wbil: await translate("This Week's Bill", lang),
      lbil: await translate("Last Week's Bill", lang),
    };
    const [rGross, rBrok, rBill, rM2m] = await Promise.all([
      t("gross_pnl", lang),
      t("brokerage_lbl", lang),
      t("bill_pnl", lang),
      t("m2m_lbl", lang),
    ]);

    title = labelMap[reportCode] || (await translate("Bill", lang));
    subtitle = `${targetUser.accountName} | ${valanObj.label}`;
    textLines = [
      `🧾 *${title}*`,
      `_${esc(subtitle)}_`,
      "",
      `${rGross}:  ${sign(totalGross)}₹${fmt(Math.abs(totalGross))}`,
      `${rBrok}:  🔸 ₹${fmt(Math.abs(totalBrok))}`,
      `${rBill}:   ${sign(totalBill)}₹${fmt(Math.abs(totalBill))}`,
      `${rM2m}:        ${sign(totalM2M)}₹${fmt(Math.abs(totalM2M))}`,
      "",
      `_${await translate("Calculated based on", lang)} ${data.length} ${await translate("downline users", lang)}_`,
    ];
    pdfSections = [
      {
        heading: `${title} — ${subtitle}`,
        table: {
          columns: [await t("date_lbl", lang), await t("rate_lbl", lang)], // Metric | Value
          rows: [
            [rGross, fmt(totalGross)],
            [rBrok, fmt(totalBrok)],
            [rBill, fmt(totalBill)],
            [rM2m, fmt(totalM2M)],
          ],
        },
      },
    ];
  }

  return { title, subtitle, textLines, pdfSections };
}

// ── Search downline users ─────────────────────────────────────────────────────
async function searchDownlineUsers(user, query) {
  return UserModel.find({
    parentIds: oid(user._id),
    accountCode: { $regex: query, $options: "i" },
    isDeleted: false,
  })
    .populate("accountType")
    .limit(10)
    .lean();
}

// ── Get recent valans list ────────────────────────────────────────────────────
async function getRecentValans(limit = 8) {
  return WeekValanModel.find().sort({ endDate: -1 }).limit(limit).lean();
}

module.exports = {
  buildAllTrades,
  buildSummaryReport,
  buildScriptWiseSummary,
  buildAllPositions,
  buildMarginMgmt,
  buildTDReport,
  buildActiveUsersReport,
  buildLedger,
  buildUserMgmtReport,
  searchDownlineUsers,
  getRecentValans,
};
