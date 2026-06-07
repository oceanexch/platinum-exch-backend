const express = require("express");
const router = express.Router();
const multer = require("multer");
// Configure multer to store the uploaded file in memory.
const storage = multer.memoryStorage();
const upload = multer({ storage: storage });

const {
  addQuantitySetting,
  getUserQuantitySetting,
  updateQuantitySetting,
  deleteQuantitySetting,
  transferQuantitySetting,
  clearBuySellVariation,
  addLotSetting,
  getLotSetting,
  updateLotSetting,
  refreshLotSettings,
  addHoliday,
  getHolidays,
  deleteHoliday,
  addTime,
  getTimes,
  editTime,
  deleteTime,
  addNotification,
  getNotifications,
  deleteNotification,
  getUserNotification,
  seenNotification,
  blockScript,
  getBlockedScripts,
  //removeScriptBlock,
  unblockScript,
  addExpiry,
  getExpiries,
  deleteExpiry,
  editExpiry,
  addLimitDisable,
  getLimitDisable,
  deleteLimitDisable,
  transferSetting,
  getAlertSetting,
  updateAlertSetting,
  getMasterData,
  updateMasterData,
  getMasterDatas,
  getCurrencyValue,
  uploadFile,
  getClosingRate,
  addClosingRate,
  deleteClosingRate,
  deleteAllClosingRate,
  editClosingRate,
  getValanStatus,
  generateBill,
  revertBill,
  addScriptFroze,
  updateScriptFroze,
  getScriptFroze,
  deleteScriptFroze,
  updateNSEBan,
  getNSEBan,
  getMarketClosePrices,
  getMarketClosePricesBulk,
  syncClosingRates,
} = require("../controllers/SettingController");
const authenticateJWT = require("../middlewares/authenticateJWT");

// ---------Quantity Setting ---------------------
router.post("/addQuantitySetting", authenticateJWT, addQuantitySetting);
router.post("/getUserQuantitySetting", authenticateJWT, getUserQuantitySetting);
router.post("/updateQuantitySetting", authenticateJWT, updateQuantitySetting);
router.post("/deleteQuantitySetting", authenticateJWT, deleteQuantitySetting);
router.post(
  "/transferQuantitySetting",
  authenticateJWT,
  transferQuantitySetting
);

router.post("/clearBuySellVariation", authenticateJWT, clearBuySellVariation);

// ---------Lot Setting ---------------------
router.post("/addLotSetting", authenticateJWT, addLotSetting);
router.get("/getLotSetting", authenticateJWT, getLotSetting);
router.post("/updateLotSetting", authenticateJWT, updateLotSetting);
router.post("/refreshLotSettings", authenticateJWT, refreshLotSettings);

// ---------Holiday Setting ---------------------
router.post("/addHoliday", authenticateJWT, addHoliday);
router.get("/getHolidays", authenticateJWT, getHolidays);
router.post("/deleteHoliday", authenticateJWT, deleteHoliday);

// ---------Time Setting ---------------------
router.post("/addTime", authenticateJWT, addTime);
router.get("/getTimes", authenticateJWT, getTimes);
router.post("/editTime", authenticateJWT, editTime);
router.post("/deleteTime", authenticateJWT, deleteTime);

// ---------Notification/Headline Setting ---------------------
router.post("/addNotification", authenticateJWT, addNotification);
router.get("/getNotifications", authenticateJWT, getNotifications);
router.post("/deleteNotification", authenticateJWT, deleteNotification);
router.get("/getUserNotification", authenticateJWT, getUserNotification);
router.post("/seenNotification", authenticateJWT, seenNotification);

// ---------Allow/Block Script ---------------------
router.post("/blockScript", authenticateJWT, blockScript);
router.post("/getBlockedScripts", authenticateJWT, getBlockedScripts);
//router.post("/removeScriptBlock", authenticateJWT, removeScriptBlock);
router.post("/unblockScript", authenticateJWT, unblockScript);

// ---------Expiry ---------------------
router.post("/addExpiry", authenticateJWT, addExpiry);
router.get("/getExpiries", authenticateJWT, getExpiries);
router.post("/deleteExpiry", authenticateJWT, deleteExpiry);
router.post("/editExpiry", authenticateJWT, editExpiry);

// ---------Limit Disable ---------------------
router.post("/addLimitDisable", authenticateJWT, addLimitDisable);
router.get("/getLimitDisable", authenticateJWT, getLimitDisable);
router.post("/deleteLimitDisable", authenticateJWT, deleteLimitDisable);

// ---------Transfer Setting ---------------------
router.post("/transferSetting", authenticateJWT, transferSetting);

// ---------Alert Setting ---------------------
router.get("/getAlertSetting", authenticateJWT, getAlertSetting);
router.post("/updateAlertSetting", authenticateJWT, updateAlertSetting);

//Master data
router.post("/getMasterData", authenticateJWT, getMasterData);
router.post("/updateMasterData", authenticateJWT, updateMasterData);
router.get("/getMasterDatas", authenticateJWT, getMasterDatas);

router.get("/getCurrencyValue", authenticateJWT, getCurrencyValue);

router.post("/uploadFile", authenticateJWT, upload.single("file"), uploadFile);
router.post("/getClosingRate", authenticateJWT, getClosingRate);
router.post("/addClosingRate", authenticateJWT, addClosingRate);
router.post("/deleteClosingRate", authenticateJWT, deleteClosingRate);  
router.post("/deleteAllClosingRate", authenticateJWT, deleteAllClosingRate);
router.post("/editClosingRate", authenticateJWT, editClosingRate);

router.get("/getValanStatus", authenticateJWT, getValanStatus);
router.post("/generateBill", authenticateJWT, generateBill);
router.post("/revertBill", authenticateJWT, revertBill);

// --------- Script Froze ---------------------
router.post("/addScriptFroze", authenticateJWT, addScriptFroze);
router.post("/updateScriptFroze", authenticateJWT, updateScriptFroze);
router.get("/getScriptFroze", authenticateJWT, getScriptFroze);
router.post("/deleteScriptFroze", authenticateJWT, deleteScriptFroze);

// --------- NSE Ban ---------------------
router.post("/updateNSEBan", authenticateJWT, updateNSEBan);
router.get("/getNSEBan", authenticateJWT, getNSEBan);

router.post("/getMarketClosePrices", authenticateJWT, getMarketClosePrices);
router.post("/getMarketClosePricesBulk", authenticateJWT, getMarketClosePricesBulk);

// --------- Closing Rates Sync (Super Admin only) ---------------------
// Hits the Apollo /closing-price API, filters to Redis-known symbols,
// and updates BuyPrice + SellPrice (bid/ask) in Redis for changed symbols.
router.post("/syncClosingRates", authenticateJWT, syncClosingRates);

module.exports = router;
