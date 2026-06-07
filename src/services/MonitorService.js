'use strict';
/**
 * MonitorService — central hub for user activity surveillance.
 *
 * Responsibilities:
 *  1. Cache-backed lookup: is a given userId currently monitored?
 *  2. Fetch the watcher list for a monitored user.
 *  3. Format pretty Telegram Markdown messages per event type.
 *  4. Fire-and-forget notifications to each watcher's telegramChatId.
 */

const UserMonitor = require('../models/UserMonitorModel');
const UserModel = require('../models/UserModel');
const UAParser = require('ua-parser-js');
const parser = new UAParser();

// ── Device Parser ───────────────────────────────────────────────────────────
function getDeviceName(userAgent) {
  if (!userAgent || userAgent === '—' || userAgent === 'Unknown') return '—';
  // Detect Dart / Flutter (Mobile App)
  if (/dart/i.test(userAgent)) return 'Mobile App';
  
  const ua = parser.setUA(userAgent).getResult();
  let name = ua.os.name || '';
  if (ua.os.version) name += ` ${ua.os.version}`;
  if (ua.browser.name) name += ` (${ua.browser.name})`;
  return name || 'Unknown Device';
}

// ── Lazy-load the monitor bot so MonitorService can be required from
//   the main API process (which has no BOT_TOKEN_MONITOR) without crashing.
let _bot = null;
function getBot() {
  if (_bot) return _bot;
  const TelegramBot = require('node-telegram-bot-api');
  const token = process.env.BOT_TOKEN_MONITOR;
  if (!token) {
    // console.warn('[MonitorService] BOT_TOKEN_MONITOR not set — notifications disabled');
    return null;
  }
  _bot = new TelegramBot(token); // No polling — send-only
  return _bot;
}

// ── Redis cache key pattern ────────────────────────────────────────────────
const CACHE_TTL = 60; // seconds
let _redis = null;
async function redisGet(key) {
  try {
    if (!_redis) {
      const { redisClient } = require('../config/redis');
      _redis = redisClient;
    }
    return await _redis.get(key);
  } catch { return null; }
}
async function redisSet(key, val, ttl = CACHE_TTL) {
  try {
    if (!_redis) {
      const { redisClient } = require('../config/redis');
      _redis = redisClient;
    }
    await _redis.set(key, val, 'EX', ttl);
  } catch { /* non-critical */ }
}
async function redisDel(key) {
  try {
    if (!_redis) {
      const { redisClient } = require('../config/redis');
      _redis = redisClient;
    }
    await _redis.del(key);
  } catch { /* non-critical */ }
}

// ── IST time formatter ─────────────────────────────────────────────────────
function formatIST(date = new Date()) {
  return new Intl.DateTimeFormat('en-IN', {
    timeZone: 'Asia/Kolkata',
    year: 'numeric',
    month: 'short',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: true
  }).format(date instanceof Date ? date : new Date(date));
}

// ── Escape MarkdownV2 special chars ───────────────────────────────────────
function esc(s) {
  return String(s ?? '—').replace(/([_*[\]()~`>#+\-=|{}.!\\])/g, '\\$1');
}

// ─────────────────────────────────────────────────────────────────────────────
// isMonitored(userId, parentIds)  — Redis-cached check
// ─────────────────────────────────────────────────────────────────────────────
async function isMonitored(userId, parentIds = []) {
  const idsToCheck = [userId, ...parentIds];
  
  // For efficiency, we check DB directly for hierarchical monitoring.
  // We can still cache the aggregate result for the specific user.
  const key = `monitor:active:h:${userId}`;
  const cached = await redisGet(key);
  if (cached !== null) return cached === '1';

  const exists = await UserMonitor.exists({ monitoredUserId: { $in: idsToCheck }, isActive: true });
  await redisSet(key, exists ? '1' : '0', CACHE_TTL);
  return !!exists;
}

// ─────────────────────────────────────────────────────────────────────────────
// getWatchers(userId, parentIds)  — returns all watchers for the user hierarchy
// ─────────────────────────────────────────────────────────────────────────────
async function getWatchers(monitoredUserId, parentIds = []) {
  const idsToCheck = [monitoredUserId, ...parentIds];
  
  const entries = await UserMonitor.find({ monitoredUserId: { $in: idsToCheck }, isActive: true })
    .populate('monitoredUserId', 'accountName accountCode')
    .select('addedBy monitoredUserId')
    .lean();

  if (!entries.length) return [];

  const watcherMap = {};
  entries.forEach(e => {
    if (!e.addedBy) return;
    const wId = e.addedBy.toString();
    if (!watcherMap[wId]) {
      watcherMap[wId] = e.monitoredUserId;
    }
  });

  const watcherIds = Object.keys(watcherMap);
  const watchers = await UserModel.find({ _id: { $in: watcherIds }, isDeleted: false })
    .select('_id accountCode accountName monitorTelegramChatId monitorTelegramGroupChatId')
    .lean();

  return watchers
    .filter(w => w.monitorTelegramChatId || w.monitorTelegramGroupChatId)
    .map(w => ({
      ...w,
      explicitMonitoredUser: watcherMap[w._id.toString()]
    }));
}

// ─────────────────────────────────────────────────────────────────────────────
function formatMessage(eventType, monitoredUser, actorUser, details = {}, explicitMonitoredUser = null) {
  const time = esc(formatIST(details.time || new Date()));

  const mName = esc(monitoredUser?.accountName || 'Unknown');
  const mCode = esc(monitoredUser?.accountCode || '—');

  const actorName = esc(actorUser?.accountName || 'Unknown');
  const actorCode = esc(actorUser?.accountCode || '—');

  const isSelf = actorUser?._id?.toString() === monitoredUser?._id?.toString();
  const isML   = details.isMultiLogin || false;

  let actorLine;
  if (isSelf) {
    actorLine = `👤 *Actor:* ${actorName} \\(${actorCode}\\) \\— _themselves_`;
  } else if (isML) {
    actorLine = `👤 *Actor:* ${actorName} \\(${actorCode}\\) \\— via *multi\\-login*`;
  } else {
    actorLine = `👤 *Actor:* ${actorName} \\(${actorCode}\\)`;
  }

  const ip  = esc(details.ip  || '—');
  const dev = esc(getDeviceName(details.device || '—'));

  // ── Event-specific icon + label ──────────────────────────────────────────
  const EVENT_META = {
    LOGIN:          { icon: '🔑', label: 'Logged In'           },
    LOGOUT:         { icon: '🚪', label: 'Logged Out'          },
    OFFLINE:        { icon: '📴', label: 'Gone Offline'        },
    TRADE_PLACED:   { icon: '📈', label: 'Trade Placed'        },
    LIMIT_PLACED:   { icon: '⏳', label: 'Limit Placed'        },
    LIMIT_PASSED:   { icon: '🎯', label: 'Limit Triggered'     },
    TRADE_EDITED:   { icon: '✏️',  label: 'Trade Edited'        },
    LIMIT_EDITED:   { icon: '✏️',  label: 'Limit Edited'        },
    TRADE_DELETED:  { icon: '🗑', label: 'Trade Deleted'       },
    LIMIT_DELETED:  { icon: '🗑', label: 'Limit Deleted'       },
    POSITION_EXIT:  { icon: '📤', label: 'Position Exit'       },
    SQUARE_OFF:     { icon: '⚠️',  label: 'Auto Square-Off'     }
  };
  const meta = EVENT_META[eventType] || { icon: '🔔', label: eventType };

  let lines = [
    `🔔 *User Activity Alert*`,
    ``,
    `${meta.icon} *Action:* ${esc(meta.label)}`,
    ``,
    `👤 *Monitored User:* ${mName} \\(${mCode}\\)`,
    actorLine,
    `🕐 *Time:* ${time}`,
  ];

  // ── Trade / Limit details ────────────────────────────────────────────────
  if (['TRADE_PLACED', 'LIMIT_PLACED', 'LIMIT_PASSED', 'TRADE_EDITED', 'LIMIT_EDITED', 'TRADE_DELETED', 'LIMIT_DELETED', 'POSITION_EXIT', 'SQUARE_OFF'].includes(eventType)) {
    const symbol   = esc(details.label    || details.scriptName || details.scriptId || '—');
    const txnType  = esc(details.transactionType || '—');
    const lots     = esc(details.lot      ?? '—');
    const qty      = esc(details.quantity ?? '—');
    const price    = esc(details.price != null ? `₹${Number(details.price).toLocaleString('en-IN')}` : '—');
    const mktName  = esc(details.marketName || details.marketId || '—');
    const order    = esc(details.orderType  || '—');

    lines.push(
      ``,
      `📊 *Trade Details:*`,
      `  • Script: ${symbol}`,
      `  • Type: *${txnType}*   Order: ${order}`
    );

    // ── Edit / Limit-Pass Diffs ────────────────────────────────────────────
    if ((eventType === 'TRADE_EDITED' || eventType === 'LIMIT_EDITED' || eventType === 'LIMIT_PASSED') && details.oldValues) {
      const old = details.oldValues;
      const cur = details;

      const lotChanged = old.lot !== cur.lot;
      const qtyChanged = old.quantity !== cur.quantity;
      const prcChanged = Number(old.price) !== Number(cur.price);

      if (lotChanged) lines.push(`  • Lots: ${esc(old.lot)} → *${lots}*`);
      else lines.push(`  • Lots: ${lots}`);

      if (qtyChanged) lines.push(`  • Qty: ${esc(old.quantity)} → *${qty}*`);
      else lines.push(`  • Qty: ${qty}`);

      if (prcChanged) {
        const oldP = esc(`₹${Number(old.price).toLocaleString('en-IN')}`);
        lines.push(`  • Price: ${oldP} → *${price}*`);
      } else {
        lines.push(`  • Price: ${price}`);
      }
    } else {
      lines.push(
        `  • Lots: ${lots}   Qty: ${qty}`,
        `  • Price: ${price}`
      );
    }

    lines.push(`  • Market: ${mktName}`);

    if (details.reason) {
      lines.push(`  • Reason: _${esc(details.reason)}_`);
    }
  }

  // ── Universal Meta Info (IP & Device) ────────────────────────────────────
  lines.push(
    ``,
    `🌐 *IP:* ${ip}`,
    `📱 *Device:* ${dev}`
  );

  // Add reason line if applicable
  if (explicitMonitoredUser && explicitMonitoredUser._id.toString() !== monitoredUser._id?.toString()) {
    lines.push(
      ``,
      `ℹ️ _Alert Reason: You monitor_ *${esc(explicitMonitoredUser.accountName)}* \\(${esc(explicitMonitoredUser.accountCode)}\\)`
    );
  }

  lines.push(``, `\\-\\-\\-`, `_Sent by Ocean Exchange Monitor_`);

  return lines.join('\n');
}

// ─────────────────────────────────────────────────────────────────────────────
// notifyWatchers(monitoredUserId, eventType, details)
// Fire-and-forget. Never throws.
// details: { loginUserId, actorUser, ip, device, isMultiLogin, parentIds, ...tradeFields }
// ─────────────────────────────────────────────────────────────────────────────
async function notifyWatchers(monitoredUserId, eventType, details = {}) {
  try {
    // console.log(`[MonitorService] notifyWatchers called — userId:${monitoredUserId} event:${eventType}`);

    const monitoredUser = await UserModel.findById(monitoredUserId)
      .select('accountCode accountName parentIds _id')
      .lean();
    if (!monitoredUser) { return; }

    const parentIds = details.parentIds || monitoredUser.parentIds || [];

    const monitored = await isMonitored(monitoredUserId, parentIds);
    // console.log(`[MonitorService] isMonitored=${monitored} for ${monitoredUser.accountCode}`);
    if (!monitored) return;

    const watchers = await getWatchers(monitoredUserId, parentIds);
    // console.log(`[MonitorService] watchers found: ${watchers.length}`, watchers.map(w => ({ code: w.accountCode, dmChatId: w.monitorTelegramChatId, groupChatId: w.monitorTelegramGroupChatId })));
    if (!watchers.length) return;

    let actorUser = details.actorUser || null;
    if (!actorUser && details.loginUserId) {
      actorUser = await UserModel.findById(details.loginUserId)
        .select('accountCode accountName _id')
        .lean();
    }

    const bot = getBot();
    if (!bot) { console.log('[MonitorService] bot not available — BOT_TOKEN_MONITOR missing?'); return; }

    // ── Convert event type based on status ──────────────────────────────
    let effectiveEvent = eventType;
    
    // If OFFLINE event, convert to LOGOUT
    if (eventType === 'OFFLINE') {
      effectiveEvent = 'LOGOUT';
    }
    
    // If TRADE_EDITED/TRADE_DELETED and status is PENDING, convert to LIMIT_EDITED/LIMIT_DELETED
    if (eventType === 'TRADE_EDITED' && details.transactionStatus === 'PENDING') {
      console.log(`[MonitorService] Converting TRADE_EDITED to LIMIT_EDITED (status: ${details.transactionStatus})`);
      effectiveEvent = 'LIMIT_EDITED';
    }
    if (eventType === 'TRADE_DELETED' && details.transactionStatus === 'PENDING') {
      console.log(`[MonitorService] Converting TRADE_DELETED to LIMIT_DELETED (status: ${details.transactionStatus})`);
      effectiveEvent = 'LIMIT_DELETED';
    }
    
    console.log(`[MonitorService] Event: ${eventType} → ${effectiveEvent}, Status: ${details.transactionStatus}`);

    for (const watcher of watchers) {
      const text = formatMessage(
        effectiveEvent,
        monitoredUser,
        actorUser || monitoredUser,
        details,
        watcher.explicitMonitoredUser
      );

      if (watcher.monitorTelegramChatId) {
        bot.sendMessage(watcher.monitorTelegramChatId, text, { parse_mode: 'MarkdownV2' })
          .then(() => console.log(`[MonitorService] DM sent to ${watcher.accountCode} (${effectiveEvent})`))
          .catch((err) => {
            console.error(`[MonitorService] DM FAILED for ${watcher.accountCode}:`, err.message);
            if (err.message.includes('403') || err.message.includes('blocked') || err.message.includes('chat not found')) {
              UserModel.updateOne({ _id: watcher._id }, { $unset: { monitorTelegramChatId: '', monitorTelegramId: '' } })
                .catch(() => {});
              console.warn(`[MonitorService] Cleared stale DM link for ${watcher.accountCode} — user must re-link bot`);
            }
          });
      }

      if (watcher.monitorTelegramGroupChatId) {
        bot.sendMessage(watcher.monitorTelegramGroupChatId, text, { parse_mode: 'MarkdownV2' })
          .then(() => console.log(`[MonitorService] Group sent to ${watcher.accountCode} (${effectiveEvent})`))
          .catch((err) => {
            console.error(`[MonitorService] Group FAILED for ${watcher.accountCode}:`, err.message);
            if (err.message.includes('403') || err.message.includes('blocked') || err.message.includes('chat not found') || err.message.includes('kicked')) {
              UserModel.updateOne({ _id: watcher._id }, { $unset: { monitorTelegramGroupChatId: '' } })
                .catch(() => {});
              console.warn(`[MonitorService] Cleared stale group link for ${watcher.accountCode} — bot removed or group invalid`);
            }
          });
      }
    }
  } catch (err) {
    console.error('[MonitorService] notifyWatchers error:', err.message, err.stack);
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// sendMonitorSummary(watcherId)
// Sends a list of monitored users to the watcher upon login.
// ─────────────────────────────────────────────────────────────────────────────
async function sendMonitorSummary(watcherId) {
  try {
    const watcher = await UserModel.findById(watcherId).select('monitorTelegramChatId accountName accountCode').lean();
    if (!watcher || !watcher.monitorTelegramChatId) return;

    const entries = await UserMonitor.find({ addedBy: watcherId, isActive: true })
      .select('monitoredUserId')
      .lean();

    if (!entries.length) return;

    const monitoredIds = entries.map(e => e.monitoredUserId);
    const monitoredUsers = await UserModel.find({ _id: { $in: monitoredIds }, isDeleted: false })
      .select('accountName accountCode')
      .lean();

    if (!monitoredUsers.length) return;

    const bot = getBot();
    if (!bot) return;

    let text = `👋 *Welcome Back, ${esc(watcher.accountName)}*\n\nYou are currently monitoring these users:\n\n`;
    monitoredUsers.forEach((u, index) => {
      text += `${index + 1}\\. *${esc(u.accountName)}* \\(${esc(u.accountCode)}\\)\n`;
    });
    text += `\n_You will receive real\\-time alerts for their activities and those of their downline\\._`;

    bot.sendMessage(watcher.monitorTelegramChatId, text, { parse_mode: 'MarkdownV2' }).catch((err) => {
      console.error(`[MonitorService] Failed to send summary to ${watcher.accountCode}:`, err.message);
    });
  } catch (err) {
    console.error('[MonitorService] sendMonitorSummary error:', err.message);
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Cache invalidation helpers (called by MonitorController on add/remove)
// ─────────────────────────────────────────────────────────────────────────────
async function invalidateCache(monitoredUserId) {
  // Broadly invalidate any hierarchical cache affected by this user
  // This is hard to pinpoint, so we rely on the 60s TTL or a pattern-based flush if needed.
  // For now, we clear the direct user's hierarchical cache.
  await redisDel(`monitor:active:h:${monitoredUserId}`);
}

module.exports = {
  isMonitored,
  getWatchers,
  notifyWatchers,
  sendMonitorSummary,
  invalidateCache,
  formatMessage // exported for testing
};
