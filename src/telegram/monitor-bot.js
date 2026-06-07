'use strict';
/**
 * ─────────────────────────────────────────────────────────────────────────────
 * 🌊 Ocean Exchange — Telegram Monitoring Bot
 * ─────────────────────────────────────────────────────────────────────────────
 * Run:        node src/telegram/monitor-bot.js
 * Production: pm2 start src/telegram/monitor-bot.js --name ocean-monitor-bot
 * ─────────────────────────────────────────────────────────────────────────────
 * This bot is dedicated to sending real-time activity alerts to admins.
 * It uses BOT_TOKEN_MONITOR and its own chat-binding fields.
 */

require('dotenv').config({
  path: require('path').join(__dirname, '../../.env'),
});

const TelegramBot = require('node-telegram-bot-api');
const mongoose = require('mongoose');
const UserModel = require('../models/UserModel');
const UserTypeModel = require('../models/UserTypeModel'); // Register UserType schema
const UserMonitor = require('../models/UserMonitorModel'); // Monitor status lookup

// ── DB Connection ────────────────────────────────────────────────────────────
mongoose
  .connect(process.env.MONGODB_URI)
  .then(() => console.log('[MonitorBot] MongoDB connected'))
  .catch((err) => {
    console.error('[MonitorBot] DB error:', err);
    process.exit(1);
  });

// ── Bot Initialization ────────────────────────────────────────────────────────
const token = process.env.BOT_TOKEN_MONITOR;
if (!token) {
  console.error('[MonitorBot] BOT_TOKEN_MONITOR is missing in .env');
  process.exit(1);
}
const bot = new TelegramBot(token, {
  polling: {
    autoStart: true,
    interval: 1000,
    params: { timeout: 10 }
  }
});
console.log(`[MonitorBot] Running... token suffix: ...${token.slice(-8)}`);

// ── Polling Error Recovery ────────────────────────────────────────────────────
// EFATAL stops polling entirely; restart with exponential backoff.
let _restartDelay = 5_000;
let _restartTimer = null;

bot.on('polling_error', (err) => {
  const code = err.code || 'UNKNOWN';
  const msg = (err.message || String(err)).substring(0, 120);

  if (code === 'EFATAL') {
    // Only log once per restart cycle to avoid log spam
    if (!_restartTimer) {
      console.error(`[MonitorBot] EFATAL — ${msg}`);
      console.log(`[MonitorBot] Restarting polling in ${_restartDelay / 1000}s...`);
      _restartTimer = setTimeout(() => {
        _restartTimer = null;
        bot.startPolling({ restart: true })
          .then(() => {
            console.log('[MonitorBot] Polling restarted successfully');
            _restartDelay = 5_000; // reset on success
          })
          .catch((e) => {
            console.error('[MonitorBot] Restart failed:', e.message);
            _restartDelay = Math.min(_restartDelay * 2, 120_000); // max 2 min backoff
          });
      }, _restartDelay);
    }
  } else {
    // Non-fatal: log and continue (library keeps polling)
    console.warn(`[MonitorBot] Polling warning [${code}]: ${msg}`);
  }
});

// Cache bot's own ID so we can detect when it's added to a group
let botInfo = null;
bot.getMe().then(info => { botInfo = info; }).catch(console.error);

// ── State Management ──────────────────────────────────────────────────────────
const sessions = {};
function sess(fromId) {
  if (!sessions[fromId]) sessions[fromId] = { state: 'IDLE' };
  return sessions[fromId];
}

// ── Pending Device Verifications ──────────────────────────────────────────────
// { [oldFromId]: { correctNum, newFromId, newChatId, oldChatId, userId, timer } }
const pendingVerifications = {};

function genVerifyNums() {
  const set = new Set();
  while (set.size < 3) set.add(Math.floor(Math.random() * 90) + 10);
  const nums = [...set];
  const correct = nums[Math.floor(Math.random() * 3)];
  return { nums, correct };
}

// ── Menu Helpers ─────────────────────────────────────────────────────────────
const MENU_LABELS = {
  LIST:         '📋 Monitored Users',
  UNLINK:       '🔗 Unlink Account',
  LINK_GROUP:   '🏘️ Link Group',
  UNLINK_GROUP: '🔓 Unlink Group'
};

async function sendMainMenu(chatId, text) {
  return bot.sendMessage(chatId, text, {
    reply_markup: {
      keyboard: [
        [MENU_LABELS.LIST, MENU_LABELS.UNLINK],
        [MENU_LABELS.LINK_GROUP, MENU_LABELS.UNLINK_GROUP]
      ],
      resize_keyboard: true,
      persistent: true
    },
    parse_mode: 'Markdown'
  });
}

// ── Auth Helper ──────────────────────────────────────────────────────────────
async function getUser(fromId, chatId) {
  const s = sess(fromId);
  if (s.user) return s.user;

  const u = await UserModel.findOne({ monitorTelegramId: String(fromId), isDeleted: false })
    .populate('accountType')
    .lean();

  if (u) {
    s.user = u;
    // Always sync chatId in case it's a new conversation
    if (chatId) {
      await UserModel.updateOne({ _id: u._id }, { monitorTelegramChatId: chatId });
    }
    return u;
  }
  return null;
}

// ── Commands ─────────────────────────────────────────────────────────────────

// /start — Begin Authentication Flow
bot.onText(/\/start/, async (msg) => {
  const chatId = msg.chat.id;
  const fromId = msg.from.id;
  const s = sess(fromId);

  try {
    const user = await getUser(fromId, chatId);
    if (user) {
      return sendMainMenu(chatId, `✅ *Authenticated: ${user.accountName}*\n\nYou are linked to this monitoring bot. Use the menu below to manage your watch list.`);
    }

    s.state = 'WAITING_CODE';
    bot.sendMessage(
      chatId,
      '👋 *Welcome to Ocean Exchange Monitoring*\n\nPlease enter your *Account Code* to link this Telegram account:',
      { parse_mode: 'Markdown' }
    );
  } catch (err) {
    console.error(err);
  }
});

// ── Shared Actions ───────────────────────────────────────────────────────────

const esc = (s) => String(s ?? "").replace(/([_*`\[\]\(\)~>#\+\-=\|{}\.!])/g, "\\$1");

async function handleList(chatId, fromId) {
  const user = await getUser(fromId, chatId);
  if (!user) return bot.sendMessage(chatId, '❌ You are not linked. Use /start to begin.');

  const entries = await UserMonitor.find({ addedBy: user._id, isActive: true })
    .select('monitoredUserId')
    .lean();

  if (!entries.length) {
    return bot.sendMessage(chatId, '📭 Your watch list is currently empty. You can add users via the admin panel.');
  }

  const monitoredIds = entries.map(e => e.monitoredUserId);
  const monitoredUsers = await UserModel.find({ _id: { $in: monitoredIds }, isDeleted: false })
    .select('accountName accountCode accountType')
    .populate('accountType', 'label')
    .lean();

  const groupedUsers = {};
  monitoredUsers.forEach((u) => {
    const typeLabel = u.accountType?.label || 'Other';
    if (!groupedUsers[typeLabel]) groupedUsers[typeLabel] = [];
    groupedUsers[typeLabel].push(u);
  });

  let text = `📋 *Monitored Users List*\n\n`;
  
  for (const [type, users] of Object.entries(groupedUsers)) {
    text += `*_${esc(type)}_*:\n`;
    users.forEach((u, index) => {
      text += `  ${index + 1}\\. *${esc(u.accountName)}* \\(${esc(u.accountCode)}\\)\n`;
    });
    text += `\n`;
  }

  text += `_You will receive real\\-time alerts for these users and their downline\\._`;

  bot.sendMessage(chatId, text, { parse_mode: 'MarkdownV2' });
}

async function handleUnlink(chatId, fromId) {
  const s = sess(fromId);
  const user = await getUser(fromId, chatId);
  
  if (!user) return bot.sendMessage(chatId, '❌ This account is not linked.');

  await UserModel.updateOne(
    { _id: user._id },
    { $unset: { monitorTelegramId: "", monitorTelegramChatId: "" } }
  );

  delete s.user;
  s.state = 'IDLE';

  bot.sendMessage(chatId, '✅ *Success:* Your account has been unlinked. You will no longer receive alerts.', { 
    reply_markup: { remove_keyboard: true },
    parse_mode: 'Markdown' 
  });
}

async function handleUnlinkGroup(chatId, fromId) {
  const user = await getUser(fromId, chatId);
  if (!user) return bot.sendMessage(chatId, '❌ You are not linked. Use /start to begin.');

  const fresh = await UserModel.findById(user._id).select('monitorTelegramGroupChatId').lean();
  if (!fresh?.monitorTelegramGroupChatId) return bot.sendMessage(chatId, '📭 No group is currently linked.');

  const groupChatId = fresh.monitorTelegramGroupChatId;
  await UserModel.updateOne({ _id: user._id }, { $unset: { monitorTelegramGroupChatId: '' } });
  const s = sess(fromId);
  if (s.user) delete s.user.monitorTelegramGroupChatId;

  // Notify the group itself
  bot.sendMessage(groupChatId,
    `🔓 *Group unlinked\\.* Monitoring alerts for *${esc(user.accountName)}* will no longer be sent here\\.`,
    { parse_mode: 'MarkdownV2' }
  ).catch(() => {});

  return bot.sendMessage(chatId, '✅ *Group unlinked.* Alerts will no longer be sent to that group.', { parse_mode: 'Markdown' });
}

// ── General Message Handler ───────────────────────────────────────────────
bot.on('message', async (msg) => {
  if (!msg.text) return;
  const chatId = msg.chat.id;
  const fromId = msg.from.id;
  const text = msg.text.trim();

  // ── Group: bot added to group ─────────────────────────────────────────────
  if (msg.new_chat_members && botInfo && (msg.chat.type === 'group' || msg.chat.type === 'supergroup')) {
    const botAdded = msg.new_chat_members.some(m => m.id === botInfo.id);
    if (botAdded) {
      const groupName = esc(msg.chat.title || 'this group');
      // Welcome in group
      bot.sendMessage(chatId,
        `👋 *Ocean Exchange Monitor Bot*\n\nSend \`/linkgroup\` here to link this group for monitoring alerts\\.\nOnly one owner can link per group\\.`,
        { parse_mode: 'MarkdownV2' }
      ).catch(() => {});
      // DM the person who added bot (if they're linked)
      const adder = await UserModel.findOne({ monitorTelegramId: String(fromId), isDeleted: false })
        .select('monitorTelegramChatId accountName').lean();
      if (adder?.monitorTelegramChatId) {
        bot.sendMessage(adder.monitorTelegramChatId,
          `ℹ️ Bot was added to *${groupName}*\\. Send \`/linkgroup\` in that group to start receiving alerts there\\.`,
          { parse_mode: 'MarkdownV2' }
        ).catch(() => {});
      }
    }
    return;
  }

  // ── Group: /linkgroup command ─────────────────────────────────────────────
  // In groups Telegram appends bot username: /linkgroup@BotName — strip it
  if (text.split('@')[0] === '/linkgroup' && (msg.chat.type === 'group' || msg.chat.type === 'supergroup')) {
    try {
      const user = await getUser(fromId, null); // null: don't override DM chatId
      if (!user) {
        return bot.sendMessage(chatId, '❌ Your Telegram account is not linked to this bot. Open a DM with the bot and use /start first.');
      }

      // One owner per group — block if already claimed by someone else
      const existingOwner = await UserModel.findOne({
        monitorTelegramGroupChatId: chatId,
        isDeleted: false,
        _id: { $ne: user._id }
      }).select('accountName accountCode').lean();

      if (existingOwner) {
        return bot.sendMessage(chatId,
          `❌ This group is already linked by *${esc(existingOwner.accountName)}* \\(${esc(existingOwner.accountCode)}\\)\\. Only one owner per group is allowed\\.`,
          { parse_mode: 'MarkdownV2' }
        );
      }

      await UserModel.updateOne({ _id: user._id }, { monitorTelegramGroupChatId: chatId });
      const s = sess(fromId);
      if (s.user) s.user.monitorTelegramGroupChatId = chatId;

      const groupName = esc(msg.chat.title || 'this group');
      // Confirm in group
      bot.sendMessage(chatId,
        `✅ *Group linked\\!* Only alerts for *${esc(user.accountName)}*'s monitored users will be sent here\\.`,
        { parse_mode: 'MarkdownV2' }
      ).catch(() => {});
      // Also DM the owner
      if (user.monitorTelegramChatId) {
        bot.sendMessage(user.monitorTelegramChatId,
          `✅ *Group linked\\!* *${groupName}* is now receiving alerts for your monitored users\\.`,
          { parse_mode: 'MarkdownV2' }
        ).catch(() => {});
      }
    } catch (err) {
      console.error('[MonitorBot] /linkgroup error:', err);
    }
    return;
  }

  // Only handle private DM messages below
  if (msg.chat.type !== 'private') return;

  const s = sess(fromId);

  // Slash commands
  if (text === '/status') return handleList(chatId, fromId);
  if (text === '/unlink') return handleUnlink(chatId, fromId);
  if (text === '/unlinkgroup') return handleUnlinkGroup(chatId, fromId);
  if (text === '/groupstatus') {
    const user = await getUser(fromId, chatId);
    if (!user) return bot.sendMessage(chatId, '❌ Not linked. Use /start to begin.');
    const fresh = await UserModel.findById(user._id).select('monitorTelegramGroupChatId').lean();
    if (fresh?.monitorTelegramGroupChatId) {
      return bot.sendMessage(chatId, `🏘️ *Group linked*\nChat ID: \`${fresh.monitorTelegramGroupChatId}\``, { parse_mode: 'Markdown' });
    }
    return bot.sendMessage(chatId, '📭 No group linked. Add bot to a group and send /linkgroup there.');
  }
  if (text === '/testalert') {
    const user = await getUser(fromId, chatId);
    if (!user) return bot.sendMessage(chatId, '❌ Not linked. Use /start to begin.');
    const fresh = await UserModel.findById(user._id).select('monitorTelegramGroupChatId').lean();
    if (!fresh?.monitorTelegramGroupChatId) {
      return bot.sendMessage(chatId, '📭 No group linked. Nothing to test.');
    }
    const groupId = fresh.monitorTelegramGroupChatId;
    try {
      await bot.sendMessage(groupId, `🔔 *Test Alert*\n\nThis is a test message from *${esc(user.accountName)}*\\. If you see this, group alerts are working correctly\\.`, { parse_mode: 'MarkdownV2' });
      return bot.sendMessage(chatId, `✅ Test message sent successfully to group \`${groupId}\`.`, { parse_mode: 'Markdown' });
    } catch (err) {
      return bot.sendMessage(chatId, `❌ Failed to send to group \`${groupId}\`:\n\`${err.message}\``, { parse_mode: 'Markdown' });
    }
  }
  if (text.startsWith('/')) return;

  // Menu buttons
  switch (text) {
    case MENU_LABELS.LIST:
      return handleList(chatId, fromId);
    case MENU_LABELS.UNLINK:
      return handleUnlink(chatId, fromId);
    case MENU_LABELS.UNLINK_GROUP:
      return handleUnlinkGroup(chatId, fromId);
    case MENU_LABELS.LINK_GROUP:
      return bot.sendMessage(chatId,
        '🏘️ *Link a Group*\n\n1\\. Add this bot to your Telegram group\n2\\. In that group, send:\n`/linkgroup`\n\nAlerts for your monitored users will be sent to that group\\.',
        { parse_mode: 'MarkdownV2' }
      );
  }

  // WAITING_CODE
  if (s.state === 'WAITING_CODE') {
    const u = await UserModel.findOne({ accountCode: text, isDeleted: false }).populate('accountType');
    if (!u) return bot.sendMessage(chatId, '❌ Account code not found.');

    const level = u.accountType?.level || 7;
    if (level > 5) {
      s.state = 'IDLE';
      return bot.sendMessage(chatId, '🚫 Monitoring is only available for Admin and Master level accounts.');
    }

    s.state = 'WAITING_PASS';
    s.accountCode = text;
    return bot.sendMessage(chatId, `Found user *${u.accountName}*.\nPlease enter your *Password*:`, { parse_mode: 'Markdown' });
  }

  // WAITING_PASS
  if (s.state === 'WAITING_PASS') {
    const u = await UserModel.findOne({ accountCode: s.accountCode, isDeleted: false }).populate('accountType');
    if (!u || u.password !== text) {
      return bot.sendMessage(chatId, '❌ Invalid password. Try again:');
    }

    // Already linked to a DIFFERENT Telegram ID → trigger device verification
    if (u.monitorTelegramId && u.monitorTelegramId !== String(fromId) && u.monitorTelegramChatId) {
      const oldFromId = String(u.monitorTelegramId);
      const oldChatId = u.monitorTelegramChatId;

      // Cancel any existing pending for this account
      if (pendingVerifications[oldFromId]) {
        clearTimeout(pendingVerifications[oldFromId].timer);
        delete pendingVerifications[oldFromId];
      }

      const { nums, correct } = genVerifyNums();
      const pv = { correctNum: correct, newFromId: String(fromId), newChatId: chatId, oldChatId, userId: String(u._id), timer: null };
      pv.timer = setTimeout(() => {
        if (pendingVerifications[oldFromId] === pv) {
          delete pendingVerifications[oldFromId];
          bot.sendMessage(pv.newChatId, '⏱ *Verification timed out\\.* No response from existing device\\. Login blocked\\.', { parse_mode: 'MarkdownV2' }).catch(() => {});
        }
      }, 60_000);
      pendingVerifications[oldFromId] = pv;

      s.state = 'IDLE';
      delete s.accountCode;

      bot.sendMessage(oldChatId,
        `🔐 *New Login Attempt Detected*\n\nSomeone entered your credentials on a new device\\.\nTap the correct number to *approve* the transfer:`,
        {
          parse_mode: 'MarkdownV2',
          reply_markup: {
            inline_keyboard: [[
              ...nums.map(n => ({ text: String(n), callback_data: `verify:${oldFromId}:${n}` }))
            ]]
          }
        }
      ).catch(() => {});

      return bot.sendMessage(chatId,
        `🔐 *Verification Required*\n\nA request has been sent to your currently linked device\\.\n\nTap *${correct}* on the old device within *1 minute* to approve this login\\.`,
        { parse_mode: 'MarkdownV2' }
      );
    }

    // Normal link (new or same device)
    await UserModel.updateOne(
      { _id: u._id },
      { monitorTelegramId: String(fromId), monitorTelegramChatId: chatId }
    );

    s.state = 'IDLE';
    s.user = u.toObject ? u.toObject() : u;
    delete s.accountCode;

    sendMainMenu(chatId, `🎊 *Verification Successful!*\n\nWelcome *${u.accountName}*. You are now linked.`);
  }
});

// Auto-delete credential messages for security
bot.on('message', (msg) => {
  if (msg.chat.type !== 'private') return;
  const s = sessions[msg.from.id];
  if (s && (s.state === 'WAITING_CODE' || s.state === 'WAITING_PASS')) {
    setTimeout(() => {
      bot.deleteMessage(msg.chat.id, msg.message_id).catch(() => {});
    }, 1000);
  }
});

// ── Device Verification Callback ──────────────────────────────────────────────
bot.on('callback_query', async (query) => {
  const data = query.data || '';
  if (!data.startsWith('verify:')) return;

  await bot.answerCallbackQuery(query.id).catch(() => {});

  const parts = data.split(':');
  const oldFromId = parts[1];
  const chosenNum = parseInt(parts[2]);
  const pv = pendingVerifications[oldFromId];

  // Remove inline keyboard regardless of outcome
  bot.editMessageReplyMarkup({ inline_keyboard: [] }, {
    chat_id: query.message.chat.id,
    message_id: query.message.message_id
  }).catch(() => {});

  if (!pv) {
    return bot.sendMessage(query.message.chat.id, '⏱ Verification already expired or completed.').catch(() => {});
  }

  clearTimeout(pv.timer);
  delete pendingVerifications[oldFromId];

  if (chosenNum === pv.correctNum) {
    // Approved — migrate link to new device
    await UserModel.updateOne(
      { _id: pv.userId },
      { monitorTelegramId: pv.newFromId, monitorTelegramChatId: pv.newChatId }
    );

    // Invalidate old device session
    const oldSess = sessions[oldFromId];
    if (oldSess) { delete oldSess.user; oldSess.state = 'IDLE'; }

    bot.sendMessage(pv.oldChatId,
      '✅ *Approved\\.* New device has been linked\\. Your session on this device has ended\\.',
      { parse_mode: 'MarkdownV2', reply_markup: { remove_keyboard: true } }
    ).catch(() => {});

    // Fetch user and open session on new device
    const u = await UserModel.findById(pv.userId).populate('accountType').lean().catch(() => null);
    if (u) {
      const newSess = sess(parseInt(pv.newFromId));
      newSess.user = u;
      newSess.state = 'IDLE';
      sendMainMenu(pv.newChatId, `🎊 *Verification Successful!*\n\nWelcome *${u.accountName}*. You are now linked.`).catch(() => {});
    }
  } else {
    // Wrong — block login
    bot.sendMessage(pv.oldChatId,
      '🛑 *Login Blocked\\.* Wrong number entered\\. If this was not you, consider changing your password\\.',
      { parse_mode: 'MarkdownV2' }
    ).catch(() => {});
    bot.sendMessage(pv.newChatId,
      '❌ *Verification Failed\\.* Wrong number was entered on the existing device\\. Login blocked\\.',
      { parse_mode: 'MarkdownV2' }
    ).catch(() => {});
  }
});
