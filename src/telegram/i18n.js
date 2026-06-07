"use strict";
/**
 * i18n.js — Dynamic translation for Ocean Exchange Bot
 *
 * Uses MyMemory Translation API (free, no API key required):
 *   https://mymemory.translated.net/
 *
 * Language list is fetched from the API and cached in memory.
 * Translations are cached per (text + lang) to minimise API calls.
 */

const axios = require("axios");

const MYMEMORY_BASE = "https://api.mymemory.translated.net";
const SOURCE_LANG = "en";           // All source strings are English
const CACHE_TTL_MS = 60 * 60 * 1000; // 1 hour cache for language list
const MAX_CHUNK_CHARS = 450;            // MyMemory limit is 500 chars per request

// ── In-memory caches ──────────────────────────────────────────────────────────
let _langsCache = null;   // [{ code, name }]
let _langsAt = 0;      // timestamp of last lang fetch
const _xlateCache = Object.create(null); // "text||lang" → translated string

// ── Fetch supported languages from MyMemory API ───────────────────────────────
async function getSupportedLanguages() {
    const now = Date.now();
    if (_langsCache && now - _langsAt < CACHE_TTL_MS) return _langsCache;

    try {
        const res = await axios.get(`${MYMEMORY_BASE}/languages?de=oceanexchangebot@noreply.com`, { timeout: 3000 });
        const raw = res.data?.data?.isoLangs ?? {};

        _langsCache = Object.entries(raw).map(([code, info]) => ({
            code,
            name: info?.name || code,
            nativeName: info?.nativeName || info?.name || code,
        })).sort((a, b) => a.name.localeCompare(b.name));

        _langsAt = now;
    } catch (err) {
        // Fallback for 404 or other network issues
        _langsCache = [
            { code: "en", name: "English", nativeName: "English" },
            { code: "hi", name: "Hindi", nativeName: "हिंदी (Hindi)" },
            { code: "gu", name: "Gujarati", nativeName: "ગુજરાતી (Gujarati)" },
            { code: "bn", name: "Bengali", nativeName: "বাংলা (Bengali)" },
            { code: "ta", name: "Tamil", nativeName: "தமிழ் (Tamil)" },
            { code: "te", name: "Telugu", nativeName: "తెలుగు (Telugu)" },
            { code: "mr", name: "Marathi", nativeName: "मराઠી (Marathi)" },
            { code: "ur", name: "Urdu", nativeName: "اردو (Urdu)" },
            { code: "pa", name: "Punjabi", nativeName: "ਪੰਜਾਬੀ (Punjabi)" },
            { code: "kn", name: "Kannada", nativeName: "ಕನ್ನಡ (Kannada)" },
            { code: "ml", name: "Malayalam", nativeName: "മലയാളം (Malayalam)" },
            { code: "ar", name: "Arabic", nativeName: "العربية" },
            { code: "zh", name: "Chinese", nativeName: "中文" },
            { code: "es", name: "Spanish", nativeName: "Español" },
            { code: "fr", name: "French", nativeName: "Français" },
            { code: "ru", name: "Russian", nativeName: "Русский" },
            { code: "pt", name: "Portuguese", nativeName: "Português" },
            { code: "ja", name: "Japanese", nativeName: "日本語" },
            { code: "ko", name: "Korean", nativeName: "한국어" },
            { code: "tr", name: "Turkish", nativeName: "Türkçe" },
            { code: "de", name: "German", nativeName: "Deutsch" },
            { code: "id", name: "Indonesian", nativeName: "Bahasa Indonesia" },
        ];
        _langsAt = now;
    }

    return _langsCache;
}

// ── Translate a single text chunk (max 450 chars) ─────────────────────────────
async function _translateChunk(text, targetLang) {
    if (targetLang === SOURCE_LANG) return text;

    const cacheKey = `${text}||${targetLang}`;
    if (_xlateCache[cacheKey]) return _xlateCache[cacheKey];

    try {
        const res = await axios.get(`${MYMEMORY_BASE}/get`, {
            params: {
                q: text,
                langpair: `${SOURCE_LANG}|${targetLang}`,
                de: "oceanexchangebot@noreply.com",
            },
            timeout: 6000,
        });

        const translated = res.data?.responseData?.translatedText || text;
        // MyMemory sometimes returns "BATCH QUOTA EXCEEDED" string
        const result = translated.startsWith("BATCH QUOTA") ? text : translated;
        _xlateCache[cacheKey] = result;
        return result;
    } catch (err) {
        console.warn(`[i18n] Translation error (${targetLang}):`, err.message);
        return text; // Fallback to source text
    }
}

// ── Translate a full text string (auto-splits if too long) ────────────────────
async function translate(text, targetLang = "en") {
    if (!text || targetLang === SOURCE_LANG) return text;

    // Preserve Telegram markdown special sequences: *bold*, _italic_, `code`, \\.
    // We translate plain-text portions only.
    if (text.length <= MAX_CHUNK_CHARS) {
        return _translateChunk(text, targetLang);
    }

    // Split into lines and translate individually (preserves markdown per line)
    const lines = text.split("\n");
    const translated = await Promise.all(lines.map(line => {
        const trimmed = line.trim();
        // Don't translate empty lines or pure markdown formatting lines
        if (!trimmed || /^[_*`\\]+$/.test(trimmed)) return line;
        return _translateChunk(line, targetLang).catch(() => line);
    }));
    return translated.join("\n");
}

// ── Translate a Telegram inline keyboard button label ─────────────────────────
async function translateBtn(label, targetLang) {
    if (targetLang === SOURCE_LANG) return label;
    // Keep emoji prefix, only translate the text part
    const emojiMatch = label.match(/^([\p{Emoji}\s]+)/u);
    if (emojiMatch) {
        const emoji = emojiMatch[1];
        const rest = label.slice(emoji.length);
        if (!rest.trim()) return label;
        const translated = await _translateChunk(rest.trim(), targetLang).catch(() => rest);
        return `${emoji}${translated}`;
    }
    return _translateChunk(label, targetLang).catch(() => label);
}

// ── Get a language's display name (native + english) ─────────────────────────
async function getLangDisplay(code) {
    const langs = await getSupportedLanguages();
    const found = langs.find(l => l.code === code);
    if (!found) return code.toUpperCase();
    return found.nativeName !== found.name
        ? `${found.nativeName} (${found.name})`
        : found.name;
}

// ── Static UI strings (English only — translated on-the-fly when needed) ──────
const STRINGS = {
    welcome_start: "👋 Welcome to *🌊 Ocean Exchange*!\n\nEnter your *Account Code* to begin:",
    welcome_back: (n) => `👋 Welcome back, *${n}*!`,
    select_option: "🌊 *Ocean Exchange*\n\nSelect an option from the menu below:",
    loading: "⏳ Loading...",
    no_data: "📭 No data found.",
    choose_view_download: "How would you like this report?",
    lang_changed: (name) => `✅ Language changed to ${name}.\n\nMenus will now appear in your selected language.`,
    enter_date_from: "📅 Enter FROM date (DD-MM-YYYY):",
    enter_date_to: "📅 Enter TO date (DD-MM-YYYY):",
    enter_search_code: "🔍 Enter the Account Code to search your downline:",
    select_lang: "🌐 Select your preferred language:\n\n_Menus and notifications will be translated._",
    select_valan: (dir) => `Select a Valan for *${dir}*:`,
    select_ledger_type: "Select ledger type:",
    select_direction: "Select direction:",
    select_report: (name, code) => `👤 *${name}* (${code})\n\nSelect report:`,
    select_active_type: "Select type:",
    no_users_found: "❌ No downline users found matching that code.",
    user_not_found: "❌ User not found.",
    unlinked: "✅ Telegram account unlinked.",
    login_success: (n) => `🎊 *Login Successful!*\n\nWelcome, *${n}* 👋`,
    account_not_found: "❌ Account code not found. Try again or /start to reset.",
    password_prompt: (n) => `✅ Account *${n}* found.\n\nEnter your *Password*:`,
    invalid_password: "❌ Invalid password. Try again:",
    not_linked: "⚠️ *Account not linked.* Use /start to login.",
    no_linked: "⚠️ No account is linked.* Use /start to login",
    select_user: "Select a user:",
    error_occurred: "❌ An error occurred",
    report_expired: "❌ Report expired.",
    report_expired_regen: "❌ Report expired. Please regenerate.",
    refresh_success: "✅ Successfully refreshed.",
    select_market: "🏪 Select Market:",
    // Report specific labels
    gross_pnl: "Gross P&L",
    brokerage_lbl: "Brokerage",
    bill_pnl: "Bill/Pnl",
    m2m_lbl: "M2M",
    qty_lbl: "Qty",
    rate_lbl: "Rate",
    client_lbl: "Client",
    script_lbl: "Script",
    creator_lbl: "Creator",
    time_lbl: "Time",
    market_lbl: "Market",
    direction_lbl: "Direction",
    net_qty: "Net Qty",
    buy_lbl: "BUY",
    sell_lbl: "SELL",
    long_lbl: "LONG",
    short_lbl: "SHORT",
    debit_lbl: "DEBIT",
    credit_lbl: "CREDIT",
    date_lbl: "Date",
    type_lbl: "Type",
    remarks_lbl: "Remarks",
    balance_lbl: "Balance",
    pos_lbl: "position(s)",
    trade_lbl: "trade(s)",
};

/**
 * Get a UI string (English only — caller translates if needed).
 * @param {string} key
 * @param {...any} args
 */
function getString(key, ...args) {
    const val = STRINGS[key];
    if (!val) return key;
    if (typeof val === "function") return val(...args);
    return val;
}

/**
 * Get and auto-translate a UI string.
 * @param {string} key
 * @param {string} lang   Target language code
 * @param {...any} args   Args for template strings
 */
async function t(key, lang = "en", ...args) {
    const src = getString(key, ...args);
    return translate(src, lang);
}

module.exports = {
    t,
    translate,
    translateBtn,
    getString,
    getSupportedLanguages,
    getLangDisplay,
};
