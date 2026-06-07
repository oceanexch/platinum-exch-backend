const express = require("express");
const router = express.Router();
const {
  getUserTypes,
  getAllUserTypes,
  createUser,
  getUsers,
  getUserById,
  brokerClient,
  getDownlineUsers,
  editUser,
  getMarginLimits,
  getDirectUsers,
  getClientTree,
  getDownlineLevelUsers,
  getOnlineUsers,
  getUserLevelMargins,
  getUserCounts,
  getDownlineDirectUsers,
  getMarquee,
  forceLogoutUser,
  createDemoUser,
  checkavialability,
  getActiveusercounts,
  getExtendedUsers,
  getDemoUsers,
  getOnlineHistory,
  getMarginManagement,
  getMyM2MLimits,
  getUsersWithHierarchyCounts,
  getBannedScriptUsers,
  deleteUserCompletely,
  getClientLedgerView,
  getDownlineUsersByAccountType,
  getMarketSettings,
  // Multi-Login Management
  createMLAccount,
  getMLAccounts,
  updateMLAccount,
  revokeMLAccount,
  deleteMultiLoginAccount,
  // Telegram Linking
  generateTelegramLink,
  unlinkTelegram,
  getAllLinkedAccountsHierarchy,
  unblockByIP
} = require("../controllers/UserController");
const {
  getPageHistory,
  addPageHistory
} = require("../controllers/PageHistoryController");
const {
  addTeleChatUser,
  deleteTeleChatUser,
  getTeleChatUsers
} = require("../controllers/TeleChatUserController");
const authenticateJWT = require('../middlewares/authenticateJWT');



router.get("/getUserTypes", authenticateJWT, getUserTypes);
router.get("/getAllUserTypes", authenticateJWT, getAllUserTypes);
router.post("/createUser", authenticateJWT, createUser);
router.post("/forceLogOutUser", authenticateJWT, forceLogoutUser);
router.get("/getUsers/:accountType", authenticateJWT, getUsers);
router.get("/getDemoUsers", authenticateJWT, getDemoUsers);
router.get("/getUserById/:id", authenticateJWT, getUserById);

router.get("/getMarketSettings", authenticateJWT, getMarketSettings);
router.post("/createDemoUser", createDemoUser);
router.post("/check-availability", checkavialability);
router.get("/getuserCount", authenticateJWT, getActiveusercounts);
router.get("/getUserMonitoringData", authenticateJWT, getExtendedUsers);

router.get("/getDownlineUsers", authenticateJWT, getDownlineUsers);
router.get("/brokerClient", authenticateJWT, brokerClient);

router.post("/editUser/:id/:userId", authenticateJWT, editUser);
router.post("/getMarginLimits", authenticateJWT, getMarginLimits);
router.get("/getDirectUsers", authenticateJWT, getDirectUsers);
router.post("/getClientTree", authenticateJWT, getClientTree);
router.get("/getDownlineLevelUsers/:level", authenticateJWT, getDownlineLevelUsers);
router.get("/getOnlineUsers", authenticateJWT, getOnlineUsers);
router.post("/getOnlineHistory", authenticateJWT, getOnlineHistory);
router.post("/getUserLevelMargins", authenticateJWT, getUserLevelMargins);

router.get("/getMarginManagement", authenticateJWT, getMarginManagement);
router.get("/getMyM2MLimits", authenticateJWT, getMyM2MLimits);

router.get("/getUserCounts", authenticateJWT, getUserCounts);
router.get('/getMarquee', getMarquee);
router.get("/getDownlineDirectUsers/:accountType/:userId", authenticateJWT, getDownlineDirectUsers);

router.post("/getPageHistory", authenticateJWT, getPageHistory);
router.post("/addPageHistory", authenticateJWT, addPageHistory);
router.get("/getUsersWithHierarchyCounts", authenticateJWT, getUsersWithHierarchyCounts);
router.get("/getBannedScriptUsers", authenticateJWT, getBannedScriptUsers);

//pending
router.post("/deleteUser_completely", authenticateJWT, deleteUserCompletely);

router.get("/getDeletedUsers", authenticateJWT, getClientLedgerView);
router.get("/getDeletedUserTransactions", authenticateJWT, getDownlineUsersByAccountType);

router.post("/addTeleChatUser", authenticateJWT, addTeleChatUser);
router.post("/deleteTeleChatUser", authenticateJWT, deleteTeleChatUser);
router.get("/getTeleChatUsers", authenticateJWT, getTeleChatUsers);

// ==================== MULTI-LOGIN ROUTES ====================
router.post("/create-ml-account", authenticateJWT, createMLAccount);
router.get("/ml-accounts/:userId", authenticateJWT, getMLAccounts);
router.post("/ml-account/:mlAccountId", authenticateJWT, updateMLAccount);
router.post("/ml-account/:mlAccountId", authenticateJWT, revokeMLAccount);

router.post("/delete-ml-account", authenticateJWT, deleteMultiLoginAccount);

// ==================== TELEGRAM BOT ROUTES ====================
router.post("/generate-telegram-link", authenticateJWT, generateTelegramLink);
router.post("/unlink-telegram", authenticateJWT, unlinkTelegram);
router.get("/all-linked-accounts", authenticateJWT, getAllLinkedAccountsHierarchy);
router.post("/unblock-ip", authenticateJWT, unblockByIP);

module.exports = router;

