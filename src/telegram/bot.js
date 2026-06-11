"use strict";
/**
 * ─────────────────────────────────────────────────────────────────────────────
 * 💎 Platinum Exchange — Telegram Bot
 * ─────────────────────────────────────────────────────────────────────────────
 * Run:        node src/telegram/bot.js
 * Production: pm2 start src/telegram/bot.js --name platinum-exchange-bot
 * ─────────────────────────────────────────────────────────────────────────────
 */

require("dotenv").config({
  path: require("path").join(__dirname, "../../.env"),
});
const TelegramBot = require("node-telegram-bot-api");
const mongoose = require("mongoose");
const UserModel = require("../models/UserModel");
const StockService = require("../services/StockService");
const UserService = require("../services/UserService");
const { generatePDF } = require("./pdfHelper");
const { redisClient } = require("../config/redis");
const { v4: uuidv4 } = require("uuid"); // For unique report IDs
const BASE_URL =
  process.env.PUBLIC_BASE_URL || "https://platinum-exch.com/platinum-back"; // Public URL for PDF view (includes app path prefix)
const VIEW_PDF_URL = `${BASE_URL}/api/report/view-pdf`;
const {
  t,
  translate,
  translateBtn,
  getSupportedLanguages,
  getLangDisplay,
  getString,
} = require("./i18n");
const H = require("./handlers");

// ── DB ────────────────────────────────────────────────────────────────────────
mongoose
  .connect(process.env.MONGODB_URI)
  .then(() => console.log("[PlatinumExchange] MongoDB connected"))
  .catch((err) => {
    console.error("[PlatinumExchange] DB error:", err);
    process.exit(1);
  });

// ── Bot Init ──────────────────────────────────────────────────────────────────
const bot = new TelegramBot(process.env.BOT_TOKEN, {
  polling: {
    autoStart: true,
    interval: 1000,
    params: { timeout: 10 }
  }
});

// ── Polling Error Recovery ────────────────────────────────────────────────────
let _restartDelay = 5_000;
let _restartTimer = null;

bot.on('polling_error', (err) => {
  const code = err.code || 'UNKNOWN';
  const msg = (err.message || String(err)).substring(0, 120);

  if (code === 'EFATAL') {
    if (!_restartTimer) {
      console.error(`[PlatinumExchange] EFATAL — ${msg}`);
      console.log(`[PlatinumExchange] Restarting polling in ${_restartDelay / 1000}s...`);
      _restartTimer = setTimeout(() => {
        _restartTimer = null;
        bot.startPolling({ restart: true })
          .then(() => {
            console.log('[PlatinumExchange] Polling restarted successfully');
            _restartDelay = 5_000;
          })
          .catch((e) => {
            console.error('[PlatinumExchange] Restart failed:', e.message);
            _restartDelay = Math.min(_restartDelay * 2, 120_000);
          });
      }, _restartDelay);
    }
  } else {
    console.warn(`[PlatinumExchange] Polling warning [${code}]: ${msg}`);
  }
});

// ── Legacy Markdown Escaping ──────────────────────────────────────────────────
// Only escape symbols special to legacy Markdown (*, _, `, [) to avoid "\" in names/numbers.
const esc = (s) => String(s ?? "").replace(/([_*`\[\\])/g, "\\$1");
console.log("[PlatinumExchange] Bot running...");

// ── Sessions ──────────────────────────────────────────────────────────────────
// Keyed by msg.from.id (Identity Level) instead of msg.chat middle-man.
const sessions = {};
const chatToFromId = {}; // chatId → fromId, for session-aware message tracking

function sess(fromId) {
  if (!sessions[fromId]) sessions[fromId] = { state: "IDLE", lang: "en" };
  return sessions[fromId];
}

const level = (u) => u?.accountType?.level ?? 7;

async function getUser(msg_or_cbq) {
  const fromId = String(msg_or_cbq.from.id);
  const chatId = msg_or_cbq.message
    ? msg_or_cbq.message.chat.id
    : msg_or_cbq.chat
      ? msg_or_cbq.chat.id
      : null;
  const s = sess(fromId);

  // If session has user, return it (memory cache)
  if (s.user) return s.user;

  // Check DB using telegramId (msg.from.id)
  const u = await UserModel.findOne({ telegramId: fromId, isDeleted: false })
    .populate("accountType")
    .lean();
  if (u) {
    s.user = u;
    s.state = "IDLE";
    // Also update chatId in case it changed (user moved to another group or private chat)
    if (chatId) {
      UserModel.updateOne({ _id: u._id }, { telegramChatId: chatId }).catch(
        () => {},
      );
    }
    return u;
  }
  return null;
}

async function getUserById(id) {
  return UserModel.findOne({ _id: id, isDeleted: false })
    .populate("accountType")
    .lean();
}

async function replyNotLinked(chatId, lang = "en") {
  const txt = await t("not_linked", lang);
  return bot.sendMessage(chatId, txt, { parse_mode: "Markdown" });
}

const FIVE_MINS = 300000;

function autoDelete(chatId, id1, id2, ms = FIVE_MINS) {
  setTimeout(async () => {
    try {
      if (id1) await bot.deleteMessage(chatId, id1);
    } catch (_) {}
    try {
      if (id2) await bot.deleteMessage(chatId, id2);
    } catch (_) {}
  }, ms);
}

// ── Global Message Listener — Security & Cleanup ──────────────────────────────
// Credentials (WAITING_CODE / WAITING_PASS) are deleted IMMEDIATELY.
// All other user texts auto-delete after 5 mins so the chat stays clean.
bot.on("message", (msg) => {
  if (!msg.chat.id || !msg.message_id) return;
  if (!msg.text || msg.text.startsWith("/")) return;
  if (msg.from?.is_bot) return;

  const fromId = String(msg.from?.id);
  const s = sessions[fromId];

  // Immediate deletion for credentials
  if (s && (s.state === "WAITING_CODE" || s.state === "WAITING_PASS")) {
    bot.deleteMessage(msg.chat.id, msg.message_id).catch(() => {});
    return;
  }

  // Track for session expiry bulk delete
  if (s?.trackedMsgIds) s.trackedMsgIds.push(msg.message_id);

  // 5-minute deletion for everything else
  setTimeout(async () => {
    try {
      await bot.deleteMessage(msg.chat.id, msg.message_id);
    } catch (_) {}
  }, FIVE_MINS);
});

// Auto-delete ALL bot outgoing messages after 5 mins
const _origSend = bot.sendMessage.bind(bot);
bot.sendMessage = async (...args) => {
  const m = await _origSend(...args);
  if (m?.chat?.id && m?.message_id) {
    // Track in active session for bulk expiry delete
    const fid = chatToFromId[String(m.chat.id)];
    if (fid && sessions[fid]?.trackedMsgIds) {
      sessions[fid].trackedMsgIds.push(m.message_id);
    }
    setTimeout(async () => {
      try {
        await bot.deleteMessage(m.chat.id, m.message_id);
      } catch (_) {}
    }, FIVE_MINS);
  }
  return m;
};
const _origDoc = bot.sendDocument.bind(bot);
bot.sendDocument = async (...args) => {
  const m = await _origDoc(...args);
  if (m?.chat?.id && m?.message_id) {
    setTimeout(async () => {
      try {
        await bot.deleteMessage(m.chat.id, m.message_id);
      } catch (_) {}
    }, FIVE_MINS);
  }
  return m;
};

// ── Session Expiry ────────────────────────────────────────────────────────────
function startSessionTimer(fromId, chatId) {
  const s = sess(fromId);
  if (s.sessionTimer) clearTimeout(s.sessionTimer);
  s.sessionTimer = setTimeout(() => expireSession(fromId, chatId), FIVE_MINS);
}

async function expireSession(fromId, chatId) {
  const s = sessions[fromId];
  if (!s || !s.user) return;
  const lang = s.lang || "en";
  const ids = [...(s.trackedMsgIds || [])];

  // Capture user _id before clearing session
  const userId = s.user._id;

  // Clear session before async work to prevent race re-entry
  delete s.user;
  s.state = "WAITING_CODE";
  s.trackedMsgIds = [];
  s.sessionTimer = null;
  delete chatToFromId[String(chatId)];

  // Remove telegramId from DB so /start re-prompts for account code
  await UserModel.updateOne(
    { _id: userId },
    { $unset: { telegramId: "", telegramChatId: "" } },
  ).catch(() => {});

  // Bulk-delete all tracked messages from this session
  await Promise.all(ids.map((mid) => bot.deleteMessage(chatId, mid).catch(() => {})));

  // Notify and prompt for account code
  const expiredMsg =
    (await t("session_expired", lang)) ||
    "⏱ Session expired. Please enter your account code to login again.";
  await _origSend(chatId, expiredMsg, {
    reply_markup: { remove_keyboard: true },
    parse_mode: "Markdown",
  });
}

function getLang(fromId) {
  return sess(fromId).lang || "en";
}

// English labels — the source of truth for routing
const MENU_LABELS = {
  all_trades: "📈 All Trades",
  all_positions: "📌 All Positions",
  summary: "📋 Summary Report",
  margin: "💰 Margin Management",
  td_users: "🏆 T&D Users",
  td_masters: "🎯 T&D Masters",
  active: "👥 Active/Inactive",
  ledger: "📒 Ledger",
  user_mgmt: "🔍 User Management",
  language: "🌐 Language",
  unlink: "🔗 Unlink",
  main_menu: "⬅️ Main Menu",
  script_wise_summary: "Script Wise Summary",
};

function menuRowKeys(lvl) {
  const r = [["all_trades", "all_positions"]];
  if (lvl <= 6) {
    r.push(["summary", "script_wise_summary"]);
    r.push(["margin"]);
  }
  if (lvl <= 5) r.push(["td_users", "td_masters"]);
  if (lvl <= 6) r.push(["active", "ledger"]);
  else r.push(["ledger"]);
  if (lvl <= 6) r.push(["user_mgmt", "language"]);
  else r.push(["language"]);
  r.push(["unlink"]);
  return r;
}

async function buildMenuRows(lvl, lang) {
  const keyRows = menuRowKeys(lvl);
  const translated = {};
  // Pre-translate everything for the current language
  await Promise.all(
    Object.entries(MENU_LABELS).map(async ([key, label]) => {
      translated[key] =
        lang === "en"
          ? label
          : await translateBtn(label, lang).catch(() => label);
    }),
  );
  return keyRows.map((row) => row.map((key) => translated[key]));
}

async function buildMenuMap(lvl, lang) {
  const map = {};
  for (const [key, label] of Object.entries(MENU_LABELS)) {
    const cleanLabel = label.trim();
    map[cleanLabel] = label; // Map English to English
    if (lang !== "en") {
      const xlated = await translateBtn(label, lang).catch(() => label);
      if (xlated && xlated.trim() !== cleanLabel) {
        map[xlated.trim()] = label; // Map Translated to English
      }
    }
  }
  return map;
}

async function mainMenuOpts(lvl, lang) {
  const rows = await buildMenuRows(lvl, lang);
  return {
    reply_markup: { keyboard: rows, resize_keyboard: true, persistent: true },
    parse_mode: "Markdown",
  };
}

async function subMenuOpts(lvl, lang) {
  const rows = await buildMenuRows(lvl, lang);
  const backBtn =
    lang === "en"
      ? "⬅️ Main Menu"
      : await translateBtn("⬅️ Main Menu", lang).catch(() => "⬅️ Main Menu");
  return {
    reply_markup: {
      keyboard: [...rows, [backBtn]],
      resize_keyboard: true,
      persistent: true,
    },
    parse_mode: "Markdown",
  };
}

async function sendMainMenu(chatId, fromId, lvl, text) {
  const lang = getLang(fromId);
  const mText = text || (await t("select_option", lang));
  const s = sess(fromId);
  s.menuMap = await buildMenuMap(lvl, lang);
  return bot.sendMessage(chatId, mText, await mainMenuOpts(lvl, lang));
}

async function sendSubMenu(chatId, fromId, lvl, text) {
  const lang = getLang(fromId);
  const s = sess(fromId);
  s.menuMap = await buildMenuMap(lvl, lang);
  const backLabel =
    lang === "en"
      ? MENU_LABELS.main_menu
      : await translateBtn(MENU_LABELS.main_menu, lang).catch(
          () => MENU_LABELS.main_menu,
        );
  s.menuMap[backLabel] = MENU_LABELS.main_menu;
  return bot.sendMessage(chatId, text || "...", await subMenuOpts(lvl, lang));
}

// ── Inline keyboard: View or Download ─────────────────────────────────────────────────
async function viewDlKeyboard(prefix, reportId, lang = "en") {
  if (!reportId)
    console.warn(
      `[Bot] Warning: viewDlKeyboard called with undefined reportId for prefix ${prefix}`,
    );
  return {
    inline_keyboard: [
      [
        {
          text: await translateBtn("👁 View", lang),
          url: `${VIEW_PDF_URL}/${reportId}.pdf`,
        },
        {
          text: await translateBtn("📥 Download", lang),
          callback_data: `${prefix}|d|${reportId || "error"}`,
        },
      ],
    ],
  };
}

async function sendViewDl(
  chatId,
  lang,
  prefix,
  reportId,
  promptKey = "choose_view_download",
) {
  const txt = await t(promptKey, lang);
  const keyboard = await viewDlKeyboard(prefix, reportId, lang);
  return bot.sendMessage(chatId, txt || "Choose an option:", {
    reply_markup: keyboard,
  });
}

// Keep alias for compatibility
const sendPdfBtn = sendViewDl;

// ── Deliver result ────────────────────────────────────────────────────────────────
// responseType: 'v' (View URL already sent) or 'd' (Download file)
async function deliver(chatId, data, responseType, reportId, lang = "en") {
  const { title, subtitle, pdfSections } = data;

  if (responseType === "v") {
    return;
  }

  const pdf = await generatePDF(title, pdfSections, subtitle);
  const safeName = `${title} ${subtitle || ""}`
    .replace(/[^a-zA-Z0-9\s\-_]/g, "")
    .trim()
    .replace(/\s+/g, "_")
    .slice(0, 80);

  const readyTxt = await translate(
    "📥 PDF ready — tap to open or *Download*",
    lang,
  );
  await bot.sendDocument(
    chatId,
    pdf,
    { caption: readyTxt, parse_mode: "Markdown" },
    { filename: `${safeName}.pdf`, contentType: "application/pdf" },
  );
}

// ── Generic handler wrapper ───────────────────────────────────────────────────
async function run(
  chatId,
  fromId,
  user,
  fn,
  responseType,
  reportPrefix,
  ...args
) {
  const lang = getLang(fromId);
  const loadingTxt = await t("loading", lang);
  const waiting = await bot.sendMessage(chatId, loadingTxt);
  try {
    const data = await fn(user, ...args, lang);
    try {
      await bot.deleteMessage(chatId, waiting.message_id);
    } catch (_) {}

    // Generate and Store report data in Redis for 5 minutes (Shortened for security)
    const reportId = uuidv4();
    await redisClient.set(
      `tg_report:${reportId}`,
      JSON.stringify(data),
      "EX",
      300,
    );

    if (!responseType) {
      // No responseType means we need to show the View/Download buttons
      // Use provided prefix or fallback to function name
      const prefix =
        reportPrefix ||
        (fn.name ? fn.name.replace("build", "").toUpperCase() : "RPT");
      return sendViewDl(chatId, lang, prefix, reportId);
    }

    await deliver(chatId, data, responseType, reportId, lang);
  } catch (err) {
    console.error("[Bot] Error:", err.message);
    const errTxt = (await t("error_occurred", lang)) || "❌ Error";
    await bot
      .editMessageText(`${errTxt}: ${err.message}`, {
        chat_id: chatId,
        message_id: waiting.message_id,
      })
      .catch(() => {});
  }
}

// ═══════════════════════════════════════════════════════════════════════════════
// /start — Login Flow
// ═══════════════════════════════════════════════════════════════════════════════
bot.onText(/\/start/, async (msg) => {
  const chatId = msg.chat.id;
  try {
    await bot.deleteMessage(chatId, msg.message_id);
  } catch (_) {}
  const user = await getUser(msg);
  if (user) {
    const s = sess(msg.from.id);
    s.state = "IDLE";
    s.lang = s.userLang || "en";
    s.trackedMsgIds = s.trackedMsgIds || [];
    chatToFromId[String(chatId)] = String(msg.from.id);
    startSessionTimer(String(msg.from.id), chatId);
    const welcomeText = await t("welcome_back", s.lang, esc(user.accountName));
    return sendMainMenu(chatId, msg.from.id, level(user), welcomeText);
  }
  const s = sess(msg.from.id);
  s.state = "WAITING_CODE";
  const welcome = await t("welcome_start", s.lang);
  bot.sendMessage(chatId, welcome, { parse_mode: "Markdown" });
});

// ═══════════════════════════════════════════════════════════════════════════════
// MESSAGE HANDLER
// ═══════════════════════════════════════════════════════════════════════════════
bot.on("message", async (msg) => {
  const chatId = msg.chat.id;
  if (!msg.text || msg.text.startsWith("/")) return;
  const text = msg.text.trim();
  const userMsgId = msg.message_id;
  const fromId = String(msg.from.id);
  const s = sess(fromId);
  let lang = s.lang || "en";

  // ── Login: Account Code ──────────────────────────────────────────────────
  if (s.state === "WAITING_CODE") {
    try {
      await bot.deleteMessage(chatId, userMsgId);
    } catch (_) {}
    const u = await UserModel.findOne({ accountCode: text, isDeleted: false });
    if (!u) return bot.sendMessage(chatId, await t("account_not_found", lang));
    s.state = "WAITING_PASS";
    s.accountCode = text;
    const passPrompt = await t("password_prompt", lang, esc(u.accountName));
    return bot.sendMessage(chatId, passPrompt, { parse_mode: "Markdown" });
  }

  // ── Login: Password ──────────────────────────────────────────────────────
  if (s.state === "WAITING_PASS") {
    try {
      await bot.deleteMessage(chatId, userMsgId);
    } catch (_) {}
    const u = await UserModel.findOne({
      accountCode: s.accountCode,
      isDeleted: false,
    }).populate("accountType");
    if (!u || u.password !== text)
      return bot.sendMessage(chatId, await t("invalid_password", lang));

    s.state = "IDLE";
    s.user = u.toObject ? u.toObject() : u;
    s.trackedMsgIds = [];

    // BIND: Store both identity (from.id) and transport (chat.id)
    await UserModel.updateOne(
      { _id: u._id },
      {
        telegramId: String(msg.from.id),
        telegramChatId: chatId,
      },
    );

    chatToFromId[String(chatId)] = fromId;
    startSessionTimer(fromId, chatId);
    s.userLang = "en";
    delete s.accountCode;
    const loginMsg = await t("login_success", lang, esc(u.accountName));
    return sendMainMenu(chatId, msg.from.id, level(s.user), loginMsg);
  }

  // ── Ledger: Date Input ───────────────────────────────────────────────────
  if (s.state === "WAITING_LEDGER_FROM") {
    s.ledgerFrom = text;
    s.state = "WAITING_LEDGER_TO";
    return bot.sendMessage(chatId, await t("enter_date_to", lang));
  }
  if (s.state === "WAITING_LEDGER_TO") {
    s.ledgerTo = text;
    s.state = "IDLE";
    const user = await getUser(msg);
    if (!user) return replyNotLinked(chatId, lang);
    // Start the report flow, which will generate buttons
    return run(
      chatId,
      fromId,
      user,
      (u, l) => H.buildLedger(u, s.ledgerType, s.ledgerFrom, s.ledgerTo, l),
      null,
      "LDG2",
    );
  }

  // ── User Management: Search Code ─────────────────────────────────────────
  if (s.state === "WAITING_UM_CODE") {
    const user = await getUser(msg);
    if (!user) return replyNotLinked(chatId, lang);
    s.state = "IDLE";
    const results = await H.searchDownlineUsers(user, text);
    if (!results.length)
      return bot.sendMessage(chatId, await t("no_users_found", lang));
    const keyboard = results.map((u) => [
      {
        text: `${u.accountCode} — ${u.accountName}`,
        callback_data: `UMS|${u._id.toString()}`,
      },
    ]);
    const selectTxt = await t("select_user", lang);
    return bot.sendMessage(chatId, selectTxt, {
      reply_markup: { inline_keyboard: keyboard },
    });
  }

  // Require Login for all other messages
  const user = await getUser(msg);
  if (!user) {
    try {
      await bot.deleteMessage(chatId, userMsgId);
    } catch (_) {}
    return replyNotLinked(chatId, lang);
  }
  // NOTE: Do NOT delete user menu button taps here.
  // The global listener already schedules 5-min auto-delete for all user messages.

  const lvl = level(user);
  lang = getLang(fromId);

  // Resolve action text (translated label -> English source of truth)
  const normalizedText = text.trim();
  const actionText =
    s.menuMap && s.menuMap[normalizedText]
      ? s.menuMap[normalizedText]
      : normalizedText;

  // ── Route Keyboard Buttons ────────────────────────────────────────────────
  switch (actionText) {
    case MENU_LABELS.main_menu:
      return sendMainMenu(chatId, fromId, lvl, await t("select_option", lang));

    case MENU_LABELS.all_trades:
      return run(chatId, fromId, user, H.buildAllTrades, null, "AT");

    case MENU_LABELS.all_positions:
      return run(chatId, fromId, user, H.buildAllPositions, null, "AP");

    case MENU_LABELS.summary:
      return lvl <= 6
        ? run(chatId, fromId, user, H.buildSummaryReport, null, "SR")
        : null;

    case MENU_LABELS.script_wise_summary:
      return lvl <= 6
        ? run(chatId, fromId, user, H.buildScriptWiseSummary, null, "SWS")
        : null;

    case MENU_LABELS.margin:
      return lvl <= 6
        ? run(chatId, fromId, user, H.buildMarginMgmt, null, "MM")
        : null;

    case MENU_LABELS.td_users:
      if (lvl > 5) return;
      return bot.sendMessage(chatId, await t("select_direction", lang), {
        reply_markup: {
          inline_keyboard: [
            [
              {
                text: await translateBtn("🔝 Top 15 (Most Profit)", lang),
                callback_data: "TDU|top",
              },
              {
                text: await translateBtn("🔻 Down 15 (Most Loss)", lang),
                callback_data: "TDU|down",
              },
            ],
          ],
        },
      });

    case MENU_LABELS.td_masters:
      if (lvl > 5) return;
      return bot.sendMessage(chatId, await t("select_direction", lang), {
        reply_markup: {
          inline_keyboard: [
            [
              {
                text: await translateBtn(
                  "🔝 Top 15 Masters (Most Profit)",
                  lang,
                ),
                callback_data: "TDM|top",
              },
              {
                text: await translateBtn(
                  "🔻 Down 15 Masters (Most Loss)",
                  lang,
                ),
                callback_data: "TDM|down",
              },
            ],
          ],
        },
      });

    case MENU_LABELS.active:
      if (lvl > 6) return;
      return bot.sendMessage(chatId, await t("select_active_type", lang), {
        reply_markup: {
          inline_keyboard: [
            [
              {
                text: await translateBtn("✅ Active Users", lang),
                callback_data: "AU|act",
              },
              {
                text: await translateBtn("❌ Inactive Users", lang),
                callback_data: "AU|no",
              },
            ],
          ],
        },
      });

    case MENU_LABELS.ledger:
      return bot.sendMessage(chatId, await t("select_ledger_type", lang), {
        reply_markup: {
          inline_keyboard: [
            [
              {
                text: await translateBtn("💵 Cash", lang),
                callback_data: "LDG|cash",
              },
              {
                text: await translateBtn("📋 JV", lang),
                callback_data: "LDG|jv",
              },
              {
                text: await translateBtn("📊 Trade Ledger", lang),
                callback_data: "LDG|trade",
              },
            ],
          ],
        },
      });

    case MENU_LABELS.user_mgmt:
      if (lvl > 6) return;
      s.state = "WAITING_UM_CODE";
      const searchPrompt = await t("enter_search_code", lang);
      return bot.sendMessage(chatId, searchPrompt);

    case MENU_LABELS.language: {
      const langs = await getSupportedLanguages();
      const rows = [];
      for (let i = 0; i < langs.length; i += 2) {
        const chunk = langs.slice(i, i + 2);
        const row = await Promise.all(
          chunk.map(async (l) => ({
            text: `${l.nativeName} (${l.code})`,
            callback_data: `LANG|${l.code}`,
          })),
        );
        rows.push(row);
      }
      const prompt = await t("select_lang", lang);
      return bot.sendMessage(chatId, prompt, {
        reply_markup: { inline_keyboard: rows },
        parse_mode: "Markdown",
      });
    }

    case MENU_LABELS.unlink: {
      if (s.sessionTimer) { clearTimeout(s.sessionTimer); s.sessionTimer = null; }
      delete chatToFromId[String(chatId)];
      s.trackedMsgIds = [];
      if (s.user) {
        // Clear Telegram ID in DB
        await UserModel.updateOne(
          { _id: s.user._id },
          { $unset: { telegramChatId: "", telegramId: "" } },
        );
      }
      delete s.user;
      s.state = "WAITING_CODE";
      const unlinkMsg = await t("unlinked", lang);
      return bot.sendMessage(chatId, unlinkMsg, {
        reply_markup: { remove_keyboard: true },
      });
    }

    default:
      break;
  }
});

// ═══════════════════════════════════════════════════════════════════════════════
// CALLBACK QUERY HANDLER — Inline keyboard responses
// ═══════════════════════════════════════════════════════════════════════════════
bot.on("callback_query", async (cbq) => {
  const chatId = cbq.message.chat.id;
  const data = cbq.data || "";
  const fromId = String(cbq.from.id);
  const s = sess(fromId);
  const lang = s.lang || "en";

  await bot.answerCallbackQuery(cbq.id).catch(() => {});

  // UNIFIED AUTH: uses identity from.id
  const user = await getUser(cbq);
  if (!user) return replyNotLinked(chatId);
  const lvl = level(user);

  const [cmd, p1, p2, p3] = data.split("|");

  // ── Language ──────────────────────────────────────────────────────────────
  if (cmd === "LANG") {
    s.lang = p1 || "en";
    s.userLang = s.lang;
    const dispName = await getLangDisplay(s.lang);
    const langMsg = await t("lang_changed", s.lang, dispName);
    return sendMainMenu(chatId, fromId, lvl, langMsg);
  }

  // ── All Trades ────────────────────────────────────────────────────────────
  if (cmd === "AT") {
    if (!p1) return run(chatId, fromId, user, H.buildAllTrades, null, "AT");
    if (p1 === "d") {
      const rData = await redisClient.get(`tg_report:${p2}`);
      if (!rData)
        return bot.sendMessage(chatId, "❌ Report expired. Please regenerate.");
      return deliver(chatId, JSON.parse(rData), "d", p2);
    }
  }

  // ── Summary Report ─────────────────────────────────────────────────────────
  if (cmd === "SR") {
    if (!p1) return run(chatId, fromId, user, H.buildSummaryReport, null, "SR");
    if (p1 === "d") {
      const rData = await redisClient.get(`tg_report:${p2}`);
      if (!rData) return bot.sendMessage(chatId, "❌ Report expired.");
      return deliver(chatId, JSON.parse(rData), "d", p2);
    }
  }

  if (cmd === "SWS") {
    if (!p1)
      return run(chatId, fromId, user, H.buildScriptWiseSummary, null, "SWS");
    if (p1 === "d") {
      const rData = await redisClient.get(`tg_report:${p2}`);
      if (!rData) return bot.sendMessage(chatId, "❌ Report expired.");
      return deliver(chatId, JSON.parse(rData), "d", p2);
    }
  }

  // ── All Positions ─────────────────────────────────────────────────────────
  if (cmd === "AP") {
    if (!p1) return run(chatId, fromId, user, H.buildAllPositions, null, "AP");
    if (p1 === "d") {
      const rData = await redisClient.get(`tg_report:${p2}`);
      if (!rData) return bot.sendMessage(chatId, "❌ Report expired.");
      return deliver(chatId, JSON.parse(rData), "d", p2);
    }
  }

  // ── Margin Management ─────────────────────────────────────────────────────
  if (cmd === "MM") {
    if (!p1) return run(chatId, fromId, user, H.buildMarginMgmt, null, "MM");
    if (p1 === "d") {
      const rData = await redisClient.get(`tg_report:${p2}`);
      if (!rData) return bot.sendMessage(chatId, "❌ Report expired.");
      return deliver(chatId, JSON.parse(rData), "d", p2);
    }
  }

  // ── Active / Inactive Users ───────────────────────────────────────────────
  if (cmd === "AU") {
    if (p1 === "d") {
      const rData = await redisClient.get(`tg_report:${p2}`);
      if (!rData)
        return bot.sendMessage(chatId, await t("report_expired", lang));
      return deliver(chatId, JSON.parse(rData), "d", p2);
    }
    s.auType = p1;
    return run(
      chatId,
      fromId,
      user,
      (u, l) => H.buildActiveUsersReport(u, p1 === "act", l),
      null,
      "AU",
    );
  }

  // ── T&D Users / Masters ───────────────────────────────────────────────────
  if (cmd === "TDU" || cmd === "TDM") {
    // p1 = top|down  → need valan selection
    s.tdDir = p1;
    s.tdType = cmd;
    const valans = await H.getRecentValans(8);
    const rows = valans.map((v) => [
      {
        text: v.label,
        callback_data: `VL|${v._id.toString()}`,
      },
    ]);
    return bot.sendMessage(
      chatId,
      `Select a Valan for *${cmd === "TDU" ? "T&D Users" : "T&D Masters"}* (${p1 === "top" ? "Top 15" : "Down 15"}):`,
      {
        parse_mode: "Markdown",
        reply_markup: { inline_keyboard: rows },
      },
    );
  }

  if (cmd === "VL") {
    if (p1 === "d") {
      const rData = await redisClient.get(`tg_report:${p2}`);
      if (!rData)
        return bot.sendMessage(chatId, await t("report_expired", lang));
      return deliver(chatId, JSON.parse(rData), "d", p2);
    }
    const mastersOnly = s.tdType === "TDM";
    return run(
      chatId,
      fromId,
      user,
      (u, l) => H.buildTDReport(u, s.tdDir, p1, mastersOnly, l),
      null,
      "VL",
    );
  }

  // ── Ledger: Type selected ───────────────────────────────────────────────────
  if (cmd === "LDG") {
    s.ledgerType = p1; // cash | jv | trade
    s.state = "WAITING_LEDGER_FROM";
    const prompt =
      (await t("enter_date_from", lang)) || "Enter FROM date (DD-MM-YYYY):";
    return bot.sendMessage(chatId, prompt);
  }

  // ── Ledger: Confirm after dates ───────────────────────────────────────────
  if (cmd === "LDG2") {
    if (!p1)
      return run(
        chatId,
        fromId,
        user,
        (u) => H.buildLedger(u, s.ledgerType, s.ledgerFrom, s.ledgerTo),
        null,
        "LDG2",
      );
    if (p1 === "d") {
      const rData = await redisClient.get(`tg_report:${p2}`);
      if (!rData) return bot.sendMessage(chatId, "❌ Report expired.");
      return deliver(chatId, JSON.parse(rData), "d", p2);
    }
  }

  // ── User Management: User selected ────────────────────────────────────────
  if (cmd === "UMS") {
    const targetId = p1;
    s.umUserId = targetId;
    const targetUser = await getUserById(targetId);
    if (!targetUser)
      return bot.sendMessage(chatId, await t("user_not_found", lang));

    const selectRpt = await t(
      "select_report",
      lang,
      esc(targetUser.accountName),
      esc(targetUser.accountCode),
    );
    return bot.sendMessage(chatId, selectRpt, {
      parse_mode: "Markdown",
      reply_markup: {
        inline_keyboard: [
          [
            {
              text: "📌 This Valan's Positions",
              callback_data: `UMR|${targetId}|tpos`,
            },
          ],
          [
            {
              text: "📈 This Valan's Trades",
              callback_data: `UMR|${targetId}|ttrd`,
            },
          ],
          [
            {
              text: "📈 This Week's Trades",
              callback_data: `UMR|${targetId}|wtrd`,
            },
          ],
          [{ text: "🧾 This Valan's Bill", callback_data: `UMR|${targetId}|tbil` }],
          [
            {
              text: "🧾 This Week's Bill",
              callback_data: `UMR|${targetId}|wbil`,
            },
          ],
          [
            {
              text: "🧾 Last Week's Bill",
              callback_data: `UMR|${targetId}|lbil`,
            },
          ],
        ],
      },
    });
  }

  // ── User Management: Report type selected → go straight to PDF ──────────
  if (cmd === "UMR") {
    s.umUserId = p1;
    s.umReportCode = p2;
    const targetUser = await getUserById(p1);
    if (!targetUser)
      return bot.sendMessage(chatId, await t("user_not_found", lang));
    return run(
      chatId,
      fromId,
      user,
      (u, l) => H.buildUserMgmtReport(targetUser, p2, l),
      null,
      "UMF",
    );
  }

  // ── User Management: Final deliver ────────────────────────────────────────
  if (cmd === "UMF") {
    if (p1 === "d") {
      const rData = await redisClient.get(`tg_report:${p2}`);
      if (!rData)
        return bot.sendMessage(chatId, await t("report_expired", lang));
      return deliver(chatId, JSON.parse(rData), "d", p2);
    }
  }
});

// ═══════════════════════════════════════════════════════════════════════════════
// /menu — Re-show menu
// ═══════════════════════════════════════════════════════════════════════════════
bot.onText(/\/menu/, async (msg) => {
  try {
    await bot.deleteMessage(msg.chat.id, msg.message_id);
  } catch (_) {}
  const lang = getLang(msg.from.id);
  const user = await getUser(msg);
  if (!user) return replyNotLinked(msg.chat.id, lang);
  const prompt = await t("select_option", lang);
  return sendMainMenu(msg.chat.id, msg.from.id, level(user), prompt);
});

// ═══════════════════════════════════════════════════════════════════════════════
// /unlink
// ═══════════════════════════════════════════════════════════════════════════════
bot.onText(/\/unlink/, async (msg) => {
  const chatId = msg.chat.id;
  try {
    await bot.deleteMessage(chatId, msg.message_id);
  } catch (_) {}
  const s = sess(msg.from.id);
  const lang = getLang(msg.from.id);
  if (!s.user) return bot.sendMessage(chatId, await t("no_linked", lang));
  if (s.sessionTimer) { clearTimeout(s.sessionTimer); s.sessionTimer = null; }
  delete chatToFromId[String(chatId)];
  s.trackedMsgIds = [];
  delete s.user;
  s.state = "WAITING_CODE";
  const unlinked = await t("unlinked", lang);
  bot.sendMessage(chatId, unlinked, {
    reply_markup: { remove_keyboard: true },
  });
});

// ── Graceful shutdown ─────────────────────────────────────────────────────────
process.on("SIGINT", () => {
  bot.stopPolling();
  process.exit(0);
});
process.on("SIGTERM", () => {
  bot.stopPolling();
  process.exit(0);
});
