const mongoose = require("mongoose");
const multer = require("multer");
const csv = require("csv-parse/sync");
const moment = require("moment");
const UserModel = require("../models/UserModel");
const WeekValan = require("../models/WeekValanModel");
const EventCalendar = require("../models/EventCalendarModel");
const UserBehaviorAnalysis = require("../models/UserBehaviorAnalysisModel");
const {
  analyzeUserForPeriod,
  getStoredAnalysis,
} = require("../services/UserBehaviorService");

// ─── ALLOWED LEVELS (not broker=6, not client=7) ─────────────────────────────
const ALLOWED_LEVELS = [1, 2, 3, 4, 5];

function checkAccess(req, res) {
  const level = req.user?.accountType?.level;
  if (!ALLOWED_LEVELS.includes(level)) {
    res.status(403).json({ status: false, message: "Access denied." });
    return false;
  }
  return true;
}

// ─── MULTER FOR CSV UPLOAD ────────────────────────────────────────────────────
const csvStorage = multer.memoryStorage();
const csvUpload = multer({
  storage: csvStorage,
  fileFilter: (req, file, cb) => {
    if (!file.originalname.match(/\.csv$/i)) {
      return cb(new Error("Only CSV files allowed"), false);
    }
    cb(null, true);
  },
  limits: { fileSize: 5 * 1024 * 1024 }, // 5MB
});

// ─── HELPERS ──────────────────────────────────────────────────────────────────

async function getDownlineUserIds(masterId) {
  const users = await UserModel.find(
    { parentIds: new mongoose.Types.ObjectId(masterId), isDeleted: { $ne: true } },
    { _id: 1 }
  ).lean();
  return users.map((u) => u._id);
}

// ─── CONTROLLER: getUserBehaviorAnalysis ─────────────────────────────────────

/**
 * POST /api/report/getUserBehaviorAnalysis
 *
 * Body:
 *   valanIds         string[]  — per-valan stored analysis
 *   userId           string    — single user
 *   masterId         string    — all downline of this master
 *   startDate        string    — ISO date, used with endDate for live analysis
 *   endDate          string    — ISO date
 *   includeCurrentValan bool   — append live analysis for active valan
 */
const getUserBehaviorAnalysis = async (req, res) => {
  try {
    if (!checkAccess(req, res)) return;

    const { valanIds, userId, masterId, startDate, endDate, includeCurrentValan } = req.body;

    // Resolve target user IDs
    let targetUserIds = [];
    if (userId) {
      targetUserIds = [userId];
    } else if (masterId) {
      const downline = await getDownlineUserIds(masterId);
      if (!downline.length) {
        return res.json({ status: true, data: [] });
      }
      targetUserIds = downline.map((id) => id.toString());
    } else {
      return res.status(400).json({ status: false, message: "userId or masterId required." });
    }

    const response = [];

    // ── Stored valan analysis ───────────────────────────────────────────────
    if (valanIds && valanIds.length) {
      const stored = await getStoredAnalysis(targetUserIds, valanIds);

      // Reshape: per valan per user
      const byValanUser = {};
      for (const rec of stored) {
        const vid = rec.valanId?._id?.toString() || rec.valanId?.toString();
        const uid = rec.userId?.toString();
        if (!byValanUser[vid]) byValanUser[vid] = {};
        byValanUser[vid][uid] = rec;
      }

      // Fill missing valan+user combos with live computation
      for (const vid of valanIds) {
        const valanDoc = await WeekValan.findById(vid).lean();
        if (!valanDoc) continue;

        const valanResult = {
          valanId: vid,
          valanLabel: valanDoc.label || valanDoc.keyidentifier,
          periodStart: valanDoc.startDate,
          periodEnd: valanDoc.endDate,
          users: [],
        };

        for (const uid of targetUserIds) {
          const stored = byValanUser[vid]?.[uid];
          if (stored && stored.behaviors !== undefined) {
            valanResult.users.push({
              userId: uid,
              source: "stored",
              behaviors: stored.behaviors,
              totalTrades: stored.totalTrades,
              totalProfit: stored.totalProfit,
              totalLoss: stored.totalLoss,
              computedAt: stored.computedAt,
            });
          } else {
            // Not yet stored — compute live
            const live = await analyzeUserForPeriod(uid, { valanId: vid });
            valanResult.users.push({
              userId: uid,
              source: "live",
              behaviors: live.behaviors,
              totalTrades: live.totalTrades,
              totalProfit: live.totalProfit,
              totalLoss: live.totalLoss,
              computedAt: new Date(),
            });
          }
        }

        response.push(valanResult);
      }
    }

    // ── Date-range analysis (live) ──────────────────────────────────────────
    if (startDate && endDate) {
      const rangeResult = {
        valanId: null,
        valanLabel: `${startDate} to ${endDate}`,
        periodStart: startDate,
        periodEnd: endDate,
        users: [],
      };

      for (const uid of targetUserIds) {
        const live = await analyzeUserForPeriod(uid, { startDate, endDate });
        rangeResult.users.push({
          userId: uid,
          source: "live",
          behaviors: live.behaviors,
          totalTrades: live.totalTrades,
          totalProfit: live.totalProfit,
          totalLoss: live.totalLoss,
          computedAt: new Date(),
        });
      }

      response.push(rangeResult);
    }

    // ── Current valan (live) ────────────────────────────────────────────────
    if (includeCurrentValan) {
      const currentValan = await WeekValan.findOne({ status: true }).lean();
      if (currentValan) {
        const alreadyIncluded =
          valanIds && valanIds.map(String).includes(currentValan._id.toString());

        if (!alreadyIncluded) {
          const currentResult = {
            valanId: currentValan._id,
            valanLabel: currentValan.label || currentValan.keyidentifier,
            periodStart: currentValan.startDate,
            periodEnd: currentValan.endDate,
            isCurrent: true,
            users: [],
          };

          for (const uid of targetUserIds) {
            const live = await analyzeUserForPeriod(uid, { valanId: currentValan._id });
            currentResult.users.push({
              userId: uid,
              source: "live",
              behaviors: live.behaviors,
              totalTrades: live.totalTrades,
              totalProfit: live.totalProfit,
              totalLoss: live.totalLoss,
              computedAt: new Date(),
            });
          }

          response.push(currentResult);
        } else {
          // Already included in valanIds — mark it as current
          const match = response.find(
            (r) => r.valanId?.toString() === currentValan._id.toString()
          );
          if (match) match.isCurrent = true;
        }
      }
    }

    return res.json({ status: true, data: response });
  } catch (err) {
    console.error("[UserBehavior] getUserBehaviorAnalysis error:", err);
    return res.status(500).json({ status: false, message: "Internal server error." });
  }
};

// ─── CONTROLLER: uploadEventCalendar ─────────────────────────────────────────

/**
 * POST /api/report/uploadEventCalendar
 * multipart/form-data, field "file" = CSV
 * CSV columns (case-insensitive): SYMBOL, COMPANY, PURPOSE, DETAILS, DATE
 */
const uploadEventCalendar = [
  csvUpload.single("file"),
  async (req, res) => {
    try {
      if (!checkAccess(req, res)) return;

      if (!req.file) {
        return res.status(400).json({ status: false, message: "CSV file required." });
      }

      const records = csv.parse(req.file.buffer.toString("utf8"), {
        columns: true,
        skip_empty_lines: true,
        trim: true,
      });

      if (!records.length) {
        return res.status(400).json({ status: false, message: "CSV is empty." });
      }

      let inserted = 0;
      let skipped = 0;

      for (const row of records) {
        const symbol = (row.SYMBOL || row.symbol || "").trim().toUpperCase();
        const rawDate = row.DATE || row.date || "";
        if (!symbol || !rawDate) { skipped++; continue; }

        // Parse date — handles "1-May-26", "01-May-2026", "2026-05-01"
        const eventDate = moment(rawDate, [
          "D-MMM-YY",
          "DD-MMM-YY",
          "D-MMM-YYYY",
          "DD-MMM-YYYY",
          "YYYY-MM-DD",
          "DD/MM/YYYY",
        ], true).toDate();

        if (isNaN(eventDate.getTime())) { skipped++; continue; }

        await EventCalendar.findOneAndUpdate(
          { symbol, eventDate },
          {
            symbol,
            companyName: (row.COMPANY || row.company || "").trim(),
            purpose: (row.PURPOSE || row.purpose || "").trim(),
            details: (row.DETAILS || row.details || "").trim(),
            eventDate,
          },
          { upsert: true }
        );
        inserted++;
      }

      return res.json({
        status: true,
        message: `Processed ${records.length} rows. Upserted: ${inserted}, Skipped: ${skipped}.`,
        inserted,
        skipped,
      });
    } catch (err) {
      console.error("[UserBehavior] uploadEventCalendar error:", err);
      return res.status(500).json({ status: false, message: "Internal server error." });
    }
  },
];

// ─── CONTROLLER: getUserBehaviorHistory ──────────────────────────────────────

/**
 * GET /api/report/getUserBehaviorHistory/:userId
 */
const getUserBehaviorHistory = async (req, res) => {
  try {
    if (!checkAccess(req, res)) return;

    const { userId } = req.params;
    if (!userId || !mongoose.Types.ObjectId.isValid(userId)) {
      return res.status(400).json({ status: false, message: "Invalid userId." });
    }

    const history = await UserBehaviorAnalysis.find({ userId })
      .populate("valanId", "keyidentifier label startDate endDate")
      .sort({ periodStart: -1 })
      .lean();

    return res.json({ status: true, data: history });
  } catch (err) {
    console.error("[UserBehavior] getUserBehaviorHistory error:", err);
    return res.status(500).json({ status: false, message: "Internal server error." });
  }
};

// ─── CONTROLLER: getUsersBehaviorGrouped ─────────────────────────────────────

/**
 * POST /api/report/getUsersBehaviorGrouped
 *
 * Returns users grouped by behavior type.
 * Defaults to current active valan if no valanIds / dates supplied.
 *
 * Body: same shape as getUserBehaviorAnalysis
 *   valanIds[], userId, masterId, startDate, endDate, includeCurrentValan
 */
const getUsersBehaviorGrouped = async (req, res) => {
  try {
    if (!checkAccess(req, res)) return;

    const { valanIds, userId, masterId, startDate, endDate } = req.body;

    // ── Resolve target users ──────────────────────────────────────────────────
    // If no userId/masterId → use caller's own downline
    let targetUserIds = [];
    if (userId) {
      targetUserIds = [userId];
    } else {
      const effectiveMasterId = masterId || req.context.effectiveUserId.toString();
      const downline = await getDownlineUserIds(effectiveMasterId);
      if (!downline.length) return res.json({ status: true, data: [] });
      targetUserIds = downline.map((id) => id.toString());
    }

    // ── Fetch user info for all target users ─────────────────────────────────
    const userDocs = await UserModel.find(
      { _id: { $in: targetUserIds.map((id) => new mongoose.Types.ObjectId(id)) } },
      { _id: 1, accountCode: 1, accountName: 1, createdBy: 1 }
    ).lean();

    // Collect all createdBy userIds to batch-fetch their info
    const createdByIds = userDocs
      .filter((u) => u.createdBy?.userId)
      .map((u) => u.createdBy.userId.toString());
    const uniqueCreatedByIds = [...new Set(createdByIds)];

    const createdByDocs = uniqueCreatedByIds.length
      ? await UserModel.find(
          { _id: { $in: uniqueCreatedByIds.map((id) => new mongoose.Types.ObjectId(id)) } },
          { _id: 1, accountCode: 1, accountName: 1 }
        ).lean()
      : [];

    const createdByMap = {};
    for (const u of createdByDocs) {
      createdByMap[u._id.toString()] = { accountCode: u.accountCode, accountName: u.accountName };
    }

    const userInfoMap = {};
    for (const u of userDocs) {
      const cbId = u.createdBy?.userId?.toString();
      userInfoMap[u._id.toString()] = {
        accountCode: u.accountCode,
        accountName: u.accountName,
        createdBy: cbId && createdByMap[cbId]
          ? { userId: cbId, accountCode: createdByMap[cbId].accountCode, accountName: createdByMap[cbId].accountName }
          : null,
      };
    }

    // ── Resolve valans to analyse ─────────────────────────────────────────────
    const valanDocs = [];

    if (valanIds && valanIds.length) {
      const docs = await WeekValan.find({ _id: { $in: valanIds } }).lean();
      valanDocs.push(...docs);
    } else {
      // No valanIds given → fall back to current active valan
      const currentValan = await WeekValan.findOne({ status: true }).lean();
      if (currentValan) valanDocs.push({ ...currentValan, _isCurrent: true });
    }

    // ── For each valan: load stored records + live-fill gaps ──────────────────
    const response = [];

    for (const valanDoc of valanDocs) {
      const vidStr = valanDoc._id.toString();

      // Load all stored analysis records for this valan + these users
      const storedRecords = await UserBehaviorAnalysis.find({
        valanId: new mongoose.Types.ObjectId(vidStr),
        userId: { $in: targetUserIds.map((id) => new mongoose.Types.ObjectId(id)) },
      }).lean();

      const storedByUser = {};
      for (const rec of storedRecords) {
        storedByUser[rec.userId.toString()] = rec;
      }

      // Identify users missing stored analysis → compute live
      const missingUsers = targetUserIds.filter((uid) => !storedByUser[uid]);

      for (const uid of missingUsers) {
        const live = await analyzeUserForPeriod(uid, { valanId: vidStr });
        storedByUser[uid] = {
          userId: uid,
          behaviors: live.behaviors,
          totalTrades: live.totalTrades,
          totalProfit: live.totalProfit,
          totalLoss: live.totalLoss,
          _isLive: true,
        };
      }

      // ── Group by behavior type ───────────────────────────────────────────────
      const behaviorMap = {}; // type → { label, users[] }
      const noBehaviorUsers = [];

      for (const uid of targetUserIds) {
        const rec = storedByUser[uid];
        if (!rec || !rec.behaviors || rec.behaviors.length === 0) {
          // noBehaviorUsers.push({ userId: uid, ...userInfoMap[uid] });
          continue;
        }

        for (const beh of rec.behaviors) {
          if (!behaviorMap[beh.type]) {
            behaviorMap[beh.type] = { type: beh.type, label: beh.label, users: [] };
          }
          behaviorMap[beh.type].users.push({
            userId: uid,
            ...userInfoMap[uid],
            tradeCount: beh.tradeCount,
            successRate: beh.successRate,
            profitAmount: beh.profitAmount,
            lossAmount: beh.lossAmount,
            netPnl: beh.netPnl,
            confidence: beh.confidence,
            totalTrades: rec.totalTrades,
            totalProfit: rec.totalProfit,
            totalLoss: rec.totalLoss,
            source: rec._isLive ? "live" : "stored",
          });
        }
      }

      // Sort each group by netPnl descending (best performers first)
      const groupedBehaviors = Object.values(behaviorMap)
        .map((g) => ({
          ...g,
          count: g.users.length,
          users: g.users.sort((a, b) => b.netPnl - a.netPnl),
        }))
        .sort((a, b) => b.count - a.count); // most common behavior first

      response.push({
        valanId: vidStr,
        valanLabel: valanDoc.label || valanDoc.keyidentifier,
        periodStart: valanDoc.startDate,
        periodEnd: valanDoc.endDate,
        isCurrent: valanDoc._isCurrent || false,
        totalUsers: targetUserIds.length,
        analyzedUsers: targetUserIds.length - noBehaviorUsers.length,
        groupedBehaviors,
        // noBehavior: noBehaviorUsers,
      });
    }

    // ── Date-range override (live, no valan) ─────────────────────────────────
    if (startDate && endDate) {
      const behaviorMap = {};
      const noBehaviorUsers = [];

      for (const uid of targetUserIds) {
        const live = await analyzeUserForPeriod(uid, { startDate, endDate });
        if (!live.behaviors || live.behaviors.length === 0) {
          // noBehaviorUsers.push({ userId: uid, ...userInfoMap[uid] });
          continue;
        }
        for (const beh of live.behaviors) {
          if (!behaviorMap[beh.type]) {
            behaviorMap[beh.type] = { type: beh.type, label: beh.label, users: [] };
          }
          behaviorMap[beh.type].users.push({
            userId: uid,
            ...userInfoMap[uid],
            tradeCount: beh.tradeCount,
            successRate: beh.successRate,
            profitAmount: beh.profitAmount,
            lossAmount: beh.lossAmount,
            netPnl: beh.netPnl,
            confidence: beh.confidence,
            totalTrades: live.totalTrades,
            totalProfit: live.totalProfit,
            totalLoss: live.totalLoss,
            source: "live",
          });
        }
      }

      const groupedBehaviors = Object.values(behaviorMap)
        .map((g) => ({
          ...g,
          count: g.users.length,
          users: g.users.sort((a, b) => b.netPnl - a.netPnl),
        }))
        .sort((a, b) => b.count - a.count);

      response.push({
        valanId: null,
        valanLabel: `${startDate} to ${endDate}`,
        periodStart: startDate,
        periodEnd: endDate,
        isCurrent: false,
        totalUsers: targetUserIds.length,
        analyzedUsers: targetUserIds.length - noBehaviorUsers.length,
        groupedBehaviors,
        // noBehavior: noBehaviorUsers,
      });
    }

    return res.json({ status: true, data: response });
  } catch (err) {
    console.error("[UserBehavior] getUsersBehaviorGrouped error:", err);
    return res.status(500).json({ status: false, message: "Internal server error." });
  }
};

module.exports = {
  getUserBehaviorAnalysis,
  uploadEventCalendar,
  getUserBehaviorHistory,
  getUsersBehaviorGrouped,
};
