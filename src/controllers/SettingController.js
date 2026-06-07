const csv = require("csvtojson");
const xlsx = require("xlsx");
const moment = require("moment");
const { updateNSEBanData } = require("../services/NSEBanService");
const mongoose = require("mongoose");
const {
  saveQuantitySetting,
  getUserQuantitySetting,
  updateQuantitySetting,
  deleteQuantitySetting,
  transferQuantitySetting,
  clearBuySellVariation,
  saveLotSetting,
  getLotSetting,
  updateLotSetting,
  upsertLotSetting,
  saveHoliday,
  getHolidays,
  updateHoliday,
  deleteHoliday,
  saveTime,
  getTimes,
  updateTime,
  deleteTime,
  saveNotification,
  getNotifications,
  deleteNotification,
  getUserNotification,
  seenNotification,
  addScriptBlock,
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
  getDefaultFormattedDate,
  saveBhavCopy,
  getBhavCopy,
  updateBhavCopy,
  deleteBhavCopy,
  deleteAllBhavCopy,
  convertOptionString,
  getValanStatus,
  revertBill,
  getMarketClosePrices,
  getMarketClosePricesBySymbols
} = require("../services/SettingService");
const { MARKET_IDS } = require("../config/marketConstants");
const { MAX_LOT_VALUE } = require("../config/config");
const { getScriptsExpiryAndDataKey } = require("../services/ScriptService");

// When qtySetting is 'Lot', no lot-qty field may exceed MAX_LOT_VALUE (configurable).
// Returns the offending field name, or null if all within cap.
const LOT_QTY_FIELDS = ["maxOrder", "minOrder", "positionLimit", "perStrikePosition", "startRange", "endRange"];
const overLotCapField = (details) =>
  LOT_QTY_FIELDS.find((f) => (Number(details[f]) || 0) > MAX_LOT_VALUE) || null;
const { validateTransactionPassword } = require("../services/UserService");
const {
  getMultipleLiveStock,
  getUserPendingQuantity,
  setGetNextValanDetails,
  getActiveWeekValan,
  getValanById,
  getNextValanDetailsByValan,
  updateBillStatusBySegment,
  saveStockTransactions,
  getClientProfitLossReport,
  getLiveStock
} = require("../services/StockService");
const { generateFinalBills, generateMonthlyFinalBills } = require("../services/FinalBillService");
const { hmset, hgetall, redisClient } = require("../services/RedisService");
const {
  fetchClosingRates,
  applyClosingRatesToRedis,
} = require("../services/ClosingRateService");
const { validatepassword } = require("../services/AuthService");
const { getEffectiveUserId, getLoginUserId, getUserContext } = require("../utils/contextHelpers");
const quantitySetting = require("../models/QuantitySettingModel");
const lotSetting = require("../models/LotSettingModel");
const timeSetting = require("../models/TimeSettingModel");
const blockScript = require("../models/ScriptBlockModel");
const limitDisable = require("../models/LimitDisableModel");
const { setData, getData, del } = require("../services/RedisService");
const scriptSchema = require('../models/MarketTypeModel');
const { Script } = require('../models/MarketTypeModel');
const expirySetting = require('../models/ExpiryModel')
const ScriptFroze = require("../models/ScriptFrozeModel");
// ---------Quantity Setting ---------------------

exports.addQuantitySetting = async (req, res) => {
  try {
    const userId = getLoginUserId(req);
    const {
      clientId,
      marketId,
      marketName,
      scriptId,
      scriptName,
      qtySetting,
      isRange,
      startRange,
      endRange,
      minOrder,
      maxOrder,
      perStrikePosition,
      positionLimit,
      maxAmount,
      buySellVariation,
      variationStartTime,
      variationEndTime
    } = req.body;

    const quantityDetails = {
      clientId,
      marketId,
      marketName,
      scriptId,
      scriptName,
      qtySetting,
      isRange: Boolean(isRange),
      startRange: Number(startRange) || 0,
      endRange: Number(endRange) || 0,
      minOrder: Number(minOrder) || 0,
      maxOrder: Number(maxOrder) || 0,
      perStrikePosition: Number(perStrikePosition) || 0,
      positionLimit: Number(positionLimit) || 0,
      buySellVariation: Number(buySellVariation) || 0,
      variationStartTime: variationStartTime || "",
      variationEndTime: variationEndTime || "",
      createdBy: userId,
    };

    if (isRange) {
      // If it's a range setting, only check for overlapping ranges of the same type
      const nStart = quantityDetails.startRange;
      const nEnd = quantityDetails.endRange;

      if (nStart < 0 || nEnd < 0 || nStart >= nEnd) {
        return res.status(400).json({ status: false, message: "Invalid range: start range must be less than end range and both positive." });
      }

      // Overlap check
      const overlaps = await quantitySetting.findOne({
        clientId: new mongoose.Types.ObjectId(clientId),
        marketId,
        scriptId,
        qtySetting,
        isRange: true,
        startRange: { $lte: nEnd },
        endRange: { $gte: nStart }
      }).lean();

      if (overlaps) {
        return res.status(400).json({
          status: false,
          message: `The range ${nStart}-${nEnd} overlaps with an existing range ${overlaps.startRange}-${overlaps.endRange} for this ${qtySetting} setting.`
        });
      }
    } else {
      const exist = await quantitySetting.findOne({
        clientId: new mongoose.Types.ObjectId(clientId),
        marketId,
        scriptId,
        qtySetting
      }).lean();
      if (exist) {
        return res.status(500).json({ status: "false", message: "Quantity setting already exist!" });
      }
    }

    // map maxAmount if provided in payload
    if (maxAmount !== undefined) {
      quantityDetails.maxAmount = Number(maxAmount);
    }

    // For NSE-EQ, enforce 'Qty' type and only 1 param (max amount, stored in maxOrder for validation)
    if (marketId == MARKET_IDS.NSE_EQ) {
      if (qtySetting !== "Qty") {
        return res.status(400).json({ status: "false", message: "For NSE-EQ, only 'Qty' setting is allowed (which validates max amount)." });
      }
      // Zero out other parameters as per "only 1 param max amount" requirement
      quantityDetails.isRange = false;
      quantityDetails.startRange = 0;
      quantityDetails.endRange = 0;
      quantityDetails.minOrder = 0;
      quantityDetails.perStrikePosition = 0;
      quantityDetails.positionLimit = 0;

      // use separate field for maxAmount
    }

    // Lot cap: when type is 'Lot', no lot-qty field may exceed MAX_LOT_VALUE (configurable)
    if (qtySetting === "Lot") {
      const bad = overLotCapField(quantityDetails);
      if (bad) {
        return res.status(400).json({ status: false, message: `${bad} cannot exceed ${MAX_LOT_VALUE} for Lot setting` });
      }
    }

    const ip = req.headers["x-forwarded-for"] || req.socket.remoteAddress || req.ip;
    await saveQuantitySetting(quantityDetails, userId, ip);
    res
      .status(200)
      .json({ status: true, message: "Quantity setting added successfully" });
  } catch (error) {
    console.log(error);
    res.status(500).json({ status: "false", message: error.message });
  }
};

exports.getUserQuantitySetting = async (req, res) => {
  try {
    const response = await getUserQuantitySetting(req.body.clientId);
    res.status(200).json({ status: true, data: response });
  } catch (error) {
    console.log(error);
    res.status(500).json({ status: "false", message: error.message });
  }
};

exports.updateQuantitySetting = async (req, res) => {
  try {
    const userId = getLoginUserId(req);
    const {
      _id,
      qtySetting,
      isRange,
      startRange,
      endRange,
      minOrder,
      maxOrder,
      perStrikePosition,
      positionLimit,
      maxAmount,
      buySellVariation,
      variationStartTime,
      variationEndTime
    } = req.body;

    let quantityDetails = {
      qtySetting,
      isRange,
      startRange,
      endRange,
      minOrder,
      maxOrder,
      perStrikePosition,
      positionLimit,
      buySellVariation: Number(buySellVariation) || 0,
    };

    // map maxAmount if provided in payload
    if (maxAmount !== undefined) {
      quantityDetails.maxAmount = Number(maxAmount);
    }

    // Check if the setting being updated exists
    const existingSetting = await quantitySetting.findById(_id);
    if (!existingSetting) {
      return res.status(404).json({ status: false, message: "Quantity setting not found" });
    }

    // Range overlap validation for updates
    if (isRange) {
      const nStart = Number(startRange) || 0;
      const nEnd = Number(endRange) || 0;

      if (nStart < 0 || nEnd < 0 || nStart >= nEnd) {
        return res.status(400).json({ status: false, message: "Invalid range: start range must be less than end range and both positive." });
      }

      const overlap = await quantitySetting.findOne({
        _id: { $ne: _id },
        clientId: existingSetting.clientId,
        marketId: existingSetting.marketId,
        scriptId: existingSetting.scriptId,
        qtySetting: qtySetting || existingSetting.qtySetting,
        isRange: true,
        startRange: { $lte: nEnd },
        endRange: { $gte: nStart }
      }).lean();

      if (overlap) {
        return res.status(400).json({
          status: false,
          message: `The updated range ${nStart}-${nEnd} overlaps with an existing range ${overlap.startRange}-${overlap.endRange}.`
        });
      }
    } else if (isRange === false) {
      // Ensure no duplicate non-range exists
      const exist = await quantitySetting.findOne({
        _id: { $ne: _id },
        clientId: existingSetting.clientId,
        marketId: existingSetting.marketId,
        scriptId: existingSetting.scriptId,
        qtySetting: qtySetting || existingSetting.qtySetting,
        isRange: false
      }).lean();

      if (exist) {
        return res.status(400).json({
          status: false,
          message: `Another general ${qtySetting || existingSetting.qtySetting} setting already exists. Cannot have duplicates.`
        });
      }
    }

    quantityDetails.isRange = isRange !== undefined ? Boolean(isRange) : existingSetting.isRange;
    quantityDetails.startRange = startRange !== undefined ? Number(startRange) : existingSetting.startRange;
    quantityDetails.endRange = endRange !== undefined ? Number(endRange) : existingSetting.endRange;
    quantityDetails.minOrder = minOrder !== undefined ? Number(minOrder) : existingSetting.minOrder;
    quantityDetails.maxOrder = maxOrder !== undefined ? Number(maxOrder) : existingSetting.maxOrder;
    quantityDetails.perStrikePosition = perStrikePosition !== undefined ? Number(perStrikePosition) : existingSetting.perStrikePosition;
    quantityDetails.positionLimit = positionLimit !== undefined ? Number(positionLimit) : existingSetting.positionLimit;
    quantityDetails.buySellVariation = buySellVariation !== undefined ? Number(buySellVariation) : existingSetting.buySellVariation;
    quantityDetails.variationStartTime = variationStartTime !== undefined ? variationStartTime : existingSetting.variationStartTime;
    quantityDetails.variationEndTime = variationEndTime !== undefined ? variationEndTime : existingSetting.variationEndTime;

    // map maxAmount if provided in payload
    if (maxAmount !== undefined) {
      quantityDetails.maxAmount = Number(maxAmount);
    }

    if (existingSetting.marketId == MARKET_IDS.NSE_EQ) {
      if (qtySetting !== "Qty") {
        return res.status(400).json({ status: "false", message: "For NSE-EQ, only 'Qty' setting is allowed (which validates max amount)." });
      }
      // Zero out other parameters as per "only 1 param max amount" requirement
      quantityDetails.isRange = false;
      quantityDetails.startRange = 0;
      quantityDetails.endRange = 0;
      quantityDetails.minOrder = 0;

      quantityDetails.perStrikePosition = 0;
      quantityDetails.positionLimit = 0;

      // use separate field for maxAmount
    }

    // Lot cap: when type is 'Lot', no lot-qty field may exceed MAX_LOT_VALUE (configurable)
    if ((qtySetting || existingSetting.qtySetting) === "Lot") {
      const bad = overLotCapField(quantityDetails);
      if (bad) {
        return res.status(400).json({ status: false, message: `${bad} cannot exceed ${MAX_LOT_VALUE} for Lot setting` });
      }
    }

    const ip = req.headers["x-forwarded-for"] || req.socket.remoteAddress || req.ip;
    await updateQuantitySetting(quantityDetails, _id, userId, ip);
    res
      .status(200)
      .json({ status: true, message: "Quantity setting updated successfully" });
  } catch (error) {
    console.log(error);
    res.status(500).json({ status: "false", message: error.message });
  }
};

exports.deleteQuantitySetting = async (req, res) => {
  try {
    const userId = getLoginUserId(req);
    const ip = req.headers["x-forwarded-for"] || req.socket.remoteAddress || req.ip;
    await deleteQuantitySetting(req.body._id, userId, ip);
    res.status(200).json({
      status: true,
      message: "Quantity setting deleted successfully!",
    });
  } catch (error) {
    console.log(error);
    res.status(500).json({ status: "false", message: error.message });
  }
};

exports.transferQuantitySetting = async (req, res) => {
  try {
    const userId = getLoginUserId(req);
    const { fromClientId, toClientId } = req.body;
    if (!fromClientId || !toClientId || (Array.isArray(toClientId) && toClientId.length === 0)) {
      return res
        .status(500)
        .json({ status: "false", message: "From and To client are required" });
    }
    const ip = req.headers["x-forwarded-for"] || req.socket.remoteAddress || req.ip;
    await transferQuantitySetting(userId, fromClientId, toClientId, ip);
    res.status(200).json({
      status: true,
      message: "Quantity setting transered successfully",
    });
  } catch (error) {
    console.log(error);
    res.status(500).json({ status: "false", message: error.message });
  }
};

exports.clearBuySellVariation = async (req, res) => {
  try {
    const { userId, adminId } = req.body;
    if (!userId && !adminId) {
      return res.status(400).json({ status: false, message: "Either user_id or admin_id is required" });
    }
    const edit_by = getLoginUserId(req);
    const ip = req.headers["x-forwarded-for"] || req.socket.remoteAddress || req.ip;
    const response = await clearBuySellVariation(adminId, userId, edit_by, ip);
    res.status(200).json(response);
  } catch (error) {
    console.error(error);
    res.status(500).json({ status: false, message: error.message });
  }
};

// ---------Lot Setting ---------------------

exports.addLotSetting = async (req, res) => {
  try {
    const userId = getLoginUserId(req);
    const { marketId, marketName, scriptName, quantity } = req.body;
    const normalizedName = String(scriptName || "").toUpperCase();

    await upsertLotSetting({
      marketId: String(marketId),
      marketName,
      scriptName: normalizedName,
      quantity: Number(quantity)
    });

    res
      .status(200)
      .json({ status: true, message: "Lot setting saved successfully" });
  } catch (error) {
    console.log(error);
    res.status(500).json({ status: "false", message: error.message });
  }
};

exports.refreshLotSettings = async (req, res) => {
  try {
    const axios = require("axios");
    const { MARKET_IDS, MARKET_NAMES, ALLOWED_MCX_SCRIPTS } = require("../config/marketConstants");

    const API_BASE_URL = process.env.NEW_API_URL || "https://feed.apollo.in.net/test/api";
    const AUTH_TOKEN = process.env.NEW_API_TOKEN || "96e38803-3bf0-45fd-b0bc-49c1c3208b8a";

    const response = await axios.get(`${API_BASE_URL}/symbol-info`, {
      headers: { Authorization: `Bearer ${AUTH_TOKEN}` },
      timeout: 60000,
    });

    const apiData = response.data?.data || response.data || [];
    if (!Array.isArray(apiData)) {
      return res.status(500).json({ status: false, message: "Invalid API response format" });
    }

    const lotMap = new Map(); // key: "marketId|scriptName" -> { marketId, marketName, scriptName, quantity }

    for (const item of apiData) {
      if (!item.lot_size || !item.name) continue;

      const itemName = (item.name || "").toUpperCase();
      const exchangeKey = (item.exchange || "OTHERS").toUpperCase();

      // Skip indices exchange — process via NFUT/NSE instead
      if (exchangeKey === "INDICES") continue;

      if (exchangeKey === "MCX" && !ALLOWED_MCX_SCRIPTS.includes(itemName)) continue;

      const marketKeys = resolveMarketKeys(itemName, exchangeKey, item);

      for (const mKey of marketKeys) {
        const marketId = MARKET_IDS[mKey];
        if (!marketId) continue;
        const marketName = MARKET_NAMES[marketId] || mKey;
        const mapKey = `${marketId}|${itemName}`;
        if (!lotMap.has(mapKey)) {
          lotMap.set(mapKey, { marketId, marketName, scriptName: itemName, quantity: item.lot_size });
        }
      }
    }

    let upserted = 0;
    for (const doc of lotMap.values()) {
      await upsertLotSetting(doc);
      upserted++;
    }

    return res.status(200).json({ status: true, message: `Refreshed ${upserted} lot settings` });
  } catch (error) {
    console.error("refreshLotSettings error:", error);
    res.status(500).json({ status: false, message: error.message });
  }
};

function resolveMarketKeys(itemName, exchangeKey, item) {
  const strike = Number(item.strike) || 0;
  if (itemName === "SENSEX") return ["NFUT"];
  if ((itemName === "BANKNIFTY" || itemName === "NIFTY") && (exchangeKey === "NFUT" || exchangeKey === "NSE") && strike === 0 && item.expiry) {
    return ["NFUT", "NOPT"];
  }
  if (exchangeKey === "NFUT" || exchangeKey === "NSE") {
    return item.expiry ? ["NSE"] : ["NSE_EQ"];
  }
  if (["DOWJONES","GIFTNIFTY","S&P","SPX","S AND P","NASDAQ","GLOBAL"].some(g => itemName.includes(g))) {
    return ["GLOBAL"];
  }
  if (["GLOBAL","FOREX","FX","LMAX"].includes(exchangeKey)) return ["FOREX"];
  if (exchangeKey === "NOPT") return (itemName === "NIFTY" || itemName === "BANKNIFTY") ? ["NOPT"] : [];
  return [exchangeKey];
}

exports.getLotSetting = async (req, res) => {
  try {
    const response = await getLotSetting();
    res.status(200).json({ status: true, data: response });
  } catch (error) {
    console.log(error);
    res.status(500).json({ status: "false", message: error.message });
  }
};

exports.updateLotSetting = async (req, res) => {
  try {
    const { _id, quantity } = req.body;
    await updateLotSetting({ quantity }, _id);
    res
      .status(200)
      .json({ status: true, message: "Lot updated successfully!" });
  } catch (error) {
    console.log(error);
    res.status(500).json({ status: "false", message: error.message });
  }
};

exports.deleteLot = async (req, res) => {
  try {
    await deleteLot(req.body._id);
    res
      .status(200)
      .json({ status: true, message: "Lot deleted successfully!" });
  } catch (error) {
    console.log(error);
    res.status(500).json({ status: "false", message: error.message });
  }
};
// ---------Holiday Setting ---------------------

exports.addHoliday = async (req, res) => {
  try {
    const userId = getLoginUserId(req);
    const ip = req.ip;
    const { _id, marketId, marketName, holiday, session1, session2, date } =
      req.body;
    let startDate = 0;
    let endDate = 0;
    const mDate = moment(date);
    startDate = mDate.valueOf();

    if (session1 && !session2) {
      // Session 1: From provided time until Session 1 Close (16:59:59)
      endDate = moment(date).startOf('day').add(16, 'hours').add(59, 'minutes').add(59, 'seconds').add(999, 'ms').valueOf();
    } else if (session2 && !session1) {
      // Session 2: From provided time until Session 2 Close (23:30:59)
      endDate = moment(date).startOf('day').add(23, 'hours').add(30, 'minutes').add(59, 'seconds').add(999, 'ms').valueOf();
    } else {
      // Both or None: From provided time until End of Day (23:59:59)
      endDate = mDate.clone().endOf('day').valueOf();
    }
    if (_id) {
      await updateHoliday(
        {
          marketId,
          marketName,
          holiday,
          session1,
          session2,
          startDate,
          endDate,
          date,
        },
        _id
      );
      return res
        .status(200)
        .json({ status: true, message: "Holiday updated successfully" });
    }
    const holidayDetails = {
      marketId,
      marketName,
      holiday,
      session1,
      session2,
      startDate,
      endDate,
      ip,
      date,
      createdBy: userId,
    };

    await saveHoliday(holidayDetails);
    res
      .status(200)
      .json({ status: true, message: "Holiday added successfully" });
  } catch (error) {
    console.log(error);
    res.status(500).json({ status: "false", message: error.message });
  }
};

exports.getHolidays = async (req, res) => {
  try {
    const response = await getHolidays();
    res.status(200).json({ status: true, data: response });
  } catch (error) {
    console.log(error);
    res.status(500).json({ status: "false", message: error.message });
  }
};

exports.deleteHoliday = async (req, res) => {
  try {
    await deleteHoliday(req.body._id);
    res
      .status(200)
      .json({ status: true, message: "Holiday deleted successfully!" });
  } catch (error) {
    console.log(error);
    res.status(500).json({ status: "false", message: error.message });
  }
};

// ---------Time Setting ---------------------

exports.addTime = async (req, res) => {
  try {
    const userId = getLoginUserId(req);
    const { marketId, marketName, marketStartTime, marketEndTime, tradeStartTime, tradeEndTime } = req.body;
    const exist = await timeSetting.findOne({ marketId }).lean();
    if (exist) {
      return res.status(500).json({
        status: "false",
        message: `Time setting for ${marketName} already exist!`,
      });
    }
    const timeDetails = {
      marketId,
      marketName,
      marketStartTime,
      marketEndTime,
      tradeStartTime,
      tradeEndTime,
      createdBy: userId,
    };

    await saveTime(timeDetails);
    res.status(200).json({ status: true, message: "Time added successfully" });
  } catch (error) {
    console.log(error);
    res.status(500).json({ status: "false", message: error.message });
  }
};

exports.editTime = async (req, res) => {
  try {
    const { _id, marketId, marketName, marketStartTime, marketEndTime, tradeStartTime, tradeEndTime } = req.body;
    if (!_id) {
      return res.status(400).json({ status: "false", message: "ID is required" });
    }

    const timeDetails = {
      marketId,
      marketName,
      marketStartTime,
      marketEndTime,
      tradeStartTime,
      tradeEndTime,
    };

    await updateTime(_id, timeDetails);
    res.status(200).json({ status: true, message: "Time updated successfully" });
  } catch (error) {
    console.log(error);
    res.status(500).json({ status: "false", message: error.message });
  }
};

exports.getTimes = async (req, res) => {
  try {
    const response = await getTimes();
    res.status(200).json({ status: true, data: response });
  } catch (error) {
    console.log(error);
    res.status(500).json({ status: "false", message: error.message });
  }
};

exports.deleteTime = async (req, res) => {
  try {
    await deleteTime(req.body._id);
    res
      .status(200)
      .json({ status: true, message: "Time deleted successfully!" });
  } catch (error) {
    console.log(error);
    res.status(500).json({ status: "false", message: error.message });
  }
};

// ---------Notification/Headline Setting ---------------------

exports.addNotification = async (req, res) => {
  try {
    const userId = getLoginUserId(req);
    const userIp = req.headers['x-forwarded-for'] || req.socket.remoteAddress || req.ip;
    const {
      type,
      userType,
      selectedUser,
      selectedUserType,
      startDate,
      endDate,
      title,
      message,
    } = req.body;

    const notificationDetails = {
      type,
      userType,
      startDate: new Date(startDate)?.setHours(0, 0, 0, 0),
      endDate: new Date(endDate)?.setHours(23, 59, 59, 999),
      title,
      message,
      ip: userIp,
      createdBy: userId,
    };

    if (userType == "User Wise") {
      notificationDetails.selectedUser = selectedUser;
    } else if (userType == "User Type Wise") {
      notificationDetails.selectedUserType = selectedUserType;
    }

    await saveNotification(notificationDetails);
    res
      .status(200)
      .json({ status: true, message: "Notification added successfully" });
  } catch (error) {
    console.log(error);
    res.status(500).json({ status: "false", message: error.message });
  }
};

exports.getNotifications = async (req, res) => {
  try {
    const response = await getNotifications();
    res.status(200).json({ status: true, data: response });
  } catch (error) {
    console.log(error);
    res.status(500).json({ status: "false", message: error.message });
  }
};

exports.deleteNotification = async (req, res) => {
  try {
    await deleteNotification(req.body._id);

    res
      .status(200)
      .json({ status: true, message: "Notification deleted successfully!" });
  } catch (error) {
    console.log(error);
    res.status(500).json({ status: "false", message: error.message });
  }
};

exports.getUserNotification = async (req, res) => {
  try {
    const userId = getEffectiveUserId(req);
    const { accountType } = req.user;
    const ntfn = await getUserNotification(userId, accountType);
    res.status(200).json({ status: true, data: ntfn });
  } catch (error) {
    console.log(error);
    res.status(500).json({ status: "false", message: error.message });
  }
};

exports.seenNotification = async (req, res) => {
  try {
    const userId = getEffectiveUserId(req);
    const { accountType } = req.user;
    const { notificationIds } = req.body;
    const ntfn = await seenNotification(notificationIds, userId, accountType);
    res.status(200).json({ status: true });
  } catch (error) {
    console.log(error);
    res.status(500).json({ status: "false", message: error.message });
  }
};

exports.blockScript = async (req, res) => {
  try {
    const userId = getLoginUserId(req);
    const banArray = Array.isArray(req.body) ? req.body : [req.body];

    const detailsArray = banArray.map(item => ({
      clientId: item.userId || item.clientId,
      marketId: item.marketId,
      scriptId: item.scriptId,
      scriptName: item.scriptName,
      blockedBy: userId,
    }));

    const results = await addScriptBlock(detailsArray);

    // Aggregate results for the final message
    const successCount = results.filter(r => r.status).length;
    const failCount = results.length - successCount;

    let message = "Script blocking processed.";
    if (results.length > 1) {
      message = `Processed ${results.length} scripts: ${successCount} succeeded, ${failCount} failed.`;
    } else if (results.length === 1) {
      message = results[0].message;
    }

    res.status(200).json({
      status: successCount > 0,
      message,
      data: results
    });
  } catch (error) {
    console.error(error);
    res.status(500).json({ status: "false", message: error.message });
  }
};

exports.getBlockedScripts = async (req, res) => {
  try {
    const userId = getEffectiveUserId(req);
    const { clientId, marketId, scriptId } = req.body;
    const response = await getBlockedScripts({
      clientId,
      marketId,
      scriptId,
      userId,
      isRequesterDemo: isDemoUser(req)
    });
    res.status(200).json({ status: true, data: response });
  } catch (error) {
    console.log(error);
    res.status(500).json({ status: "false", message: error.message });
  }
};

exports.unblockScript = async (req, res) => {
  try {
    const userId = getLoginUserId(req);
    const { clientId, marketId, scriptId } = req.body;
    await unblockScript(clientId, marketId, scriptId);
    res.status(200).json({ status: true, message: "Script unblocked!" });
  } catch (error) {
    console.log(error);
    res.status(500).json({ status: "false", message: error.message });
  }
};

// --------- Expiry ---------------------

exports.addExpiry = async (req, res) => {
  try {
    const userId = getLoginUserId(req);
    const ip = req.headers['x-forwarded-for'] || req.socket.remoteAddress || req.ip;
    const {
      marketId,
      marketName,
      scriptId,
      scriptName,
      tradeStartDate,
      tradeEndDate,
      expiryDate,
    } = req.body;

    const expiryDetail = {
      marketId,
      marketName,
      scriptId,
      scriptName,
      tradeStartDate,
      tradeEndDate,
      expiryDate,
      ip,
      createdBy: userId,
    };

    await addExpiry(expiryDetail);
    res
      .status(200)
      .json({ status: true, message: "Expiry added successfully" });
  } catch (error) {
    console.log(error);
    res.status(500).json({ status: "false", message: error.message });
  }
};

exports.getExpiries = async (req, res) => {
  try {
    const response = await getExpiries();
    res.status(200).json({ status: true, data: response });
  } catch (error) {
    console.log(error);
    res.status(500).json({ status: "false", message: error.message });
  }
};

exports.deleteExpiry = async (req, res) => {
  try {
    const userId = getLoginUserId(req);
    await deleteExpiry(req.body._id);
    res.status(200).json({ status: true, message: "Expiry deleted!" });
  } catch (error) {
    console.log(error);
    res.status(500).json({ status: "false", message: error.message });
  }
};

exports.editExpiry = async (req, res) => {
  try {
    const userId = getLoginUserId(req);
    console.log(req.user);
    const { _id, tradeEndDate, expiryDate, password } = req.body;

    const validate = await validatepassword(userId, password);
    if (validate) {
      await editExpiry(_id, { tradeEndDate, expiryDate });

      const expiryDoc = await expirySetting.findById(_id);

      if (expiryDoc) {
        const { script_id, script_expiry_id } = expiryDoc;

        await scriptSchema.Script.updateOne(
          {
            script_id: script_id,                    // match script
            'expiry.script_expiry_id': script_expiry_id // match correct expiry in array
          },
          {
            $set: {
              'expiry.$.expiry_date': expiryDate,

            }
          }
        );
      }

      return res
        .status(200)
        .json({ status: true, message: 'Expiry date updated!' });
    } else {
      res
        .status(500)
        .json({ status: 'false', message: 'Password validation failed!' });

    }
  } catch (error) {
    console.log(error);
    res.status(500).json({ status: 'false', message: error.message });
  }
};

exports.addLimitDisable = async (req, res) => {
  try {
    const userId = getLoginUserId(req);
    const ip = req.headers['x-forwarded-for'] || req.socket.remoteAddress || req.ip;
    const { marketId, marketName, date, onlySquareOff } = req.body;
    const exist = await limitDisable.findOne({ marketId, date }).lean();
    if (exist) {
      return res.status(500).json({
        status: "false",
        message: "Limit disable already exist for this date!",
      });
    }
    const limitDisableDetail = {
      marketId,
      marketName,
      date,
      onlySquareOff,
      ip,
      createdBy: userId,
    };

    await addLimitDisable(limitDisableDetail);
    res
      .status(200)
      .json({ status: true, message: "Limit disable added successfully" });
  } catch (error) {
    console.log(error);
    res.status(500).json({ status: "false", message: error.message });
  }
};

exports.getLimitDisable = async (req, res) => {
  try {
    const response = await getLimitDisable();
    res.status(200).json({ status: true, data: response });
  } catch (error) {
    console.log(error);
    res.status(500).json({ status: "false", message: error.message });
  }
};

exports.deleteLimitDisable = async (req, res) => {
  try {
    const userId = getLoginUserId(req);
    await deleteLimitDisable(req.body._id);
    res.status(200).json({ status: true, message: "Limit disable deleted !" });
  } catch (error) {
    console.log(error);
    res.status(500).json({ status: "false", message: error.message });
  }
};

// --------- Transfer Setting ---------------------

exports.transferSetting = async (req, res) => {
  try {
    const userId = getLoginUserId(req);
    const ip = req.ip;
    const { marketId, fromClient, toClient, transferType } = req.body;
    if (!fromClient || !toClient || (Array.isArray(toClient) && toClient.length === 0)) {
      return res
        .status(500)
        .json({ status: "false", message: "From and To client are required" });
    }

    const transferDetail = {
      marketId,
      fromClient,
      toClient,
      ip,

    };
    if (transferType == "scriptblockallow") {
      await transferSetting(transferDetail);
    } else {
      return res
        .status(500)
        .json({ status: true, message: "Something went wrong." });
    }
    res
      .status(200)
      .json({ status: true, message: "Setting transfered successfully" });
  } catch (error) {
    console.log(error);
    res.status(500).json({ status: "false", message: error.message });
  }
};

// ---------Alert Setting ---------------------

exports.getAlertSetting = async (req, res) => {
  try {
    const userId = getEffectiveUserId(req);
    const response = await getAlertSetting(userId);
    res.status(200).json({ status: true, data: response });
  } catch (error) {
    console.log(error);
    res.status(500).json({ status: "false", message: error.message });
  }
};

exports.updateAlertSetting = async (req, res) => {
  try {
    const userId = getEffectiveUserId(req);
    const {
      tradeSound,
      autoSquareOffAlert,
      autoSquareOffAlertSound,
      tradeClearAlert,
    } = req.body;

    const details = {
      tradeSound,
      autoSquareOffAlert,
      autoSquareOffAlertSound,
      tradeClearAlert,
    };

    await updateAlertSetting(details, userId);
    res
      .status(200)
      .json({ status: true, message: "Alert setting updated successfully" });
  } catch (error) {
    console.log(error);
    res.status(500).json({ status: "false", message: error.message });
  }
};
exports.getMasterData = async (req, res) => {
  try {
    const { type } = req.body;
    if (
      ![
        "shortTradeMdata",
        "bulkTradeMdata",
        "lineTradeMdata",
        "intraday_squareoff_time",
        "weekly_squareoff_time",
        "currency_rate",
      ].includes(type)
    ) {
      return res
        .status(500)
        .json({ status: "false", message: "Invalid request!" });
    }
    let data = await hgetall(type);
    if (!Object.keys(data).length) {
      if (type == "shortTradeMdata") {
        await hmset("shortTradeMdata", { minute: 15 });
      } else if (type == "bulkTradeMdata") {
        await hmset("bulkTradeMdata", { noOfTrade: 10, minute: 15 });
      } else if (type == "lineTradeMdata") {
        await hmset("lineTradeMdata", {
          market: "",
          script: "",
          buyRateFrom: "",
          buyRateTo: "",
          sellRateFrom: "",
          sellRateTo: "",
          minute: 15,
        });
      }
    }
    data = await hgetall(type);
    res.status(200).json({ status: true, data });
  } catch (error) {
    console.log(error);
    res.status(500).json({ status: "false", message: error.message });
  }
};


exports.getMasterDatas = async (req, res) => {
  try {
    let intraday = await hgetall("intraday_squareoff_time");
    let weekly = await hgetall("weekly_squareoff_time");
    let currency = await hgetall("currency_rate");
    let password = await hgetall("master_password");
    res
      .status(200)
      .json({ status: true, data: { intraday, weekly, currency, password } });
  } catch (error) {
    console.log(error);
    res.status(500).json({ status: "false", message: error.message });
  }
};

exports.updateMasterData = async (req, res) => {
  try {
    const { type, value } = req.body;
    if (
      ![
        "shortTradeMdata",
        "bulkTradeMdata",
        "intraday_squareoff_time",
        "weekly_squareoff_time",
        "currency_rate",
        "master_password"
      ].includes(type)
    ) {
      return res
        .status(500)
        .json({ status: "false", message: "Invalid request!" });
    }
    await hmset(type, value);
    res.status(200).json({ status: true, message: "Successfully updated!" });
  } catch (error) {
    console.log(error);
    res.status(500).json({ status: "false", message: error.message });
  }
};

exports.getCurrencyValue = async (req, res) => {
  try {
    let currency = await hgetall("currency_rate");
    res.status(200).json({ status: true, data: currency });
  } catch (error) {
    console.log(error);
    res.status(500).json({ status: "false", message: error.message });
  }
};

exports.uploadFile = async (req, res) => {
  try {
    const { marketId } = req.body;
    if (!req.file) {
      return res.status(400).send("No file uploaded.");
    }

    let jsonArray;
    const fileExtension = req.file.originalname.split('.').pop().toLowerCase();

    if (fileExtension === 'csv') {
      const csvString = req.file.buffer.toString("utf-8");
      jsonArray = await csv().fromString(csvString);
    } else if (['xlsx', 'xls'].includes(fileExtension)) {
      // Use cellDates: true for proper Excel date handling
      const workbook = xlsx.read(req.file.buffer, { type: 'buffer', cellDates: true });
      const sheetName = workbook.SheetNames[0];
      const sheet = workbook.Sheets[sheetName];
      jsonArray = xlsx.utils.sheet_to_json(sheet, { defval: "" });
    } else {
      try {
        const csvString = req.file.buffer.toString("utf-8");
        jsonArray = await csv().fromString(csvString);
      } catch (e) {
        return res.status(400).send("Unsupported file format.");
      }
    }

    if (!jsonArray || jsonArray.length === 0) {
      return res.status(400).send("File is empty or could not be parsed.");
    }

    // Helper to find column values safely (handles truncation/case-sensitivity/aliases)
    const findVal = (row, ...aliases) => {
      const rowKeys = Object.keys(row);
      for (const alias of aliases) {
        const key = rowKeys.find(k => k.toLowerCase().trim() === alias.toLowerCase().trim());
        if (key !== undefined) return row[key];

        // Prefix match for truncated headers (e.g., CONTRAC -> CONTRACT_DESC)
        const prefix = alias.substring(0, 7).toLowerCase();
        const pKey = rowKeys.find(k => k.toLowerCase().startsWith(prefix));
        if (pKey !== undefined) return row[pKey];
      }
      return undefined;
    };

    // NSE-EQ scripts have empty expiry arrays — $unwind in getScriptsExpiryAndDataKey drops them.
    // For NSE-EQ query Script model directly and shape minimal records (no expiry concept).
    const scripts = marketId == "12"
      ? (await Script.find({ market_type_id: "12" })
          .select({ script_name: 1, script_id: 1, symbol: 1, market_type_id: 1, instrument_type: 1 })
          .lean()).map(s => ({
            marketId: s.market_type_id,
            scriptId: s.script_id || s.symbol,
            scriptName: s.script_name,
            symbol: s.symbol || s.script_name,
            label: s.script_name,
            InstrumentIdentifier: s.symbol || s.script_name,
          }))
      : await getScriptsExpiryAndDataKey({ market_type_id: marketId });

    // Map with normalized uppercase keys for robust matching
    // DB values like "ASHOKLEY 2026-03-30" or "ASHOKLEY 2026-03-30 25750 CE"
    // NSE-EQ (marketId 12) has no expiry; skip scriptMap construction (would break on parts[1]).
    const scriptMap = marketId == "12"
      ? new Map()
      : new Map(scripts.map(item => {
          const parts = item.label.split(" ");
          const symb = parts[0];
          const exp = getDefaultFormattedDate(parts[1]);
          let normalizedLabel = `${symb} ${exp}`.toUpperCase();
          if (parts.length > 2) {
            // Handle Options: SYMB EXP STRIKE TYPE
            // Parse strike to float to handle trailing zeros from DB (e.g., 25000.0 -> 25000)
            normalizedLabel = `${symb} ${exp} ${parseFloat(parts[2])} ${parts[3]}`.toUpperCase();
          }
          return [normalizedLabel, item];
        }));



    // All keys for prefix/fuzzy matching (for truncated symbols in Bhav copy)
    const scriptLabels = Array.from(scriptMap.keys());

    let newData = [];

    // Logic for NSE (2) and INDEX (10)
    if (marketId == "2" || marketId == "10") {
      newData = jsonArray.map((row, index) => {
        let scriptNameFromFile = "";
        let expiryDateFromFile = "";
        let searchLabel = "";

        const contractDesc = findVal(row, 'CONTRACT_DESC', 'CONTRACT_D', 'CONTRAC');
        if (contractDesc) {
          // Improved regex: Handle symbols ending in digits like NIFTYNXT50 
          // Group 2 ensures symbol starts with letters/hyphen/&, then greedily takes chars until a valid date pattern starts
          const match = String(contractDesc).match(/^(FUTSTK|FUTIDX|OPTSTK|OPTIDX)\s*([A-Z&-]+[A-Z0-9&-]*?)(\d{1,2}-?[A-Z]{3}-?\d{2,4})\s*(PE|CE)?\s*(\d*\.?\d*)?/i);
          if (match) {
            scriptNameFromFile = match[2];
            expiryDateFromFile = match[3];
            const exp = getDefaultFormattedDate(expiryDateFromFile);
            const optType = (match[4] || "").toUpperCase();
            const strike = match[5];

            if (optType && strike) {
              searchLabel = `${scriptNameFromFile.trim()} ${exp} ${parseFloat(strike)} ${optType}`.toUpperCase();
            } else {
              searchLabel = `${scriptNameFromFile.trim()} ${exp}`.toUpperCase();
            }
          }
        }

        if (!scriptNameFromFile) scriptNameFromFile = findVal(row, 'SYMBOL', 'SCRIP', 'SCRIPT');
        if (!expiryDateFromFile) expiryDateFromFile = findVal(row, 'EXPIRY_DT', 'EXPIRY_DATE', 'EXPIRY');

        if (!scriptNameFromFile || !expiryDateFromFile) return undefined;

        const exp = getDefaultFormattedDate(expiryDateFromFile);
        if (!searchLabel) searchLabel = `${scriptNameFromFile.trim()} ${exp}`.toUpperCase();


        // Exact match first
        let scriptRecord = scriptMap.get(searchLabel);
        if (!scriptRecord) {
          // Fuzzy match for truncated symbols
          const matchedLabel = scriptLabels.find(l => {
            const parts = l.split(" ");
            if (parts[1] !== exp) return false; // Expiry must match exactly
            return parts[0].startsWith(scriptNameFromFile.toUpperCase().trim());
          });
          if (matchedLabel) scriptRecord = scriptMap.get(matchedLabel);
        }

        if (!scriptRecord) {
          if (index < 5) console.log(`No match for NSE/IDX: "${searchLabel}"`);
          return undefined;
        }

        // Fallback for empty Close price (use Settlement price)
        let closePriceStr = findVal(row, 'CLOSE_PRIC', 'CLOSE_PR', 'CLOSE', 'SETTLE_PR', 'SETTLEME', 'CLOSE_PR_I');
        let closePrice = parseFloat(closePriceStr);

        if (isNaN(closePrice) || closePrice === 0) {
          // Try specifically settlement columns if close is missing
          const settlePriceStr = findVal(row, 'SETTLEME', 'SETTLEMENT', 'SETTLE_PR');
          const settlePrice = parseFloat(settlePriceStr);
          if (!isNaN(settlePrice) && settlePrice !== 0) closePrice = settlePrice;
        }

        return {
          marketName: marketId == "2" ? 'NSE' : 'INDEX',
          scriptName: scriptRecord.scriptName,
          scriptId: scriptRecord.scriptId || scriptRecord.symbol,
          symbol: scriptRecord.symbol,
          marketId: scriptRecord.marketId || marketId,
          expiry: exp,
          closingPrice: closePrice || 0,
          label: scriptRecord.label,
          InstrumentIdentifier: scriptRecord.InstrumentIdentifier,
        };
      }).filter(item => item !== undefined);

    } else if (marketId == "1") { //MCX
      newData = jsonArray.map((row, index) => {
        const rawExp = findVal(row, 'Expiry Date', 'EXPIRY_DT', 'EXPIRY');
        const symbol = findVal(row, 'Symbol', 'SCRIP', 'INSTRUMENT');
        const closePrice = findVal(row, 'Close', 'CLOSE_PR', 'CLOSE_PRIC', 'CLOSE', 'SETTLEME');


        if (!rawExp || !symbol) return undefined;

        const exp = getDefaultFormattedDate(rawExp);
        const searchLabel = `${symbol.trim()} ${exp}`.toUpperCase();

        // Exact match first
        let scriptRecord = scriptMap.get(searchLabel);
        if (!scriptRecord) {
          // Fuzzy match for truncated symbols in MCX (e.g. ALUMINI -> ALUMINIUM)
          const matchedLabel = scriptLabels.find(l => {
            const parts = l.split(" ");
            if (parts[1] !== exp) return false; // Expiry must match exactly
            return parts[0].startsWith(symbol.toUpperCase().trim());
          });
          if (matchedLabel) scriptRecord = scriptMap.get(matchedLabel);
        }

        if (!scriptRecord) {
          return undefined;
        }

        return {
          marketName: 'MCX',
          scriptName: scriptRecord.scriptName || symbol.trim(),
          scriptId: scriptRecord.scriptId || scriptRecord.symbol,
          symbol: scriptRecord.symbol,
          marketId: scriptRecord.marketId || marketId,
          expiry: exp,
          closingPrice: parseFloat(closePrice) || 0,
          label: scriptRecord.label,
          InstrumentIdentifier: scriptRecord.InstrumentIdentifier,
        };
      }).filter(item => item !== undefined);
    } else if (marketId == '4' || marketId == '7') { // GLOBAL & COMEX
      const instrumentIds = scripts.map(item => item.InstrumentIdentifier);
      const liveStock = await getMultipleLiveStock({ InstrumentIdentifier: { $in: instrumentIds } });
      const stockMap = new Map(liveStock.map(item => [item.InstrumentIdentifier, item]));

      newData = scripts.map(row => {
        const nameAndExpiry = row.label.split(" ");
        const exp = getDefaultFormattedDate(nameAndExpiry[1]);
        const InstrumentIdentifier = row.InstrumentIdentifier;
        return {
          marketId,
          marketName: marketId == '4' ? 'GLOBAL' : 'COMEX',
          scriptId: row.symbol || row.scriptId,
          scriptName: nameAndExpiry[0],
          expiry: exp,
          closingPrice: stockMap.get(InstrumentIdentifier)?.LastTradePrice || 0,
          label: row.label,
          InstrumentIdentifier,
        };
      });

    } else if (marketId == '3') { //NOPT
      newData = (await Promise.allSettled(jsonArray.map(async (row) => {
        const contractDesc = findVal(row, 'CONTRACT_DESC', 'CONTRACT_D', 'CONTRAC');
        const closePrice = findVal(row, 'CLOSE_PRIC', 'CLOSE_PR', 'CLOSE', 'SETTLE_PR', 'SETTLEME', 'CLOSE_PR_I');

        if (!contractDesc) return undefined;

        const match = await convertOptionString(contractDesc);
        if (!match || !match.scriptName) return undefined;

        const exp = getDefaultFormattedDate(match.expiryDate);
        const searchLabel = `${match.scriptName} ${exp} ${parseFloat(match.strike)} ${match.optionType}`.toUpperCase();

        let scriptRecord = scriptMap.get(searchLabel);
        if (!scriptRecord) {
          // Fuzzy match for truncated symbols if any
          const matchedLabel = scriptLabels.find(l => {
            const parts = l.split(" "); // Format: NAME EXP STRIKE TYPE
            if (parts[1] !== exp) return false;
            if (parts[2] !== parseFloat(match.strike).toString()) return false;
            if (parts[3] !== match.optionType.toUpperCase()) return false;
            return parts[0].startsWith(match.scriptName.toUpperCase().trim());
          });
          if (matchedLabel) scriptRecord = scriptMap.get(matchedLabel);
        }

        if (!scriptRecord) return undefined;

        return {
          marketName: 'NOPT',
          scriptName: match.scriptName,
          scriptId: scriptRecord.scriptId || scriptRecord.symbol,
          symbol: scriptRecord.symbol,
          marketId: scriptRecord.marketId || marketId,
          expiry: exp,
          closingPrice: parseFloat(closePrice) || 0,
          label: scriptRecord.label,
          InstrumentIdentifier: scriptRecord.InstrumentIdentifier,
        };
      }))).filter(item => item.status === 'fulfilled' && item.value && item.value.scriptId).map(item => item.value);
    } else if (marketId == "12") { // NSE-EQ (no expiry, match by symbol)
      // Build symbol-based map for NSE-EQ
      const symbolMap = new Map();
      scripts.forEach(item => {
        const labelFirst = (item.label || "").split(" ")[0];
        const sym = String(item.symbol || item.scriptName || labelFirst || "").toUpperCase().trim();
        if (sym && !symbolMap.has(sym)) symbolMap.set(sym, item);
      });

      // Accept equity series only — skip SGB (gold bonds), BE/BZ trade-to-trade, etc. unless map has them
      // Auto-detect series column (SERIES / SctySrs)
      const EQ_SERIES = new Set(["EQ", "BE", "BZ", "SM", "ST"]);

      let skippedSeries = 0;
      let unmatchedSymbols = 0;
      const sampleUnmatched = [];

      newData = jsonArray.map((row) => {
        // Auto-detect column aliases: old NSE bhav (SYMBOL/CLOSE) and new SEBI bhav (TckrSymb/ClsPric)
        const rawSym = findVal(row, 'SYMBOL', 'TckrSymb', 'SCRIP', 'SCRIPT');
        if (!rawSym) return undefined;
        const sym = String(rawSym).toUpperCase().trim();

        const series = String(findVal(row, 'SERIES', 'SctySrs') || "").toUpperCase().trim();
        if (series && !EQ_SERIES.has(series)) { skippedSeries++; return undefined; }

        const closePriceStr = findVal(row, 'CLOSE', 'ClsPric', 'CLOSE_PRICE', 'CLOSE_PRIC', 'LAST', 'LastPric');
        const closePrice = parseFloat(closePriceStr);
        if (isNaN(closePrice)) return undefined;

        const scriptRecord = symbolMap.get(sym);
        if (!scriptRecord) {
          unmatchedSymbols++;
          if (sampleUnmatched.length < 10) sampleUnmatched.push(sym);
          return undefined;
        }

        return {
          marketName: 'NSE-EQ',
          scriptName: scriptRecord.scriptName,
          scriptId: scriptRecord.scriptId || scriptRecord.symbol,
          symbol: scriptRecord.symbol,
          marketId: scriptRecord.marketId || marketId,
          expiry: null,
          closingPrice: closePrice,
          label: scriptRecord.label,
          InstrumentIdentifier: scriptRecord.InstrumentIdentifier,
        };
      }).filter(item => item !== undefined);

      console.log(`[NSE-EQ Upload] scriptsInDB=${scripts.length} mapSize=${symbolMap.size} totalRows=${jsonArray.length} matched=${newData.length} skippedSeries=${skippedSeries} unmatchedSymbols=${unmatchedSymbols}`);
      if (unmatchedSymbols > 0) console.log(`[NSE-EQ Upload] sample unmatched:`, sampleUnmatched);
    }

    if (newData.length > 0) {
      await saveBhavCopy(newData);
      res.status(200).json({ status: true, message: `Data saved successfully (${newData.length} records)` });
    } else {
      res.status(400).json({ status: false, message: "No matching scripts found in the uploaded file." });
    }
  } catch (error) {
    console.error("Upload Error:", error);
    res.status(500).json({ status: "false", message: error.message });
  }
};

exports.getClosingRate = async (req, res) => {
  try {
    const { marketId, date } = req.body;
    const filter = { marketId };
    if (date) {
      filter.date = date;
    }
    let data = await getBhavCopy(filter);

    // Fallback: If Bhavcopy is empty, try MarketClosePrice snapshots
    if (data.length === 0) {
      const fallbackData = await getMarketClosePrices(date, marketId);
      if (fallbackData && fallbackData.length > 0) {
        data = fallbackData.map((item) => ({
          _id: item._id,
          InstrumentIdentifier: item.symbol,
          symbol: item.symbol,
          scriptName: item.scriptName,
          expiry: item.expiry,
          marketId: item.marketId,
          marketName: item.marketName,
          closingPrice: item.ltp,
          date: date || (item.createdAt ? moment(item.createdAt).format("YYYY-MM-DD") : ""),
          isFallback: true
        }));
      }
    }

    res.status(200).json({ status: true, data });
  } catch (error) {
    console.log(error);
    res.status(500).json({ status: "false", message: error.message });
  }
};

exports.addClosingRate = async (req, res) => {
  try {
    // const body = req.body;
    // let data = JSON.parse(await getData("STOCK_CLOSING_RATE")) || [];
    // data = [...data, body];
    // await setData("STOCK_CLOSING_RATE", JSON.stringify(data));
    const {
      marketId,
      marketName,
      InstrumentIdentifier,
      closingPrice
    } = req.body;
    if (!marketId || !marketName || !InstrumentIdentifier || closingPrice === undefined) {
      return res.status(500).json({ status: "false", message: "Invalid data provided" });
    }
    // expiry = await getDefaultFormattedDate(expiry);
    // let label = `${scriptName} ${expiry}`;
    // const dataKey = await getDataKeyByLabel([label]);
    await saveBhavCopy({
      marketId,
      marketName,
      InstrumentIdentifier,
      closingPrice
    });
    res.status(200).json({ status: true, message: "Successfully added" });
  } catch (error) {
    console.log(error);
    res.status(500).json({ status: "false", message: error.message });
  }
};

exports.deleteAllClosingRate = async (req, res) => {
  try {
    const { marketId } = req.body;
    await deleteAllBhavCopy(marketId);
    //await del("STOCK_CLOSING_RATE");
    res.status(200).json({ status: true, message: "Successfully deleted" });
  } catch (error) {
    console.log(error);
    res.status(500).json({ status: "false", message: error.message });
  }
};

exports.deleteClosingRate = async (req, res) => {
  try {
    const { _id } = req.body;
    await deleteBhavCopy(_id);
    //await del("STOCK_CLOSING_RATE");
    res.status(200).json({ status: true, message: "Successfully deleted" });
  } catch (error) {
    console.log(error);
    res.status(500).json({ status: "false", message: error.message });
  }
};

exports.editClosingRate = async (req, res) => {
  try {
    const { _id, closingPrice } = req.body;
    await updateBhavCopy({ _id }, { closingPrice });
    //await del("STOCK_CLOSING_RATE");
    res.status(200).json({ status: true, message: "Successfully deleted" });
  } catch (error) {
    console.log(error);
    res.status(500).json({ status: "false", message: error.message });
  }
};

exports.getValanStatus = async (req, res) => {
  try {
    const valanstataus = await getValanStatus();
    res.status(200).json({ status: true, data: valanstataus });
  } catch (error) {
    console.log(error);
    res.status(500).json({ status: "false", message: error.message });
  }
};

exports.generateBill = async (req, res) => {
  try {
    const { valanId, marketId, transactionPassword } = req.body;

    if (!transactionPassword) {
      return res.status(400).json({ status: false, message: "Transaction password is required." });
    }
    const loginUserId = getLoginUserId(req);
    const isValidPassword = await validateTransactionPassword(loginUserId, transactionPassword.trim());
    if (!isValidPassword) {
      return res.status(400).json({ status: false, message: "Invalid transaction password." });
    }

    const stocks = await getBhavCopy({ marketId });
    // Build bhav copy map keyed by label AND by scriptId for fallback lookup
    const stockMapByLabel = new Map(stocks.map(item => [item.label, item]));
    const stockMapByScriptId = new Map(stocks.map(item => [item.scriptId, item]));
    const stockMapByInstrument = new Map(stocks.map(item => [item.InstrumentIdentifier, item]));

    const currentValan = await getValanById(valanId);
    const nextValan = await getNextValanDetailsByValan(currentValan);
    if (!currentValan || !nextValan) {
      return res.status(500).send({ status: true, message: "Error reading valan." });
    }

    const now = new Date();
    const startDate = new Date(currentValan.startDate);
    const endDate = new Date(currentValan.endDate);
    const isInRange = now >= startDate && now <= endDate;
    // if (isInRange) {
    //   return res.status(500).send({ status: true, message: "Bill generation not allowed during current valan." });
    // }

    const segment = currentValan?.segment?.find(f => f.id == marketId) || {};
    if (segment.billStatus) {
      return res.status(500).send({ status: true, message: "Bill already generated." });
    }

    const match = { transactionStatus: "COMPLETED", marketId, valanId: currentValan._id };
    const pendingQuantity = await getUserPendingQuantity(match);
    const QUANTITY_THRESHOLD = 0.0001;
    const usersWithPositions = pendingQuantity.filter(
      (item) => Math.abs(item.BUY_QTY - item.SELL_QTY) >= QUANTITY_THRESHOLD
    );

    if (usersWithPositions.length === 0) {
      const updateBill = await updateBillStatusBySegment(currentValan._id, segment._id, true);
      if (updateBill.allSegmentsBilled) {
        await getClientProfitLossReport(currentValan);
        const valanEnd = new Date(currentValan.endDate);
        await generateMonthlyFinalBills(valanEnd.getFullYear(), valanEnd.getMonth() + 1);
      }
      return res.send({ status: true, message: "Bill generated." });
    }

    const pendingEntries = [];
    const skipped = [];

    for (let entry of usersWithPositions) {
      // Remove unwanted fields from the last transaction
      delete entry.lastTransaction._id;
      delete entry.lastTransaction.createdAt;
      delete entry.lastTransaction.updatedAt;
      delete entry.lastTransaction.__v;
      delete entry.lastTransaction.otherBrokerage;
      delete entry.lastTransaction.orderBrokerage;
      delete entry.lastTransaction.netBrokerage;
      delete entry.lastTransaction.brokeragePercentage;
      delete entry.lastTransaction.brokerTotalBrokerage;
      delete entry.lastTransaction.brockersBrokerage;
      delete entry.lastTransaction.brokeragePercentageType;

      const { label, scriptId, scriptName, InstrumentIdentifier } = entry.lastTransaction;
      let stockInfo;
      // 1. Try bhav copy by label
      // let stockInfo = stockMapByLabel.get(label);
      // 2. Fallback: try by scriptId
      if (!stockInfo) stockInfo = stockMapByScriptId.get(scriptId);
      // 3. Fallback: try by InstrumentIdentifier
      if (!stockInfo) stockInfo = stockMapByInstrument.get(InstrumentIdentifier);

      let orderPrice = stockInfo?.closingPrice || 0;

      // 4. If still no closing price, fetch from live stock (Redis → MongoDB)
      if (!orderPrice) {
        const identifiers = [InstrumentIdentifier, scriptId, label, scriptName].filter(Boolean);
        let liveData = null;
        for (const ident of identifiers) {
          liveData = await getLiveStock(ident);
          if (liveData) break;
        }
        if (liveData) {
          // Use LastTradePrice as the closing price substitute
          orderPrice = Number(liveData.LastTradePrice || liveData.SellPrice || liveData.BuyPrice || 0);
        }
      }

      // 5. If still no price found, skip and log
      if (!orderPrice) {
        console.warn(`[generateBill] No price found for label="${label}" scriptId="${scriptId}". Skipping.`);
        skipped.push({ label, scriptId });
        continue;
      }

      const transactionType = entry.BUY_QTY > entry.SELL_QTY ? "SELL" : "BUY";
      const qty = Math.abs(entry.BUY_QTY - entry.SELL_QTY);
      const lot = Math.abs(entry.BUY_LOT - entry.SELL_LOT);
      const lastEntry = { ...entry.lastTransaction };
      // Safety check: Skip if quantity is negligible (floating-point error)
      if (qty < QUANTITY_THRESHOLD) {
        console.warn(`[generateBill] Skipping negligible quantity ${qty} for user ${entry._id.userId} script ${entry._id.scriptId}`);
        continue;
      }
      // Create Carry Forward (CF) in old valan
      pendingEntries.push(
        getNewEntry(lastEntry, currentValan._id, lot, qty, orderPrice, transactionType, "CF", "Carry Forward")
      );
      // Create B Forward (BF) in new valan
      pendingEntries.push(
        getNewEntry(lastEntry, nextValan._id, lot, qty, orderPrice, transactionType === "BUY" ? "SELL" : "BUY", "BF", "B Forward")
      );
    }

    if (pendingEntries.length > 0) {
      await saveStockTransactions(pendingEntries);

      // Update positions for all affected users/scripts in BOTH old and new valans
      const { setUserPosition } = require('../services/StockService');
      const seenOldValan = new Set();
      const seenNewValan = new Set();

      for (const entry of pendingEntries) {
        const userScriptKey = `${entry.userId}_${entry.scriptId}`;

        // Update position in old valan (CF transactions)
        if (entry.type === 'CF' && !seenOldValan.has(userScriptKey)) {
          seenOldValan.add(userScriptKey);
          try {
            await setUserPosition(entry.userId, entry.scriptId, currentValan._id, false);
          } catch (posErr) {
            console.error(`[generateBill] Error updating OLD valan position for user ${entry.userId} script ${entry.scriptId}:`, posErr);
          }
        }

        // Update position in new valan (BF transactions)
        if (entry.type === 'BF' && !seenNewValan.has(userScriptKey)) {
          seenNewValan.add(userScriptKey);
          try {
            await setUserPosition(entry.userId, entry.scriptId, nextValan._id, false);
          } catch (posErr) {
            console.error(`[generateBill] Error updating NEW valan position for user ${entry.userId} script ${entry.scriptId}:`, posErr);
          }
        }
      }
    }

    const updateBill = await updateBillStatusBySegment(currentValan._id, segment._id, true);
    
    // 🔹 Generate Final Bills in background (non-blocking)
    // This runs asynchronously after the main operation succeeds
    setImmediate(async () => {
      try {
        console.log(`[generateBill] Starting background bill generation for valan ${currentValan._id}, market ${marketId}`);
        await generateFinalBills(currentValan._id, marketId, { clean: true, force: true });
        console.log(`[generateBill] ✓ Background bill generation completed for valan ${currentValan._id}, market ${marketId}`);

        if (updateBill.allSegmentsBilled) {
          console.log(`[generateBill] All segments billed, generating client P&L report and monthly bills...`);
          await getClientProfitLossReport(currentValan);
          const valanEnd = new Date(currentValan.endDate);
          await generateMonthlyFinalBills(valanEnd.getFullYear(), valanEnd.getMonth() + 1);
          console.log(`[generateBill] ✓ Client P&L report and monthly bills generated`);
        }
      } catch (billError) {
        console.error(`[generateBill] ✗ Background bill generation failed for valan ${currentValan._id}, market ${marketId}:`, billError.message);
        console.error(billError.stack);
      }
    });

    res.status(200).json({
      status: true,
      message: `Bill successfully generated! ${pendingEntries.length / 2} positions rolled over.` +
        (skipped.length ? ` ${skipped.length} skipped (no price): ${skipped.map(s => s.label).join(', ')}` : '') +
        ` Final bills are being generated in the background.`
    });
  } catch (error) {
    console.log(error);
    res.status(500).json({ status: "false", message: error.message });
  }
};

const getNewEntry = (
  lastTransaction,
  valanId,
  lot,
  qty,
  orderPrice,
  transactionType,
  type,
  message
) => {
  return {
    ...lastTransaction,
    valanId,
    lot,
    quantity: qty,
    orderPrice,
    totalOrderPrice: orderPrice * qty,
    netPrice: orderPrice,
    totalNetPrice: orderPrice * qty,
    orderBrokerage: 0,
    netBrokerage: 0,
    brokeragePercentage: 0,
    type,
    transactionType,
    transactionStatus: "COMPLETED",
    orderType: "Market",
    ip: "0",
    message,
    quantityType: { intraday: qty, delivery: 0 },
    m2mPrice: orderPrice * qty,
    brokerTotalBrokerage: 0,
    brokeragePercentageType: { intraday: 0, delivery: 0 },
    brokerTotalPercentage: 0,
    otherBrokerage: { totalOrderBrokerage: 0, totalBrokerPercentage: 0 },
  };
};

exports.revertBill = async (req, res) => {
  try {
    const { valanId, marketId, transactionPassword } = req.body;
    if (!valanId || !marketId) {
      return res.status(400).json({ status: false, message: "valanId and marketId are required." });
    }

    if (!transactionPassword) {
      return res.status(400).json({ status: false, message: "Transaction password is required." });
    }
    const loginUserId = getLoginUserId(req);
    const isValidPassword = await validateTransactionPassword(loginUserId, transactionPassword.trim());
    if (!isValidPassword) {
      return res.status(400).json({ status: false, message: "Invalid transaction password." });
    }

    const currentValan = await getValanById(valanId);
    if (!currentValan) {
      return res.status(500).json({ status: false, message: "Valan not found." });
    }

    // Fetch next valan if it exists — BF entries may live there
    const nextValan = await getNextValanDetailsByValan(currentValan).catch(() => null);

    // Hard delete all CF/BF transactions for this market/valan
    await revertBill(currentValan, nextValan, marketId);

    // Reset bill status flag for the segment
    const segment = currentValan?.segment?.find(f => f.id == marketId);
    if (segment?._id) {
      await updateBillStatusBySegment(currentValan._id, segment._id, false);
    }

    res.status(200).json({ status: true, message: "Bill successfully reverted. All CF/BF entries and reports hard-deleted." });
  } catch (error) {
    console.log(error);
    res.status(500).json({ status: "false", message: error.message });
  }
};

// --------- Script Froze Setting ---------------------

exports.addScriptFroze = async (req, res) => {
  try {
    const userId = getLoginUserId(req);
    const { scriptId, scriptName, timeoutSeconds, isEnabled = true } = req.body;

    if (!scriptId || !scriptName || !timeoutSeconds) {
      return res.status(400).json({ status: "false", message: "Missing required fields" });
    }

    // Upsert (Create or Update)
    await ScriptFroze.findOneAndUpdate(
      { scriptId },
      {
        scriptId,
        scriptName,
        timeoutSeconds: Number(timeoutSeconds),
        isEnabled,
        createdBy: userId
      },
      { upsert: true, new: true }
    );

    res.status(200).json({ status: true, message: "Rule saved successfully" });
  } catch (error) {
    console.log(error);
    res.status(500).json({ status: "false", message: error.message });
  }
};

exports.updateScriptFroze = async (req, res) => {
  try {
    const userId = getLoginUserId(req);
    const { _id, scriptId, scriptName, timeoutSeconds, isEnabled } = req.body;

    if (!_id) {
      return res.status(400).json({ status: "false", message: "Missing required field: _id" });
    }

    await ScriptFroze.findByIdAndUpdate(
      _id,
      {
        scriptId,
        scriptName,
        timeoutSeconds: Number(timeoutSeconds),
        isEnabled,
        createdBy: userId
      },
      { new: true }
    );

    res.status(200).json({ status: true, message: "Rule updated successfully" });
  } catch (error) {
    console.log(error);
    res.status(500).json({ status: "false", message: error.message });
  }
};

exports.getScriptFroze = async (req, res) => {
  try {
    const response = await ScriptFroze.find({})
      .populate("createdBy", "accountCode accountName")
      .sort({ createdAt: -1 })
      .lean();
    res.status(200).json({ status: true, data: response });
  } catch (error) {
    console.log(error);
    res.status(500).json({ status: "false", message: error.message });
  }
};

exports.deleteScriptFroze = async (req, res) => {
  try {
    const { _id } = req.body;
    await ScriptFroze.findByIdAndDelete(_id);
    res.status(200).json({ status: true, message: "Rule deleted successfully" });
  } catch (error) {
    console.log(error);
    res.status(500).json({ status: "false", message: error.message });
  }
};

exports.updateNSEBan = async (req, res) => {
  try {
    const response = await updateNSEBanData();
    res.status(200).json({ status: true, message: "NSE Ban list updated successfully", data: response.data });
  } catch (error) {
    console.log(error);
    res.status(500).json({ status: "false", message: error.message });
  }
};

exports.getNSEBan = async (req, res) => {
  try {
    const data = await getData('nse_ban_scripts');
    res.status(200).json({ status: true, data: data ? JSON.parse(data) : [] });
  } catch (error) {
    console.log(error);
    res.status(500).json({ status: "false", message: error.message });
  }
};

exports.getMarketClosePrices = async (req, res) => {
  try {
    const { date, marketId } = req.body;
    const response = await getMarketClosePrices(date, marketId);
    res.status(200).json({ status: true, data: response });
  } catch (error) {
    console.error("Error in getMarketClosePrices controller:", error);
    res.status(500).json({ status: false, message: error.message });
  }
};

exports.getMarketClosePricesBulk = async (req, res) => {
  try {
    const { symbols } = req.body;
    if (!Array.isArray(symbols) || symbols.length === 0) {
      return res.status(400).json({ status: false, message: "symbols array required" });
    }
    const data = await getMarketClosePricesBySymbols(symbols);
    return res.status(200).json({ status: true, data });
  } catch (error) {
    console.error("Error in getMarketClosePricesBulk:", error);
    res.status(500).json({ status: false, message: error.message });
  }
};

/**
 * POST /setting/syncClosingRates
 *
 * Super-admin only endpoint that manually triggers a closing-rate sync:
 *  1. Fetches rates from the Apollo closing-price API.
 *  2. Filters to symbols that actually exist in Redis (ignores unknown symbols).
 *  3. Applies updated BuyPrice / SellPrice (bid/ask) for changed symbols.
 *
 * Safe to call at any time — if a market is still open its live prices
 * won't match the closing-price value so no change will be applied
 * for those symbols (areAllRatesApplied logic in the service handles this).
 */
exports.syncClosingRates = async (req, res) => {
  try {
    // ── Super-admin guard ─────────────────────────────────────────────────────
    const user = req.user;
    const level = user?.accountType?.level ?? user?.level;
    if (!user || level !== 1) {
      return res.status(403).json({
        status: false,
        message: "Access denied. Super admin only.",
      });
    }

    // ── Fetch from Apollo API ─────────────────────────────────────────────────
    const rates = await fetchClosingRates();
    if (!rates || rates.length === 0) {
      return res.status(200).json({
        status: true,
        message: "No closing rates returned from API.",
        total: 0,
        matched: 0,
        updated: 0,
      });
    }

    // ── Filter: keep only symbols present in the Redis stocks hash ────────────
    // This removes irrelevant symbols that our platform doesn't trade.
    const symbols = rates.map(r => r.symbol);
    const existingRaw = await redisClient.hmget("stocks", ...symbols);
    const filteredRates = rates.filter((_, i) => existingRaw[i] !== null);

    console.log(
      `[syncClosingRates] API returned ${rates.length} symbols. ` +
      `${filteredRates.length} matched Redis. ` +
      `${rates.length - filteredRates.length} skipped (not in Redis).`
    );

    // ── Apply closing prices ──────────────────────────────────────────────────
    const updatedCount = filteredRates.length > 0
      ? await applyClosingRatesToRedis(filteredRates)
      : 0;

    return res.status(200).json({
      status: true,
      message: `Closing rates synced successfully.`,
      total: rates.length,
      matched: filteredRates.length,
      updated: updatedCount,
    });
  } catch (error) {
    console.error("Error in syncClosingRates controller:", error);
    res.status(500).json({ status: false, message: error.message });
  }
};
