const MARKET_IDS = {
    MCX: "1",
    NSE: "2",
    NOPT: "3",
    GLOBAL: "4",
    OTHERS: "5",
    FOREX: "6",
    COMEX: "7",
    CDS: "8",
    NCDEX: "9",
    NFUT: "10",
    CRYPTO: "11",
    NSE_EQ: "12",
    GIFT: "13",
    USSTOCKS: "14"
};

const MARKET_NAMES = {
    [MARKET_IDS.MCX]: "MCX",
    [MARKET_IDS.NSE]: "NSE-FO",
    [MARKET_IDS.NOPT]: "NOPT",
    [MARKET_IDS.GLOBAL]: "GLOBAL",
    [MARKET_IDS.FOREX]: "FOREX",
    [MARKET_IDS.OTHERS]: "OTHERS",
    [MARKET_IDS.CDS]: "CDS",
    [MARKET_IDS.NCDEX]: "NCDEX",
    [MARKET_IDS.COMEX]: "COMEX",
    [MARKET_IDS.NFUT]: "INDEX",
    [MARKET_IDS.CRYPTO]: "CRYPTO",
    [MARKET_IDS.NSE_EQ]: "NSE-EQ",
    [MARKET_IDS.GIFT]: "GIFT",
    [MARKET_IDS.USSTOCKS]: "US STOCKS",
};

const ALLOWED_MCX_SCRIPTS = [
    "GOLD",
    "SILVER",
    "CRUDEOIL",
    "ALUMINIUM",
    "COPPER",
    "GOLDM",
    "LEAD",
    "NATURALGAS",
    "SILVERM",
    "SILVERMIC",
    "ZINC"
];
const NSE_EQ_HIDDEN_SCRIPTS = [
    "",

];

const MARKET_ORDER = {
    [MARKET_IDS.NFUT]: 1,
    [MARKET_IDS.NSE]: 2,
    [MARKET_IDS.MCX]: 3,
    [MARKET_IDS.NOPT]: 4,
    [MARKET_IDS.NSE_EQ]: 5,
    [MARKET_IDS.GLOBAL]: 6,
    [MARKET_IDS.FOREX]: 7,
    [MARKET_IDS.COMEX]: 8,
    [MARKET_IDS.CDS]: 9,
    [MARKET_IDS.NCDEX]: 10,
    [MARKET_IDS.CRYPTO]: 11,
    [MARKET_IDS.GIFT]: 12,
    [MARKET_IDS.USSTOCKS]: 13,
    [MARKET_IDS.OTHERS]: 14,
};

const MARKET_DEFAULT_TIMES = {
    [MARKET_IDS.NSE]: { marketStartTime: "09:15:00", marketEndTime: "15:30:00", tradeStartTime: "09:15:00", tradeEndTime: "15:30:00" },
    [MARKET_IDS.NOPT]: { marketStartTime: "09:15:00", marketEndTime: "15:30:00", tradeStartTime: "09:15:00", tradeEndTime: "15:30:00" },
    [MARKET_IDS.NFUT]: { marketStartTime: "09:15:00", marketEndTime: "15:30:00", tradeStartTime: "09:15:00", tradeEndTime: "15:30:00" },
    [MARKET_IDS.NSE_EQ]: { marketStartTime: "09:15:00", marketEndTime: "15:30:00", tradeStartTime: "09:15:00", tradeEndTime: "15:30:00" },
    DEFAULT: { marketStartTime: "00:01:00", marketEndTime: "23:55:00", tradeStartTime: "00:01:00", tradeEndTime: "23:55:00" }
};
const HEADER_INDICES = [
    { symbol: "NIFTY50", name: "NIFTY50", exchange: "INDICES" },
    { symbol: "NIFTYBANK", name: "BANKNIFTY", exchange: "INDICES" },
    { symbol: "INDIAVIX", name: "INDIAVIX", exchange: "INDICES" },
    { symbol: "SENSEX", name: "SENSEX", exchange: "NSE" }
];

module.exports = {
    MARKET_IDS,
    MARKET_NAMES,
    MARKET_ORDER,
    ALLOWED_MCX_SCRIPTS,
    MARKET_DEFAULT_TIMES,
    HEADER_INDICES,
    CONVERSION_MARKET_IDS: ["6", "7", "8", "9", "11"],
    SMARTFEED_BATCH_SIZE: 250,
    SMARTFEED_POLL_INTERVAL: 500
};
