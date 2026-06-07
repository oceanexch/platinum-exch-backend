const mongoose = require("mongoose");
const moment = require("moment");
const userModel = require("../models/UserModel");
const quantitySetting = require("../models/QuantitySettingModel");
const lotSetting = require("../models/LotSettingModel");
const holidaySetting = require("../models/HolidayModel");
const timeSetting = require("../models/TimeSettingModel");
const notificationSetting = require("../models/NotificationModel");
const expirySetting = require("../models/ExpiryModel");
const limitDisable = require("../models/LimitDisableModel");
const alertSetting = require("../models/AlertSettingModel");
const bhavCopy = require("../models/BhavCopyModel");
const weekValan = require("../models/WeekValanModel");
const ProfitLoss = require("../models/ProfitLossReport");
const Ledger = require("../models/LedgerModel");
const StockTransaction = require("../models/StockTransactionModel");
const StockService = require("./StockService");
const MarketClosePrice = require("../models/MarketClosePriceModel");
const LogService = require("./LogService");
const { MARKET_DEFAULT_TIMES, MARKET_NAMES } = require("../config/marketConstants");

// const { } = require('../../server')
const { redisPublisher } = require('../config/redis');
// ----------------- Quantity Setting --------------------------------------

exports.saveQuantitySetting = async (quantityDetails, edit_by, ip) => {
  try {
    const newQuantitySetting = new quantitySetting(quantityDetails);
    const saved = await newQuantitySetting.save();

    const user = await userModel.findById(quantityDetails.clientId).select("parentIds accountType").lean();
    await LogService.saveLog("userEdit", {
      clientId: quantityDetails.clientId,
      parentIds: user?.parentIds || [],
      accountType: user?.accountType,
      basic: [],
      brokerage: [],
      market: [],
      qty: [{
        log: "Add",
        marketId: quantityDetails.marketId,
        marketName: quantityDetails.marketName,
        scriptId: quantityDetails.scriptId,
        scriptName: quantityDetails.scriptName,
        qtySetting: quantityDetails.qtySetting,
        isRange: quantityDetails.isRange,
        startRange: quantityDetails.startRange,
        endRange: quantityDetails.endRange,
        minOrder: quantityDetails.minOrder,
        maxOrder: quantityDetails.maxOrder,
        maxAmount: quantityDetails.maxAmount,
        perStrikePosition: quantityDetails.perStrikePosition,
        positionLimit: quantityDetails.positionLimit,
        buySellVariation: quantityDetails.buySellVariation,
        variationStartTime: quantityDetails.variationStartTime,
        variationEndTime: quantityDetails.variationEndTime,
        old_value: null,
      }],
      ip,
      time: Date.now(),
      edit_by,
    });

    return saved;
  } catch (error) {
    console.error("Error fetching data:", error);
    throw error;
  }
};

exports.getUserQuantitySetting = async (clientId) => {
  try {
    if (!clientId || !mongoose.Types.ObjectId.isValid(clientId)) {
      return [];
    }
    const qtySettings = await quantitySetting
      .find({ clientId })
      .populate("clientId", "accountName accountCode")
      .populate("createdBy", "accountName accountCode")
      .lean();

    if (!qtySettings.length) return [];

    const activeValan = await weekValan.findOne({ status: true }).lean();
    if (!activeValan) return qtySettings;

    const response = await Promise.all(
      qtySettings.map(async (qty) => {
        const positionMatch = {
          userId: new mongoose.Types.ObjectId(clientId),
          valanId: activeValan._id,
          marketId: qty.marketId,
        };


        const positions = await StockService.getUserPosition(positionMatch);
        const totalLots = positions.reduce((acc, pos) => {
          return acc + (pos.buyLot - pos.sellLot);
        }, 0);

        return {
          ...qty,
          totalPosition: totalLots,
        };
      })
    );

    return response;
  } catch (error) {
    console.error("Error fetching data:", error);
    throw error;
  }
};

exports.updateQuantitySetting = async (quantityDetails, _id, edit_by, ip) => {
  try {
    const oldSetting = await quantitySetting.findById(_id).lean();
    if (!oldSetting) return;

    const result = await quantitySetting.updateOne({ _id }, quantityDetails);

    const user = await userModel.findById(oldSetting.clientId).select("parentIds accountType").lean();
    await LogService.saveLog("userEdit", {
      clientId: oldSetting.clientId,
      parentIds: user?.parentIds || [],
      accountType: user?.accountType,
      basic: [],
      brokerage: [],
      market: [],
      qty: [
        {
          log: "Old",
          marketId: oldSetting.marketId,
          marketName: oldSetting.marketName,
          scriptId: oldSetting.scriptId,
          scriptName: oldSetting.scriptName,
          qtySetting: oldSetting.qtySetting,
          isRange: oldSetting.isRange,
          startRange: oldSetting.startRange,
          endRange: oldSetting.endRange,
          minOrder: oldSetting.minOrder,
          maxOrder: oldSetting.maxOrder,
          maxAmount: oldSetting.maxAmount,
          perStrikePosition: oldSetting.perStrikePosition,
          positionLimit: oldSetting.positionLimit,
          buySellVariation: oldSetting.buySellVariation,
          variationStartTime: oldSetting.variationStartTime,
          variationEndTime: oldSetting.variationEndTime,
        },
        {
          log: "Edit",
          marketId: oldSetting.marketId,
          marketName: oldSetting.marketName,
          scriptId: oldSetting.scriptId,
          scriptName: oldSetting.scriptName,
          qtySetting: quantityDetails.qtySetting ?? oldSetting.qtySetting,
          isRange: quantityDetails.isRange ?? oldSetting.isRange,
          startRange: quantityDetails.startRange ?? oldSetting.startRange,
          endRange: quantityDetails.endRange ?? oldSetting.endRange,
          minOrder: quantityDetails.minOrder ?? oldSetting.minOrder,
          maxOrder: quantityDetails.maxOrder ?? oldSetting.maxOrder,
          maxAmount: quantityDetails.maxAmount ?? oldSetting.maxAmount,
          perStrikePosition: quantityDetails.perStrikePosition ?? oldSetting.perStrikePosition,
          positionLimit: quantityDetails.positionLimit ?? oldSetting.positionLimit,
          buySellVariation: quantityDetails.buySellVariation ?? oldSetting.buySellVariation,
          variationStartTime: quantityDetails.variationStartTime ?? oldSetting.variationStartTime,
          variationEndTime: quantityDetails.variationEndTime ?? oldSetting.variationEndTime,
        },
      ],
      ip,
      time: Date.now(),
      edit_by,
    });

    return result;
  } catch (error) {
    console.error("Error updating quantity setting:", error);
    throw error;
  }
};

exports.deleteQuantitySetting = async (_id, edit_by, ip) => {
  try {
    const oldSetting = await quantitySetting.findById(_id).lean();
    if (!oldSetting) return;

    const result = await quantitySetting.deleteOne({ _id });

    const user = await userModel.findById(oldSetting.clientId).select("parentIds accountType").lean();
    await LogService.saveLog("userEdit", {
      clientId: oldSetting.clientId,
      parentIds: user?.parentIds || [],
      accountType: user?.accountType,
      basic: [],
      brokerage: [],
      market: [],
      qty: [{
        log: "Del",
        marketId: oldSetting.marketId,
        marketName: oldSetting.marketName,
        scriptId: oldSetting.scriptId,
        scriptName: oldSetting.scriptName,
        qtySetting: oldSetting.qtySetting,
        isRange: oldSetting.isRange,
        startRange: oldSetting.startRange,
        endRange: oldSetting.endRange,
        minOrder: oldSetting.minOrder,
        maxOrder: oldSetting.maxOrder,
        maxAmount: oldSetting.maxAmount,
        perStrikePosition: oldSetting.perStrikePosition,
        positionLimit: oldSetting.positionLimit,
        buySellVariation: oldSetting.buySellVariation,
        variationStartTime: oldSetting.variationStartTime,
        variationEndTime: oldSetting.variationEndTime,
      }],
      ip,
      time: Date.now(),
      edit_by,
    });

    return result;
  } catch (error) {
    console.error("Error fetching data:", error);
    throw error;
  }
};

exports.transferQuantitySetting = async (userId, fromClientId, toClientId,ip) => {
  try {
    if (!fromClientId || !mongoose.Types.ObjectId.isValid(fromClientId)) {
      return [];
    }
    const targetIds = Array.isArray(toClientId) ? toClientId : [toClientId];
    const validTargetIds = targetIds.filter(id => id && mongoose.Types.ObjectId.isValid(id));
    
    if (validTargetIds.length === 0) {
      return [];
    }

    const qtyList = await quantitySetting
      .find({ clientId: fromClientId })
      .lean();
    if (!qtyList.length) return [];
    // We need to support an array of toClientIds
    const toClientIds = Array.isArray(toClientId) ? toClientId : [toClientId];
    const transferList = [];

    for (const id of validTargetIds) {
      qtyList.forEach((qty) => {
        transferList.push({
          clientId: id,
          marketId: qty.marketId,
          marketName: qty.marketName,
          scriptId: qty.scriptId,
          scriptName: qty.scriptName,
          qtySetting: qty.qtySetting,
          isRange: qty.isRange,
          startRange: qty.startRange,
          endRange: qty.endRange,
          minOrder: qty.minOrder,
          maxOrder: qty.maxOrder,
          perStrikePosition: qty.perStrikePosition,
          positionLimit: qty.positionLimit,
          buySellVariation: qty.buySellVariation || 0,
          variationStartTime: qty.variationStartTime || "",
          variationEndTime: qty.variationEndTime || "",
          createdBy: userId,
        });
      });
    }

    await quantitySetting.deleteMany({ clientId: { $in: validTargetIds } });
    const result = await quantitySetting.insertMany(transferList);

    for (const targetId of validTargetIds) {
      const user = await userModel.findById(targetId).select("parentIds accountType").lean();
      await LogService.saveLog("userEdit", {
        clientId: targetId,
        parentIds: user?.parentIds || [],
        accountType: user?.accountType,
        basic: [],
        brokerage: [],
        market: [],
        qty: qtyList.map((qty) => ({
          log: "Transfer",
          from: fromClientId,
          marketId: qty.marketId,
          marketName: qty.marketName,
          scriptId: qty.scriptId,
          scriptName: qty.scriptName,
          qtySetting: qty.qtySetting,
          isRange: qty.isRange,
          startRange: qty.startRange,
          endRange: qty.endRange,
          minOrder: qty.minOrder,
          maxOrder: qty.maxOrder,
          maxAmount: qty.maxAmount,
          perStrikePosition: qty.perStrikePosition,
          positionLimit: qty.positionLimit,
          buySellVariation: qty.buySellVariation || 0,
          variationStartTime: qty.variationStartTime || "",
          variationEndTime: qty.variationEndTime || "",
        })),
        ip,
        time: Date.now(),
        edit_by: userId,
      });
    }

    return result;
  } catch (error) {
    console.error("Error fetching data:", error);
    throw error;
  }
};

exports.clearBuySellVariation = async (adminId, userId, edit_by, ip) => {
  try {
    let clientIdsToUpdate = [];
    if (adminId) {
      const downlines = await userModel.find({ parentIds: new mongoose.Types.ObjectId(adminId) }).select('_id').lean();
      clientIdsToUpdate = downlines.map(d => d._id);
    } else if (userId) {
      clientIdsToUpdate = [new mongoose.Types.ObjectId(userId)];
    }

    if (clientIdsToUpdate.length === 0) {
      return { status: true, message: "No users found" };
    }

    // Fetch old settings for logging BEFORE reset
    const oldSettings = await quantitySetting.find({
      clientId: { $in: clientIdsToUpdate },
      buySellVariation: { $ne: 0 }
    }).lean();

    await quantitySetting.updateMany(
      { clientId: { $in: clientIdsToUpdate } },
      { $set: { buySellVariation: 0 } }
    );

    // Logging per user reset
    for (const old of oldSettings) {
      const logDetails = {
        clientId: old.clientId,
        marketId: old.marketId,
        marketName: old.marketName,
        scriptId: old.scriptId,
        scriptName: old.scriptName,
        qtySetting: old.qtySetting,
        old_value: {
          buySellVariation: old.buySellVariation,
          variationStartTime: old.variationStartTime,
          variationEndTime: old.variationEndTime,
        },
        new_value: {
          buySellVariation: 0,
          variationStartTime: old.variationStartTime,
          variationEndTime: old.variationEndTime,
        },
        ip: ip,
        time: Date.now(),
        edit_by: edit_by,
      };

      const user = await userModel.findById(old.clientId).select("parentIds").lean();
      if (user) {
        logDetails.parentIds = user.parentIds;
      }
      await LogService.saveLog("quantitySetting", logDetails);
    }

    return { status: true, message: "Variation reset successfully" };
  } catch (error) {
    console.error("Error clearing variation:", error);
    throw error;
  }
};

// ----------------- Lot Setting --------------------------------------

exports.saveLotSetting = async (lotDetails) => {
  try {
    const newLotSetting = new lotSetting(lotDetails);
    return await newLotSetting.save();
  } catch (error) {
    console.error("Error fetching data:", error);
    throw error;
  }
};

exports.getLotSetting = async (match = {}, project = {}) => {
  try {
    return await lotSetting.find(match).select(project).lean();
  } catch (error) {
    console.error("Error fetching data:", error);
    throw error;
  }
};

exports.updateLotSetting = async (lotDetails, _id) => {
  try {
    return await lotSetting.updateOne({ _id }, lotDetails);
  } catch (error) {
    console.error("Error fetching data:", error);
    throw error;
  }
};

exports.deleteLot = async (_id) => {
  try {
    return await lotSetting.deleteOne({ _id });
  } catch (error) {
    console.error("Error fetching data:", error);
    throw error;
  }
};

exports.upsertLotSetting = async ({ marketId, marketName, scriptName, quantity }) => {
  try {
    return await lotSetting.updateOne(
      { marketId: String(marketId), scriptName: String(scriptName).toUpperCase() },
      {
        $set: { quantity: Number(quantity), marketName: String(marketName) },
        $setOnInsert: { createdBy: new (require("mongoose").Types.ObjectId)("000000000000000000000000") }
      },
      { upsert: true }
    );
  } catch (error) {
    console.error("Error upserting lot setting:", error);
    throw error;
  }
};
// ----------------- Holiday Setting --------------------------------------

exports.saveHoliday = async (holidayDetails) => {
  try {
    const newHoliday = new holidaySetting(holidayDetails);
    return await newHoliday.save();
  } catch (error) {
    console.error("Error fetching data:", error);
    throw error;
  }
};

exports.getHolidays = async () => {
  try {
    return await holidaySetting
      .find({})
      .populate("createdBy", "accountName accountCode")
      .lean();
  } catch (error) {
    console.error("Error fetching data:", error);
    throw error;
  }
};

exports.updateHoliday = async (holidayDetails, _id) => {
  try {
    return await holidaySetting.updateOne({ _id }, holidayDetails);
  } catch (error) {
    console.error("Error fetching data:", error);
    throw error;
  }
};

exports.deleteHoliday = async (_id) => {
  try {
    return await holidaySetting.deleteOne({ _id });
  } catch (error) {
    console.error("Error fetching data:", error);
    throw error;
  }
};

exports.getHolidayByFilter = async (match) => {
  try {
    return await holidaySetting.findOne(match).lean();
  } catch (error) {
    console.error("Error fetching data:", error);
    throw error;
  }
};

// ----------------- Time Setting --------------------------------------

exports.saveTime = async (timeDetails) => {
  try {
    const newTime = new timeSetting(timeDetails);
    return await newTime.save();
  } catch (error) {
    console.error("Error fetching data:", error);
    throw error;
  }
};

exports.getTimes = async () => {
  try {
    return await timeSetting
      .find({})
      //.populate("createdBy", "accountName accountCode")
      .lean();
  } catch (error) {
    console.error("Error fetching data:", error);
    throw error;
  }
};

exports.updateTime = async (_id, timeDetails) => {
  try {
    return await timeSetting.updateOne({ _id }, timeDetails);
  } catch (error) {
    console.error("Error fetching data:", error);
    throw error;
  }
};

exports.deleteTime = async (_id) => {
  try {
    return await timeSetting.deleteOne({ _id });
  } catch (error) {
    console.error("Error fetching data:", error);
    throw error;
  }
};

exports.getTimeByMarket = async (marketId) => {
  try {
    // console.log("marketId", marketId);
    const setting = await timeSetting
      .findOne({ marketId })
      //.populate("createdBy", "accountName accountCode")
      .lean();
    // console.log("setting", setting);

    if (setting) return setting;

    // Fallback to defaults
    const defaultTime = MARKET_DEFAULT_TIMES[marketId] || MARKET_DEFAULT_TIMES.DEFAULT;

    return {
      marketId,
      marketStartTime: defaultTime.marketStartTime,
      marketEndTime: defaultTime.marketEndTime,
      tradeStartTime: defaultTime.tradeStartTime,
      tradeEndTime: defaultTime.tradeEndTime,
      isDefault: true
    };
  } catch (error) {
    console.error("Error fetching data:", error);
    throw error;
  }
};

exports.saveNotification = async (notificationDetails) => {
  try {
    // Normalize startDate/endDate to epoch ms (if provided)
    const normalizeDate = (val) => {
      if (val == null || val === "") return null;
      if (typeof val === "number") return val;
      const d = new Date(val);
      return isNaN(d.getTime()) ? null : d.getTime();
    };

    const payloadToSave = {
      ...notificationDetails,
      startDate: normalizeDate(notificationDetails.startDate),
      endDate: normalizeDate(notificationDetails.endDate),
    };

    const newNotification = new notificationSetting(payloadToSave);
    const savedNotification = await newNotification.save();

    // Prepare a compact payload for Redis (avoid circular refs, large objects)
    const publishPayload = {
      type: "ADD",
      data: {
        _id: savedNotification._id.toString(),
        title: savedNotification.title,
        message: savedNotification.message,
        type: savedNotification.type,
        userType: savedNotification.userType,
        selectedUser: savedNotification.selectedUser,
        selectedUserType: savedNotification.selectedUserType,
        isParentShow: savedNotification.isParentShow,
        parentIds: savedNotification.parentIds,
        startDate: savedNotification.startDate,
        endDate: savedNotification.endDate,
        createdAt: savedNotification.createdAt?.getTime?.() || Date.now()
      }
    };

    // Decide channel based on savedNotification.type
    // Treat "Headline" (or "Heading") as headline channel — tweak string to match your schema.
    const channelName =
      (savedNotification.type || "").toString().toLowerCase() === "headline"
        ? "headlines"
        : "notifications";

    await redisPublisher.publish(channelName, JSON.stringify(publishPayload));

    return savedNotification;
  } catch (error) {
    console.error("Error saving notification:", error);
    throw error;
  }
};

exports.getNotifications = async () => {
  try {
    return await notificationSetting
      .find({})
      .populate("createdBy", "accountName accountCode")
      .sort({ createdAt: -1 })
      .lean();
  } catch (error) {
    console.error("Error fetching data:", error);
    throw error;
  }
};

exports.deleteNotification = async (_id) => {
  try {
    const data = await notificationSetting.findOne({ _id }).lean();

    if (!data) return;

    const result = await notificationSetting.deleteOne({ _id });
    const channelName =
      (data.type || "").toString().toLowerCase() === "headline"
        ? "headlines"
        : "notifications";

    await redisPublisher.publish(channelName, JSON.stringify({
      type: "DELETE",
      // data: { id: data._id }
      data: data
    }));
    return result;
  } catch (error) {
    console.error("Error fetching data:", error);
    throw error;
  }
};


exports.getUserNotification = async (userId, accountType) => {
  try {
    const userObjectId = new mongoose.Types.ObjectId(userId);
    const accountTypeObjectId = new mongoose.Types.ObjectId(accountType._id);
    const currentTime = new Date().getTime();

    const headlines = await notificationSetting.aggregate([
      {
        $match: {
          type: 'Headline',
          startDate: { $lte: currentTime },
          endDate: { $gte: currentTime },
        },
      },
      {
        $project: {
          message: 1,
          _id: 0,
        },
      },
      {
        $sort: { createdAt: -1 }
      }
    ]);

    const notification = await notificationSetting.aggregate([
      {
        $match: {
          type: 'Notification',
          startDate: { $lte: currentTime },
          endDate: { $gte: currentTime },
          $or: [
            { userType: "User Wise", selectedUser: { $in: [userId, "All"] } },
            { userType: "User Type Wise", selectedUserType: accountTypeObjectId },
            { isParentShow: true, parentIds: userObjectId }
          ],
          readBy: { $ne: userObjectId }
        },
      },
      {
        $project: {
          title: 1,
          message: 1,
          createdAt: 1
        },
      },
      {
        $sort: {
          createdAt: -1
        }
      }
    ]);

    // return all messages as an array
    return {
      notification,
      headlines: headlines.map(h => h.message)
    };
  } catch (error) {
    console.error("Error fetching data:", error);
    throw error;
  }
};

exports.seenNotification = async (notificationIds, userId, accountType) => {
  try {
    return await notificationSetting.updateMany({ _id: { $in: notificationIds } }, { $addToSet: { readBy: userId } });
  } catch (error) {
    console.error("Error fetching data:", error);
    throw error;
  }
};


exports.addScriptBlock = async (details) => {
  try {
    const processItem = async (item) => {
      try {
        const exist = await userModel
          .findOne({
            _id: item.clientId,
            "marketAccess.marketId": item.marketId,
          })
          .lean();
        if (exist) {
          const update = await userModel.updateOne(
            {
              _id: item.clientId,
              "marketAccess.marketId": item.marketId,
            },
            {
              $pull: {
                "marketAccess.$[market].other.allowScript": {
                  scriptId: item.scriptId,
                },
              },
              $addToSet: {
                "marketAccess.$[market].other.blockScript": {
                  scriptId: item.scriptId,
                  scriptName: item.scriptName,
                  bannedBy: item.blockedBy,
                },
              },
            },
            {
              arrayFilters: [{ "market.marketId": item.marketId }],
            }
          );
          return {
            status: true,
            message: `Script ${item.scriptName} blocked for user.`,
            result: update
          };
        } else {
          return {
            status: false,
            message: `Market ${item.marketId} is not available for this user.`,
            item
          };
        }
      } catch (err) {
        return { status: false, message: err.message, item };
      }
    };

    if (Array.isArray(details)) {
      const results = [];
      for (const item of details) {
        results.push(await processItem(item));
      }
      return results;
    } else {
      const res = await processItem(details);
      if (res.status === false) throw { message: res.message };
      return res;
    }
  } catch (error) {
    console.error("Error in addScriptBlock:", error);
    throw error;
  }
};

exports.getBlockedScripts = async ({
  clientId,
  marketId,
  scriptId,
  userId,
  isRequesterDemo = false,
}) => {
  try {
    let mainQuery = {
      parentIds: new mongoose.Types.ObjectId(userId),
      demoid: isRequesterDemo ? true : { $ne: true }
    };
    let marketQuery = {};
    let scriptQuery = {};
    if (clientId) {
      mainQuery._id = new mongoose.Types.ObjectId(clientId);
    }
    if (marketId) {
      marketQuery["marketAccess.marketId"] = marketId;
    }
    if (scriptId) {
      scriptQuery["marketAccess.other.blockScript.scriptId"] = scriptId;
    }
    const list = await userModel.aggregate([
      {
        $match: mainQuery,
      },
      {
        $project: {
          tagsLength: 1,
          accountName: 1,
          accountCode: 1,
          marketAccess: {
            marketId: 1,
            marketName: 1,
            other: {
              blockScript: 1,
              isTransferred: 1,
            },
          },
        },
      },
      {
        $unwind: "$marketAccess",
      },
      {
        $match: marketQuery,
      },
      {
        $unwind: "$marketAccess.other.blockScript",
      },
      {
        $match: scriptQuery,
      },
      {
        $lookup: {
          from: "users",
          localField: "marketAccess.other.blockScript.bannedBy",
          foreignField: "_id",
          as: "bannedByUser",
        },
      },
      {
        $addFields: {
          "marketAccess.other.blockScript.bannedBy": {
            $cond: {
              if: { $gt: [{ $size: "$bannedByUser" }, 0] },
              then: {
                accountName: { $arrayElemAt: ["$bannedByUser.accountName", 0] },
                accountCode: { $arrayElemAt: ["$bannedByUser.accountCode", 0] },
              },
              else: null,
            },
          },
        },
      },
      {
        $project: {
          bannedByUser: 0,
        },
      },
    ]);
    return list;
  } catch (error) {
    console.error("Error fetching data:", error);
    throw error;
  }
};

exports.unblockScript = async (clientId, marketId, scriptId) => {
  try {
    const update = await userModel.updateOne(
      {
        _id: new mongoose.Types.ObjectId(clientId),
        "marketAccess.marketId": marketId, // Ensure market exists
      },
      {
        $pull: {
          "marketAccess.$[market].other.blockScript": { scriptName: scriptId },
        },
      },
      {
        arrayFilters: [{ "market.marketId": marketId }],
      }
    );
    return update;
  } catch (error) {
    console.error("Error fetching data:", error);
    throw error;
  }
};

// ----------------- Expiry --------------------------------------

exports.addExpiry = async (details) => {
  try {
    const expiry = new expirySetting(details);
    return await expiry.save();
  } catch (error) {
    console.error("Error fetching data:", error);
    throw error;
  }
};

exports.getExpiries = async () => {
  try {
    return await expirySetting
      .find({})
      .populate("createdBy", "accountName accountCode")
      .lean();
  } catch (error) {
    console.error("Error fetching data:", error);
    throw error;
  }
};

exports.deleteExpiry = async (_id) => {
  try {
    return await expirySetting.deleteOne({ _id });
  } catch (error) {
    console.error("Error fetching data:", error);
    throw error;
  }
};

exports.getFilterExpiries = async (match) => {
  try {
    return await expirySetting.find({ ...match }).lean();
  } catch (error) {
    console.error("Error fetching data:", error);
    throw error;
  }
};

exports.editExpiry = async (_id, detail) => {
  try {
    // let temp = await expirySetting.updateOne({ _id }, detail);
    return await expirySetting.findByIdAndUpdate(_id, detail, { new: true }).lean();
  } catch (error) {
    console.error("Error fetching data:", error);
    throw error;
  }
};

// ----------------- LimitDisable --------------------------------------

exports.addLimitDisable = async (details) => {
  try {
    const limitD = new limitDisable(details);
    return await limitD.save();
  } catch (error) {
    console.error("Error fetching data:", error);
    throw error;
  }
};

exports.getLimitDisable = async () => {
  try {
    return await limitDisable
      .find({})
      .populate("createdBy", "accountName accountCode")
      .lean();
  } catch (error) {
    console.error("Error fetching data:", error);
    throw error;
  }
};

exports.deleteLimitDisable = async (_id) => {
  try {
    return await limitDisable.deleteOne({ _id });
  } catch (error) {
    console.error("Error fetching data:", error);
    throw error;
  }
};

exports.getFilterLimitDisable = async (match) => {
  try {
    return await limitDisable.findOne({ ...match }).lean();
  } catch (error) {
    console.error("Error fetching data:", error);
    throw error;
  }
};

// ----------------- Transfer Setting --------------------------------------

exports.transferSetting = async (details) => {
  try {
    const exist = await userModel.aggregate([
      { $match: { _id: new mongoose.Types.ObjectId(details.fromClient) } },
      { $unwind: "$marketAccess" },
      { $match: { "marketAccess.marketId": details.marketId } },
      { $project: { "marketAccess.other": 1, _id: 0 } },
    ]);
    if (exist.length) {
      // Create an array of IDs safely
      const toClientIds = Array.isArray(details.toClient) ? details.toClient : [details.toClient];

      const update = await userModel.updateMany(
        {
          _id: { $in: toClientIds },
          "marketAccess.marketId": details.marketId,
        },
        {
          $set: {
            "marketAccess.$.other.allowOrBlock":
              exist[0].marketAccess.other.allowOrBlock,
            "marketAccess.$.other.allowScript":
              exist[0].marketAccess.other.allowScript,
            "marketAccess.$.other.blockScript":
              exist[0].marketAccess.other.blockScript,
            "marketAccess.$.other.isTransferred": true,
          },
        }
      );
      return update;
    } else {
      throw { message: "Market is not available for this user." };
    }
  } catch (error) {
    console.error("Error fetching data:", error);
    throw error;
  }
};

// ----------------- Alert Setting --------------------------------------

exports.saveAlertSetting = async (details) => {
  try {
    const newAlertSetting = new alertSetting(details);
    return await newAlertSetting.save();
  } catch (error) {
    console.error("Error fetching data:", error);
    throw error;
  }
};

exports.getAlertSetting = async (userId) => {
  try {
    const setting = await alertSetting.findOne({ userId }).lean();
    if (!setting) {
      let details = {
        userId,
        tradeSound: false,
        autoSquareOffAlert: false,
        autoSquareOffAlertSound: false,
        tradeClearAlert: false,
      };
      await this.saveAlertSetting(details);
      return details;
    } else {
      return setting;
    }
  } catch (error) {
    console.error("Error fetching data:", error);
    throw error;
  }
};

exports.updateAlertSetting = async (details, userId) => {
  try {
    return await alertSetting.updateOne({ userId }, details);
  } catch (error) {
    console.error("Error fetching data:", error);
    throw error;
  }
};

exports.getDefaultFormattedDate = (date) => {
  if (!date) return "";
  const formats = ["DDMMMYYYY", "YYYY-MM-DD", "DD-MM-YYYY", "DD MMM YYYY", "DD-MMM-YYYY"];
  const m = moment(date, formats, true);
  if (m.isValid()) return m.format("DDMMMYYYY").toUpperCase();
  const mFallback = moment(date);
  if (mFallback.isValid()) return mFallback.format("DDMMMYYYY").toUpperCase();
  return String(date).toUpperCase();
}

exports.saveBhavCopy = async (details) => {
  try {
    const today = moment().format("YYYY-MM-DD");
    if (Array.isArray(details)) {
      if (details.length === 0) return;
      const ops = details.map((item) => {
        item.date = today;
        return {
          updateOne: {
            filter: { InstrumentIdentifier: item.InstrumentIdentifier },
            update: { $set: item },
            upsert: true,
          },
        };
      });
      return await bhavCopy.bulkWrite(ops);
    } else {
      details.date = today;
      return await bhavCopy.updateOne(
        { InstrumentIdentifier: details.InstrumentIdentifier },
        { $set: details },
        { upsert: true }
      );
    }
  } catch (error) {
    console.error("Error saving bhavcopy:", error);
    throw error;
  }
};

exports.getBhavCopy = async (filter) => {
  try {
    const result = await bhavCopy.aggregate([
      { $match: filter },
      { $sort: { scriptId: 1, createdAt: -1 } },
      {
        $group: {
          _id: '$scriptId',
          doc: { $first: '$$ROOT' }
        }
      },
      { $replaceRoot: { newRoot: '$doc' } },
      { $sort: { scriptId: 1 } }
    ]);
    console.log("Bhav copy results :",result)
    return result;
  } catch (error) {
    console.error("Error fetching data:", error);
    throw error;
  }
};

exports.updateBhavCopy = async (filter, details) => {
  try {
    return await bhavCopy.updateOne(filter, details);
  } catch (error) {
    console.error("Error fetching data:", error);
    throw error;
  }
};

exports.deleteBhavCopy = async (_id) => {
  try {
    return await bhavCopy.deleteOne({ _id });
  } catch (error) {
    console.error("Error fetching data:", error);
    throw error;
  }
};

exports.deleteAllBhavCopy = async (marketId) => {
  try {
    const filter = {};
    if (marketId) {
      filter.marketId = marketId;
    }
    return await bhavCopy.deleteMany(filter);
  } catch (error) {
    console.error("Error deleting data:", error);
    throw error;
  }
};

exports.convertOptionString = async (input) => {
  try {
    //const regex = /^OPTSTK([A-Z]+)(\d{2})-([A-Z]{3})-(\d{4})(PE|CE)(\d+)$/;
    const regex = /^(OPTSTK|OPTIDX)([A-Z]+)(\d{2})-([A-Z]{3})-(\d{4})(PE|CE)(\d+)$/;
    const monthMap = {
      JAN: '01', FEB: '02', MAR: '03', APR: '04',
      MAY: '05', JUN: '06', JUL: '07', AUG: '08',
      SEP: '09', OCT: '10', NOV: '11', DEC: '12'
    };

    const match = input.match(regex);
    if (!match) return "Invalid format";

    const script = match[2];            // e.g. ANGELONE or NIFTY
    const day = match[3];               // e.g. 31
    const monthStr = match[4];          // e.g. JUL
    const yearFull = match[5];          // e.g. 2025
    const yearShort = yearFull.slice(2);// e.g. 25
    const optionType = match[6];        // PE or CE
    const strike = match[7];            // e.g. 2000

    const month = monthMap[monthStr];   // Convert JUL to 07

    const optionFormatted = `${script}${yearShort}${month}${day}${strike}${optionType}`;
    const expiryDate = `${day}-${monthStr}-${yearFull}`;

    return {
      scriptName: script,
      expiryDate: expiryDate,
      strike: strike,
      optionType: optionType,
      optionString: optionFormatted
    };
  } catch (error) {
    console.error("Error converting option string:", error);
    throw error;
  }

}

exports.getValanStatus = async (userId) => {
  try {
    const today = moment().startOf("day");
    const activeValan = await weekValan
      .findOne({ status: true })
      .sort({ createdAt: -1 })
      .lean();

    if (!activeValan) {
      return [];
    }

    let valansToProcess = [];

    // ---------------------------------------------------------
    // TEMP CODE: Show this (active) and prev valan
    // [Start of temporary section — Comment out below after test]
    // ---------------------------------------------------------
    const prevValan = await weekValan
      .findOne({ endDate: { $lt: activeValan.startDate } })
      .sort({ endDate: -1 })
      .lean();
    if (prevValan) {
      valansToProcess.push(prevValan);
    }
    // ---------------------------------------------------------
    // [End of temporary section]
    // ---------------------------------------------------------

    valansToProcess.push(activeValan);

    const valanEndDate = moment(activeValan.endDate).startOf("day");
    
    // Always show next valan on Saturday (6), Sunday (0) or on the actual end day
    if (valanEndDate.isSame(today) || today.day() === 6 || today.day() === 0) {
      const nextValan = await weekValan
        .findOne({ startDate: { $gt: activeValan.endDate } })
        .sort({ startDate: 1 })
        .lean();

      if (nextValan) {
        valansToProcess.push(nextValan);
      }
    }

    const result = [];
    for (const v of valansToProcess) {
      if (v.segment && Array.isArray(v.segment)) {
        for (const seg of v.segment) {
          result.push({
            _id: v._id,
            label: v.label,
            segment: seg,
            billstatus: v.billStatus,
            status: v.status,
            startDate: v.startDate,
            endDate: v.endDate,
          });
        }
      }
    }
    return result;
  } catch (error) {
    console.error("Error fetching data:", error);
    throw error;
  }
};

exports.revertBill = async (currentValan, nextValan, marketId) => {
  try {
    // Build the deletion filter: always delete CF from currentValan,
    // and BF from nextValan if it exists.
    const cfbfFilter = nextValan
      ? {
        $or: [
          { valanId: currentValan._id, type: "CF", marketId },
          { valanId: nextValan._id, type: "BF", marketId }
        ]
      }
      : { valanId: currentValan._id, type: "CF", marketId };

    // Fetch affected transactions before deleting to recalculate positions
    const affectedTxns = await StockTransaction.find(cfbfFilter, { userId: 1, scriptId: 1, valanId: 1 }).lean();
    
    await StockTransaction.deleteMany(cfbfFilter);

    // Recalculate positions for all affected users/scripts
    const { setUserPosition } = require('./StockService');
    const seen = new Set();
    for (const txn of affectedTxns) {
      const key = `${txn.userId}_${txn.scriptId}_${txn.valanId}`;
      if (!seen.has(key)) {
        seen.add(key);
        try {
          await setUserPosition(txn.userId, txn.scriptId, txn.valanId, false);
        } catch (posErr) {
          console.error(`[revertBill] Error recalculating position for user ${txn.userId} script ${txn.scriptId}:`, posErr);
        }
      }
    }

    // Also hard-delete profit/loss and ledger reports for this valan+market
    await ProfitLoss.deleteMany({ valanId: currentValan._id, marketId });
    await Ledger.deleteMany({ valanId: currentValan._id, marketId });
  } catch (error) {
    console.error("Error in revertBill:", error);
    throw error;
  }
};

exports.saveMarketClosePrices = async (prices) => {
  try {
    if (!prices || !prices.length) return;
    return await MarketClosePrice.insertMany(prices);
  } catch (error) {
    console.error("Error in saveMarketClosePrices:", error);
    throw error;
  }
};

exports.getMarketClosePrices = async (date, marketId) => {
  try {
    const query = {};
    if (date) {
      const start = moment(date).startOf("day").toDate();
      const end = moment(date).endOf("day").toDate();
      query.createdAt = { $gte: start, $lte: end };
    }
    if (marketId) {
      query.marketId = marketId;
    }
    const results = await MarketClosePrice.find(query).sort({ createdAt: -1 }).lean();
    return results.map((r) => ({
      ...r,
      marketName: r.marketName || MARKET_NAMES[r.marketId] || "",
    }));
  } catch (error) {
    console.error("Error in getMarketClosePrices service:", error);
    throw error;
  }
};

exports.getMarketClosePricesBySymbols = async (symbols) => {
  try {
    if (!symbols || symbols.length === 0) return [];
    return await MarketClosePrice.find({ symbol: { $in: symbols } })
      .sort({ createdAt: -1 })
      .lean();
  } catch (error) {
    console.error("Error in getMarketClosePricesBySymbols:", error);
    throw error;
  }
};