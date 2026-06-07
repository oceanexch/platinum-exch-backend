const express = require("express");
const router = express.Router();
const {
  saveStock,
  getStocks,
  getUserStocks,
  getSummaryReport,
  getStocksUserScriptWise,
  getScriptWiseReport,
  getWeekValan,
  getScriptSummaryReport,
  exitPosition,
  getStockData,
  manualTrade,
  getUserManualStocks,
  rollOverPosition,
  deleteTrade,
  editTrade,
  markTradeAsExecutedFromShort,
  getShortTradeReport,
  getShortTradeReportAllUsers,
  getLineTradeReport,
  saveDeletedLineTrade,
  getDeletedLineTrades,
  getBulkTradingReport,
  getUserPositionReport,
  saveLimitStock,
  getDownlineSummaryReport,
  getClientStockTransactions,
  clientStockByMaster,
  hardDeleteTrade,
  refreshMargin,
  hardRefreshMargin,
  adjustShortTrade,
  getBulkLot,
  getUsersScriptWisePosition,
  getNseEqSummaryReport,
  getNseEqScriptSummaryReport,
  getNseEqInterestReport,
  bulkDeleteTrade,
  recoverTrade,
  recalculateUserPositions,
  getTransactionAnalysis
} = require("../controllers/StockController");
const authenticateJWT = require("../middlewares/authenticateJWT");
const checkBrokerAccess = require("../middlewares/checkBrokerAccess");

// Apply broker access control middleware to all routes
router.use(authenticateJWT);
router.use(checkBrokerAccess);

router.post("/saveStock", saveStock);
router.post("/getStocks", getStocks);
router.get("/getUserStocks", getUserStocks);
router.get("/getSummaryReport", getSummaryReport);
router.get("/getStocksUserScriptWise", getStocksUserScriptWise);
router.get("/getScriptWiseReport", getScriptWiseReport);
router.get("/getWeekValan", getWeekValan);
router.get("/getScriptSummaryReport", getScriptSummaryReport);

router.post("/exitPosition", exitPosition);
router.get("/getStockData", getStockData);
router.post("/manualTrade", manualTrade);

router.post("/getUserManualStocks", getUserManualStocks);
router.post("/rollOverPosition", rollOverPosition);

router.post("/deleteTrade", deleteTrade);
router.post("/editTrade", editTrade);
router.post("/hardDeleteTrade", hardDeleteTrade);
router.post("/bulkDeleteTrade", bulkDeleteTrade);
router.post("/recoverTrade", recoverTrade);

router.post("/getShortTradeReport", getShortTradeReport);
router.post("/markTradeAsExecutedFromShort", markTradeAsExecutedFromShort);
router.post("/getShortTradeReportAllUsers", getShortTradeReportAllUsers);
router.post("/getLineTradeReport", getLineTradeReport);
router.post("/saveDeletedLineTrade", saveDeletedLineTrade);
router.get("/getDeletedLineTrades", getDeletedLineTrades);
router.post("/getBulkTradingReport", getBulkTradingReport);
router.post("/getUserPositionReport", getUserPositionReport);
router.post("/saveLimitStock", saveLimitStock);

router.get("/getDownlineSummaryReport", getDownlineSummaryReport);

router.get("/getClientStockTransactions", getClientStockTransactions)
router.get("/clientStockByMaster", clientStockByMaster)

router.post("/refreshMargin", refreshMargin);
router.post("/hardRefreshMargin", hardRefreshMargin);
router.post("/adjustShortTrade", adjustShortTrade);

router.post("/getBulkLot", getBulkLot);

router.post("/getUsersScriptWisePosition", getUsersScriptWisePosition);
router.get("/getNseEqSummaryReport", getNseEqSummaryReport);
router.get("/getNseEqScriptSummaryReport", getNseEqScriptSummaryReport);
router.get("/getNseEqInterestReport", getNseEqInterestReport);

router.post("/recalculateUserPositions", recalculateUserPositions);

router.post("/getTransactionAnalysis", getTransactionAnalysis);

module.exports = router;
