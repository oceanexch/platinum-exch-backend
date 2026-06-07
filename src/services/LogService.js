const mongoose = require("mongoose");
const logModel = require("../models/LogModel");
const userModel = require("../models/UserModel");
const { redisPublisher } = require('../config/redis');


exports.saveLog = async (type, details) => {
  try {
    const logData = {
      type,
      [`${type}Log`]: details,
    };
    const newLog = new logModel(logData);
    const log = (await newLog.save()).toObject();
    let populatedLogQuery = logModel.findById(log._id);
    if (type === "rejection") {
      const clientId = details?.clientId || details?._id;
      if (clientId) {
        const user = await userModel.findById(clientId);
        if (user) {
          // Skip incrementing for top-level users (no parents)
          if (user.parentIds && user.parentIds.length > 0) {
            user.rejectionAttempts = (user.rejectionAttempts || 0) + 1;
            if (user.rejectionAttempts >= 30) {
              user.status = false;
            }
            await userModel.updateOne(
              { _id: clientId },
              { $set: { rejectionAttempts: user.rejectionAttempts, status: user.status } }
            );
          }
        }
      }

      populatedLogQuery = populatedLogQuery
        .populate({
          path: "rejectionLog.clientId",
          select: "accountName accountCode"
        })
        .populate({
          path: "rejectionLog.parentIds",
          select: "accountName accountCode"
        });
      const populatedLog = await populatedLogQuery.lean();
      const publishPayload = {
        type: "ADD",
        data: populatedLog,
        meta: {
          targetUser: log.rejectionLog?.clientId?.toString() || log.rejectionLog?.clientId,
          parentIds: Array.isArray(log.rejectionLog?.parentIds)
            ? log.rejectionLog.parentIds.map(p => p?.toString ? p.toString() : p)
            : []
        }
      };

      await redisPublisher.publish("logs", JSON.stringify(publishPayload));
    }
    return;
  } catch (error) {
    console.error("Error in saveLog:", error);
    throw error;
  }
};

exports.getLedgerLog = async (query, type, isRequesterDemo = false) => {
  try {
    // clone query
    query = { ...query };

    // 🔥 FIX 1: normalize ObjectIds
    if (query[`${type}Log.createdBy`]) {
      query[`${type}Log.createdBy`] =
        new mongoose.Types.ObjectId(query[`${type}Log.createdBy`]);
    }

    if (query[`${type}Log.userId`]) {
      query[`${type}Log.userId`] =
        new mongoose.Types.ObjectId(query[`${type}Log.userId`]);
    }

    const pipeline = [
      { $match: query },

      {
        $lookup: {
          from: "users",
          localField: `${type}Log.userId`,
          foreignField: "_id",
          as: "userInfo"
        }
      },
      {
        $unwind: {
          path: "$userInfo",
          preserveNullAndEmptyArrays: true
        }
      }
    ];

    // 🔥 FIX 2: correct demo filter and isDeleted filter
    pipeline.push({
      $match: {
        $and: [
          {
            $or: [
              isRequesterDemo
                ? { "userInfo.demoid": true }
                : { "userInfo.demoid": { $ne: true } },
              { userInfo: { $exists: false } }
            ]
          },
          {
            $or: [
              { "userInfo.isDeleted": false },
              { userInfo: { $exists: false } }
            ]
          }
        ]
      }
    });

    // populate userId
    pipeline.push(
      {
        $lookup: {
          from: "users",
          localField: `${type}Log.userId`,
          foreignField: "_id",
          as: "userId_populated"
        }
      },
      {
        $unwind: {
          path: "$userId_populated",
          preserveNullAndEmptyArrays: true
        }
      }
    );

    // projection
    pipeline.push({
      $project: {
        type: 1,
        createdAt: 1,
        updatedAt: 1,
        [`${type}Log`]: {
          $mergeObjects: [
            `$${type}Log`,
            {
              userId: {
                _id: `$${type}Log.userId`,
                accountName: "$userId_populated.accountName",
                accountCode: "$userId_populated.accountCode"
              }
            }
          ]
        }
      }
    });

    pipeline.push({ $sort: { createdAt: -1 } });
    return await logModel.aggregate(pipeline);
  } catch (error) {
    console.error("getLedgerLog error:", error);
    throw error;
  }
};

exports.getRejectionLog = async (query, isRequesterDemo = false) => {
  try {
    // Build aggregation pipeline
    const pipeline = [
      { $match: query },
      // Lookup to join with User collection to check demoid
      {
        $lookup: {
          from: "users",
          localField: "rejectionLog.clientId",
          foreignField: "_id",
          as: "userInfo"
        }
      },
      {
        $unwind: {
          path: "$userInfo",
          preserveNullAndEmptyArrays: true
        }
      }
    ];

    // Add demoid filter
    pipeline.push({
      $match: isRequesterDemo
        ? { "userInfo.demoid": true }
        : { "userInfo.demoid": { $ne: true }, "userInfo": { $ne: null } }
    });

    // Lookup for clientId populate (accountName, accountCode)
    pipeline.push({
      $lookup: {
        from: "users",
        localField: "rejectionLog.clientId",
        foreignField: "_id",
        as: "clientId_populated"
      }
    });
    pipeline.push({
      $unwind: {
        path: "$clientId_populated",
        preserveNullAndEmptyArrays: true
      }
    });

    // Project to format output similar to populate
    pipeline.push({
      $project: {
        type: 1,
        rejectionLog: {
          $cond: {
            if: { $ne: ["$clientId_populated", null] },
            then: {
              $mergeObjects: [
                "$rejectionLog",
                {
                  clientId: {
                    _id: "$rejectionLog.clientId",
                    accountName: "$clientId_populated.accountName",
                    accountCode: "$clientId_populated.accountCode"
                  }
                }
              ]
            },
            else: "$rejectionLog"
          }
        },
        createdAt: 1,
        updatedAt: 1
      }
    });

    pipeline.push({ $sort: { createdAt: -1 } });

    return await logModel.aggregate(pipeline);
  } catch (error) {
    console.error("Error fetching data:", error);
    throw error;
  }
};


exports.getTradeLog = async (query, isRequesterDemo = false) => {
  try {
    // Build aggregation pipeline
    const pipeline = [
      { $match: query },
      // Lookup to join with User collection to check demoid
      {
        $lookup: {
          from: "users",
          localField: "tradeLog.userId",
          foreignField: "_id",
          as: "userInfo"
        }
      },
      {
        $unwind: {
          path: "$userInfo",
          preserveNullAndEmptyArrays: true
        }
      }
    ];

    // Add demoid filter
    pipeline.push({
      $match: isRequesterDemo
        ? { "userInfo.demoid": true }
        : { "userInfo.demoid": { $ne: true }, "userInfo": { $ne: null } }
    });

    // Lookup for userId populate (accountName, accountCode)
    pipeline.push({
      $lookup: {
        from: "users",
        localField: "tradeLog.userId",
        foreignField: "_id",
        as: "userId_populated"
      }
    });
    pipeline.push({
      $unwind: {
        path: "$userId_populated",
        preserveNullAndEmptyArrays: true
      }
    });

    // Lookup for created_by (deleter/editor) to show "Deleted By" / "Edited By" name
    pipeline.push({
      $lookup: {
        from: "users",
        let: { cby: "$tradeLog.created_by" },
        pipeline: [
          {
            $match: {
              $expr: {
                $or: [
                  { $eq: ["$_id", "$$cby"] },
                  { $eq: [{ $toString: "$_id" }, { $toString: "$$cby" }] }
                ]
              }
            }
          },
          { $project: { accountName: 1, accountCode: 1 } },
          { $limit: 1 }
        ],
        as: "createdBy_populated"
      }
    });

    // Project: populate userId and createdBy (deleter name) into tradeLog
    pipeline.push({
      $project: {
        type: 1,
        tradeLog: {
          $mergeObjects: [
            "$tradeLog",
            {
              userId: {
                $cond: {
                  if: { $ne: ["$userId_populated", null] },
                  then: {
                    _id: "$tradeLog.userId",
                    accountName: "$userId_populated.accountName",
                    accountCode: "$userId_populated.accountCode"
                  },
                  else: "$tradeLog.userId"
                }
              }
            },
            {
              createdBy: { $arrayElemAt: ["$createdBy_populated", 0] }
            }
          ]
        },
        createdAt: 1,
        updatedAt: 1
      }
    });

    pipeline.push({ $sort: { createdAt: -1 } });

    return await logModel.aggregate(pipeline);
  } catch (error) {
    console.error("Error fetching data:", error);
    throw error;
  }
};


exports.getUserEditLog = async (query = {}, isDemo = false) => {
  try {
    // 🛡️ clone query to avoid mutating caller object
    query = { ...query };

    // 🧠 helper: safe ObjectId
    const toObjectId = (val) => {
      if (!val) return val;
      if (mongoose.Types.ObjectId.isValid(val)) {
        return new mongoose.Types.ObjectId(val);
      }
      return val;
    };

    // 🔹 normalize ids
    if (query["userEditLog.parentIds"]) {
      query["userEditLog.parentIds"] = {
        $in: [toObjectId(query["userEditLog.parentIds"])]
      };
    }

    if (query["userEditLog.clientId"]) {
      query["userEditLog.clientId"] = toObjectId(
        query["userEditLog.clientId"]
      );
    }

    if (query["userEditLog.accountType"]) {
      query["userEditLog.accountType"] = toObjectId(
        query["userEditLog.accountType"]
      );
    }

    // 🔹 action filter logic
    if (
      query.actionType ||
      query.isUpdated !== undefined ||
      query.isDeleted !== undefined
    ) {
      if (Array.isArray(query.actionType) && query.actionType.length > 0) {
        query["userEditLog.action"] = { $in: query.actionType };
      } else {
        const actions = [];
        if (query.isUpdated) actions.push("EDT");
        if (query.isDeleted) actions.push("DEL");

        if (actions.length > 0) {
          query["userEditLog.action"] = { $in: actions };
        } else {
          query["userEditLog.action"] = { $nin: ["EDT", "DEL"] };
        }
      }

      delete query.actionType;
      delete query.isUpdated;
      delete query.isDeleted;
    }

    // 🔹 aggregation pipeline
    const pipeline = [
      { $match: query },

      {
        $lookup: {
          from: "users",
          localField: "userEditLog.clientId",
          foreignField: "_id",
          as: "userInfo"
        }
      },
      {
        $unwind: {
          path: "$userInfo",
          preserveNullAndEmptyArrays: true
        }
      }
    ];

    // 🔹 demo filter
    pipeline.push({
      $match: isDemo
        ? { "userInfo.demoid": true }
        : { "userInfo.demoid": { $ne: true }, "userInfo": { $ne: null } }
    });

    // 🔹 populate clientId
    pipeline.push(
      {
        $lookup: {
          from: "users",
          localField: "userEditLog.clientId",
          foreignField: "_id",
          as: "clientId_populated"
        }
      },
      {
        $unwind: {
          path: "$clientId_populated",
          preserveNullAndEmptyArrays: true
        }
      }
    );

    // 🔹 populate edit_by
    pipeline.push(
      {
        $lookup: {
          from: "users",
          localField: "userEditLog.edit_by",
          foreignField: "_id",
          as: "editBy_populated"
        }
      },
      {
        $unwind: {
          path: "$editBy_populated",
          preserveNullAndEmptyArrays: true
        }
      }
    );

    // 🔹 populate accountType
    pipeline.push(
      {
        $lookup: {
          from: "usertypes",
          localField: "userEditLog.accountType",
          foreignField: "_id",
          as: "accountType_populated"
        }
      },
      {
        $unwind: {
          path: "$accountType_populated",
          preserveNullAndEmptyArrays: true
        }
      }
    );

    // 🔹 final projection
    pipeline.push({
      $project: {
        type: 1,
        createdAt: 1,
        updatedAt: 1,
        userEditLog: {
          createdAt: "$createdAt",
          time: "$userEditLog.time",
          ip: "$userEditLog.ip",
          action: "$userEditLog.action",

          clientId: {
            _id: "$userEditLog.clientId",
            accountName: "$clientId_populated.accountName",
            accountCode: "$clientId_populated.accountCode"
          },

          edit_by: {
            _id: "$userEditLog.edit_by",
            accountName: "$editBy_populated.accountName",
            accountCode: "$editBy_populated.accountCode"
          },

          accountType: {
            _id: "$userEditLog.accountType",
            level: "$accountType_populated.level",
            label: "$accountType_populated.label"
          }
        }
      }
    });

    pipeline.push({ $sort: { createdAt: -1 } });

    return await logModel.aggregate(pipeline);
  } catch (err) {
    console.error("getUserEditLog error:", err);
    throw err;
  }
};

exports.getUserEditLogDetail = async (_id, type) => {
  try {
    const response = await logModel
      .findOne({ _id })
      .select(`userEditLog.${type} createdAt`)
      .lean();
    return response;
  } catch (error) {
    console.error("Error fetching data:", error);
    throw error;
  }
};

exports.getLoginLog = async (query, isRequesterDemo = false) => {
  try {
    // Build aggregation pipeline
    const pipeline = [
      { $match: query },
      // Lookup to join with User collection to check demoid
      {
        $lookup: {
          from: "users",
          localField: "loginLog.clientId",
          foreignField: "_id",
          as: "userInfo"
        }
      },
      {
        $unwind: {
          path: "$userInfo",
          preserveNullAndEmptyArrays: true
        }
      }
    ];

    // Add demoid filter
    pipeline.push({
      $match: isRequesterDemo
        ? { "userInfo.demoid": true }
        : { "userInfo.demoid": { $ne: true }, "userInfo": { $ne: null } }
    });

    // Lookup for clientId populate (accountName, accountCode)
    pipeline.push({
      $lookup: {
        from: "users",
        localField: "loginLog.clientId",
        foreignField: "_id",
        as: "clientId_populated"
      }
    });
    pipeline.push({
      $unwind: {
        path: "$clientId_populated",
        preserveNullAndEmptyArrays: true
      }
    });

    // Project to format output similar to populate
    pipeline.push({
      $project: {
        type: 1,
        loginLog: {
          $cond: {
            if: { $ne: ["$clientId_populated", null] },
            then: {
              $mergeObjects: [
                "$loginLog",
                {
                  clientId: {
                    _id: "$loginLog.clientId",
                    accountName: "$clientId_populated.accountName",
                    accountCode: "$clientId_populated.accountCode"
                  }
                }
              ]
            },
            else: "$loginLog"
          }
        },
        createdAt: 1,
        updatedAt: 1
      }
    });

    pipeline.push({ $sort: { createdAt: -1 } });

    return await logModel.aggregate(pipeline);
  } catch (error) {
    console.error("Error fetching data:", error);
    throw error;
  }
};
exports.getQuantitySettingLog = async (query, isRequesterDemo = false) => {
  try {
    const pipeline = [
      { $match: query },
      {
        $lookup: {
          from: "users",
          localField: "quantitySettingLog.clientId",
          foreignField: "_id",
          as: "userInfo"
        }
      },
      {
        $unwind: {
          path: "$userInfo",
          preserveNullAndEmptyArrays: true
        }
      }
    ];

    pipeline.push({
      $match: isRequesterDemo
        ? { "userInfo.demoid": true }
        : { "userInfo.demoid": { $ne: true }, "userInfo": { $ne: null } }
    });

    pipeline.push({
      $lookup: {
        from: "users",
        localField: "quantitySettingLog.clientId",
        foreignField: "_id",
        as: "clientId_populated"
      }
    });
    pipeline.push({
      $unwind: {
        path: "$clientId_populated",
        preserveNullAndEmptyArrays: true
      }
    });

    pipeline.push({
      $lookup: {
        from: "users",
        localField: "quantitySettingLog.edit_by",
        foreignField: "_id",
        as: "editBy_populated"
      }
    });
    pipeline.push({
      $unwind: {
        path: "$editBy_populated",
        preserveNullAndEmptyArrays: true
      }
    });

    pipeline.push({
      $project: {
        type: 1,
        quantitySettingLog: {
          $mergeObjects: [
            "$quantitySettingLog",
            {
              clientId: {
                _id: "$quantitySettingLog.clientId",
                accountName: "$clientId_populated.accountName",
                accountCode: "$clientId_populated.accountCode"
              }
            },
            {
              edit_by: {
                _id: "$quantitySettingLog.edit_by",
                accountName: "$editBy_populated.accountName",
                accountCode: "$editBy_populated.accountCode"
              }
            }
          ]
        },
        createdAt: 1,
        updatedAt: 1
      }
    });

    pipeline.push({ $sort: { createdAt: -1 } });

    return await logModel.aggregate(pipeline);
  } catch (error) {
    console.error("Error fetching quantity setting log:", error);
    throw error;
  }
};
