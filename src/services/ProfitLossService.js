const ProfitLoss = require("../models/ProfitLossReport");
const Ledger = require("../models/LedgerModel");
const CashLedger = require("../models/CashLedgerModel");
const DepositWithdraw = require("../models/DepositWithdrawModel");
const JVLedger = require("../models/JVLedgerModel");
const { saveLog } = require("../services/LogService");
const StockTransaction = require("../models/StockTransactionModel");
const userModel = require("../models/UserModel");
const getOnlineUserIds = require("./UserService");
const { computeCombinedBalances } = require("./Balanceservice");
exports.saveReport = async (details) => {
  try {
    return await ProfitLoss.insertMany(details);
  } catch (error) {
    console.error("Error creating data:", error);
    throw error;
  }
};

exports.saveLedger = async (details) => {
  try {
    return await Ledger.insertMany(details);
  } catch (error) {
    console.error("Error creating data:", error);
    throw error;
  }
};

/* 
exports.getLedgers = async (id, level) => {
  try {
    return await ProfitLoss.aggregate([
      {
        $match: { parentIds: id },
      },
      {
        $project: {
          m2m: 1,
          uplineAmount: {
            $sum: {
              $slice: ["$uplineM2M", level - 1],
            },
          },
          selfAmount: { $arrayElemAt: ["$uplineM2M", level - 1] },
          valanName: 1,
          marketName: 1,
          userId: 1,
          parentIds: 1,
        },
      },
      {
        $group: {
          _id: "$userId",
          amount: { $sum: "$m2m" },
          selfAmount: { $sum: "$selfAmount" },
          uplineAmount: { $sum: "$uplineAmount" },
          valanName: { $first: "$valanName" },
          marketName: { $first: "$marketName" },
          parentIds: { $first: "$parentIds" },
        },
      },
    ]);
  } catch (error) {
    console.error("Error creating data:", error);
    throw error;
  }
};
*/
/*
exports.getLedgerList = async (id, date, txnType, market, isRequesterDemo = false) => {
  try {
    if (["CASH", "JV"].includes(txnType)) {
      return [];
    }

    let match = {
      userId: id,
    };

    if (market && market != "") {
      match.marketId = market;
    }

    if (date && date != "") {
      match.createdAt = { $gte: new Date(date) };
    }

    return await Ledger.aggregate([
      {
        $match: match,
      },
      {
        $group: {
          _id: { marketId: "$marketId", valanId: "$valanId" },
          userId: { $first: "$userId" },
          marketName: { $first: "$marketName" },
          valanName: { $first: "$valanName" },
          createdAt: { $first: "$createdAt" },
          uplineAmount: { $sum: "$uplineAmount" },
          amount: { $sum: "$amount" },
        },
      },
      {
        $project: {
          _id: 0,
          marketId: "$_id.marketId",
          valanId: "$_id.valanId",
          userId: 1,
          marketName: 1,
          valanName: 1,
          uplineAmount: 1,
          amount: 1,
          createdAt: 1,
        },
      },
    ]);
  } catch (error) {
    console.error("Error creating data:", error);
    throw error;
  }
};
*/

exports.saveCashLedger = async (details) => {
  try {
    const entry = new CashLedger(details);
    const saved = await entry.save();

    // Log the insertion
    const logDetails = {
      userId: saved.userId,
      createdBy: saved.createdBy,
      old_amount: 0,
      new_amount: saved.transactionType == "RECEIPT" ? saved.amount : -Math.abs(saved.amount),
      old_remark: "",
      new_remark: saved.remarks,
      logType: "INS",
      ip: details.ip || "",
      add_time: new Date(saved.createdAt).getTime(),
      edit_time: 0,
    };
    saveLog("cashLedger", logDetails);

    return saved;
  } catch (error) {
    console.error("Error creating data:", error);
    throw error;
  }
};

exports.getCashLedger = async (match, id, isRequesterDemo = false) => {
  try {
    const pipeline = [
      {
        $match: match,
      },
      {
        $addFields: {
          userIds: ["$createdBy", "$userId"],
        },
      },
      {
        $lookup: {
          from: "users",
          let: { uIds: "$userIds" },
          pipeline: [
            {
              $match: {
                $expr: { $in: ["$_id", "$$uIds"] },
                isDeleted: false,
                demoid: isRequesterDemo ? true : { $ne: true },
              },
            },
            { $project: { accountName: 1, accountCode: 1, demoid: 1 } },
          ],
          as: "usersInfo",
        },
      },
    ];

    // After lookup, if not a demo requester, we only want entries where BOTH users (if both exist) are NOT demo users.
    // Or more simply, if any participating user was a demo user, the lookup might return fewer users or usersInfo will have demoid=true.
    // Since we filtered in the lookup pipeline above, if a demo user was involved, they won't be in usersInfo.
    // However, some transactions might be with deleted users or system.
    // Let's refine: if isRequesterDemo is false, we should only show entries where both participants (if in userIds) are NOT demo users.
    pipeline.push({
      $match: {
        $expr: { $eq: [{ $size: "$usersInfo" }, { $size: "$userIds" }] }
      }
    });
    pipeline.push(
      {
        $addFields: {
          creatorInfo: {
            $arrayElemAt: [
              {
                $filter: {
                  input: "$usersInfo",
                  as: "user",
                  cond: { $eq: ["$$user._id", "$createdBy"] },
                },
              },
              0,
            ],
          },
          recipientInfo: {
            $arrayElemAt: [
              {
                $filter: {
                  input: "$usersInfo",
                  as: "user",
                  cond: { $eq: ["$$user._id", "$userId"] },
                },
              },
              0,
            ],
          },
        },
      },
      {
        $addFields: {
          otherUser: {
            $cond: {
              if: {
                $eq: ["$createdBy", id],
              },
              then: "$recipientInfo",
              else: "$creatorInfo",
            },
          },
          isCreated: {
            $cond: {
              if: {
                $eq: ["$createdBy", id ],
              },
              then: "1",
              else: "0",
            },
          },
        },
      },
      {
        $project: {
          amount: 1,
          transactionType: 1,
          date: 1,
          remarks: 1,
          createdAt: 1,
          updatedAt: 1,
          otherUser: 1,
          isCreated: 1,
        },
      },
      {
        $sort: {
          createdAt: -1,
        },
      }
    );

    return await CashLedger.aggregate(pipeline);
  } catch (error) {
    console.error("Error creating data:", error);
    throw error;
  }
};

exports.deleteCashLedger = async (_id, actorId, ip) => {
  try {
    const oldDetails = await CashLedger.findById(_id);
    if (!oldDetails) return null;

    const result = await CashLedger.deleteOne({ _id });

    // Log the deletion
    const logDetails = {
      userId: oldDetails.userId,
      createdBy: actorId, // Who deleted it
      old_amount: oldDetails.transactionType == "RECEIPT" ? oldDetails.amount : -Math.abs(oldDetails.amount),
      new_amount: 0,
      old_remark: oldDetails.remarks,
      new_remark: "DELETED",
      logType: "DEL",
      ip: ip || "",
      add_time: new Date(oldDetails.createdAt).getTime(),
      edit_time: Date.now(),
    };
    saveLog("cashLedger", logDetails);

    return result;
  } catch (error) {
    console.error("Error deleting data:", error);
    throw error;
  }
};

exports.updateCashLedger = async (_id, details) => {
  try {
    const update = await CashLedger.findOneAndUpdate({ _id }, details);
    if (update) {
      insertCashLedgerUpdateLog(update, details);
    }
    return update;
  } catch (error) {
    console.error("Error updating data:", error);
    throw error;
  }
};

const insertCashLedgerUpdateLog = async (oldDetails, newDetails) => {
  try {
    const details = {
      userId: oldDetails.userId,
      createdBy: oldDetails.createdBy,
      old_amount:
        oldDetails.transactionType == "RECEIPT"
          ? oldDetails.amount
          : -Math.abs(oldDetails.amount),
      new_amount:
        newDetails.transactionType == "RECEIPT"
          ? newDetails.amount
          : -Math.abs(newDetails.amount),
      old_remark: oldDetails.remarks,
      new_remark: newDetails.remarks,
      logType: "UPD",
      ip: newDetails.ip || "",
      edit_time: Date.now(),
      add_time: new Date(oldDetails.createdAt).getTime(),
    };
    saveLog("cashLedger", details);
  } catch (error) {
    console.error("Error creating log data:", error);
  }
};

exports.saveDepositWithdraw = async (details) => {
  try {
    const entry = new DepositWithdraw(details);
    const saved = await entry.save();

    // Log the insertion
    const logDetails = {
      userId: saved.userId,
      createdBy: saved.createdBy,
      old_amount: 0,
      new_amount: saved.transactionType == "DEPOSIT" ? saved.amount : -Math.abs(saved.amount),
      old_remark: "",
      new_remark: saved.remarks,
      logType: "INS",
      ip: details.ip || "",
      add_time: new Date(saved.createdAt).getTime(),
      edit_time: 0,
    };
    saveLog("depositLedger", logDetails);

    return saved;
  } catch (error) {
    console.error("Error creating data:", error);
    throw error;
  }
};

exports.getDepositWithdraw = async (match, id, isRequesterDemo = false) => {
  try {
    const pipeline = [
      {
        $match: match,
      },
      {
        $addFields: {
          userIds: ["$createdBy", "$userId"],
        },
      },
      {
        $lookup: {
          from: "users",
          let: { uIds: "$userIds" },
          pipeline: [
            {
              $match: {
                $expr: { $in: ["$_id", "$$uIds"] },
                isDeleted: false,
                demoid: isRequesterDemo ? true : { $ne: true },
              },
            },
            { $project: { accountName: 1, accountCode: 1, demoid: 1 } },
          ],
          as: "usersInfo",
        },
      },
    ];

    pipeline.push({
      $match: {
        $expr: { $eq: [{ $size: "$usersInfo" }, { $size: "$userIds" }] }
      }
    });
    pipeline.push(
      {
        $addFields: {
          creatorInfo: {
            $arrayElemAt: [
              {
                $filter: {
                  input: "$usersInfo",
                  as: "user",
                  cond: { $eq: ["$$user._id", "$createdBy"] },
                },
              },
              0,
            ],
          },
          recipientInfo: {
            $arrayElemAt: [
              {
                $filter: {
                  input: "$usersInfo",
                  as: "user",
                  cond: { $eq: ["$$user._id", "$userId"] },
                },
              },
              0,
            ],
          },
        },
      },
      {
        $addFields: {
          otherUser: {
            $cond: {
              if: {
                $eq: ["$createdBy", id],
              },
              then: "$recipientInfo",
              else: "$creatorInfo",
            },
          },
          isCreated: {
            $cond: {
              if: {
                $eq: ["$createdBy", id],
              },
              then: "1",
              else: "0",
            },
          },
        },
      },
      {
        $project: {
          amount: 1,
          transactionType: 1,
          date: 1,
          remarks: 1,
          createdAt: 1,
          updatedAt: 1,
          otherUser: 1,
          isCreated: 1,
        },
      },
      {
        $sort: {
          createdAt: -1,
        },
      }
    );

    return await DepositWithdraw.aggregate(pipeline);
  } catch (error) {
    console.error("Error creating data:", error);
    throw error;
  }
};

exports.deleteDepositWithdraw = async (_id, actorId, ip) => {
  try {
    const oldDetails = await DepositWithdraw.findById(_id);
    if (!oldDetails) return null;

    const result = await DepositWithdraw.deleteOne({ _id });

    // Log the deletion
    const logDetails = {
      userId: oldDetails.userId,
      createdBy: actorId, // Who deleted it
      old_amount: oldDetails.transactionType == "DEPOSIT" ? oldDetails.amount : -Math.abs(oldDetails.amount),
      new_amount: 0,
      old_remark: oldDetails.remarks,
      new_remark: "DELETED",
      logType: "DEL",
      ip: ip || "",
      add_time: new Date(oldDetails.createdAt).getTime(),
      edit_time: Date.now(),
    };
    saveLog("depositLedger", logDetails);

    return result;
  } catch (error) {
    console.error("Error deleting data:", error);
    throw error;
  }
};

exports.updateDepositWithdraw = async (_id, details) => {
  try {
    const update = await DepositWithdraw.findOneAndUpdate({ _id }, details);
    if (update) {
      insertDWUpdateLog(update, details);
    }
    return update;
  } catch (error) {
    console.error("Error updating data:", error);
    throw error;
  }
};

const insertDWUpdateLog = async (oldDetails, newDetails) => {
  try {
    const details = {
      userId: oldDetails.userId,
      createdBy: oldDetails.createdBy,
      old_amount:
        oldDetails.transactionType == "DEPOSIT"
          ? oldDetails.amount
          : -Math.abs(oldDetails.amount),
      new_amount:
        newDetails.transactionType == "DEPOSIT"
          ? newDetails.amount
          : -Math.abs(newDetails.amount),
      old_remark: oldDetails.remarks,
      new_remark: newDetails.remarks,
      logType: "UPD",
      ip: newDetails.ip || "",
      edit_time: Date.now(),
      add_time: new Date(oldDetails.createdAt).getTime(),
    };
    saveLog("depositLedger", details);
  } catch (error) {
    console.error("Error creating log data:", error);
  }
};

exports.getUserCashLedger = async (id, date, txnType) => {
  try {
    if (["BILL", "JV"].includes(txnType)) {
      return [];
    }

    let match = {
      userId: id,
    };

    if (date && date != "") {
      match.date = { $gte: new Date(date) };
    }

    return await CashLedger.find(match).lean();
  } catch (error) {
    console.error("Error creating data:", error);
    throw error;
  }
};

exports.getDownlineCashLedger = async (ids) => {
  try {
    return await CashLedger.aggregate([
      {
        $match: {
          userId: { $in: ids },
        },
      },
      {
        $group: {
          _id: "$userId",
          amount: {
            $sum: {
              $cond: {
                if: {
                  $eq: ["$transactionType", "PAYMENT"],
                },
                then: { $multiply: [-1, "$amount"] },
                else: "$amount",
              },
            },
          },
        },
      },
    ]);
  } catch (error) {
    console.error("Error creating data:", error);
    throw error;
  }
};

exports.getClientLedger = async (ids) => {
  try {
    return await Ledger.aggregate([
      {
        $match: {
          userId: { $in: ids },
        },
      },
      {
        $group: {
          _id: "$userId",
          amount: { $sum: "$amount" },
        },
      },
      {
        $project: {
          _id: 0,
          userId: "$_id",
          amount: 1,
        },
      },
    ]);
  } catch (error) {
    console.error("Error creating data:", error);
    throw error;
  }
};

exports.saveJVLedger = async (details) => {
  try {
    const entry = new JVLedger(details);
    return await entry.save();
  } catch (error) {
    console.error("Error creating data:", error);
    throw error;
  }
};

exports.getJVLedger = async (match, user, isRequesterDemo = false) => {
  try {
    const pipeline = [
      {
        $match: match,
      },
      {
        $addFields: {
          userIds: ["$debitAccount", "$creditAccount"],
        },
      },
      {
        $lookup: {
          from: "users",
          let: { uIds: "$userIds" },
          pipeline: [
            {
              $match: {
                $expr: { $in: ["$_id", "$$uIds"] },
                isDeleted: false,
                demoid: isRequesterDemo ? true : { $ne: true },
              },
            },
            { $project: { accountName: 1, accountCode: 1, demoid: 1 } },
          ],
          as: "usersInfo",
        },
      },
    ];

    pipeline.push({
      $match: {
        $expr: { $eq: [{ $size: "$usersInfo" }, { $size: "$userIds" }] }
      }
    });
    pipeline.push(
      {
        $addFields: {
          debitAccount: {
            $arrayElemAt: [
              {
                $filter: {
                  input: "$usersInfo",
                  as: "user",
                  cond: { $eq: ["$$user._id", "$debitAccount"] },
                },
              },
              0,
            ],
          },
          creditAccount: {
            $arrayElemAt: [
              {
                $filter: {
                  input: "$usersInfo",
                  as: "user",
                  cond: { $eq: ["$$user._id", "$creditAccount"] },
                },
              },
              0,
            ],
          },
        },
      },
      {
        $project: {
          amount: 1,
          transactionType: 1,
          date: 1,
          remarks: 1,
          createdAt: 1,
          updatedAt: 1,
          debitAccount: 1,
          creditAccount: 1,
        },
      },
      {
        $sort: {
          createdAt: -1,
        },
      }
    );

    return await JVLedger.aggregate(pipeline);
  } catch (error) {
    console.error("Error creating data:", error);
    throw error;
  }
};

exports.deleteJVLedger = async (_id) => {
  try {
    return await JVLedger.deleteOne({ _id });
  } catch (error) {
    console.error("Error creating data:", error);
    throw error;
  }
};

exports.updateJVLedger = async (_id, details) => {
  try {
    const update = await JVLedger.findOneAndUpdate({ _id }, details);
    insertDWUpdateLog(update, details);
    return update;
  } catch (error) {
    console.error("Error creating data:", error);
    throw error;
  }
};

exports.updateReport = async (details) => {
  try {
    const bulkReportOps = details.map((doc) => ({
      updateOne: {
        filter: {
          userId: doc.userId,
          valanId: doc.valanId,
          marketId: doc.marketId,
          scriptId: doc.scriptId,
        },
        update: { $set: doc },
        upsert: true,
      },
    }));

    const result = await ProfitLoss.bulkWrite(bulkReportOps);
    //console.log("Bulk operation result:", result);
  } catch (error) {
    console.error("Error creating data:", error);
    throw error;
  }
};

exports.updateLedger = async (details) => {
  try {
    const bulkLedgerOps = details.map((doc) => ({
      updateOne: {
        filter: {
          userId: doc.userId,
          valanId: doc.valanId,
          marketId: doc.marketId,
          scriptId: doc.scriptId,
        },
        update: { $set: doc },
        upsert: true,
      },
    }));

    const result = await Ledger.bulkWrite(bulkLedgerOps);
    //console.log("Bulk operation result:", result);
  } catch (error) {
    console.error("Error creating data:", error);
    throw error;
  }
};

exports.getJVLedgerList = async (userId, date, txnType, isRequesterDemo = false) => {
  try {
    if (["BILL", "CASH"].includes(txnType)) {
      return [];
    }

    let match = {
      $or: [{ debitAccount: userId }, { creditAccount: userId }],
    }

    if (date && date != "") {
      match.date = { $gte: new Date(date) };
    }

    return JVLedger.aggregate([
      {
        $match: match
      },
      {
        $project: {
          _id: 1,
          date: 1,
          amount: 1,
          remarks: 1,
          txnType: {
            $cond: {
              if: { $eq: ["$creditAccount", userId] },
              then: "CR",
              else: "DR",
            },
          },
        },
      },
    ]);
  } catch (error) {
    return [];
  }
};

exports.getCombineLedger = async (id) => {
  try {
    const cashLedger = await CashLedger.aggregate([
      {
        $match: {
          userId: { $in: id },
        },
      },
      {
        $group: {
          _id: "$userId",
          netAmount: {
            $sum: {
              $cond: [
                { $eq: ["$transactionType", "RECEIPT"] },
                "$txn.amount",
                { $multiply: ["$txn.amount", -1] },
              ],
            },
          },
        },
      },
    ]);

    const jvLedger = await JVLedger.aggregate([
      {
        $match: {
          $or: [{ debitAccount: { $in: id } }, { creditAccount: { $in: id } }],
        },
      },
      {
        $project: {
          txn: {
            $concatArrays: [
              {
                $cond: [
                  { $in: ["$creditAccount", id] },
                  [
                    {
                      user: "$creditAccount",
                      txnType: "CR",
                      amount: "$amount",
                    },
                  ],
                  [],
                ],
              },
              {
                $cond: [
                  { $in: ["$debitAccount", id] },
                  [{ user: "$debitAccount", txnType: "DR", amount: "$amount" }],
                  [],
                ],
              },
            ],
          },
        },
      },
      { $unwind: "$txn" },
      {
        $group: {
          _id: "$txn.user",
          netAmount: {
            $sum: {
              $cond: [
                { $eq: ["$txn.txnType", "CR"] },
                "$txn.amount",
                { $multiply: ["$txn.amount", -1] },
              ],
            },
          },
        },
      },
    ]);

    const userMap = new Map();
    for (let cledger of cashLedger) {
      const id = cledger._id.toString();
      let getMap = userMap.get(id);
      if (!getMap) {
        userMap.set(id, { cash: cledger.netAmount });
      }
    }

    for (let jvledger of jvLedger) {
      const id = jvledger._id.toString();
      let getMap = userMap.get(id);
      if (!getMap) {
        userMap.set(id, { jv: jvledger.netAmount });
      } else {
        userMap.set(id, { ...getMap, jv: jvledger.netAmount });
      }
    }

    return userMap;
  } catch (error) {
    console.error("Error creating data:", error);
    throw error;
  }
};
exports.pushBalancesToOnlineUsers = async () => {
  try {
    const onlineIds = await getOnlineUserIds(); // array of id strings
    if (!onlineIds.length) return;

    // compute balances
    const balances = await computeCombinedBalances(onlineIds);

    // emit to each user room (this uses your socket.io redis adapter)
    for (const b of balances) {
      // send minimal payload
      const payload = {
        userId: b.userId,
        balance: b.balance,
        breakdown: { cash: b.cash, jv: b.jv, ledger: b.ledger },
      };

      // emit to the user's room: works across cluster because of redis adapter
      io.to(`user:${b.userId}`).emit("balance:update", payload);
    }
  } catch (err) {
    console.error("pushBalancesToOnlineUsers err", err);
  }
}
