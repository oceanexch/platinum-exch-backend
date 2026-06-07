const express = require("express");
const router = express.Router();
const {
  getLedgers,
  getLedgerList,
  getMyLedger,
  getUplineSettlement,
  getUplineSettlementList,
  createCashLedger,
  getCashLedger,
  deleteCashLedger,
  updateCashLedger,
  createDepositWithdraw,
  getDepositWithdraw,
  updateDepositWithdraw,
  deleteDepositWithdraw,
  getLedgerLog,
  getRejectionLog,
  noActiveUsers,
  deactivateNoActiveUsers,
  sameIpReport,
  getBrokerageReport,
  getTradeLog,
  setBrokerageRefresh,
  getBrokerageRefresh,
  createJVLedger,
  getJVLedger,
  updateJVLedger,
  deleteJVLedger,
  getUserEditLog,
  getUserEditLogDetail,
  getLoginLog,
  getQuantitySettingLog,
  deleteProfitableUserTrades,
  getProfitLossUsers,
  getFinalBillsAllClients,
  viewPdf
} = require("../controllers/ReportController");
const {
  getUserBehaviorAnalysis,
  uploadEventCalendar,
  getUserBehaviorHistory,
  getUsersBehaviorGrouped,
} = require("../controllers/UserBehaviorController");
const authenticateJWT = require("../middlewares/authenticateJWT");
const checkBrokerAccess = require("../middlewares/checkBrokerAccess");

// Public for Telegram in-app browser (must be BEFORE auth middlewares)
router.get("/view-pdf/:id", viewPdf);

// Apply broker access control middleware to all routes
router.use(authenticateJWT);
router.use(checkBrokerAccess);

router.get("/getLedgers", getLedgers);
router.get("/getLedgerList/:userId", getLedgerList);
router.get("/getMyLedger", getMyLedger);
router.get("/getUplineSettlement", getUplineSettlement);
router.get("/getUplineSettlementList", getUplineSettlementList);
router.post("/createCashLedger", createCashLedger);
router.post("/getCashLedger", getCashLedger);
router.post("/deleteCashLedger", deleteCashLedger);
router.post("/updateCashLedger", updateCashLedger);
router.post("/createDepositWithdraw", createDepositWithdraw);
router.post("/getDepositWithdraw", getDepositWithdraw);
router.post("/deleteDepositWithdraw", deleteDepositWithdraw);
router.post("/updateDepositWithdraw", updateDepositWithdraw);
router.post("/getLedgerLog", getLedgerLog);
router.post("/getRejectionLog", authenticateJWT, getRejectionLog);
router.post("/createJVLedger", authenticateJWT, createJVLedger);
router.post("/getJVLedger", authenticateJWT, getJVLedger);
router.post("/deleteJVLedger", authenticateJWT, deleteJVLedger);
router.post("/updateJVLedger", authenticateJWT, updateJVLedger);
router.post("/getUserEditLog", authenticateJWT, getUserEditLog);
router.post("/getUserEditLogDetail", authenticateJWT, getUserEditLogDetail);
router.post("/getLoginLog", authenticateJWT, getLoginLog);
router.post("/getQuantitySettingLog", authenticateJWT, getQuantitySettingLog);

router.post("/noActiveUsers", authenticateJWT, noActiveUsers);
router.post("/deactivateNoActiveUsers", authenticateJWT, deactivateNoActiveUsers);
router.post("/sameIpReport", authenticateJWT, sameIpReport);
router.post("/getBrokerageReport", authenticateJWT, getBrokerageReport);
router.post("/getTradeLog", authenticateJWT, getTradeLog);
router.post("/deleteProfitableUserTrades", authenticateJWT, deleteProfitableUserTrades);

router.post("/setBrokerageRefresh", authenticateJWT, setBrokerageRefresh);
router.get("/getBrokerageRefresh", authenticateJWT, getBrokerageRefresh);

router.post("/getProfitLossUsers", authenticateJWT, getProfitLossUsers);
router.post("/getTrialBalance", authenticateJWT, getFinalBillsAllClients);

// ─── User Behavior Analysis ──────────────────────────────────────────────────
router.post("/getUserBehaviorAnalysis", authenticateJWT, getUserBehaviorAnalysis);
router.post("/uploadEventCalendar", authenticateJWT, ...uploadEventCalendar);
router.get("/getUserBehaviorHistory/:userId", authenticateJWT, getUserBehaviorHistory);
router.post("/getUsersBehaviorGrouped", authenticateJWT, getUsersBehaviorGrouped);

module.exports = router;
