// config/config.js
require('dotenv').config();

module.exports = {
  JWT_SECRET: process.env.JWT_SECRET,
  JWT_EXPIRATION: process.env.JWT_EXPIRATION,
  JWT_EXPIRATION_IN_SECONDS: process.env.JWT_EXPIRATION_IN_SECONDS,
  JWT_REFRESH_SECRET: process.env.JWT_REFRESH_SECRET,
  JWT_REFRESH_EXPIRATION: process.env.JWT_REFRESH_EXPIRATION,
  JWT_REFRESH_EXPIRATION_IN_SECONDS: process.env.JWT_REFRESH_EXPIRATION_IN_SECONDS,
  MONGODB_URI: process.env.MONGODB_URI,
  PORT: process.env.PORT || 3000,
  REDIS_HOST: process.env.REDIS_HOST,
  REDIS_PORT: process.env.REDIS_PORT,
  API_END_POINT: process.env.API_END_POINT,

  // Max value allowed wherever the type is 'lot' (user margin totalLotWise + qty setting Lot fields).
  // Change here to apply the new cap everywhere. Override via MAX_LOT_VALUE env var.
  MAX_LOT_VALUE: Number(process.env.MAX_LOT_VALUE) || 50000,

  // Account code must be numeric and at most this many digits.
  // Change here to apply the new length everywhere. Override via ACCOUNT_CODE_LENGTH env var.
  ACCOUNT_CODE_LENGTH: Number(process.env.ACCOUNT_CODE_LENGTH) || 6,

  // User Type Level Enums for Login Access Control
  // Configure which user type levels can login from admin portal
  ADMIN_LOGIN_ALLOWED_LEVELS: [1], // Only level 1 (Super Admin) can login from admin portal

  // Configure which user type levels can login from client portal
  // CLIENT_LOGIN_ALLOWED_LEVELS: [2, 3, 4, 5, 6], // Uncomment when frontend is ready

  // Broker (Level 6) Accessible URL Prefixes
  // Brokers can only access these endpoints (read-only view of partner users' data)
  BROKER_ACCESSIBLE_URLS: [
    '/api/stock/getWeekValan',
    '/api/stock/getUserPositionReport',
    '/api/stock/getSummaryReport',
    '/api/stock/getDownlineSummaryReport',
    '/api/stock/getStocksUserScriptWise',
    '/api/stock/getScriptWiseReport',
    '/api/stock/getScriptSummaryReport',
    '/api/stock/getShortTradeReport',
    '/api/stock/getLineTradeReport',
    '/api/stock/getBulkTradingReport',
    '/api/stock/getUsersScriptWisePosition',
    '/api/stock/getNseEqSummaryReport',
    '/api/stock/getNseEqScriptSummaryReport',
    '/api/stock/getNseEqInterestReport',
    '/api/report/getLedgers',
    '/api/report/getLedgerList/:userId',
    '/api/report/getMyLedger',
    '/api/report/getUplineSettlement',
    '/api/report/getUplineSettlementList',
    '/api/report/getCashLedger',
    '/api/report/getDepositWithdraw',
    '/api/report/getJVLedger',
    '/api/report/getLedgerLog',
    '/api/report/getRejectionLog',
    '/api/stock/getStocks',
    '/api/stock/getUserStocks',
    '/api/stock/getStockData',
    '/api/report/getTradeLog',
    '/api/report/getBrokerageReport',
    '/api/report/getUserEditLog',
    '/api/report/getLoginLog',
    '/api/report/getQuantitySettingLog',
    '/api/report/getProfitLossUsers',
    '/api/report/getFinalBillsAllClients',
    '/api/user/getUsers',
    '/api/user/getUserById',
    '/api/user/getDownlineUsers',
    '/api/script/getMarkets',
    '/api/script/getSquareOffList'
  ]
};