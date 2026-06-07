'use strict';
/**
 * MonitorController — CRUD for user watch list.
 *
 * Allowed roles: levels 1–5 (SuperAdmin → Master).
 * Brokers (6) and Clients (7) cannot monitor users.
 */

const UserMonitor = require('../models/UserMonitorModel');
const UserModel   = require('../models/UserModel');
const { invalidateCache } = require('../services/MonitorService');
const { getLoginUserId, getEffectiveUserId } = require('../utils/contextHelpers');
const mongoose = require('mongoose');

// Services for real-time status and M2M (Summary Report logic)
const { hgetall } = require('../services/RedisService');
const { getProfitLossWithLivePrices, setGetValanDetails } = require('../services/StockService');
const { getLastSeen } = require('../services/UserService');

// ── Helper: verify the target user is in the requester's downline ─────────
async function isInDownline(requesterId, targetId) {
  const target = await UserModel.findById(targetId)
    .select('parentIds')
    .lean();
  if (!target) return false;
  return (target.parentIds || []).some(pid => pid.toString() === requesterId.toString());
}

// ─────────────────────────────────────────────────────────────────────────────
// POST /api/monitor/add
// Body: { monitoredUserId }
// ─────────────────────────────────────────────────────────────────────────────
exports.addMonitor = async (req, res) => {
  try {
    const addedBy       = getLoginUserId(req);
    const requesterLevel = req.user?.accountType?.level;

    // Only levels 1–5 allowed
    if (!requesterLevel || requesterLevel > 5) {
      return res.status(403).json({
        status: false,
        message: 'Only SuperAdmin, Admin, Sub-Admin, Super Master, and Master can add users to monitoring'
      });
    }

    const { monitoredUserId } = req.body;
    if (!monitoredUserId || !mongoose.Types.ObjectId.isValid(monitoredUserId)) {
      return res.status(400).json({ status: false, message: 'Valid monitoredUserId is required' });
    }

    // Cannot monitor yourself
    if (monitoredUserId.toString() === addedBy.toString()) {
      return res.status(400).json({ status: false, message: 'You cannot monitor yourself' });
    }

    // Target user must exist
    const targetUser = await UserModel.findById(monitoredUserId)
      .select('_id accountCode accountName parentIds')
      .lean();
    if (!targetUser) {
      return res.status(404).json({ status: false, message: 'Target user not found' });
    }

    // Target must be in requester's downline
    const downline = await isInDownline(addedBy, monitoredUserId);
    if (!downline) {
      return res.status(403).json({
        status: false,
        message: 'You can only monitor users within your own downline'
      });
    }

    // Upsert (set isActive = true in case they re-add an old entry)
    await UserMonitor.findOneAndUpdate(
      { monitoredUserId, addedBy },
      { monitoredUserId, addedBy, isActive: true },
      { upsert: true, new: true, setDefaultsOnInsert: true }
    );

    // Invalidate Redis cache
    await invalidateCache(monitoredUserId);

    return res.status(200).json({
      status: true,
      message: `${targetUser.accountName} (${targetUser.accountCode}) added to monitoring`
    });
  } catch (err) {
    console.error('[MonitorController.addMonitor]', err);
    return res.status(500).json({ status: false, message: err.message || 'Server error' });
  }
};

// ─────────────────────────────────────────────────────────────────────────────
// DELETE /api/monitor/remove/:monitoredUserId
// ─────────────────────────────────────────────────────────────────────────────
exports.removeMonitor = async (req, res) => {
  try {
    const addedBy = getLoginUserId(req);
    const { monitoredUserId } = req.params;

    if (!mongoose.Types.ObjectId.isValid(monitoredUserId)) {
      return res.status(400).json({ status: false, message: 'Invalid monitoredUserId' });
    }

    const entry = await UserMonitor.deleteOne(
      { monitoredUserId, addedBy });

    if (!entry) {
      return res.status(404).json({ status: false, message: 'Monitor entry not found or not owned by you' });
    }

    await invalidateCache(monitoredUserId);

    return res.status(200).json({ status: true, message: 'User removed from monitoring' });
  } catch (err) {
    console.error('[MonitorController.removeMonitor]', err);
    return res.status(500).json({ status: false, message: err.message || 'Server error' });
  }
};

// ─────────────────────────────────────────────────────────────────────────────
// GET /api/monitor/list
// Returns all active users the current requester is watching.
// ─────────────────────────────────────────────────────────────────────────────
exports.listMonitored = async (req, res) => {
  try {
    const addedBy = getLoginUserId(req);
    const requesterLevel = req.user?.accountType?.level;

    if (!requesterLevel || requesterLevel > 5) {
      return res.status(403).json({ status: false, message: 'Access denied' });
    }

    const entries = await UserMonitor.find({ addedBy, isActive: true })
      .select('monitoredUserId createdAt')
      .lean();

    const userIds = entries.map(e => e.monitoredUserId);
    const users   = await UserModel.find({ _id: { $in: userIds }, isDeleted: false })
      .select('accountCode accountName status')
      .populate('accountType', 'label level')
      .lean();

    const map = new Map(users.map(u => [u._id.toString(), u]));

    // 1. Fetch Active Valan and Calculate Live M2M (Matches Summary Report Logic)
    const activeValan = await setGetValanDetails();
    const liveResults = await getProfitLossWithLivePrices({
      transactionStatus: 'COMPLETED',
      userId: { $in: userIds },
      valanId: activeValan?._id
    }, requesterLevel, addedBy);

    const m2mDataMap = new Map();
    if (liveResults && liveResults.data) {
      liveResults.data.forEach(r => {
        // selfNetPrice is the share-based P&L from the requester's perspective
        // r.m2m is the total house pooled M2M (net result) for that user
        m2mDataMap.set(String(r.userId), {
          selfM2m: Number(r.selfNetPrice || 0),
          totalM2m: Number(r.m2m || 0)
        });
      });
    }

    // 2. Fetch Online Status from Redis
    const allStatuses = await hgetall('onlineStatus');
    const onlineSet = new Set(
      Object.entries(allStatuses || {})
        .filter(([_, s]) => String(s).trim().toLowerCase() === 'online')
        .map(([id]) => String(id))
    );

    // 3. Assemble results with Last Seen status and M2M
    const result = (await Promise.all(entries.map(async (e) => {
      const u = map.get(e.monitoredUserId.toString());
      if (!u) return { accountCode: '—' };

      const isOnline = onlineSet.has(u._id.toString());
      const lastSeenRaw = await getLastSeen(u._id, isOnline);
      const m2mData = m2mDataMap.get(u._id.toString()) || { selfM2m: 0, totalM2m: 0 };

      return {
        monitoredUserId: e.monitoredUserId,
        accountCode:     u.accountCode  || '—',
        accountName:     u.accountName  || '—',
        status : u.status || '-',
        role:            u.accountType?.label || '—',
        addedAt:         e.createdAt,
        lastSeen:        lastSeenRaw,
        m2m:             Number(m2mData.selfM2m.toFixed(4)),
        totalM2m:        Number(m2mData.totalM2m.toFixed(4))
      };
    }))).filter(r => r.accountCode !== '—');

    return res.status(200).json({ status: true, data: result });
  } catch (err) {
    console.error('[MonitorController.listMonitored]', err);
    return res.status(500).json({ status: false, message: err.message || 'Server error' });
  }
};

// ─────────────────────────────────────────────────────────────────────────────
// GET /api/monitor/who-added/:monitoredUserId
// Returns who is watching this user (admin visibility).
// ─────────────────────────────────────────────────────────────────────────────
exports.whoAdded = async (req, res) => {
  try {
    const requesterLevel = req.user?.accountType?.level;
    if (!requesterLevel || requesterLevel > 5) {
      return res.status(403).json({ status: false, message: 'Access denied' });
    }

    const { monitoredUserId } = req.params;
    if (!mongoose.Types.ObjectId.isValid(monitoredUserId)) {
      return res.status(400).json({ status: false, message: 'Invalid monitoredUserId' });
    }

    const entries = await UserMonitor.find({ monitoredUserId, isActive: true })
      .select('addedBy createdAt')
      .lean();

    const watcherIds = entries.map(e => e.addedBy);
    const watchers   = await UserModel.find({ _id: { $in: watcherIds }, isDeleted: false })
      .select('accountCode accountName')
      .populate('accountType', 'label level')
      .lean();

    const map = new Map(watchers.map(w => [w._id.toString(), w]));

    const result = entries.map(e => {
      const w = map.get(e.addedBy.toString());
      return {
        watcherId:   e.addedBy,
        accountCode: w?.accountCode || '—',
        accountName: w?.accountName || '—',
        role:        w?.accountType?.label || '—',
        addedAt:     e.createdAt
      };
    });

    return res.status(200).json({ status: true, data: result });
  } catch (err) {
    console.error('[MonitorController.whoAdded]', err);
    return res.status(500).json({ status: false, message: err.message || 'Server error' });
  }
};
