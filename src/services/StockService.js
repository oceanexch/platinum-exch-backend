const StockTransaction = require("../models/StockTransactionModel");
const DeletedLineTradeHistory = require("../models/DeletedLineTradeHistoryModel");
const FinalBillModel = require("../models/FinalBillModel");
const mongoose = require("mongoose");
const moment = require("moment");
const WeekValanModel = require("../models/WeekValanModel");
const UserQuantityModel = require("../models/UserQuantityModel");
const StockModel = require("../models/StockModel");
const UserPosition = require("../models/UserPositionModel");
const { getAllMarkets } = require("./MarketService");
const userTypeModel = require("../models/UserTypeModel");
const userModel = require("../models/UserModel");
const {
  getMultipleStockData,
  getSingleStockData,
  getAllStocksHash,
  del,
  hgetall,
} = require("./RedisService");
// const { getMultipleStockData } = require("./RedisService");
const { saveReport, saveLedger } = require("./ProfitLossService");

const getCurrentWeekDays = () => {
  const today = moment();

  const startOfWeek = today.clone().startOf("isoWeek");
  const endOfWeek = startOfWeek.clone().add(5, "days");

  const startDateFormatted = startOfWeek.format("DDMMM").toUpperCase();
  const endDateFormatted = endOfWeek.format("DDMMM").toUpperCase();

  const startDateWithYear = startOfWeek.format("DDMMMYYYY").toUpperCase();
  const endDateWithYear = endOfWeek.format("DDMMMYYYY").toUpperCase();

  const weekRange = `${startDateFormatted}-${endDateFormatted}`;
  const weekRangeWithYear = `${startDateWithYear}-${endDateWithYear}`;

  return { weekRange, weekRangeWithYear, startOfWeek, endOfWeek };
};

const getNextWeekDays = () => {
  const today = moment();
  const startOfCurrentWeek = today.clone().startOf("isoWeek");
  const startOfNextWeek = startOfCurrentWeek.clone().add(1, "week");
  const endOfNextWeek = startOfNextWeek.clone().add(5, "days");

  const startDateFormatted = startOfNextWeek.format("DDMMM").toUpperCase();
  const endDateFormatted = endOfNextWeek.format("DDMMM").toUpperCase();

  const startDateWithYear = startOfNextWeek.format("DDMMMYYYY").toUpperCase();
  const endDateWithYear = endOfNextWeek.format("DDMMMYYYY").toUpperCase();

  const weekRange = `${startDateFormatted}-${endDateFormatted}`;
  const weekRangeWithYear = `${startDateWithYear}-${endDateWithYear}`;

  return {
    weekRange,
    weekRangeWithYear,
    startOfWeek: startOfNextWeek,
    endOfWeek: endOfNextWeek,
  };
};

const getNextWeekDaysByDate = (date) => {
  const today = moment(date);
  const startOfCurrentWeek = today.clone().startOf("isoWeek");
  const startOfNextWeek = startOfCurrentWeek.clone().add(1, "week");
  const endOfNextWeek = startOfNextWeek.clone().add(5, "days");

  const startDateFormatted = startOfNextWeek.format("DDMMM").toUpperCase();
  const endDateFormatted = endOfNextWeek.format("DDMMM").toUpperCase();

  const startDateWithYear = startOfNextWeek.format("DDMMMYYYY").toUpperCase();
  const endDateWithYear = endOfNextWeek.format("DDMMMYYYY").toUpperCase();

  const weekRange = `${startDateFormatted}-${endDateFormatted}`;
  const weekRangeWithYear = `${startDateWithYear}-${endDateWithYear}`;

  return {
    weekRange,
    weekRangeWithYear,
    startOfWeek: startOfNextWeek,
    endOfWeek: endOfNextWeek,
  };
};

exports.setGetValanDetails = async () => {
  const { weekRange, weekRangeWithYear, startOfWeek, endOfWeek } =
    getCurrentWeekDays();
  let findValan = await WeekValanModel.findOne({
    keyidentifier: weekRangeWithYear,
  }).lean();

  if (!findValan) {
    const segment = await getAllMarkets();
    findValan = new WeekValanModel({
      keyidentifier: weekRangeWithYear,
      label: weekRange,
      startDate: startOfWeek,
      endDate: endOfWeek,
      segment: segment.map((mkt) => ({ ...mkt, billStatus: false })),
    });

    await WeekValanModel.updateMany({ status: true }, { status: false });
    await findValan.save();

    // Calculate weekend interest for Saturday and Sunday before this valan
    try {
      const { calculateWeekendInterest } = require('../cron/nseEqInterestCron');
      // console.log(`[setGetValanDetails] Triggering weekend interest calculation for new valan: ${findValan._id}`);
      await calculateWeekendInterest(findValan._id);
    } catch (err) {
      console.error('[setGetValanDetails] Error calculating weekend interest:', err);
    }
  }

  return findValan;
};

exports.setGetNextValanDetails = async () => {
  // used saturday in auto cf bf.
  const { weekRange, weekRangeWithYear, startOfWeek, endOfWeek } =
    getNextWeekDays();
  let findValan = await WeekValanModel.findOne({
    keyidentifier: weekRangeWithYear,
  }).lean();

  if (!findValan) {
    const segment = await getAllMarkets();
    findValan = new WeekValanModel({
      keyidentifier: weekRangeWithYear,
      label: weekRange,
      startDate: startOfWeek,
      endDate: endOfWeek,
      segment: segment.map((mkt) => ({ ...mkt, billStatus: false })),
    });

    await WeekValanModel.updateMany({ status: true }, { status: false });
    await findValan.save();

    // Calculate weekend interest for Saturday and Sunday before this valan
    try {
      const { calculateWeekendInterest } = require('../cron/nseEqInterestCron');
      // console.log(`[setGetNextValanDetails] Triggering weekend interest calculation for new valan: ${findValan._id}`);
      await calculateWeekendInterest(findValan._id);
    } catch (err) {
      console.error('[setGetNextValanDetails] Error calculating weekend interest:', err);
    }
  }

  return findValan;
};

exports.getNextValanDetailsByValan = async (valan) => {

  const { weekRange, weekRangeWithYear, startOfWeek, endOfWeek } =
    getNextWeekDaysByDate(valan.endDate);
  let findValan = await WeekValanModel.findOne({
    keyidentifier: weekRangeWithYear,
  }).lean();

  if (!findValan) {
    const segment = await getAllMarkets();
    findValan = new WeekValanModel({
      keyidentifier: weekRangeWithYear,
      label: weekRange,
      startDate: startOfWeek,
      endDate: endOfWeek,
      segment: segment.map((mkt) => ({ ...mkt, billStatus: false })),
    });

    await WeekValanModel.updateMany({ status: true }, { status: false });
    await findValan.save();

    // Calculate weekend interest for Saturday and Sunday before this valan
    try {
      const { calculateWeekendInterest } = require('../cron/nseEqInterestCron');
      // console.log(`[getNextValanDetailsByValan] Triggering weekend interest calculation for new valan: ${findValan._id}`);
      await calculateWeekendInterest(findValan._id);
    } catch (err) {
      console.error('[getNextValanDetailsByValan] Error calculating weekend interest:', err);
    }
  }

  return findValan;
};

const marginPipeline = (extraStages = []) => {
  extraStages = Array.isArray(extraStages) ? extraStages : [extraStages];
  return [
    {
      $sort: { createdAt: 1 },
    },
    {
      $group: {
        _id: { userId: "$userId", scriptId: "$scriptId" },
        marketId: { $first: "$marketId" },
        transactions: {
          $push: {
            txnType: "$transactionType",
            qty: "$quantity",
            lot: "$lot",
            price: "$orderPrice",
            date: "$createdAt",
          },
        },
      },
    },
    ...extraStages,
    {
      $project: {
        marketId: 1,
        result: {
          $reduce: {
            input: "$transactions",
            initialValue: {
              netQty: 0,
              lastBuyPrice: null,
              lastSellPrice: null,
              buyLot: 0,
              sellLot: 0,
              buyQty: 0,
              sellQty: 0,
            },
            in: {
              netQty: {
                $cond: [
                  { $eq: ["$$this.txnType", "BUY"] },
                  { $add: ["$$value.netQty", { $toDecimal: "$$this.qty" }] },
                  {
                    $subtract: ["$$value.netQty", { $toDecimal: "$$this.qty" }],
                  },
                ],
              },
              lastBuyPrice: {
                $cond: [
                  { $eq: ["$$this.txnType", "BUY"] },
                  { $toDouble: "$$this.price" },
                  "$$value.lastBuyPrice",
                ],
              },
              lastSellPrice: {
                $cond: [
                  { $eq: ["$$this.txnType", "SELL"] },
                  { $toDouble: "$$this.price" },
                  "$$value.lastSellPrice",
                ],
              },
              buyLot: {
                $cond: [
                  { $eq: ["$$this.txnType", "BUY"] },
                  { $add: ["$$value.buyLot", { $toDecimal: "$$this.lot" }] },
                  "$$value.buyLot",
                ],
              },
              sellLot: {
                $cond: [
                  { $eq: ["$$this.txnType", "SELL"] },
                  { $add: ["$$value.sellLot", { $toDecimal: "$$this.lot" }] },
                  "$$value.sellLot",
                ],
              },
              buyQty: {
                $cond: [
                  { $eq: ["$$this.txnType", "BUY"] },
                  { $add: ["$$value.buyQty", { $toDecimal: "$$this.qty" }] },
                  "$$value.buyQty",
                ],
              },
              sellQty: {
                $cond: [
                  { $eq: ["$$this.txnType", "SELL"] },
                  { $add: ["$$value.sellQty", { $toDecimal: "$$this.qty" }] },
                  "$$value.sellQty",
                ],
              },
            },
          },
        },
      },
    },
    {
      $project: {
        marketId: 1,
        margin: {
          $cond: [
            { $gt: ["$result.netQty", 0] },
            { $multiply: ["$result.netQty", "$result.lastBuyPrice"] },
            {
              $cond: [
                { $lt: ["$result.netQty", 0] },
                {
                  $multiply: ["$result.netQty", "$result.lastSellPrice"],
                },
                0,
              ],
            },
          ],
        },
        lastBuyPrice: "$result.lastBuyPrice",
        lastSellPrice: "$result.lastSellPrice",
        buyLot: "$result.buyLot",
        sellLot: "$result.sellLot",
        buyQty: "$result.buyQty",
        sellQty: "$result.sellQty",
      },
    },
    {
      $group: {
        _id: "$_id.userId",
        markets: {
          $push: {
            scriptId: "$_id.scriptId",
            marketId: "$marketId",
            margin: { $abs: { $toDouble: "$margin" } },
            lot: { $abs: { $subtract: ["$buyLot", "$sellLot"] } },
            netMargin: { $toDouble: "$margin" }, //storing without abs
            netLot: { $subtract: ["$buyLot", "$sellLot"] },
            buyQty: "$buyQty",
            sellQty: "$sellQty",
            buyLot: "$buyLot",
            sellLot: "$sellLot",
            lastBuyPrice: "$lastBuyPrice",
            lastSellPrice: "$lastSellPrice",
          },
        },
      },
    },
  ];
};

exports.saveTransaction = async (stockDetails) => {
  try {
    const newTransaction = new StockTransaction(stockDetails);
    return await newTransaction.save();
  } catch (error) {
    console.error("Error creating data:", error);
    throw error;
  }
};

exports.deleteTransaction = async (_id) => {
  try {
    return await StockTransaction.deleteOne({ _id: _id });
  } catch (error) {
    console.error("Error in deleteTransaction:", error);
    throw error;
  }
};

exports.bulkDeleteTransactions = async (ids, type = 'soft', deletedBy = null) => {
  try {
    // Fetch trade metadata BEFORE deleting so we know which positions to recalculate
    const trades = await StockTransaction.find(
      { _id: { $in: ids }, transactionStatus: { $ne: 'DELETED' } },
      { userId: 1, scriptId: 1, valanId: 1 }
    ).lean();

    if (type === 'hard') {
      await StockTransaction.deleteMany({ _id: { $in: ids } });
    } else {
      await StockTransaction.updateMany(
        { _id: { $in: ids } },
        [
          {
            $set: {
              deletedBy: deletedBy,
              prevStatus: {
                $cond: {
                  if: { $eq: ["$transactionStatus", "DELETED"] },
                  then: "$prevStatus",
                  else: "$transactionStatus"
                }
              },
              transactionStatus: 'DELETED'
            }
          }
        ]
      );
    }

    // After deleting, recalculate UserPosition for each unique {userId, scriptId, valanId}
    const seen = new Set();
    for (const t of trades) {
      const key = `${t.userId}_${t.scriptId}_${t.valanId}`;
      if (seen.has(key)) continue;
      seen.add(key);
      try {
        await exports.setUserPosition(t.userId, t.scriptId, t.valanId, false);
      } catch (posErr) {
        console.error(`[bulkDelete] Error recalculating position for user ${t.userId} script ${t.scriptId}:`, posErr);
      }
    }

    return { deletedCount: trades.length };
  } catch (error) {
    console.error("Error in bulkDeleteTransactions:", error);
    throw error;
  }
};

exports.recoverTransactions = async (ids) => {
  try {
    // Fetch trade metadata before recovering so we know which positions to recalculate
    const trades = await StockTransaction.find(
      { _id: { $in: ids }, prevStatus: { $exists: true, $ne: null } },
      { userId: 1, scriptId: 1, valanId: 1 }
    ).lean();

    const result = await StockTransaction.updateMany(
      { _id: { $in: ids }, prevStatus: { $exists: true, $ne: null } },
      [
        {
          $set: {
            transactionStatus: "$prevStatus",
          }
        },
        {
          $unset: ["prevStatus"]
        }
      ]
    );

    // After recovering, recalculate UserPosition for each unique {userId, scriptId, valanId}
    const seen = new Set();
    for (const t of trades) {
      const key = `${t.userId}_${t.scriptId}_${t.valanId}`;
      if (seen.has(key)) continue;
      seen.add(key);
      try {
        await exports.setUserPosition(t.userId, t.scriptId, t.valanId, false);
      } catch (posErr) {
        console.error(`[recoverTransactions] Error recalculating position for user ${t.userId} script ${t.scriptId}:`, posErr);
      }
    }

    return result;
  } catch (error) {
    console.error("Error in recoverTransactions:", error);
    throw error;
  }
};

exports.getStocks = async (search, isRequesterDemo = false) => {
  // // console.log("isRequesterDemo", isRequesterDemo);
  // // console.log("search", search);
  try {
    // Build aggregation pipeline
    const pipeline = [
      // Match stage with existing search filters
      { $match: search },
      // Lookup to join with User collection to check demoid
      {
        $lookup: {
          from: "users",
          localField: "userId",
          foreignField: "_id",
          as: "userInfo",
        },
      },
      {
        $unwind: {
          path: "$userInfo",
          preserveNullAndEmptyArrays: true,
        },
      },
    ];

    // Add demoid filter and isDeleted filter
    pipeline.push({
      $match: {
        $and: [
          isRequesterDemo
            ? { "userInfo.demoid": true }
            : { $or: [{ "userInfo.demoid": { $ne: true } }, { userInfo: null }] },
          {
            $or: [{ "userInfo.isDeleted": false }, { userInfo: null }],
          },
        ],
      },
    });

    // Lookup for userId populate (accountName, accountCode)
    pipeline.push({
      $lookup: {
        from: "users",
        localField: "userId",
        foreignField: "_id",
        as: "userId_populated",
      },
    });
    pipeline.push({
      $unwind: {
        path: "$userId_populated",
        preserveNullAndEmptyArrays: true,
      },
    });

    // Lookup for createdBy populate (accountName, accountCode)
    pipeline.push({
      $lookup: {
        from: "users",
        localField: "createdBy",
        foreignField: "_id",
        as: "createdBy_populated",
      },
    });
    pipeline.push({
      $unwind: {
        path: "$createdBy_populated",
        preserveNullAndEmptyArrays: true,
      },
    });

    // Lookup for valanId populate (label)
    pipeline.push({
      $lookup: {
        from: "weekvalans",
        localField: "valanId",
        foreignField: "_id",
        as: "valanId_populated",
      },
    });
    pipeline.push({
      $unwind: {
        path: "$valanId_populated",
        preserveNullAndEmptyArrays: true,
      },
    });

    // Lookup for myParent populate (accountName, accountCode)
    pipeline.push({
      $lookup: {
        from: "users",
        localField: "myParent",
        foreignField: "_id",
        as: "myParent_populated",
      },
    });
    pipeline.push({
      $unwind: {
        path: "$myParent_populated",
        preserveNullAndEmptyArrays: true,
      },
    });

    // Project stage to format the output similar to populate
    pipeline.push({
      $project: {
        // Keep all original fields
        marketId: 1,
        marketName: 1,
        scriptId: 1,
        scriptName: 1,
        label: 1,
        expiry: 1,
        lot: 1,
        quantityType: 1,
        quantity: 1,
        orderPrice: 1,
        totalOrderPrice: 1,
        netPrice: 1,
        totalNetPrice: 1,
        orderBrokerage: 1,
        netBrokerage: 1,
        m2mPrice: 1,
        brokerTotalBrokerage: 1,
        brokeragePercentageType: 1,
        brokeragePercentage: 1,
        brokerTotalPercentage: 1,
        otherBrokerage: 1,
        type: 1,
        transactionType: 1,
        transactionStatus: 1,
        orderType: 1,
        tradePosition: 1,
        ip: 1,
        userAgent: 1,
        message: 1,
        shortmsg: 1,
        parentIds: 1,
        brokerIds: 1,
        partnership: 1,
        minPercentageWiseBrokerage: 1,
        minLotWiseBrokerage: 1,
        isEdited: 1,
        createdAt: 1,
        updatedAt: 1,
        // Format populated fields to match Mongoose populate behavior
        userId: {
          $cond: {
            if: { $ne: ["$userId_populated", null] },
            then: {
              _id: "$userId",
              accountName: "$userId_populated.accountName",
              accountCode: "$userId_populated.accountCode",
            },
            else: "$userId",
          },
        },
        createdBy: {
          $cond: {
            if: { $ne: ["$createdBy_populated", null] },
            then: {
              _id: "$createdBy",
              accountName: "$createdBy_populated.accountName",
              accountCode: "$createdBy_populated.accountCode",
            },
            else: "$createdBy",
          },
        },
        valanId: {
          $cond: {
            if: { $ne: ["$valanId_populated", null] },
            then: {
              _id: "$valanId",
              label: "$valanId_populated.label",
            },
            else: "$valanId",
          },
        },
        myParent: {
          $cond: {
            if: { $ne: ["$myParent_populated", null] },
            then: {
              _id: "$myParent",
              accountName: "$myParent_populated.accountName",
              accountCode: "$myParent_populated.accountCode",
            },
            else: "$myParent",
          },
        },
      },
    });

    // Sort by _id descending
    pipeline.push({ $sort: { createdAt: -1 } });

    const resp = await StockTransaction.aggregate(pipeline);
    return resp;
  } catch (error) {
    console.error("Error creating data:", error);
    throw error;
  }
};

exports.getProfitLoss = async (match, level, userId, opts = {}) => {
  try {
    // Asker (viewer) perspective — used for share-math (selfBrokerage, selfNetPrice, brokerNetPrice, uplineNetPrice, downlineNetPrice).
    // `level` and `userId` continue to control filtering / target. Defaults preserve existing callers.
    const askerLevel = Number(opts.askerLevel ?? level);
    const rawAskerId = opts.askerId ?? userId;
    // $toObjectId in pipeline crashes on 'null' string — use a throwaway ObjectId when no asker
    const askerId = rawAskerId ? String(rawAskerId) : new mongoose.Types.ObjectId().toString();
    const pipeline = [
      { $match: { ...match } },
      {
        $group: {
          _id: { userId: "$userId", scriptId: "$scriptId" },
          scriptName: { $first: "$scriptName" },
          marketName: { $first: "$marketName" },
          label: { $first: "$label" },
          transactions: { $push: "$$ROOT" },
          BUY_QTY: {
            $sum: {
              $cond: [{ $eq: ["$transactionType", "BUY"] }, "$quantity", 0],
            },
          },
          SELL_QTY: {
            $sum: {
              $cond: [{ $eq: ["$transactionType", "SELL"] }, "$quantity", 0],
            },
          },
        },
      },
      {
        $lookup: {
          from: "stocks",
          localField: "scriptName",
          foreignField: "InstrumentIdentifier",
          as: "stockInfo",
        },
      },
      {
        $addFields: {
          remainingQty: { $subtract: ["$BUY_QTY", "$SELL_QTY"] },
        },
      },
      {
        $addFields: {
          qtyDifference: { $abs: "$remainingQty" },
          transactionType: {
            $cond: {
              if: { $gt: ["$remainingQty", 0] },
              then: "SELL",
              else: "BUY",
            },
          },
          orderPrice: {
            $cond: {
              if: { $gte: ["$remainingQty", 0] },
              then: {
                $ifNull: [{ $arrayElemAt: ["$stockInfo.BuyPrice", 0] }, 0],
              },
              else: {
                $ifNull: [{ $arrayElemAt: ["$stockInfo.SellPrice", 0] }, 0],
              },
            },
          },
        },
      },
      {
        $addFields: {
          transactions: {
            $concatArrays: [
              "$transactions",
              [
                {
                  $cond: {
                    if: { $ne: ["$remainingQty", 0] },
                    then: {
                      userId: "$_id.userId",
                      scriptId: "$_id.scriptId",
                      transactionType: "$transactionType",
                      quantity: "$qtyDifference",
                      orderPrice: "$orderPrice",
                      totalOrderPrice: {
                        $multiply: ["$qtyDifference", "$orderPrice"],
                      },
                      netPrice: "$orderPrice",
                      totalNetPrice: {
                        $multiply: ["$qtyDifference", "$orderPrice"],
                      },
                      orderBrokerage: 0,
                      netBrokerage: 0,
                      m2mPrice: {
                        $multiply: ["$qtyDifference", "$orderPrice"],
                      },
                      brokerTotalBrokerage: 0,
                      brockersBrokerage: [],
                      transactionStatus: "LIVE",
                    },
                    else: null,
                  },
                },
              ],
            ],
          },
        },
      },
      {
        $unwind: "$transactions",
      },
      {
        $lookup: {
          from: "users",
          localField: "_id.userId",
          foreignField: "_id",
          pipeline: [
            {
              $lookup: {
                from: "usertypes",
                localField: "accountType",
                foreignField: "_id",
                as: "typeInfo",
              },
            },
            {
              $project: {
                _id: 0,
                accountName: 1,
                accountCode: 1,
                partnership: 1,
                basicDetails: 1,
                level: { $arrayElemAt: ["$typeInfo.level", 0] },
              },
            },
          ],
          as: "userInfo",
        },
      },
      {
        $project: {
          userId: "$_id.userId",
          scriptId: "$_id.scriptId",
          scriptName: 1,
          marketName: 1,
          label: 1,
          remainingQty: 1,
          userInfo: { $arrayElemAt: ["$userInfo", 0] },
          transactionType: "$transactions.transactionType",
          totalOrderPrice: "$transactions.totalOrderPrice",
          totalNetPrice: "$transactions.totalNetPrice",
          netBrokerage: "$transactions.netBrokerage",
          m2mPrice: "$transactions.m2mPrice",
          brokerBrokerage: {
            $let: {
              vars: {
                newSum: {
                  $reduce: {
                    input: { $ifNull: ["$transactions.brockersBrokerage", []] },
                    initialValue: 0,
                    in: { $add: ["$$value", "$$this.rate"] },
                  },
                },
              },
              in: {
                $cond: [
                  { $gt: ["$$newSum", 0] },
                  "$$newSum",
                  "$transactions.brokerTotalBrokerage",
                ],
              },
            },
          },
          parentIds: "$transactions.parentIds",
          brokerIds: "$transactions.brokerIds",
          otherBrokerage: "$transactions.otherBrokerage",
          brockersBrokerage: "$transactions.brockersBrokerage",
          transactions: "$transactions",
        },
      },
      {
        $group: {
          _id: { userId: "$userId", scriptId: "$scriptId" },
          scriptName: { $first: "$scriptName" },
          marketName: { $first: "$marketName" },
          label: { $first: "$label" },
          remainingQty: { $first: "$remainingQty" },
          userInfo: { $first: "$userInfo" },
          parentIds: { $first: "$parentIds" },
          brokerIds: { $first: "$brokerIds" },
          buyOrderPrice: {
            $sum: {
              $cond: [
                { $eq: ["$transactionType", "BUY"] },
                "$totalOrderPrice",
                0,
              ],
            },
          },
          sellOrderPrice: {
            $sum: {
              $cond: [
                { $eq: ["$transactionType", "SELL"] },
                "$totalOrderPrice",
                0,
              ],
            },
          },
          buyNetPrice: {
            $sum: {
              $cond: [
                { $eq: ["$transactionType", "BUY"] },
                "$totalNetPrice",
                0,
              ],
            },
          },
          sellNetPrice: {
            $sum: {
              $cond: [
                { $eq: ["$transactionType", "SELL"] },
                "$totalNetPrice",
                0,
              ],
            },
          },
          brokerage: { $sum: "$netBrokerage" },
          buyM2MPrice: {
            $sum: {
              $cond: [{ $eq: ["$transactionType", "BUY"] }, "$m2mPrice", 0],
            },
          },
          sellM2MPrice: {
            $sum: {
              $cond: [{ $eq: ["$transactionType", "SELL"] }, "$m2mPrice", 0],
            },
          },
          brokerBrokerage: { $sum: "$brokerBrokerage" },
          myBrokerage: {
            $sum: {
              $let: {
                vars: {
                  myBkr: {
                    $filter: {
                      input: { $ifNull: ["$brockersBrokerage", []] },
                      as: "b",
                      cond: {
                        $eq: [
                          "$$b.brokerId",
                          { $toObjectId: askerId }
                        ]
                      }
                    }
                  }
                },
                in: {
                  $cond: [
                    { $gt: [{ $size: "$$myBkr" }, 0] },
                    { $arrayElemAt: ["$$myBkr.rate", 0] },
                    { $ifNull: [`$otherBrokerage.${askerId}.netBrokerage`, 0] }
                  ]
                }
              }
            }
          },
          allOtherBrokerage: { $push: "$otherBrokerage" },
          allBrokersBrokerage: { $push: "$brockersBrokerage" },
          transactions: { $push: "$transactions" },
        },
      },
      {
        $addFields: {
          bill: { $subtract: ["$sellNetPrice", "$buyNetPrice"] },
          m2m: { $subtract: ["$sellM2MPrice", "$buyM2MPrice"] },
          // Use the viewer's level (passed as parameter) to calculate indices
          // This ensures the report shows the viewer's perspective, not the transaction owner's
          parentIndex: { $arrayElemAt: ["$userInfo.partnership", { $subtract: [{ $literal: level }, 2] }] },
          childIndex: { $arrayElemAt: ["$userInfo.partnership", { $literal: level }] },
          myIndex: { $arrayElemAt: ["$userInfo.partnership", { $subtract: [{ $literal: level }, 1] }] },
          brokerIndex: { $arrayElemAt: ["$userInfo.partnership", 5] },
          // Calculate summedOtherBrokerage first
          summedOtherBrokerage: {
            $function: {
              body: function (allOtherBrokerage, allBrokersBrokerage) {
                const sums = {};
                // Sum from new array (if present)
                allBrokersBrokerage.forEach((commArray) => {
                  if (Array.isArray(commArray) && commArray.length > 0) {
                    commArray.forEach((c) => {
                      if (c && c.brokerId) {
                        const bid = c.brokerId.toString();
                        sums[bid] = (sums[bid] || 0) + (Number(c.rate) || 0);
                      }
                    });
                  } else {
                    // Fallback for this transaction to old format if new array is empty
                    // This assumes we process one trade's array at a time if allBrokersBrokerage is [trade1_arr, trade2_arr...]
                    // Actually allBrokersBrokerage is an array of arrays.
                  }
                });

                // For any broker that has NO sum from new arrays yet, we could check the old format.
                // But simpliest is: if we have NO new data AT ALL for ANY broker across ALL trades in this group, then use old.
                // Or better: for each trade, prefer new, else use old.
                // But $function receives all trades at once.

                // Let's rely on the fact that if any trade has the new array, we prefer it.
                // For trades without it, they won't add anything to sums.
                // So we add from allOtherBrokerage ONLY if the corresponding trade's brockersBrokerage was empty.

                allOtherBrokerage.forEach((brokerageObj, index) => {
                  const hasNew = allBrokersBrokerage[index] && allBrokersBrokerage[index].length > 0;
                  if (!hasNew && brokerageObj) {
                    Object.keys(brokerageObj).forEach((brokerId) => {
                      if (brokerId != "totalOrderBrokerage" && brokerId != "totalBrokerPercentage") {
                        sums[brokerId] = (sums[brokerId] || 0) + (brokerageObj[brokerId].netBrokerage || 0);
                      }
                    });
                  }
                });

                return Object.keys(sums).map((brokerId) => ({
                  brokerId: brokerId,
                  netBrokerage: sums[brokerId],
                }));
              },
              args: ["$allOtherBrokerage", "$allBrokersBrokerage"],
              lang: "js",
            },
          },
          // Calculate total of summedOtherBrokerage
          summedOtherBrokerageTotal: {
            $function: {
              body: function (allOtherBrokerage, allBrokersBrokerage) {
                let total = 0;
                // Sum from new array (if present)
                allBrokersBrokerage.forEach((commArray) => {
                  if (Array.isArray(commArray) && commArray.length > 0) {
                    commArray.forEach((c) => {
                      if (c) total += (Number(c.rate) || 0);
                    });
                  }
                });

                // Fallback for old format - only for trades NOT having the new array
                allOtherBrokerage.forEach((brokerageObj, index) => {
                  const hasNew = allBrokersBrokerage[index] && allBrokersBrokerage[index].length > 0;
                  if (!hasNew && brokerageObj) {
                    Object.keys(brokerageObj).forEach((brokerId) => {
                      if (brokerId != "totalOrderBrokerage" && brokerId != "totalBrokerPercentage") {
                        total += (brokerageObj[brokerId].netBrokerage || 0);
                      }
                    });
                  }
                });
                return total;
              },
              args: ["$allOtherBrokerage", "$allBrokersBrokerage"],
              lang: "js",
            },
          },
        },
      },
      // Second $addFields stage to calculate remBrokerage
      {
        $addFields: {
          // remBrokerage = Clt.Brok - ALL_BROKER_BROKERAGE
          // NOTE: brokerBrokerage already contains ALL broker commissions (Brok + SB1 + SB2 + ...)
          // Do NOT also subtract summedOtherBrokerageTotal as that would be double-counting
          remBrokerage: { $subtract: ["$brokerage", "$brokerBrokerage"] },
        },
      },
      {
        $project: {
          _id: 0,
          userId: "$_id.userId",
          scriptId: "$_id.scriptId",
          scriptName: 1,
          marketName: 1,
          label: 1,
          remainingQty: 1,
          gross: { $subtract: ["$sellOrderPrice", "$buyOrderPrice"] },
          brokerage: 1,
          bill: 1,
          m2m: 1,
          brokerBrokerage: 1,
          myBrokerage: 1,
          accountName: "$userInfo.accountName",
          accountCode: "$userInfo.accountCode",
          userInfo: "$userInfo",  // Include full userInfo to access partnership array later
          parentIds: 1,
          brokerIds: 1,
          summedOtherBrokerage: 1,
          summedOtherBrokerageTotal: 1,  // For debugging
          remBrokerage: 1,  // Pass through correctly calculated remBrokerage
          transactions: 1,
          brokerIndex: "$brokerIndex",  // Ensure brokerIndex is passed through
          brokerPartnershipPercent: 1,  // Asker=broker's slice on this client (0 otherwise)
          // Self Brokerage calculation:
          // For level 6 (broker): Only their direct commission from broker's brokerage array
          // For other levels: (remBrokerage × myIndex%) where remBrokerage = client brokerage - all broker commissions
          selfBrokerage: {
            $cond: [
              { $eq: [{ $literal: askerLevel }, 6] },
              "$myBrokerage",  // Broker gets only their direct commission
              {
                $divide: [{ $multiply: ["$remBrokerage", { $arrayElemAt: ["$userInfo.partnership", { $subtract: [{ $literal: askerLevel }, 1] }] }] }, 100],
              },
            ],
          },
          myShare: { $arrayElemAt: ["$userInfo.partnership", { $subtract: [{ $literal: askerLevel }, 1] }] },
          // For level 6: Calculate broker's partnership percentage from brokerPartnership array
          brokerPartnershipPercent: {
            $cond: [
              { $eq: [{ $literal: askerLevel }, 6] },
              {
                $reduce: {
                  input: { $ifNull: ["$userInfo.basicDetails.brokerPartnership", []] },
                  initialValue: 0,
                  in: {
                    $cond: [
                      { $eq: [{ $toString: "$$this.broker" }, askerId] },
                      "$$this.partnership",
                      "$$value"
                    ]
                  }
                }
              },
              0
            ]
          },
          selfNetPrice: {
            $cond: [
              { $eq: [{ $literal: askerLevel }, 6] },
              // Asker is broker: use broker's partnership entry on the client (matched via askerId).
              // Formula: (m2m * brokerPartnershipPercent * -1) / 100
              {
                $divide: [
                  {
                    $multiply: [
                      "$m2m",
                      {
                        $reduce: {
                          input: { $ifNull: ["$userInfo.basicDetails.brokerPartnership", []] },
                          initialValue: 0,
                          in: {
                            $cond: [
                              { $eq: [{ $toString: "$$this.broker" }, askerId] },
                              "$$this.partnership",
                              "$$value"
                            ]
                          }
                        }
                      },
                      -1
                    ]
                  },
                  100
                ]
              },
              // Other askers: Use myIndex (asker's partnership slot)
              { $divide: [{ $multiply: ["$m2m", "$myIndex", -1] }, 100] }
            ]
          },
          brokerNetPrice: {
            $cond: [
              { $eq: [{ $literal: askerLevel }, 6] },
              // Asker is broker: (m2m * brokerIndex / 100) minus broker's own slice = "other brokers" share
              {
                $subtract: [
                  { $divide: [{ $multiply: ["$m2m", "$brokerIndex", -1] }, 100] },
                  {
                    $divide: [
                      {
                        $multiply: [
                          "$m2m",
                          {
                            $reduce: {
                              input: { $ifNull: ["$userInfo.basicDetails.brokerPartnership", []] },
                              initialValue: 0,
                              in: {
                                $cond: [
                                  { $eq: [{ $toString: "$$this.broker" }, askerId] },
                                  "$$this.partnership",
                                  "$$value"
                                ]
                              }
                            }
                          },
                          -1
                        ]
                      },
                      100
                    ]
                  }
                ]
              },
              // For other levels: Use normal calculation
              { $divide: [{ $multiply: ["$m2m", "$brokerIndex", -1] }, 100] }
            ]
          },
          // uplineNetPrice calculation (asker's perspective):
          // Sum of all upline shares = partnership[0 .. askerLevel-1]
          uplineNetPrice: {
            $divide: [
              {
                $multiply: [
                  "$m2m",
                  {
                    $cond: [
                      { $lte: [{ $literal: askerLevel }, 1] },
                      0,
                      { $sum: { $slice: ["$userInfo.partnership", 0, { $subtract: [{ $literal: askerLevel }, 1] }] } }
                    ]
                  },
                  -1,
                ],
              },
              100,
            ],
          },
          // downlineNetPrice calculation:
          // Downline = (100% - myIndex% - uplineShare%) × M2M (asker perspective)
          downlineNetPrice: {
            $divide: [
              {
                $multiply: [
                  "$m2m",
                  {
                    $subtract: [
                      100,
                      {
                        $add: [
                          { $arrayElemAt: ["$userInfo.partnership", { $subtract: [{ $literal: askerLevel }, 1] }] },
                          {
                            $cond: [
                              { $lte: [{ $literal: askerLevel }, 1] },
                              0,
                              { $sum: { $slice: ["$userInfo.partnership", 0, { $subtract: [{ $literal: askerLevel }, 1] }] } }
                            ]
                          }
                        ]
                      }
                    ]
                  },
                  -1,
                ],
              },
              100,
            ],
          },
        },
      },
      {
        $group: {
          _id: "$userId",
          accountName: { $first: "$accountName" },
          accountCode: { $first: "$accountCode" },
          parentIds: { $first: "$parentIds" },
          brokerIds: { $first: "$brokerIds" },
          gross: { $sum: "$gross" },
          brokerage: { $sum: "$brokerage" },
          bill: { $sum: "$bill" },
          m2m: { $sum: "$m2m" },
          brokerBrokerage: { $sum: "$brokerBrokerage" },
          myBrokerage: { $sum: "$myBrokerage" },
          selfBrokerage: { $sum: "$selfBrokerage" },
          selfNetPrice: { $sum: "$selfNetPrice" },
          brokerNetPrice: { $sum: "$brokerNetPrice" },
          uplineNetPrice: { $sum: "$uplineNetPrice" },
          downlineNetPrice: { $sum: "$downlineNetPrice" },
          myShare: { $first: "$myShare" },
          summedOtherBrokerage: { $push: "$summedOtherBrokerage" },
          transactions: { $push: "$transactions" },
        },
      },
      {
        $project: {
          _id: 0,
          userId: "$_id",
          accountName: 1,
          accountCode: 1,
          parentIds: 1,
          brokerIds: 1,
          gross: 1,
          brokerage: 1,
          bill: 1,
          m2m: 1,
          brokerBrokerage: 1,
          myBrokerage: 1,
          selfBrokerage: 1,
          selfNetPrice: 1,
          brokerNetPrice: 1,
          uplineNetPrice: 1,
          downlineNetPrice: 1,
          myShare: 1,
          transactions: {
            $reduce: {
              input: "$transactions",
              initialValue: [],
              in: { $concatArrays: ["$$value", "$$this"] },
            },
          },
          summedOtherBrokerage: 1,
        },
      },
    ];

    const runPipeline = opts.scriptLevelOnly ? pipeline.slice(0, -2) : pipeline;
    const resp = await StockTransaction.aggregate(runPipeline);
    return resp;
  } catch (error) {
    console.error("Error creating data:", error);
    throw error;
  }
};

// exports.getPAndLWithLivePricesForNseEq = async (match, level, userId, options = {}) => {
//   try {
//     const scriptLevelDocs = await exports.getProfitLoss(match, level, userId, {
//       scriptLevelOnly: true,
//     });

//     if (!scriptLevelDocs || !scriptLevelDocs.length) {
//       return { data: [], scriptNames: [], livePriceCount: 0, socketSymbols: [] };
//     }

//     const priceMap = await getAllStocksHash();
//     const socketSymbols = [];
//     const usedScriptNames = new Set();

//     const enriched = scriptLevelDocs.map((row) => {
//       const txns = row.transactions || row.txns || [];
//       const sid = String(row.scriptId || row.scriptName || "").toUpperCase();
//       const live = priceMap.get(sid) || priceMap.get(row.scriptId);

//       if (live) {
//         usedScriptNames.add(row.scriptName || row.scriptId);
//         socketSymbols.push(row.scriptId);
//       }

//       let buyOrder = 0;
//       let sellOrder = 0;
//       let buyNet = 0;
//       let sellNet = 0;

//       const updatedTxns = txns
//         .filter((t) => t && typeof t === "object")
//         .map((t) => {
//           let currentT = { ...t };
//           const qty = Number(currentT.quantity) || 0;

//           if (currentT.transactionStatus === "LIVE") {
//             let liveP = 0;
//             if (live) {
//               liveP =
//                 currentT.transactionType === "BUY"
//                   ? Number(live.SellPrice ?? live.ask ?? live.Ltp)
//                   : Number(live.BuyPrice ?? live.bid ?? live.Ltp);
//             }
//             if (!liveP || !Number.isFinite(liveP)) {
//               liveP = Number(currentT.orderPrice) || 0;
//             }
//             currentT.orderPrice = liveP;
//             currentT.netPrice = liveP;
//           }

//           const price = Number(currentT.orderPrice) || 0;
//           const netP = Number(currentT.netPrice) || price;

//           currentT.totalOrderPrice = price * qty;
//           currentT.totalNetPrice = netP * qty;
//           currentT.m2mPrice = price * qty;

//           if (currentT.transactionType === "BUY") {
//             buyOrder += currentT.totalOrderPrice;
//             buyNet += currentT.totalNetPrice;
//           } else {
//             sellOrder += currentT.totalOrderPrice;
//             sellNet += currentT.totalNetPrice;
//           }

//           return currentT;
//         });

//       const gross = sellOrder - buyOrder;
//       const m2m = sellNet - buyNet;
//       const brokerage = Number(row.brokerage) || 0;
//       const brokerBrokerage = Number(row.brokerBrokerage) || 0;
//       const bill = Number(gross - brokerage);

//       const myShare = Number(row.myShare) || 0;
//       const pArr = row.userInfo?.partnership || [];
//       const brokerIndex =
//         Number(row.brokerIndex) ||
//         (pArr.length > 5 ? Number(pArr[5]) : 0);

//       let uplineShare = 0;
//       for (let i = 0; i < Math.min(level - 1, pArr.length); i++) {
//         uplineShare += Number(pArr[i]) || 0;
//       }

//       const finalM2M = bill + brokerBrokerage;

//       return {
//         ...row,
//         transactions: updatedTxns,
//         summedOtherBrokerage: row.summedOtherBrokerage || [],
//         gross: Number(gross),
//         bill: Number(bill),
//         m2m: Number(finalM2M),
//         brokerage,
//         brokerBrokerage,
//         selfNetPrice: (finalM2M * myShare * -1) / 100,
//         brokerNetPrice: (finalM2M * brokerIndex * -1) / 100,
//         uplineNetPrice: (finalM2M * uplineShare * -1) / 100,
//         downlineNetPrice: (finalM2M * (100 - myShare - uplineShare) * -1) / 100,
//         uplineShare,
//         livePriceFound: !!live,
//         marketId:
//           row.marketId ||
//           (row.transactions && row.transactions[0]?.marketId) ||
//           row.market ||
//           row.InstrumentIdentifier,
//         marketName:
//           row.marketName ||
//           (row.transactions && row.transactions[0]?.marketName) ||
//           row.exchange ||
//           "",
//       };
//     });

//     const userMap = new Map();

//     enriched.forEach((row) => {
//       const uid = String(row.userId);
//       if (!userMap.has(uid)) {
//         userMap.set(uid, {
//           userId: row.userId,
//           accountName: row.accountName,
//           accountCode: row.accountCode,
//           parentIds: row.parentIds || [],
//           brokerIds: row.brokerIds || [],
//           gross: 0,
//           brokerage: 0,
//           bill: 0,
//           m2m: 0,
//           brokerBrokerage: 0,
//           myBrokerage: 0,
//           selfBrokerage: 0,
//           selfNetPrice: 0,
//           brokerNetPrice: 0,
//           uplineNetPrice: 0,
//           downlineNetPrice: 0,
//           myShare: row.myShare,
//           uplineShare: row.uplineShare || 0,
//           interestAmount: 0,
//           summedOtherBrokerage: [],
//           transactions: [],
//         });
//       }
//       const acc = userMap.get(uid);
//       acc.gross += Number(row.gross) || 0;
//       acc.brokerage += Number(row.brokerage) || 0;
//       acc.bill += Number(row.bill) || 0;
//       acc.m2m += Number(row.m2m) || 0;
//       acc.brokerBrokerage += Number(row.brokerBrokerage) || 0;
//       acc.selfNetPrice += Number(row.selfNetPrice) || 0;
//       acc.brokerNetPrice += Number(row.brokerNetPrice) || 0;
//       acc.uplineNetPrice += Number(row.uplineNetPrice) || 0;
//       acc.downlineNetPrice += Number(row.downlineNetPrice) || 0;
//       if (row.summedOtherBrokerage) acc.summedOtherBrokerage.push(row.summedOtherBrokerage);
//       if (row.transactions) acc.transactions.push(...row.transactions);
//     });

//     try {
//       const NseEqInterestModel = require("../models/NseEqInterestModel");
//       let { interestStartDate, interestEndDate } = options;
//       if (!interestStartDate || !interestEndDate) {
//         let valanDoc = null;
//         if (match.valanId) valanDoc = await WeekValanModel.findById(match.valanId).lean();
//         if (!valanDoc) valanDoc = await exports.getActiveWeekValan();
//         if (valanDoc) {
//           if (!interestStartDate) interestStartDate = moment(valanDoc.startDate).format("YYYY-MM-DD");
//           if (!interestEndDate) interestEndDate = moment(valanDoc.endDate).format("YYYY-MM-DD");
//         }
//       }

//       const targetId = mongoose.Types.ObjectId.isValid(userId) ? new mongoose.Types.ObjectId(userId) : userId;
//       const interestDateFilter = { $lte: interestEndDate || moment().format("YYYY-MM-DD") };
//       if (interestStartDate) interestDateFilter.$gte = interestStartDate;

//       const interestOrConds = [{ parentIds: targetId }, { userId: targetId }];
//       if (typeof userId === "string") {
//         interestOrConds.push({ parentIds: userId });
//         interestOrConds.push({ userId: userId });
//       }

//       const interestAgg = await NseEqInterestModel.aggregate([
//         { $match: { date: interestDateFilter, $or: interestOrConds } },
//         {
//           $group: {
//             _id: {
//               $cond: [{ $gt: [{ $size: "$parentIds" }, level] }, { $arrayElemAt: ["$parentIds", level] }, "$userId"],
//             },
//             totalInterest: { $sum: "$interestAmount" },
//           },
//         },
//       ]);

//       const interestAggMap = new Map();
//       interestAgg.forEach((i) => {
//         if (i._id) interestAggMap.set(i._id.toString(), i.totalInterest);
//       });

//       const groupClientCount = new Map();
//       for (const [, acc] of userMap.entries()) {
//         const pIds = Array.isArray(acc.parentIds) ? acc.parentIds : [];
//         const groupKey = pIds.length > level ? String(pIds[level]) : String(acc.userId);
//         groupClientCount.set(groupKey, (groupClientCount.get(groupKey) || 0) + 1);
//       }

//       for (const [, acc] of userMap.entries()) {
//         const pIds = Array.isArray(acc.parentIds) ? acc.parentIds : [];
//         const groupKey = pIds.length > level ? String(pIds[level]) : String(acc.userId);
//         const groupInterest = interestAggMap.get(groupKey) || 0;
//         const clientCount = groupClientCount.get(groupKey) || 1;
//         const clientInterest = groupInterest / clientCount;

//         acc.interestAmount = clientInterest;
//         if (clientInterest !== 0) {
//           const myShare = Number(acc.myShare) || 0;
//           const uplineShare = Number(acc.uplineShare) || 0;
//           const downlineShare = Math.max(0, 100 - myShare - uplineShare);
//           acc.m2m -= clientInterest;
//           acc.selfNetPrice += (clientInterest * myShare) / 100;
//           acc.uplineNetPrice += (clientInterest * uplineShare) / 100;
//           acc.downlineNetPrice += (clientInterest * downlineShare) / 100;
//         }
//       }
//     } catch (intErr) {
//       console.error("[getPAndLWithLivePricesForNseEq] interest error:", intErr.message);
//     }

//     const response = Array.from(userMap.values());
//     const directReportingIds = new Set();
//     if (response && response.length > 0) {
//       response.forEach((item) => {
//         if (item.parentIds && item.parentIds.length > level) {
//           directReportingIds.add(item.parentIds[level].toString());
//         } else if (item.userId) {
//           directReportingIds.add(item.userId.toString());
//         }
//       });
//     }

//     const allDirectUsers = await userModel.find({
//       _id: { $in: Array.from(directReportingIds) },
//       demoid: options.isRequesterDemo ? true : { $ne: true }
//     }).select('accountName accountCode partnership accountDetails createdBy').populate('accountType', 'label level').lean();

//     const finalData = allDirectUsers.map(element => {
//       const elementIdStr = element._id.toString();
//       let aggGross = 0, aggBill = 0, aggM2M = 0, aggBrokerage = 0;
//       let aggBrokerBrokerage = 0, aggSelfBrokerage = 0, aggBrokerNetPrice = 0;
//       let aggSelfNetPrice = 0, aggUplineNetPrice = 0, aggDownlineNetPrice = 0;
//       let aggInterestAmount = 0;
//       const brokerSumMap = new Map();
//       const aggStockTransactions = [];

//       response.forEach(r => {
//         const rUserId = r.userId.toString();
//         const isDirectMatch = rUserId === elementIdStr;
//         const isHierarchyMatch = r.parentIds && r.parentIds.some(pid => pid.toString() === elementIdStr);

//         if (isDirectMatch || isHierarchyMatch) {
//           aggGross += Number(r.gross) || 0;
//           aggBill += Number(r.bill) || 0;
//           aggM2M += Number(r.m2m) || 0;
//           aggBrokerage += Number(r.brokerage) || 0;
//           aggBrokerBrokerage += Number(r.brokerBrokerage) || 0;
//           aggBrokerNetPrice += Number(r.brokerNetPrice) || 0;
//           aggSelfNetPrice += Number(r.selfNetPrice) || 0;
//           aggUplineNetPrice += Number(r.uplineNetPrice) || 0;
//           aggDownlineNetPrice += Number(r.downlineNetPrice) || 0;
//           aggInterestAmount += Number(r.interestAmount) || 0;

//           const flat = (r.summedOtherBrokerage || []).flat(2);
//           const match = flat.find(
//             (item) =>
//               item &&
//               item.brokerId &&
//               item.brokerId.toString() === elementIdStr
//           );

//           if (match) {
//             let base = Number(match.netBrokerage) || 0;

//             const pArr = r.userInfo?.partnership || [];
//             let uplineShare = 0;
//             for (let i = 0; i < level - 1; i++) {
//               uplineShare += Number(pArr[i]) || 0;
//             }

//             const adjusted = base - (base * uplineShare) / 100;
//             aggSelfBrokerage += adjusted;
//           }

//           if (r.summedOtherBrokerage && Array.isArray(r.summedOtherBrokerage)) {
//             const flatArr = r.summedOtherBrokerage.flat(2);
//             flatArr.forEach((item) => {
//               if (item && typeof item === 'object' && item.brokerId) {
//                 const bId = String(item.brokerId);
//                 const val = Number(item.netBrokerage) || 0;
//                 brokerSumMap.set(bId, (brokerSumMap.get(bId) || 0) + val);
//               }
//             });
//           }
//           if (r.transactions && Array.isArray(r.transactions)) {
//             aggStockTransactions.push(...r.transactions);
//           }
//         }
//       });

//       return {
//         ...element,
//         gross: Number(aggGross.toFixed(4)),
//         bill: Number(aggBill.toFixed(4)),
//         m2m: Number(aggM2M.toFixed(4)),
//         brokerage: Number(aggBrokerage.toFixed(4)),
//         brokerBrokerage: Number(aggBrokerBrokerage.toFixed(4)),
//         selfBrokerage: Number(aggSelfBrokerage.toFixed(4)),
//         uplineNetPrice: Number(aggUplineNetPrice.toFixed(4)),
//         selfNetPrice: Number(aggSelfNetPrice.toFixed(4)),
//         downlineNetPrice: Number(aggDownlineNetPrice.toFixed(4)),
//         brokerNetPrice: Number(aggBrokerNetPrice.toFixed(4)),
//         summedOtherBrokerage: Array.from(brokerSumMap.values()),
//         stockTransactions: aggStockTransactions,
//         interestAmount: Number(aggInterestAmount.toFixed(4)),
//         totalNetWithInterest: Number(aggSelfNetPrice.toFixed(4))
//       };
//     });

//     return {
//       data: finalData,
//       scriptNames: Array.from(usedScriptNames),
//       livePriceCount: usedScriptNames.size,
//       socketSymbols: [...new Set(socketSymbols)],
//     };
//   } catch (error) {
//     console.error("Error getPAndLWithLivePricesForNseEq:", error);
//     return { data: [], scriptNames: [], livePriceCount: 0, socketSymbols: [] };
//   }
// };


exports.getPAndLWithLivePricesForNseEq = async (match, level, userId, options = {}) => {
  try {
    const scriptLevelDocs = await exports.getProfitLoss(match, level, userId, {
      scriptLevelOnly: true,
    });

    if (!scriptLevelDocs || !scriptLevelDocs.length) {
      return { data: [], scriptNames: [], livePriceCount: 0, socketSymbols: [] };
    }

    const priceMap = await getAllStocksHash();
    const socketSymbols = [];
    const usedScriptNames = new Set();

    const enriched = scriptLevelDocs.map((row) => {
      const txns = row.transactions || row.txns || [];
      const sid = String(row.scriptId || row.scriptName || "").toUpperCase();
      const live = priceMap.get(sid) || priceMap.get(row.scriptId);

      if (live) {
        usedScriptNames.add(row.scriptName || row.scriptId);
        socketSymbols.push(row.scriptId);
      }

      let buyOrder = 0;
      let sellOrder = 0;
      let buyNet = 0;
      let sellNet = 0;

      const updatedTxns = txns
        .filter((t) => t && typeof t === "object")
        .map((t) => {
          let currentT = { ...t };
          const qty = Number(currentT.quantity) || 0;

          if (currentT.transactionStatus === "LIVE") {
            let liveP = 0;
            if (live) {
              // For BUY transactions, use SellPrice (Ask), for SELL use BuyPrice (Bid)
              // If either is 0 or unavailable, fallback to LTP
              if (currentT.transactionType === "BUY") {
                liveP = Number(live.SellPrice ?? live.ask ?? 0);
                if (liveP === 0) {
                  liveP = Number(live.Ltp ?? 0);
                }
              } else {
                liveP = Number(live.BuyPrice ?? live.bid ?? 0);
                if (liveP === 0) {
                  liveP = Number(live.Ltp ?? 0);
                }
              }
            }
            // Only fallback to old orderPrice if we still don't have a valid price
            if (!liveP || !Number.isFinite(liveP) || liveP === 0) {
              liveP = Number(currentT.orderPrice) || 0;
            }
            currentT.orderPrice = liveP;
            currentT.netPrice = liveP;
          }

          const price = Number(currentT.orderPrice) || 0;
          const netP = Number(currentT.netPrice) || price;

          currentT.totalOrderPrice = price * qty;
          currentT.totalNetPrice = netP * qty;
          currentT.m2mPrice = price * qty;

          if (currentT.transactionType === "BUY") {
            buyOrder += currentT.totalOrderPrice;
            buyNet += currentT.totalNetPrice;
          } else {
            sellOrder += currentT.totalOrderPrice;
            sellNet += currentT.totalNetPrice;
          }

          return currentT;
        });

      const gross = sellOrder - buyOrder;
      const m2m = sellNet - buyNet;
      const brokerage = Number(row.brokerage) || 0;
      const brokerBrokerage = Number(row.brokerBrokerage) || 0;
      const bill = Number(gross - brokerage);

      const myShare = Number(row.myShare) || 0;
      const pArr = row.userInfo?.partnership || [];
      const brokerIndex =
        Number(row.brokerIndex) ||
        (pArr.length > 5 ? Number(pArr[5]) : 0);

      let uplineShare = 0;
      for (let i = 0; i < Math.min(level - 1, pArr.length); i++) {
        uplineShare += Number(pArr[i]) || 0;
      }

      const finalM2M = bill + brokerBrokerage;

      return {
        ...row,
        transactions: updatedTxns,
        summedOtherBrokerage: row.summedOtherBrokerage || [],
        gross: Number(gross),
        bill: Number(bill),
        m2m: Number(finalM2M),
        brokerage,
        brokerBrokerage,
        selfBrokerage: Number(row.selfBrokerage) || 0,
        selfNetPrice: (finalM2M * myShare * -1) / 100,
        brokerNetPrice: (finalM2M * brokerIndex * -1) / 100,
        uplineNetPrice: (finalM2M * uplineShare * -1) / 100,
        downlineNetPrice: (finalM2M * (100 - myShare - uplineShare - brokerIndex) * -1) / 100,
        uplineShare,
        livePriceFound: !!live,
        marketId:
          row.marketId ||
          (row.transactions && row.transactions[0]?.marketId) ||
          row.market ||
          row.InstrumentIdentifier,
        marketName:
          row.marketName ||
          (row.transactions && row.transactions[0]?.marketName) ||
          row.exchange ||
          "",
      };
    });

    const userMap = new Map();

    enriched.forEach((row) => {
      const uid = String(row.userId);
      if (!userMap.has(uid)) {
        userMap.set(uid, {
          userId: row.userId,
          accountName: row.accountName,
          accountCode: row.accountCode,
          parentIds: row.parentIds || [],
          brokerIds: row.brokerIds || [],
          gross: 0,
          brokerage: 0,
          bill: 0,
          m2m: 0,
          brokerBrokerage: 0,
          myBrokerage: 0,
          selfBrokerage: 0,
          selfNetPrice: 0,
          brokerNetPrice: 0,
          uplineNetPrice: 0,
          downlineNetPrice: 0,
          myShare: row.myShare,
          brokerIndex: row.brokerIndex || (row.userInfo?.partnership?.[5] || 0),
          uplineShare: row.uplineShare || 0,
          interestAmount: 0,
          summedOtherBrokerage: [],
          transactions: [],
        });
      }
      const acc = userMap.get(uid);
      acc.gross += Number(row.gross) || 0;
      acc.brokerage += Number(row.brokerage) || 0;
      acc.bill += Number(row.bill) || 0;
      acc.m2m += Number(row.m2m) || 0;
      acc.brokerBrokerage += Number(row.brokerBrokerage) || 0;
      acc.myBrokerage += Number(row.myBrokerage) || 0;
      acc.selfBrokerage += Number(row.selfBrokerage) || 0;
      acc.selfNetPrice += Number(row.selfNetPrice) || 0;
      acc.brokerNetPrice += Number(row.brokerNetPrice) || 0;
      acc.uplineNetPrice += Number(row.uplineNetPrice) || 0;
      acc.downlineNetPrice += Number(row.downlineNetPrice) || 0;
      if (row.summedOtherBrokerage) acc.summedOtherBrokerage.push(row.summedOtherBrokerage);
      if (row.transactions) acc.transactions.push(...row.transactions);
    });

    try {
      const NseEqInterestModel = require("../models/NseEqInterestModel");
      let { interestStartDate, interestEndDate } = options;
      if (!interestStartDate || !interestEndDate) {
        let valanDoc = null;
        if (match.valanId) valanDoc = await WeekValanModel.findById(match.valanId).lean();
        if (!valanDoc) valanDoc = await exports.getActiveWeekValan();
        if (valanDoc) {
          // Include Saturday and Sunday before the valan week
          const valanStartDate = moment(valanDoc.startDate);
          const saturday = valanStartDate.clone().subtract(2, 'days');
          if (!interestStartDate) interestStartDate = saturday.format("YYYY-MM-DD");
          if (!interestEndDate) interestEndDate = moment(valanDoc.endDate).format("YYYY-MM-DD");
          // console.log(`[getPAndLWithLivePricesForNseEq] Including weekend interest from ${interestStartDate} to ${interestEndDate}`);
        }
      }

      const targetId = mongoose.Types.ObjectId.isValid(userId) ? new mongoose.Types.ObjectId(userId) : userId;
      const interestDateFilter = { $lte: interestEndDate || moment().format("YYYY-MM-DD") };
      if (interestStartDate) interestDateFilter.$gte = interestStartDate;

      // Build interest query conditions
      // If userId is null (bill generation), fetch ALL interest records for the date range
      // Otherwise, filter by hierarchy (for reports)
      let interestMatchQuery = { date: interestDateFilter };

      if (userId) {
        const interestOrConds = [{ parentIds: targetId }, { userId: targetId }];
        if (typeof userId === "string") {
          interestOrConds.push({ parentIds: userId });
          interestOrConds.push({ userId: userId });
        }
        interestMatchQuery.$or = interestOrConds;
      }

      // Aggregate interest per userId directly (not grouped by parent)
      const interestAgg = await NseEqInterestModel.aggregate([
        { $match: interestMatchQuery },
        {
          $group: {
            _id: "$userId",
            totalInterest: { $sum: "$interestAmount" },
          },
        },
      ]);

      console.log(`[getPAndLWithLivePricesForNseEq] Interest aggregation results:`, interestAgg.length, 'users');

      const interestAggMap = new Map();
      interestAgg.forEach((i) => {
        if (i._id) {
          interestAggMap.set(i._id.toString(), i.totalInterest);
          console.log(`[getPAndLWithLivePricesForNseEq] User ${i._id}: interest = ${i.totalInterest}`);
        }
      });

      for (const [, acc] of userMap.entries()) {
        const clientInterest = interestAggMap.get(String(acc.userId)) || 0;

        console.log(`[getPAndLWithLivePricesForNseEq] Setting interest for user ${acc.userId}: ${clientInterest}`);
        acc.interestAmount = clientInterest;
        if (clientInterest !== 0) {
          const myShare = Number(acc.myShare) || 0;
          const brokerIndex = Number(acc.brokerIndex) || 0;
          acc.m2m -= clientInterest;
          acc.selfNetPrice = (acc.m2m * myShare) / 100;

          acc.brokerNetPrice = (acc.m2m * brokerIndex) / 100;
          acc.selfNetPrice = acc.selfNetPrice * -1;
          acc.brokerNetPrice = acc.brokerNetPrice * -1;
        }

        if (level == 7) {
          acc.downlineNetPrice = 0;
        }
      }
    } catch (intErr) {
      console.error("[getPAndLWithLivePricesForNseEq] interest error:", intErr.message);
    }

    const response = Array.from(userMap.values());
    const directReportingIds = new Set();
    if (response && response.length > 0) {
      response.forEach((item) => {
        if (item.parentIds && item.parentIds.length > level) {
          directReportingIds.add(item.parentIds[level].toString());
        } else if (item.userId) {
          directReportingIds.add(item.userId.toString());
        }
      });
    }

    const allDirectUsers = await userModel.find({
      _id: { $in: Array.from(directReportingIds) },
      demoid: options.isRequesterDemo ? true : { $ne: true }
    }).select('accountName accountCode partnership accountDetails createdBy basicDetails.summaryPostFix').populate('accountType', 'label level').lean();

    const finalData = allDirectUsers.map(element => {
      const elementIdStr = element._id.toString();
      let aggGross = 0, aggBill = 0, aggM2M = 0, aggBrokerage = 0;
      let aggBrokerBrokerage = 0, aggSelfBrokerage = 0, aggBrokerNetPrice = 0;
      let aggSelfNetPrice = 0, aggUplineNetPrice = 0, aggDownlineNetPrice = 0;
      let aggInterestAmount = 0;
      const brokerSumMap = new Map();
      const aggStockTransactions = [];
      let aggBrokerIds = [];
      let aggMyShare = 0;

      response.forEach(r => {
        const rUserId = r.userId.toString();
        const isDirectMatch = rUserId === elementIdStr;
        const isHierarchyMatch = r.parentIds && r.parentIds.some(pid => pid.toString() === elementIdStr);

        if (isDirectMatch || isHierarchyMatch) {
          aggGross += Number(r.gross) || 0;
          aggBill += Number(r.bill) || 0;
          aggM2M += Number(r.m2m) || 0;
          aggBrokerage += Number(r.brokerage) || 0;
          aggBrokerBrokerage += Number(r.brokerBrokerage) || 0;
          aggBrokerNetPrice += Number(r.brokerNetPrice) || 0;
          aggSelfNetPrice += Number(r.selfNetPrice) || 0;
          aggUplineNetPrice += Number(r.uplineNetPrice) || 0;
          aggDownlineNetPrice += Number(r.downlineNetPrice) || 0;
          aggInterestAmount += Number(r.interestAmount) || 0;

          aggSelfBrokerage += Number(r.selfBrokerage) || 0;

          if (isDirectMatch) {
            if (Array.isArray(r.brokerIds) && r.brokerIds.length) aggBrokerIds = r.brokerIds;
            if (r.myShare != null) aggMyShare = Number(r.myShare) || 0;
          }

          // Fix summedOtherBrokerage aggregation - avoid duplication
          // summedOtherBrokerage comes from the pipeline as an array of arrays (one per script)
          // Each inner array contains objects with {brokerId, netBrokerage}
          if (r.summedOtherBrokerage && Array.isArray(r.summedOtherBrokerage)) {
            r.summedOtherBrokerage.forEach((scriptBrokerageArray) => {
              // Each scriptBrokerageArray is the result from one script's aggregation
              if (Array.isArray(scriptBrokerageArray)) {
                scriptBrokerageArray.forEach((item) => {
                  if (item && typeof item === 'object' && item.brokerId) {
                    const bId = String(item.brokerId);
                    const val = Number(item.netBrokerage) || 0;
                    brokerSumMap.set(bId, (brokerSumMap.get(bId) || 0) + val);
                  }
                });
              } else if (scriptBrokerageArray && typeof scriptBrokerageArray === 'object' && scriptBrokerageArray.brokerId) {
                // Handle case where it's a single object (not wrapped in array)
                const bId = String(scriptBrokerageArray.brokerId);
                const val = Number(scriptBrokerageArray.netBrokerage) || 0;
                brokerSumMap.set(bId, (brokerSumMap.get(bId) || 0) + val);
              }
            });
          }
          if (r.transactions && Array.isArray(r.transactions)) {
            aggStockTransactions.push(...r.transactions);
          }
        }
      });

      return {
        ...element,
        userId: element._id,
        gross: Number(aggGross.toFixed(4)),
        bill: Number(aggBill.toFixed(4)),
        m2m: Number(aggM2M.toFixed(4)),
        brokerage: Number(aggBrokerage.toFixed(4)),
        brokerBrokerage: Number(aggBrokerBrokerage.toFixed(4)),
        selfBrokerage: Number(aggSelfBrokerage.toFixed(4)),
        uplineNetPrice: Number(aggUplineNetPrice.toFixed(4)),
        selfNetPrice: Number(aggSelfNetPrice.toFixed(4)),
        downlineNetPrice: Number(aggDownlineNetPrice.toFixed(4)),
        brokerNetPrice: Number(aggBrokerNetPrice.toFixed(4)),
        summedOtherBrokerage: Array.from(brokerSumMap.entries()).map(([brokerId, netBrokerage]) => ({
          brokerId,
          netBrokerage: Number(netBrokerage.toFixed(4))
        })),
        stockTransactions: aggStockTransactions,
        interestAmount: Number(aggInterestAmount.toFixed(4)),
        totalNetWithInterest: Number(aggSelfNetPrice.toFixed(4)),
        brokerIds: aggBrokerIds,
        myShare: aggMyShare,
      };
    });

    return {
      data: finalData,
      scriptNames: Array.from(usedScriptNames),
      livePriceCount: usedScriptNames.size,
      socketSymbols: [...new Set(socketSymbols)],
    };
  } catch (error) {
    console.error("Error getPAndLWithLivePricesForNseEq:", error);
    return { data: [], scriptNames: [], livePriceCount: 0, socketSymbols: [] };
  }
};

exports.getProfitLossWithLivePrices = async (match, level, userId, options = {}) => {
  try {
    const askerLevel = Number(options.askerLevel ?? level);
    const askerId = String(options.askerId ?? userId);

    const scriptLevelDocs = await exports.getProfitLoss(match, level, userId, {
      scriptLevelOnly: true,
      askerLevel,
      askerId,
    });

    if (!scriptLevelDocs || !scriptLevelDocs.length) {
      return { data: [], scriptNames: [], livePriceCount: 0, socketSymbols: [] };
    }

    const priceMap = await getAllStocksHash();
    const socketSymbols = [];
    const usedScriptNames = new Set();

    const enriched = scriptLevelDocs.map((row) => {
      const txns = row.transactions || row.txns || [];
      const sid = String(row.scriptId || row.scriptName || "").toUpperCase();
      const live = priceMap.get(sid) || priceMap.get(row.scriptId);

      if (live) {
        usedScriptNames.add(row.scriptName || row.scriptId);
        socketSymbols.push(row.scriptId);
      }

      let buyOrder = 0;
      let sellOrder = 0;
      let buyNet = 0;
      let sellNet = 0;

      const updatedTxns = txns
        .filter((t) => t && typeof t === "object")
        .map((t) => {
          let currentT = { ...t };

          const qty = Number(currentT.quantity) || 0;

          // LIVE PRICE FIX
          if (currentT.transactionStatus === "LIVE") {
            let liveP = 0;

            if (live) {
              // For BUY transactions, use SellPrice (Ask), for SELL use BuyPrice (Bid)
              // If either is 0 or unavailable, fallback to LTP
              if (currentT.transactionType === "BUY") {
                liveP = Number(live.SellPrice ?? live.ask ?? 0);
                if (liveP === 0) {
                  liveP = Number(live.Ltp ?? 0);
                }
              } else {
                liveP = Number(live.BuyPrice ?? live.bid ?? 0);
                if (liveP === 0) {
                  liveP = Number(live.Ltp ?? 0);
                }
              }
            }

            // Only fallback to old orderPrice if we still don't have a valid price
            if (!liveP || !Number.isFinite(liveP) || liveP === 0) {
              liveP = Number(currentT.orderPrice) || 0;
            }

            currentT.orderPrice = liveP;
            currentT.netPrice = liveP;
          }

          const price = Number(currentT.orderPrice) || 0;
          const netP = Number(currentT.netPrice) || price;

          currentT.totalOrderPrice = price * qty;
          currentT.totalNetPrice = netP * qty;
          currentT.m2mPrice = price * qty;

          if (currentT.transactionType === "BUY") {
            buyOrder += currentT.totalOrderPrice;
            buyNet += currentT.totalNetPrice;
          } else {
            sellOrder += currentT.totalOrderPrice;
            sellNet += currentT.totalNetPrice;
          }

          return currentT;
        });

      const gross = sellOrder - buyOrder;
      const m2m = sellNet - buyNet;

      // ✅ USE PIPELINE VALUES (DO NOT RECALCULATE)
      const brokerage = Number(row.brokerage) || 0;
      const brokerBrokerage = Number(row.brokerBrokerage) || 0;

      const bill = Number(gross - brokerage);

      // Partnership logic - use pipeline values from aggregation
      const myShare = Number(row.myShare) || 0;
      const pArr = row.userInfo?.partnership || [];
      const myBrokerage = Number(row.myBrokerage) || 0;

      let brokerIndex =
        Number(row.brokerIndex) ||
        (pArr.length > 5 ? Number(pArr[5]) : 0);

      // Asker perspective controls share math. uplineShare slice uses asker's level.
      // (For non-broker callers askerLevel === level, behavior unchanged.)
      let uplineShare = 0;
      for (let i = 0; i < Math.min(askerLevel - 1, pArr.length); i++) {
        uplineShare += Number(pArr[i]) || 0;
      }

      // const finalM2M = bill;
      const finalM2M = bill + brokerBrokerage;

      let selfNetPrice, brokerNetPrice, uplineNetPrice;

      if (askerLevel === 6) {
        // Asker is broker: recompute from live-adjusted finalM2M using broker's partnership
        // entry on this client (exposed by pipeline as brokerPartnershipPercent). Do NOT trust
        // pipeline selfNetPrice — it was computed from pipeline m2m which diverges from live m2m
        // when there are open positions.
        const brokerOwnShare = Number(row.brokerPartnershipPercent) || 0;
        selfNetPrice = (finalM2M * brokerOwnShare * -1) / 100;
        brokerNetPrice = (finalM2M * (brokerIndex - brokerOwnShare) * -1) / 100;
        uplineNetPrice = (finalM2M * uplineShare * -1) / 100;
      } else {
        // Normal calculation for other levels (unchanged)
        selfNetPrice = (finalM2M * myShare * -1) / 100;
        brokerNetPrice = (finalM2M * brokerIndex * -1) / 100;
        uplineNetPrice = (finalM2M * uplineShare * -1) / 100;
      }

      return {
        ...row,
        transactions: updatedTxns,

        // ✅ IMPORTANT: PRESERVE THIS (OLD CODE LOGIC)
        summedOtherBrokerage: row.summedOtherBrokerage || [],

        gross: Number(gross),
        bill: Number(bill),
        m2m: Number(finalM2M),

        brokerage,
        brokerBrokerage,

        selfNetPrice: selfNetPrice,
        brokerNetPrice: brokerNetPrice,
        uplineNetPrice: uplineNetPrice,
        downlineNetPrice: askerLevel === 6
          ? (finalM2M * (100 - brokerIndex - uplineShare) * -1) / 100
          : (finalM2M * (100 - myShare - uplineShare) * -1) / 100,

        // Expose partnership shares so userMap can carry them for interest distribution
        uplineShare,

        livePriceFound: !!live,

        marketId:
          row.marketId ||
          (row.transactions && row.transactions[0]?.marketId) ||
          row.market ||
          row.InstrumentIdentifier,

        marketName:
          row.marketName ||
          (row.transactions && row.transactions[0]?.marketName) ||
          row.exchange ||
          "",
      };
    });

    // ============================
    // USER LEVEL GROUPING
    // ============================
    const userMap = new Map();

    enriched.forEach((row) => {
      const uid = String(row.userId);

      if (!userMap.has(uid)) {
        userMap.set(uid, {
          userId: row.userId,
          accountName: row.accountName,
          accountCode: row.accountCode,
          parentIds: row.parentIds || [],
          brokerIds: row.brokerIds || [],

          gross: 0,
          brokerage: 0,
          bill: 0,
          m2m: 0,
          brokerBrokerage: 0,

          myBrokerage: 0,
          selfBrokerage: 0,

          selfNetPrice: 0,
          brokerNetPrice: 0,
          uplineNetPrice: 0,
          downlineNetPrice: 0,

          myShare: row.myShare,
          uplineShare: row.uplineShare || 0, // carries per-script weighted value; used for interest split
          interestAmount: 0,                  // populated later for NSE-EQ
          summedOtherBrokerage: [],
          transactions: [],
        });
      }

      const acc = userMap.get(uid);

      acc.gross += Number(row.gross) || 0;
      acc.brokerage += Number(row.brokerage) || 0;
      acc.bill += Number(row.bill) || 0;
      acc.m2m += Number(row.m2m) || 0;
      acc.brokerBrokerage += Number(row.brokerBrokerage) || 0;
      acc.myBrokerage += Number(row.myBrokerage) || 0;
      acc.selfBrokerage += Number(row.selfBrokerage) || 0;

      acc.selfNetPrice += Number(row.selfNetPrice) || 0;
      acc.brokerNetPrice += Number(row.brokerNetPrice) || 0;
      acc.uplineNetPrice += Number(row.uplineNetPrice) || 0;
      acc.downlineNetPrice += Number(row.downlineNetPrice) || 0;

      // Collect broker brokerages from transactions
      if (row.transactions && Array.isArray(row.transactions)) {
        row.transactions.forEach(txn => {
          if (txn.brockersBrokerage && Array.isArray(txn.brockersBrokerage)) {
            txn.brockersBrokerage.forEach(bb => {
              if (bb && bb.brokerId) {
                const bId = String(bb.brokerId);
                const rate = Number(bb.rate) || 0;
                if (!acc.brokerBrokerageMap) acc.brokerBrokerageMap = new Map();
                acc.brokerBrokerageMap.set(bId, (acc.brokerBrokerageMap.get(bId) || 0) + rate);
              }
            });
          }
        });
      }

      if (row.transactions) {
        acc.transactions.push(...row.transactions);
      }
    });

    // Convert brokerBrokerageMap to summedOtherBrokerage array
    for (const [, acc] of userMap.entries()) {
      if (acc.brokerBrokerageMap && acc.brokerBrokerageMap.size > 0) {
        acc.summedOtherBrokerage = Array.from(acc.brokerBrokerageMap.entries()).map(([brokerId, netBrokerage]) => ({
          brokerId,
          netBrokerage: Number(netBrokerage.toFixed(4))
        }));
      }
      delete acc.brokerBrokerageMap; // Clean up temporary map
    }

    // ── NSE-EQ Interest Distribution ──────────────────────────────────────────
    // COMMENTED OUT: This section was overriding the calculated selfNetPrice values
    // TODO: Fix this section to only adjust for interest without recalculating M2M distribution
    /*
    // Uses the same hierarchy-aware aggregation as the original controller:
    //   match  → parentIds contains the requester's userId (or userId IS the requester)
    //   group  → by parentIds[level], which is the direct-report user id at requester's level
    // Then pro-rates each group's total interest across the clients in that group.
    if (String(match.marketId) === '12') {
      try {
        const NseEqInterestModel = require('../models/NseEqInterestModel');

        // ── Resolve date range ─────────────────────────────────────────────────
        let { interestStartDate, interestEndDate } = options;
        if (!interestStartDate || !interestEndDate) {
          let valanDoc = null;
          if (match.valanId) valanDoc = await WeekValanModel.findById(match.valanId).lean();
          if (!valanDoc) valanDoc = await exports.getActiveWeekValan();
          if (valanDoc) {
            // Include Saturday and Sunday before the valan week
            const valanStartDate = moment(valanDoc.startDate);
            const saturday = valanStartDate.clone().subtract(2, 'days');
            if (!interestStartDate) interestStartDate = saturday.format("YYYY-MM-DD");
            if (!interestEndDate) interestEndDate = moment(valanDoc.endDate).format("YYYY-MM-DD");
          }
        }

        // ── Build requester's targetId (same as controller) ────────────────────
        const targetId = mongoose.Types.ObjectId.isValid(userId)
          ? new mongoose.Types.ObjectId(userId)
          : userId;

        const interestDateFilter = { $lte: interestEndDate || moment().format('YYYY-MM-DD') };
        if (interestStartDate) interestDateFilter.$gte = interestStartDate;

        const interestOrConds = [
          { parentIds: targetId },
          { userId: targetId }
        ];
        if (typeof userId === 'string') {
          interestOrConds.push({ parentIds: userId });
          interestOrConds.push({ userId: userId });
        }

        // ── Aggregate interest per userId directly (not grouped by parent) ─────
        const interestAgg = await NseEqInterestModel.aggregate([
          {
            $match: {
              date: interestDateFilter,
              $or: interestOrConds
            }
          },
          {
            $group: {
              _id: '$userId',
              totalInterest: { $sum: '$interestAmount' }
            }
          }
        ]);

        // interestAggMap: { userId → totalInterest }
        const interestAggMap = new Map();
        interestAgg.forEach(i => {
          if (i._id) {
            interestAggMap.set(i._id.toString(), i.totalInterest);
            console.log(`[getProfitLossWithLivePrices] Interest for user ${i._id}: ${i.totalInterest}`);
          }
        });

        console.log(`[getProfitLossWithLivePrices] Total users with interest: ${interestAggMap.size}`);

        for (const [, acc] of userMap.entries()) {
          const clientInterest = interestAggMap.get(String(acc.userId)) || 0;

          console.log(`[getProfitLossWithLivePrices] Setting interest for ${acc.accountCode} (${acc.userId}): ${clientInterest}`);
          acc.interestAmount = clientInterest;
          if (clientInterest !== 0) {
            const myShare = Number(acc.myShare) || 0;
            const uplineShare = Number(acc.uplineShare) || 0;
            const downlineShare = Math.max(0, 100 - myShare - uplineShare);
            // Interest is an expense — deduct from m2m & bill, then split net prices
            acc.m2m -= clientInterest;
            acc.selfNetPrice += (clientInterest * myShare) / 100;
            acc.uplineNetPrice += (clientInterest * uplineShare) / 100;
            acc.downlineNetPrice += (clientInterest * downlineShare) / 100;
          }
        }
      } catch (intErr) {
        console.error('[getProfitLossWithLivePrices] NSE-EQ interest error:', intErr.message, intErr.stack);
      }
    }
    */

    for (const [uid, acc] of userMap.entries()) {
      // If level is 6 (broker), adjust values ONCE per user
      if (level === 6) {
        // Calculate selfNetPrice: (totalM2M × myShare%) + myBrokerage
        // console.log("Before any chnage :",acc);
        acc.uplineNetPrice = (Math.abs(acc.uplineNetPrice) + Math.abs(acc.brokerNetPrice));
        // acc.uplineNetPrice = -acc.uplineNetPrice;

        acc.brokerNetPrice = acc.selfNetPrice;
        acc.selfNetPrice = acc.selfNetPrice + acc.selfBrokerage;

        // Calculate uplineNetPrice: bill - selfNetPrice
        // // Remove brokerNetPrice from response (do not send to frontend)
      }
    }

    return {
      data: Array.from(userMap.values()),
      enriched,
      scriptNames: Array.from(usedScriptNames),
      livePriceCount: usedScriptNames.size,
      socketSymbols: [...new Set(socketSymbols)],
    };
  } catch (error) {
    console.error("Error getProfitLossWithLivePrices:", error);
    return { data: [], scriptNames: [], livePriceCount: 0, socketSymbols: [] };
  }
};
exports.getStocksUserScriptWise = async (match, level, applyExtraMatch) => {
  try {
    const pipeline = [
      { $match: match },
      {
        $group: {
          _id: { userId: "$userId", scriptId: "$scriptId" },
          scriptName: { $first: "$scriptName" },
          label: { $first: "$label" },
          marketName: { $first: "$marketName" },
          marketId: { $first: "$marketId" },
          txn: { $push: "$$ROOT" },
          BUY_QTY: {
            $sum: {
              $cond: [{ $eq: ["$transactionType", "BUY"] }, "$quantity", 0],
            },
          },
          SELL_QTY: {
            $sum: {
              $cond: [{ $eq: ["$transactionType", "SELL"] }, "$quantity", 0],
            },
          },
          BUY_LOT: {
            $sum: { $cond: [{ $eq: ["$transactionType", "BUY"] }, "$lot", 0] },
          },
          SELL_LOT: {
            $sum: { $cond: [{ $eq: ["$transactionType", "SELL"] }, "$lot", 0] },
          },
        },
      },
      {
        $addFields: {
          remainingQty: { $subtract: ["$BUY_QTY", "$SELL_QTY"] },
          remainingLot: { $subtract: ["$BUY_LOT", "$SELL_LOT"] },
        },
      },
      {
        $lookup: {
          from: "stocks",
          localField: "scriptName",
          foreignField: "InstrumentIdentifier",
          as: "stockInfo",
        },
      },
      {
        $addFields: {
          qtyDifference: { $abs: "$remainingQty" },
          lotDifference: { $abs: "$remainingLot" },
          orderPrice: {
            $cond: {
              if: { $gte: ["$remainingQty", 0] },
              then: {
                $ifNull: [{ $arrayElemAt: ["$stockInfo.BuyPrice", 0] }, 0],
              },
              else: {
                $ifNull: [{ $arrayElemAt: ["$stockInfo.SellPrice", 0] }, 0],
              },
            },
          },
          transactionType: {
            $cond: {
              if: { $gt: ["$remainingQty", 0] },
              then: "SELL",
              else: "BUY",
            },
          },
        },
      },
      {
        $addFields: {
          txn: {
            $concatArrays: [
              "$txn",
              [
                {
                  $cond: {
                    if: { $ne: ["$remainingQty", 0] },
                    then: {
                      userId: "$_id.userId",
                      scriptId: "$_id.scriptId",
                      transactionType: "$transactionType",
                      quantity: "$qtyDifference",
                      lot: "$lotDifference",
                      label: "$label",
                      marketName: "$marketName",
                      marketId: "$marketId",
                      orderPrice: "$orderPrice",
                      totalOrderPrice: {
                        $multiply: ["$qtyDifference", "$orderPrice"],
                      },
                      netPrice: "$orderPrice",
                      totalNetPrice: {
                        $multiply: ["$qtyDifference", "$orderPrice"],
                      },
                      orderBrokerage: 0,
                      netBrokerage: 0,
                      brokerTotalBrokerage: 0,
                      transactionStatus: "LIVE",
                      type: "LIVE",
                      createdAt: new Date(),
                    },
                    else: null,
                  },
                },
              ],
            ],
          },
        },
      },
      { $unwind: "$txn" },
      {
        $match: {
          txn: { $ne: null }, // Filter out null txn
        },
      },
      {
        $group: {
          _id: { userId: "$txn.userId", scriptId: "$txn.scriptId" },
          label: { $first: "$txn.label" },
          marketName: { $first: "$txn.marketName" },
          marketId: { $first: "$txn.marketId" },
          transactions: { $push: "$txn" },
          buyLot: {
            $sum: {
              $cond: [{ $eq: ["$txn.transactionType", "BUY"] }, "$txn.lot", 0],
            },
          },
          sellLot: {
            $sum: {
              $cond: [{ $eq: ["$txn.transactionType", "SELL"] }, "$txn.lot", 0],
            },
          },
          buyQuantity: {
            $sum: {
              $cond: [
                { $eq: ["$txn.transactionType", "BUY"] },
                "$txn.quantity",
                0,
              ],
            },
          },
          sellQuantity: {
            $sum: {
              $cond: [
                { $eq: ["$txn.transactionType", "SELL"] },
                "$txn.quantity",
                0,
              ],
            },
          },
          buyOrderPrice: {
            $sum: {
              $cond: [
                { $eq: ["$txn.transactionType", "BUY"] },
                "$txn.totalOrderPrice",
                0,
              ],
            },
          },
          sellOrderPrice: {
            $sum: {
              $cond: [
                { $eq: ["$txn.transactionType", "SELL"] },
                "$txn.totalOrderPrice",
                0,
              ],
            },
          },
          buyNetPrice: {
            $sum: {
              $cond: [
                { $eq: ["$txn.transactionType", "BUY"] },
                "$txn.totalNetPrice",
                0,
              ],
            },
          },
          sellNetPrice: {
            $sum: {
              $cond: [
                { $eq: ["$txn.transactionType", "SELL"] },
                "$txn.totalNetPrice",
                0,
              ],
            },
          },
          buyTurnover: {
            $sum: {
              $cond: [
                {
                  $and: [
                    { $eq: ["$txn.transactionType", "BUY"] },
                    { $eq: ["$txn.type", "NRM"] },
                  ],
                },
                "$txn.totalOrderPrice",
                0,
              ],
            },
          },
          sellTurnover: {
            $sum: {
              $cond: [
                {
                  $and: [
                    { $eq: ["$txn.transactionType", "SELL"] },
                    { $eq: ["$txn.type", "NRM"] },
                  ],
                },
                "$txn.totalOrderPrice",
                0,
              ],
            },
          },
          brokerage: { $sum: "$txn.netBrokerage" },
          brokerBrokerage: { $sum: "$txn.brokerTotalBrokerage" },
        },
      },
      {
        $sort: { label: 1 },
      },
      {
        $lookup: {
          from: "users",
          localField: "_id.userId",
          foreignField: "_id",
          pipeline: [
            {
              $project: {
                _id: 0,
                accountName: 1,
                accountCode: 1,
                partnership: 1,
              },
            },
          ],
          as: "userDetails",
        },
      },
      { $addFields: { userDetails: { $arrayElemAt: ["$userDetails", 0] } } },
      {
        $addFields: {
          effectivePartnership: { $ifNull: ["$userDetails.partnership", { $ifNull: ["$partnership", []] }] },
        },
      },
      {
        $addFields: {
          bill: { $subtract: ["$sellNetPrice", "$buyNetPrice"] },
          orderBill: { $subtract: ["$sellOrderPrice", "$buyOrderPrice"] },
          myIndex: { $arrayElemAt: ["$effectivePartnership", level - 1] },
        },
      },
      {
        $project: {
          _id: 0,
          userId: "$_id.userId",
          scriptId: "$_id.scriptId",
          symbol: "$_id.scriptId",
          label: "$label",
          marketName: "$marketName",
          marketId: "$marketId",
          transactions: {
            $map: {
              input: "$transactions",
              as: "transaction",
              in: {
                lot: "$$transaction.lot",
                quantity: "$$transaction.quantity",
                orderPrice: "$$transaction.orderPrice",
                netPrice: "$$transaction.netPrice",
                totalOrderPrice: "$$transaction.totalOrderPrice",
                totalNetPrice: "$$transaction.totalNetPrice",
                transactionType: "$$transaction.transactionType",
                type: "$$transaction.type",
                brokerage: "$$transaction.brokerage",
                brokerBrokerage: "$$transaction.brokerBrokerage",
                netBrokerage: "$$transaction.netBrokerage",
                brokerTotalBrokerage: "$$transaction.brokerTotalBrokerage",
                minPercentageWiseBrokerage:
                  "$$transaction.minPercentageWiseBrokerage",
                minLotWiseBrokerage: "$$transaction.minLotWiseBrokerage",
                brokeragePercentage: "$$transaction.brokeragePercentage",
                brockersBrokerage: "$$transaction.brockersBrokerage",
                marketName: "$$transaction.marketName",
                marketId: "$$transaction.marketId",
                label: "$$transaction.label",
                createdAt: "$$transaction.createdAt",
              },
            },
          },
          total: {
            buyLot: "$buyLot",
            sellLot: "$sellLot",
            buyQuantity: "$buyQuantity",
            sellQuantity: "$sellQuantity",
            buyOrderPrice: "$buyOrderPrice",
            sellOrderPrice: "$sellOrderPrice",
            buyNetPrice: "$buyNetPrice",
            sellNetPrice: "$sellNetPrice",
            buyTurnover: "$buyTurnover",
            sellTurnover: "$sellTurnover",
            brokerage: "$brokerage",
            brokerBrokerage: "$brokerBrokerage",
            myIndex: "$myIndex",
            selfNetPrice: {
              $divide: [{ $multiply: ["$bill", "$myIndex", -1] }, 100],
            },
            selfOrderPrice: {
              $divide: [{ $multiply: ["$orderBill", "$myIndex", -1] }, 100],
            },
            myNetPrice: {
              $divide: [
                {
                  $multiply: [
                    { $add: ["$bill", "$brokerBrokerage"] },
                    "$myIndex",
                    -1,
                  ],
                },
                100,
              ],
            },
          },
          userDetails: 1,
        },
      },
    ];

    const extraMatchCondition = { remainingQty: { $ne: 0 } };

    if (applyExtraMatch == "true") {
      const lookupIndex = pipeline.findIndex((stage) => stage.$lookup);
      if (lookupIndex !== -1) {
        pipeline.splice(lookupIndex, 0, { $match: extraMatchCondition });
      }
    }

    const result = await StockTransaction.aggregate(pipeline);

    // -------------------------------------------------------------------------
    // ENHANCEMENT: Fetch Live Prices and Calculate P&L Distribution (Same as P&L Report)
    // -------------------------------------------------------------------------
    const scriptIds = [
      ...new Set(result.map((r) => r.scriptId).filter(Boolean)),
    ];
    const priceMap = {};

    if (scriptIds.length > 0) {
      const redisPrices = await getMultipleStockData(scriptIds);
      scriptIds.forEach((id, i) => {
        const data = redisPrices[i];
        if (
          data &&
          (data.BuyPrice != null || data.SellPrice != null || data.Ltp != null)
        ) {
          priceMap[id] = data;
        }
      });
    }

    const currencyMap = (await hgetall("currency_rate")) || {};
    const TARGET_CONVERSION_MARKETS = ["7", "8", "9", "11", "14"];

    const enriched = result.map((row) => {
      const live = priceMap[row.scriptId];
      const marketId = String(row.marketId || "");
      const conversionRate = TARGET_CONVERSION_MARKETS.includes(marketId)
        ? Number(
          currencyMap[marketId] ||
          currencyMap[row.marketName] ||
          currencyMap[row.marketName?.toUpperCase()] ||
          currencyMap[row.marketName?.toLowerCase()] ||
          currencyMap["dollar"] ||
          currencyMap["Dollar"] ||
          currencyMap["DOLLAR"] ||
          currencyMap["usd"] ||
          currencyMap["USD"] ||
          1
        )
        : 1;


      const buyQty = Number(row.total.buyQuantity) || 0;
      const sellQty = Number(row.total.sellQuantity) || 0;
      const buyNet = Number(row.total.buyNetPrice) || 0;
      const sellNet = Number(row.total.sellNetPrice) || 0;
      const remainingQty = Number(buyQty - sellQty) || 0;
      const myIndex = Number(row.total.myIndex || row.myIndex) || 0;
      const partnership = row.userDetails?.partnership || [];

      // ─── DIAGNOSTIC LOGS (getUserScriptWise) ──────────────────────────────


      // ──────────────────────────────────────────────────────────────────────

      // 1. Recalculate transactions and summary totals using refreshed prices
      let updatedBuyOrderPrice = 0;
      let updatedSellOrderPrice = 0;
      let updatedBuyNetPrice = 0;
      let updatedSellNetPrice = 0;

      const updatedTxns = row.transactions.map((t) => {
        let currentT = { ...t };
        if (t.type === "LIVE") {
          // Identify valuation price based on transaction side
          // BUY exit trade -> Use BuyPrice (Ask)
          // SELL exit trade -> Use SellPrice (Bid)
          const liveP = currentT.transactionType === "BUY"
            ? (live ? Number(live.BuyPrice ?? live.bid ?? live.Ltp ?? 0) : Number(currentT.orderPrice || 0))
            : (live ? Number(live.SellPrice ?? live.ask ?? live.Ltp ?? 0) : Number(currentT.orderPrice || 0));

          currentT.orderPrice = liveP;
          currentT.totalOrderPrice = liveP * (Number(currentT.quantity) || 0);
          currentT.netPrice = liveP; // For LIVE trades, netPrice is usually the same as orderPrice
          currentT.totalNetPrice = liveP * (Number(currentT.quantity) || 0);
        }

        if (currentT.transactionType === "BUY") {
          updatedBuyOrderPrice += Number(currentT.totalOrderPrice) || 0;
          updatedBuyNetPrice += Number(currentT.totalNetPrice) || 0;
        } else {
          updatedSellOrderPrice += Number(currentT.totalOrderPrice) || 0;
          updatedSellNetPrice += Number(currentT.totalNetPrice) || 0;
        }

        return currentT;
      });

      // 2. Brokerage: Re-calculate from updated transactions
      let calculatedBrokerBrokerage = 0;
      let recalculatedClientBrokerage = 0;
      let myTotalCommission = 0;

      updatedTxns.forEach((t) => {
        const cltNetBrok = Number(t.netBrokerage) || 0;
        let bkrShare = 0;
        if (t.brockersBrokerage && t.brockersBrokerage.length > 0) {
          bkrShare = t.brockersBrokerage.reduce(
            (acc, b) => acc + (Number(b.rate) || 0),
            0,
          );
          const myBkr = t.brockersBrokerage.find(
            (b) => b.brokerId?.toString() === row.userId?.toString(),
          );
          if (myBkr) {
            myTotalCommission += Number(myBkr.rate) || 0;
          }
        } else {
          bkrShare = Number(t.brokerTotalBrokerage) || 0;
          if (level === 6) {
            myTotalCommission += bkrShare;
          }
        }
        calculatedBrokerBrokerage += bkrShare;
        recalculatedClientBrokerage += cltNetBrok;
      });

      const rawBrokerage = recalculatedClientBrokerage;
      const rawCalculatedBrokerBrokerage = calculatedBrokerBrokerage;

      const brokerage = recalculatedClientBrokerage;
      const brokerRatio = Number(partnership[5]) || 0;

      // 3. Final Calculations (House Perspective)
      // Use RAW values for P&L math so it remains in original currency as requested
      const grossProfit = updatedSellOrderPrice - updatedBuyOrderPrice;
      const clientNetPnL = grossProfit - rawBrokerage;
      const houseM2M = clientNetPnL * -1 - rawCalculatedBrokerBrokerage;
      const bill = clientNetPnL;

      // 4. Distribution logic
      let uplineShareIndex = 0;
      for (let i = 0; i < Math.min(level - 1, partnership.length); i++) {
        uplineShareIndex += Number(partnership[i]) || 0;
      }
      const downlineShareIndex = 100 - myIndex - uplineShareIndex;

      const selfNetPrice = (houseM2M * myIndex) / 100;
      const brokerNetPrice = (houseM2M * brokerRatio) / 100;
      const uplineNetPrice = (houseM2M * uplineShareIndex) / 100;
      const downlineNetPrice = (houseM2M * downlineShareIndex) / 100;

      let selfBrokerage = ((rawBrokerage - rawCalculatedBrokerBrokerage) * myIndex) / 100;
      if (level === 6) {
        selfBrokerage = myTotalCommission;
      }

      return {
        ...row,
        transactions: updatedTxns,
        total: {
          ...row.total,
          buyOrderPrice: Number(updatedBuyOrderPrice.toFixed(4)),
          sellOrderPrice: Number(updatedSellOrderPrice.toFixed(4)),
          buyNetPrice: Number(updatedBuyNetPrice.toFixed(4)),
          sellNetPrice: Number(updatedSellNetPrice.toFixed(4)),
          gross: Number(grossProfit.toFixed(4)),
          bill: Number(clientNetPnL.toFixed(4)),
          m2m: Number(houseM2M.toFixed(4)),
          brokerage: Number((rawBrokerage * conversionRate).toFixed(4)),
          brokerBrokerage: Number((rawCalculatedBrokerBrokerage * conversionRate).toFixed(4)),
          selfBrokerage: Number((selfBrokerage * conversionRate).toFixed(4)),
          selfNetPrice: Number(selfNetPrice.toFixed(4)),
          brokerNetPrice: Number(brokerNetPrice.toFixed(4)),
          uplineNetPrice: Number(uplineNetPrice.toFixed(4)),
          downlineNetPrice: Number(downlineNetPrice.toFixed(4)),
          myNetPrice: Number(selfNetPrice.toFixed(4)),
          conversionRate: conversionRate,
        },
      };
    });

    return enriched;
  } catch (err) {
    console.error("Error in fetching grouped data with references:", err);
    throw err;
  }
};
exports.getScriptWiseReport = async (
  match,
  level,
  userId,
  isRequesterDemo = false,
) => {
  try {
    // Defensive check for ObjectId fields in match
    if (match.userId && typeof match.userId === 'string' && !mongoose.Types.ObjectId.isValid(match.userId)) {
      console.warn(`[getScriptWiseReport] Invalid userId in match: ${match.userId}`);
      return [];
    }
    if (match.valanId && typeof match.valanId === 'string' && !mongoose.Types.ObjectId.isValid(match.valanId)) {
      console.warn(`[getScriptWiseReport] Invalid valanId in match: ${match.valanId}`);
      return [];
    }

    const userIdObj = userId ? new mongoose.Types.ObjectId(userId) : null;
    //// console.log(match)
    const result = await StockTransaction.aggregate([
      {
        $match: match,
      },
      {
        $group: {
          _id: { userId: "$userId", scriptId: "$scriptId" },
          scriptName: { $first: "$scriptName" },
          marketId: { $first: "$marketId" },
          marketName: { $first: "$marketName" },
          label: { $first: "$label" },
          transactions: { $push: "$$ROOT" },
          buyLot: {
            $sum: {
              $cond: [{ $eq: ["$transactionType", "BUY"] }, "$lot", 0],
            },
          },
          sellLot: {
            $sum: {
              $cond: [{ $eq: ["$transactionType", "SELL"] }, "$lot", 0],
            },
          },
          buyQuantity: {
            $sum: {
              $cond: [{ $eq: ["$transactionType", "BUY"] }, "$quantity", 0],
            },
          },
          sellQuantity: {
            $sum: {
              $cond: [{ $eq: ["$transactionType", "SELL"] }, "$quantity", 0],
            },
          },
          buyOrderPrice: {
            $sum: {
              $cond: [
                { $eq: ["$transactionType", "BUY"] },
                "$totalOrderPrice",
                0,
              ],
            },
          },
          sellOrderPrice: {
            $sum: {
              $cond: [
                { $eq: ["$transactionType", "SELL"] },
                "$totalOrderPrice",
                0,
              ],
            },
          },
          buyNetPrice: {
            $sum: {
              $cond: [
                { $eq: ["$transactionType", "BUY"] },
                "$totalNetPrice",
                0,
              ],
            },
          },
          sellNetPrice: {
            $sum: {
              $cond: [
                { $eq: ["$transactionType", "SELL"] },
                "$totalNetPrice",
                0,
              ],
            },
          },
          partnership: { $first: "$partnership" },
          brokerage: { $sum: "$netBrokerage" },
          brokerBrokerage: {
            $sum: {
              $let: {
                vars: {
                  newSum: {
                    $reduce: {
                      input: { $ifNull: ["$brockersBrokerage", []] },
                      initialValue: 0,
                      in: { $add: ["$$value", "$$this.rate"] },
                    },
                  },
                },
                in: {
                  $cond: [
                    { $gt: ["$$newSum", 0] },
                    "$$newSum",
                    "$brokerTotalBrokerage",
                  ],
                },
              },
            },
          },
          myBrokerage: {
            $sum: {
              $let: {
                vars: {
                  myBkr: {
                    $filter: {
                      input: { $ifNull: ["$brockersBrokerage", []] },
                      as: "b",
                      cond: {
                        $eq: ["$$b.brokerId", userIdObj],
                      },
                    },
                  },
                },
                in: {
                  $cond: [
                    { $gt: [{ $size: "$$myBkr" }, 0] },
                    { $arrayElemAt: ["$$myBkr.rate", 0] },
                    0,
                  ],
                },
              },
            },
          },
        },
      },
      {
        $sort: {
          "_id.scriptId": 1,
        },
      },
      {
        $lookup: {
          from: "users",
          localField: "_id.userId",
          foreignField: "_id",
          as: "userInfo",
        },
      },
      {
        $addFields: {
          userInfo: { $arrayElemAt: ["$userInfo", 0] },
        },
      },
      {
        $lookup: {
          from: "stocks",
          localField: "scriptName",
          foreignField: "InstrumentIdentifier",
          as: "stockInfo",
        },
      },
      {
        $addFields: {
          remainingQty: { $subtract: ["$buyQuantity", "$sellQuantity"] },
          remainingQtyAbs: {
            $abs: { $subtract: ["$buyQuantity", "$sellQuantity"] },
          },
          remainingLot: { $subtract: ["$buyLot", "$sellLot"] },
          buyNetAveragePrice: {
            $cond: {
              if: { $eq: ["$buyQuantity", 0] },
              then: 0,
              else: { $divide: ["$buyNetPrice", "$buyQuantity"] },
            },
          },
          sellNetAveragePrice: {
            $cond: {
              if: { $eq: ["$sellQuantity", 0] },
              then: 0,
              else: { $divide: ["$sellNetPrice", "$sellQuantity"] },
            },
          },
          effectivePartnership: { $ifNull: ["$userInfo.partnership", { $ifNull: ["$partnership", []] }] },
        },
      },
      {
        $addFields: {
          myShare: { $arrayElemAt: ["$effectivePartnership", level - 1] },
          uplineShare: { $sum: { $slice: ["$effectivePartnership", level - 1] } },
          downlineShare: {
            $subtract: [100, { $sum: { $slice: ["$effectivePartnership", level] } }],
          },
          brokerShareRatio: {
            $cond: [
              { $gte: [{ $size: "$effectivePartnership" }, 6] },
              { $arrayElemAt: ["$effectivePartnership", 5] },
              0,
            ],
          },
          // Correct orderPrice for valuation: Long -> SellPrice(Bid), Short -> BuyPrice(Ask). 0 if closed.
          orderPrice: {
            $cond: [
              { $eq: ["$remainingQty", 0] },
              0,
              {
                $cond: {
                  if: { $gt: ["$remainingQty", 0] },
                  then: {
                    $ifNull: [{ $arrayElemAt: ["$stockInfo.SellPrice", 0] }, 0],
                  },
                  else: {
                    $ifNull: [{ $arrayElemAt: ["$stockInfo.BuyPrice", 0] }, 0],
                  },
                },
              },
            ],
          },
          livePrice: {
            $cond: [
              { $eq: ["$remainingQty", 0] },
              0,
              {
                $cond: {
                  if: { $gt: ["$remainingQty", 0] },
                  then: {
                    $ifNull: [{ $arrayElemAt: ["$stockInfo.SellPrice", 0] }, 0],
                  },
                  else: {
                    $ifNull: [{ $arrayElemAt: ["$stockInfo.BuyPrice", 0] }, 0],
                  },
                },
              },
            ],
          },
        },
      },
      {
        $addFields: {
          // gross: Total Gross Profit (raw execution price profit/loss)
          gross: {
            $add: [
              { $subtract: ["$sellOrderPrice", "$buyOrderPrice"] },
              { $multiply: ["$remainingQty", "$livePrice"] },
            ],
          },
          // m2m: Client Net Profit/Loss (includes client-paid brokerage)
          m2m: {
            $add: [
              { $subtract: ["$sellNetPrice", "$buyNetPrice"] },
              { $multiply: ["$remainingQty", "$livePrice"] },
            ],
          },
          // hierarchyPool: Hierarchy Perspective (opposite of Client, plus house brokerage expenses)
          // Represents the net debt/credit position of the hierarchy relative to this trade.
          hierarchyPool: {
            $subtract: [
              {
                $multiply: [
                  {
                    $add: [
                      { $subtract: ["$sellNetPrice", "$buyNetPrice"] },
                      { $multiply: ["$remainingQty", "$livePrice"] },
                    ],
                  },
                  -1,
                ],
              },
              "$brokerBrokerage",
            ],
          },
        },
      },
      {
        $addFields: {
          // If viewer is level 7 (Client), selfNetPrice is their own m2m.
          // For all other levels (Admin/Master), selfNetPrice is their share of the hierarchyPool.
          selfNetPrice: {
            $cond: [
              { $eq: [level, 7] },
              "$m2m",
              { $divide: [{ $multiply: ["$hierarchyPool", "$myShare"] }, 100] },
            ],
          },
          brokerNetPrice: {
            $divide: [{ $multiply: ["$hierarchyPool", "$brokerShareRatio"] }, 100],
          },
          uplineNetPrice: {
            $divide: [{ $multiply: ["$hierarchyPool", "$uplineShare"] }, 100],
          },
          downlineNetPrice: {
            $divide: [{ $multiply: ["$hierarchyPool", "$downlineShare"] }, 100],
          },
          selfBrokerage: {
            $cond: [
              { $eq: [level, 6] },
              "$myBrokerage",
              {
                $divide: [
                  {
                    $multiply: [
                      { $subtract: ["$brokerage", "$brokerBrokerage"] },
                      "$myShare",
                    ],
                  },
                  100,
                ],
              },
            ],
          },
        },
      },
      {
        $group: {
          _id: "$_id.userId",
          scripts: {
            $push: {
              label: "$label",
              scriptId: "$_id.scriptId",
              scriptName: "$scriptName",
              marketId: "$marketId",
              marketName: "$marketName",
              buyLot: "$buyLot",
              sellLot: "$sellLot",
              remainingLot: "$remainingLot",
              buyQuantity: "$buyQuantity",
              sellQuantity: "$sellQuantity",
              remainingQty: "$remainingQty",
              buyNetAveragePrice: "$buyNetAveragePrice",
              sellNetAveragePrice: "$sellNetAveragePrice",
              m2m: "$m2m",
              gross: "$gross",
              orderPrice: "$orderPrice",
              myShare: "$myShare",
              uplineShare: "$uplineShare",
              downlineShare: "$downlineShare",
              brokerage: "$brokerage",
              brokerBrokerage: "$brokerBrokerage",
              selfBrokerage: "$selfBrokerage",
              selfNetPrice: "$selfNetPrice",
              brokerNetPrice: "$brokerNetPrice",
              uplineNetPrice: "$uplineNetPrice",
              downlineNetPrice: "$downlineNetPrice",
              livePrice: "$livePrice",
            },
          },
        },
      },
      {
        $lookup: {
          from: "users",
          localField: "_id",
          foreignField: "_id",
          pipeline: [
            {
              $project: {
                _id: 1,
                accountName: 1,
                accountCode: 1,
                demoid: 1,
              },
            },
          ],
          as: "userDetails",
        },
      },
      {
        $unwind: {
          path: "$userDetails",
          preserveNullAndEmptyArrays: true,
        },
      },
      {
        $match: isRequesterDemo
          ? {}
          : {
            $or: [
              { "userDetails.demoid": { $ne: true } },
              { userDetails: null },
            ],
          },
      },
      {
        $project: {
          _id: 0,
          scripts: 1,
          userDetails: 1,
        },
      },
      {
        $sort: {
          "userDetails.accountName": 1,
        },
      },
    ]);

    const roundedResult = result.map(u => {
      if (u.scripts && Array.isArray(u.scripts)) {
        u.scripts = u.scripts.map(s => {
          s.buyLot = Number(Number(s.buyLot || 0).toFixed(2));
          s.sellLot = Number(Number(s.sellLot || 0).toFixed(2));
          s.remainingLot = Number(Number(s.remainingLot || 0).toFixed(2));
          s.selfQty = Number(Number(s.selfQty || 0).toFixed(2));
          return s;
        });
      }
      return u;
    });

    return roundedResult;
  } catch (error) {
    console.error("Error creating data:", error);
    throw error;
  }
};
exports.getScriptSummaryReport = async (match, level, userId, isRequesterDemo = false) => {
  try {
    const userIdObj = userId ? new mongoose.Types.ObjectId(userId) : null;
    const intermediateResult = await StockTransaction.aggregate([
      {
        $match: match,
      },
      {
        $lookup: {
          from: "users",
          localField: "userId",
          foreignField: "_id",
          as: "userDetails",
        },
      },
      {
        $unwind: {
          path: "$userDetails",
          preserveNullAndEmptyArrays: true,
        },
      },
      {
        $match: {
          $and: [
            isRequesterDemo
              ? { "userDetails.demoid": true }
              : {
                $or: [
                  { "userDetails.demoid": { $ne: true } },
                  { "userDetails.demoid": { $exists: false } },
                  { userDetails: null },
                ],
              },
            {
              $or: [{ "userDetails.isDeleted": false }, { userDetails: null }],
            },
          ],
        },
      },
      {
        $group: {
          _id: { userId: "$userId", scriptId: "$scriptId" },
          marketId: { $first: "$marketId" },
          marketName: { $first: "$marketName" },
          scriptName: { $first: "$scriptName" },
          scriptId: { $first: "$scriptId" },
          label: { $first: "$label" },
          partnership: { $first: "$partnership" },
          buyLot: { $sum: { $cond: [{ $eq: ["$transactionType", "BUY"] }, "$lot", 0] } },
          sellLot: { $sum: { $cond: [{ $eq: ["$transactionType", "SELL"] }, "$lot", 0] } },
          buyQuantity: { $sum: { $cond: [{ $eq: ["$transactionType", "BUY"] }, "$quantity", 0] } },
          sellQuantity: { $sum: { $cond: [{ $eq: ["$transactionType", "SELL"] }, "$quantity", 0] } },
          buyOrderPrice: { $sum: { $cond: [{ $eq: ["$transactionType", "BUY"] }, "$totalOrderPrice", 0] } },
          sellOrderPrice: { $sum: { $cond: [{ $eq: ["$transactionType", "SELL"] }, "$totalOrderPrice", 0] } },
          buyNetPrice: { $sum: { $cond: [{ $eq: ["$transactionType", "BUY"] }, "$totalNetPrice", 0] } },
          sellNetPrice: { $sum: { $cond: [{ $eq: ["$transactionType", "SELL"] }, "$totalNetPrice", 0] } },
          brokerage: { $sum: "$netBrokerage" },
          brokerBrokerage: {
            $sum: {
              $let: {
                vars: {
                  newSum: {
                    $reduce: {
                      input: { $ifNull: ["$brockersBrokerage", []] },
                      initialValue: 0,
                      in: { $add: ["$$value", "$$this.rate"] },
                    },
                  },
                },
                in: { $cond: [{ $gt: ["$$newSum", 0] }, "$$newSum", "$brokerTotalBrokerage"] },
              },
            },
          },
          myBrokerage: {
            $sum: {
              $let: {
                vars: {
                  myBkr: {
                    $filter: {
                      input: { $ifNull: ["$brockersBrokerage", []] },
                      as: "b",
                      cond: { $eq: ["$$b.brokerId", userIdObj] },
                    },
                  },
                },
                in: { $cond: [{ $gt: [{ $size: "$$myBkr" }, 0] }, { $arrayElemAt: ["$$myBkr.rate", 0] }, 0] },
              },
            },
          },
        },
      },
      {
        $lookup: {
          from: "users",
          localField: "_id.userId",
          foreignField: "_id",
          as: "clientInfo",
        },
      },
      {
        $addFields: {
          clientInfo: { $arrayElemAt: ["$clientInfo", 0] },
        },
      },
      {
        $addFields: {
          remainingQty: { $subtract: ["$buyQuantity", "$sellQuantity"] },
          remainingLot: { $subtract: ["$buyLot", "$sellLot"] },
          brokerPartnershipArray: { $ifNull: ["$clientInfo.basicDetails.brokerPartnership", []] },
        },
      },
      {
        $addFields: {
          localPartnership: { $ifNull: ["$clientInfo.partnership", { $ifNull: ["$partnership", []] }] },
        },
      },
      {
        $addFields: {
          myShare: {
            $cond: [
              { $eq: [level, 6] },
              {
                $let: {
                  vars: {
                    matchBkr: {
                      $filter: {
                        input: "$brokerPartnershipArray",
                        as: "bp",
                        cond: {
                          $or: [
                            { $eq: ["$$bp.broker", userIdObj] },
                            { $eq: ["$$bp.broker._id", userIdObj] },
                            { $eq: [{ $toString: "$$bp.broker" }, { $toString: userIdObj }] },
                            { $eq: [{ $toString: "$$bp.broker._id" }, { $toString: userIdObj }] },
                          ],
                        },
                      },
                    },
                  },
                  in: {
                    $cond: [
                      { $gt: [{ $size: "$$matchBkr" }, 0] },
                      { $arrayElemAt: ["$$matchBkr.partnership", 0] },
                      { $ifNull: [{ $arrayElemAt: ["$localPartnership", 5] }, 0] },
                    ],
                  },
                },
              },
              { $ifNull: [{ $arrayElemAt: ["$localPartnership", level - 1] }, 0] },
            ],
          },
          brokerShareRatio: { $cond: [{ $gte: [{ $size: "$localPartnership" }, 6] }, { $arrayElemAt: ["$localPartnership", 5] }, 0] },
          effectivePartnership: "$localPartnership",
        },
      },
    ]);

    const { getAllStocksHash } = require("./RedisService");
    const allPrices = await getAllStocksHash();

    const scriptMap = {};

    intermediateResult.forEach((r) => {
      // Find the best live price match (using scriptId first, then scriptName)
      const symbolKey = (r.scriptId || "").toUpperCase();
      const nameKey = (r.scriptName || "").toUpperCase();
      const live = allPrices.get(symbolKey) || allPrices.get(nameKey) || allPrices.get(r.scriptId) || allPrices.get(r.scriptName);

      let livePrice = 0;
      if (live) {
        if (r.remainingQty > 0) {
          // LONG position: "if the position holding is buy then add the sell price as live price"
          livePrice = Number(live.SellPrice || live.bid || live.Ltp || 0);
        } else if (r.remainingQty < 0) {
          // SHORT position: "if it is sell position then take the buy price as live prie"
          livePrice = Number(live.BuyPrice || live.ask || live.Ltp || 0);
        }
      }

      const buyAvg = r.buyQuantity > 0 ? r.buyNetPrice / r.buyQuantity : 0;
      const sellAvg = r.sellQuantity > 0 ? r.sellNetPrice / r.sellQuantity : 0;

      // Master View of Script's Total Result (Realized + Unrealized)
      const matchedQty = Math.min(r.buyQuantity, r.sellQuantity);
      const realizedHousePOrL = matchedQty * (buyAvg - sellAvg);

      let unrealizedHousePOrL = 0;
      if (r.remainingQty > 0) {
        unrealizedHousePOrL = r.remainingQty * (buyAvg - livePrice);
      } else if (r.remainingQty < 0) {
        unrealizedHousePOrL = Math.abs(r.remainingQty) * (livePrice - sellAvg);
      }

      const scriptTotalResult = realizedHousePOrL + unrealizedHousePOrL;

      const m2m = scriptTotalResult;
      const gross = m2m;

      const p = r.effectivePartnership || r.clientInfo?.partnership || r.partnership || [];
      const uplineShare = p.slice(0, level - 1).reduce((acc, val) => acc + (Number(val) || 0), 0);
      const myShare = Number(p[level - 1]) || 0;
      const downlineShare = 100 - uplineShare - myShare;
      const brokerShareRatio = p.length >= 6 ? (Number(p[5]) || 0) : 0;

      const uplineNetPrice = (m2m * uplineShare) / 100;
      const downlineNetPrice = (m2m * downlineShare) / 100;
      const brokerNetPrice = (m2m * brokerShareRatio) / 100;
      // selfQty: viewer's proportional share of the net open quantity
      // e.g. myShare = 2.5%, remainingQty = 100  → selfQty = 2.5
      const selfQty = level === 7 ? r.remainingQty : (r.remainingQty * r.myShare) / 100;

      // selfNetPrice: viewer's proportional share of P&L, using the same myShare ratio
      // e.g. myShare = 2.5%, m2m = 10000  → selfNetPrice = 250
      const selfNetPrice = level === 7 ? (-1 * m2m) : (m2m * r.myShare) / 100;

      // Grouping by scriptId for the final report
      if (!scriptMap[r.scriptId]) {
        scriptMap[r.scriptId] = {
          _id: r.scriptId,
          marketName: r.marketName,
          marketId: r.marketId,
          label: r.label,
          scriptName: r.scriptName,
          buyLot: 0,
          sellLot: 0,
          remainingLot: 0,
          buyQuantity: 0,
          sellQuantity: 0,
          remainingQty: 0,
          buyNetPrice: 0,
          sellNetPrice: 0,
          buyOrderPrice: 0,
          sellOrderPrice: 0,
          gross: 0,
          m2m: 0,
          selfQty: 0,
          selfNetPrice: 0,
          uplineNetPrice: 0,
          downlineNetPrice: 0,
          brokerNetPrice: 0,
          brokerage: 0,
          brokerBrokerage: 0,
          selfBrokerage: 0,
          livePrice: livePrice, // Use livePrice from one of the rows (they should be same for same script)
        };
      }

      const s = scriptMap[r.scriptId];
      s.buyLot += r.buyLot;
      s.sellLot += r.sellLot;
      s.remainingLot += r.remainingLot;
      s.buyQuantity += r.buyQuantity;
      s.sellQuantity += r.sellQuantity;
      s.remainingQty += r.remainingQty;
      s.buyNetPrice += r.buyNetPrice;
      s.sellNetPrice += r.sellNetPrice;
      s.buyOrderPrice += r.buyOrderPrice;
      s.sellOrderPrice += r.sellOrderPrice;
      s.gross += gross;
      s.m2m += m2m;
      s.selfQty += selfQty;
      s.selfNetPrice += selfNetPrice;
      s.uplineNetPrice += uplineNetPrice;
      s.downlineNetPrice += downlineNetPrice;
      s.brokerNetPrice += brokerNetPrice;
      s.brokerage += r.brokerage;
      s.brokerBrokerage += r.brokerBrokerage;

      if (level === 6) {
        s.selfBrokerage += r.myBrokerage;
      } else {
        s.selfBrokerage += ((r.brokerage - r.brokerBrokerage) * r.myShare) / 100;
      }
    });

    const finalResult = Object.values(scriptMap).map(s => {
      s.buyNetAveragePrice = s.buyQuantity > 0 ? s.buyNetPrice / s.buyQuantity : 0;
      s.sellNetAveragePrice = s.sellQuantity > 0 ? s.sellNetPrice / s.sellQuantity : 0;

      // Fix floating point precision issues for lots and quantities
      s.buyLot = Number(s.buyLot.toFixed(2));
      s.sellLot = Number(s.sellLot.toFixed(2));
      s.remainingLot = Number(s.remainingLot.toFixed(2));
      s.selfQty = Number(s.selfQty.toFixed(2));

      return s;
    }).sort((a, b) => a._id.localeCompare(b._id));

    return finalResult;
  } catch (error) {
    console.error("Error creating getScriptSummaryReport data:", error);
    throw error;
  }
};
exports.getClientMargin = async (clientIds, marketIds) => {
  try {
    const pipeline = [
      {
        $match: {
          userId: { $in: clientIds },
          transactionStatus: "COMPLETED",
          type: "NRM",
          marketId: { $in: marketIds },
        },
      },
      ...marginPipeline(),
    ];

    const qty = await StockTransaction.aggregate(pipeline);
    return qty;
  } catch (error) {
    console.error("Error processing data:", error);
    throw error;
  }
};

exports.getMarketWiseClientMargin = async (userId, match, project) => {
  try {
    const pipeline = [
      {
        $match: {
          userId: new mongoose.Types.ObjectId(userId),
          ...match,
        },
      },
      ...marginPipeline(project),
    ];

    const margins = await StockTransaction.aggregate(pipeline);
    return margins;
  } catch (error) {
    console.error("Error processing data:", error);
    throw error;
  }
};

exports.getUserPendingQuantity = async (match) => {
  try {
    return await StockTransaction.aggregate([
      { $match: match },
      { $sort: { userId: 1, createdAt: 1 } },
      {
        $group: {
          _id: { userId: "$userId", scriptId: "$scriptId" },
          lastTransaction: { $last: "$$ROOT" },
          BUY_QTY: {
            $sum: {
              $cond: [{ $eq: ["$transactionType", "BUY"] }, "$quantity", 0],
            },
          },
          SELL_QTY: {
            $sum: {
              $cond: [{ $eq: ["$transactionType", "SELL"] }, "$quantity", 0],
            },
          },
          BUY_LOT: {
            $sum: { $cond: [{ $eq: ["$transactionType", "BUY"] }, "$lot", 0] },
          },
          SELL_LOT: {
            $sum: { $cond: [{ $eq: ["$transactionType", "SELL"] }, "$lot", 0] },
          },
        },
      },
    ]);
  } catch (error) {
    console.error("Error processing data:", error);
    throw error;
  }
};

exports.getWeekValan = async () => {
  try {
    return await WeekValanModel.find().sort({ createdAt: -1 }).lean();
  } catch (error) {
    console.error("Error fetching data:", error);
    throw error;
  }
};
exports.calculateSummaryFromScriptWise = (scriptWiseData) => {
  let totalGross = 0;
  let totalBrokerage = 0;
  let buyTurnover = 0;
  let sellTurnover = 0;

  scriptWiseData.forEach((item) => {
    const total = item.total;

    const sell = Number(total.sellNetPrice) || 0;
    const buy = Number(total.buyNetPrice) || 0;

    totalGross += sell - buy;
    totalBrokerage += Number(total.brokerage) || 0;
    buyTurnover += Number(total.buyTurnover) || 0;
    sellTurnover += Number(total.sellTurnover) || 0;
  });

  return {
    totalGross,
    totalBrokerage,
    finalBill: totalGross,
    buyTurnover,
    sellTurnover,
  };
};

// exports.getActiveWeekValan = async () => {
//   try {
//     return await WeekValanModel.findOne({ status: true })
//       .sort({ createdAt: -1 })
//       .lean();
//   } catch (error) {
//     console.error("Error fetching data:", error);
//     throw error;
//   }
// };

exports.getActiveWeekValan = async () => {
  try {
    const valan = await WeekValanModel.findOne({ status: true })
      .sort({ createdAt: -1 })
      .lean();

    // // console.log("valan",valan);

    if (!valan) {
      throw new Error("Active week valan not found");
    }

    return valan;
  } catch (error) {
    console.error("Error fetching active week valan:", error.message);
    throw error;
  }
};

/**
 * Get active week valan without throwing error (for background processes)
 * Returns null if no active valan found
 */
exports.getActiveWeekValanSafe = async () => {
  try {
    const valan = await WeekValanModel.findOne({ status: true })
      .sort({ createdAt: -1 })
      .lean();

    if (!valan) {
      console.warn("⚠️ No active week valan found");
      return null;
    }

    return valan;
  } catch (error) {
    console.error("Error fetching active week valan:", error.message);
    return null;
  }
};

exports.getValanById = async (id) => {
  try {
    return await WeekValanModel.findById(id).lean();
  } catch (error) {
    console.error("Error fetching data:", error);
    throw error;
  }
};

// exports.getLastValan = async () => {
//   try {
//     // Get the current date and calculate the last Monday
//     // If today is Saturday, get this week's Monday; otherwise, get last week's Monday
//     const today = new Date();
//     const day = today.getDay(); // 0 (Sun) to 6 (Sat)
//     const diffToMonday = (day === 0 ? 7 : day) - 1;

//     const monday = new Date(today);
//     if (day === 6) {
//       // Saturday → get this week's Monday
//       monday.setDate(today.getDate() - diffToMonday);
//     } else {
//       // Any other day → get last week's Monday
//       monday.setDate(today.getDate() - diffToMonday - 7);
//     }

//     return await WeekValanModel.findOne({
//       startDate: { $lte: monday },
//       endDate: { $gte: monday }
//     }).lean();
//   } catch (error) {
//     console.error("Error fetching data:", error);
//     throw error;
//   }
// };

exports.updateBillStatusBySegment = async (valanId, segmentId, status) => {
  try {
    const update = await WeekValanModel.updateOne(
      { _id: valanId, "segment._id": segmentId },
      {
        $set: {
          "segment.$[elem].billStatus": status,
        },
      },
      {
        arrayFilters: [
          { "elem._id": segmentId }, // <-- segment ID
        ],
      },
    );

    // update main valan bill status if all segments are billed
    const doc = await WeekValanModel.findOne({ _id: valanId });
    const allSegmentsBilled = doc.segment.every(
      (seg) => seg.billStatus === true,
    );
    if (allSegmentsBilled && doc.billStatus === false) {
      await WeekValanModel.updateOne(
        { _id: valanId },
        { $set: { billStatus: true } },
      );
    }

    return { update, allSegmentsBilled };
  } catch (error) {
    console.error("Error fetching data:", error);
    throw error;
  }
};

const getProfitLossReport = async (match) => {
  try {
    const pipeline = [
      { $match: match },
      {
        $group: {
          _id: { userId: "$userId", scriptId: "$scriptId" },
          parentIds: { $first: "$parentIds" },
          partnership: { $first: "$partnership" },
          brokerIds: { $first: "$brokerIds" },
          scriptName: { $first: "$scriptName" },
          marketId: { $first: "$marketId" },
          marketName: { $first: "$marketName" },
          label: { $first: "$label" },
          buyOrderPrice: {
            $sum: {
              $cond: [
                { $eq: ["$transactionType", "BUY"] },
                "$totalOrderPrice",
                0,
              ],
            },
          },
          sellOrderPrice: {
            $sum: {
              $cond: [
                { $eq: ["$transactionType", "SELL"] },
                "$totalOrderPrice",
                0,
              ],
            },
          },
          buyNetPrice: {
            $sum: {
              $cond: [
                { $eq: ["$transactionType", "BUY"] },
                "$totalNetPrice",
                0,
              ],
            },
          },
          sellNetPrice: {
            $sum: {
              $cond: [
                { $eq: ["$transactionType", "SELL"] },
                "$totalNetPrice",
                0,
              ],
            },
          },
          brokerage: { $sum: "$netBrokerage" },
          buyM2MPrice: {
            $sum: {
              $cond: [{ $eq: ["$transactionType", "BUY"] }, "$m2mPrice", 0],
            },
          },
          sellM2MPrice: {
            $sum: {
              $cond: [{ $eq: ["$transactionType", "SELL"] }, "$m2mPrice", 0],
            },
          },
          brokerBrokerage: { $sum: "$brokerTotalBrokerage" },
          allOtherBrokerage: { $push: "$otherBrokerage" },
        },
      },
      {
        $lookup: {
          from: "users",
          localField: "_id.userId",
          foreignField: "_id",
          pipeline: [
            {
              $lookup: {
                from: "usertypes",
                localField: "accountType",
                foreignField: "_id",
                as: "typeInfo",
              },
            },
            {
              $project: {
                _id: 1,
                accountName: 1,
                accountCode: 1,
                partnership: 1,
                basicDetails: 1,
                level: { $arrayElemAt: ["$typeInfo.level", 0] },
              },
            },
          ],
          as: "userInfo",
        },
      },
      {
        $addFields: {
          userInfo: { $arrayElemAt: ["$userInfo", 0] },
        },
      },
      {
        $addFields: {
          effectivePartnership: { $ifNull: ["$userInfo.partnership", { $ifNull: ["$partnership", []] }] },
        },
      },
      {
        $addFields: {
          bill: { $subtract: ["$sellNetPrice", "$buyNetPrice"] },
          m2m: { $subtract: ["$sellM2MPrice", "$buyM2MPrice"] },
          firstIndex: { $arrayElemAt: ["$effectivePartnership", 0] },
          secondIndex: { $arrayElemAt: ["$effectivePartnership", 1] },
          thirdIndex: { $arrayElemAt: ["$effectivePartnership", 2] },
          fourthIndex: { $arrayElemAt: ["$effectivePartnership", 3] },
          fifthIndex: { $arrayElemAt: ["$effectivePartnership", 4] },
          sixthIndex: { $arrayElemAt: ["$effectivePartnership", 5] },
        },
      },
      {
        $project: {
          _id: 0,
          userId: "$_id.userId",
          scriptId: "$_id.scriptId",
          scriptName: 1,
          marketId: 1,
          marketName: 1,
          label: 1,
          gross: { $subtract: ["$sellOrderPrice", "$buyOrderPrice"] },
          bill: 1,
          m2m: 1,
          level: "$userInfo.level",
          brokerage: "$brokerage",
          brokerBrokerage: "$brokerBrokerage",
          parentIds: 1,
          brokerIds: 1,
          partnership: 1,
          uplineBrokerage: {
            $concatArrays: [
              [
                {
                  $divide: [{ $multiply: ["$brokerage", "$firstIndex"] }, 100],
                },
              ],
              [
                {
                  $divide: [{ $multiply: ["$brokerage", "$secondIndex"] }, 100],
                },
              ],
              [
                {
                  $divide: [{ $multiply: ["$brokerage", "$thirdIndex"] }, 100],
                },
              ],
              [
                {
                  $divide: [{ $multiply: ["$brokerage", "$fourthIndex"] }, 100],
                },
              ],
              [
                {
                  $divide: [{ $multiply: ["$brokerage", "$fifthIndex"] }, 100],
                },
              ],
            ],
          },
          uplineM2M: {
            $concatArrays: [
              [{ $divide: [{ $multiply: ["$m2m", "$firstIndex", -1] }, 100] }],
              [
                {
                  $divide: [{ $multiply: ["$m2m", "$secondIndex", -1] }, 100],
                },
              ],
              [{ $divide: [{ $multiply: ["$m2m", "$thirdIndex", -1] }, 100] }],
              [
                {
                  $divide: [{ $multiply: ["$m2m", "$fourthIndex", -1] }, 100],
                },
              ],
              [{ $divide: [{ $multiply: ["$m2m", "$fifthIndex", -1] }, 100] }],
              [{ $divide: [{ $multiply: ["$m2m", "$sixthIndex", -1] }, 100] }],
            ],
          },
          allOtherBrokerage: 1,
        },
      },
    ];

    const resp = await StockTransaction.aggregate(pipeline);
    return resp;
  } catch (error) {
    console.error("Error creating data:", error);
    throw error;
  }
};
exports.getProfitLossReport = getProfitLossReport;

exports.getUserQuantity = async ({
  userId,
  marketId,
  marketName,
  scriptId,
  scriptName,
  quantity,
  transactionType,
  edited = {},
}) => {
  try {
    // Remove .lean() to get a Mongoose document
    let checkRow = await UserQuantityModel.findOne({
      userId,
      marketId,
      scriptId,
    }).select({
      previous: 1,
      current: 1,
    });

    if (!checkRow) {
      const prev = {
        date: Date.now(),
        buyQty: 0,
        sellQty: 0,
        currentBuyQty: 0,
        currentSellQty: 0,
        isSettled: true,
      };
      const curr = { date: Date.now(), buyQty: 0, sellQty: 0 };

      // Initialize a new document
      checkRow = new UserQuantityModel({
        userId,
        marketId,
        marketName,
        scriptId,
        scriptName,
        previous: prev,
        current: curr,
      });

      // Save the newly created document
      await checkRow.save();
    }

    if (edited?.isEdited && edited?.isEdited == true) {
      const tradeMoment = moment(edited.tradeDate);
      const currentMoment = moment(checkRow.current.date);

      let isSameDayAsCurrent = currentMoment.isSame(tradeMoment, "day");
      if (transactionType === "BUY") {
        if (isSameDayAsCurrent) {
          checkRow.current.buyQty = checkRow.current.buyQty - edited.quantity;
          let offsetPortion = checkRow.previous.currentBuyQty;
          if (offsetPortion > checkRow.current.buyQty) {
            const diff = offsetPortion - checkRow.current.buyQty;
            checkRow.previous.currentBuyQty =
              checkRow.previous.currentBuyQty - diff;
          }
        } else {
          checkRow.previous.buyQty = checkRow.previous.buyQty - edited.quantity;
        }
      }

      if (transactionType === "SELL") {
        if (isSameDayAsCurrent) {
          checkRow.current.sellQty = checkRow.current.sellQty - edited.quantity;
          let offsetPortion = checkRow.previous.currentSellQty;
          if (offsetPortion > checkRow.current.sellQty) {
            const diff = offsetPortion - checkRow.current.sellQty;
            checkRow.previous.currentSellQty =
              checkRow.previous.currentSellQty - diff;
          }
        } else {
          checkRow.previous.sellQty =
            checkRow.previous.sellQty - edited.quantity;
        }
      }
    }

    const today = moment();
    const isSameDay = moment(checkRow.current.date).isSame(today, "day");
    if (!isSameDay) {
      checkRow.previous.buyQty += checkRow.current.buyQty;
      checkRow.previous.sellQty += checkRow.current.sellQty;
      checkRow.previous.isSettled =
        checkRow.previous.buyQty == checkRow.previous.sellQty;
      checkRow.previous.currentBuyQty = 0;
      checkRow.previous.currentSellQty = 0;
      checkRow.previous.date = checkRow.current.date;

      checkRow.current.buyQty = 0;
      checkRow.current.sellQty = 0;
      checkRow.current.date = Date.now();
      await checkRow.save();
    }

    // Destructure previous and current from the document
    let { previous, current } = checkRow;
    let intraday = 0;
    let delivery = 0;
    let isSettled = previous.isSettled;

    if (!isSettled) {
      const prevDiff =
        previous.buyQty -
        previous.sellQty +
        previous.currentBuyQty -
        previous.currentSellQty;
      const absDiff = Math.abs(prevDiff);

      if (prevDiff > 0) {
        if (transactionType === "BUY") {
          intraday = quantity;
        } else {
          const currentDiff = current.buyQty - current.sellQty - quantity;
          const absCurrentDiff = Math.abs(currentDiff);
          if (currentDiff >= 0) {
            intraday = quantity;
            previous.currentSellQty += quantity; // Update currentSellQty
          } else {
            if (absCurrentDiff <= absDiff) {
              isSettled = true;
              delivery = absCurrentDiff;
              intraday = quantity - absCurrentDiff;
              previous.currentSellQty += absCurrentDiff;
              previous.isSettled = true;
            } else {
              isSettled = true;
              delivery = absDiff;
              intraday = quantity - absDiff;
              previous.currentSellQty += absCurrentDiff;
              previous.isSettled = true;
            }
          }
        }
      } else {
        if (transactionType === "SELL") {
          intraday = quantity;
        } else {
          const currentDiff = current.buyQty - current.sellQty + quantity;
          const absCurrentDiff = Math.abs(currentDiff);
          if (currentDiff >= 0) {
            if (absCurrentDiff <= absDiff) {
              isSettled = true;
              delivery = absCurrentDiff;
              intraday = quantity - absCurrentDiff;
              previous.currentBuyQty += absCurrentDiff;
              previous.isSettled = true;
            } else {
              isSettled = true;
              delivery = absDiff;
              intraday = quantity - absDiff;
              previous.currentBuyQty += quantity;
              previous.isSettled = true;
              // Optionally update currentBuyQty here if needed
            }
          } else {
            intraday = quantity;
            previous.currentBuyQty += quantity; // Update currentBuyQty
          }
        }
      }
    } else {
      intraday = quantity;
    }

    // Update the current field based on transactionType
    if (transactionType === "BUY") {
      current.buyQty += quantity;
    } else if (transactionType === "SELL") {
      current.sellQty += quantity;
    }

    return { intraday, delivery, isSettled, previous, current };
  } catch (error) {
    console.error("Error updating user quantity:", error);
    throw error;
  }
};

exports.updateUserQuantity = async (match, body) => {
  try {
    await UserQuantityModel.updateOne(match, body);
  } catch (error) {
    console.error("Error updating user quantity:", error);
    throw error;
  }
};

exports.getLiveStock = async (InstrumentIdentifier) => {
  try {
    const { getSingleStockData } = require("./RedisService");
    const cached = await getSingleStockData(InstrumentIdentifier);
    if (cached) {
      try {
        return JSON.parse(cached);
      } catch (e) {
        // ignore parse error and fall back
      }
    }
    return await StockModel.findOne({ InstrumentIdentifier }).lean();
  } catch (error) {
    console.error("Error fetching live stock:", error);
    throw error;
  }
};

exports.getMultipleLiveStock = async (match) => {
  try {
    const { getMultipleStockData } = require("./RedisService");
    if (
      match.InstrumentIdentifier &&
      Array.isArray(match.InstrumentIdentifier.$in)
    ) {
      const redisKeys = match.InstrumentIdentifier.$in;
      const cached = await getMultipleStockData(redisKeys);
      // Filter out nulls and normalize
      const results = cached.filter((c) => c !== null);
      if (results.length === redisKeys.length) return results;

      // If some missing, fallback to DB but merge results
      const dbResults = await StockModel.find({ ...match }).lean();
      const merged = [...results];
      const seenIds = new Set(results.map((r) => r.InstrumentIdentifier));
      dbResults.forEach((d) => {
        if (!seenIds.has(d.InstrumentIdentifier)) merged.push(d);
      });
      return merged;
    }
    return await StockModel.find({ ...match }).lean();
  } catch (error) {
    console.error("Error fetching multiple live stocks:", error);
    throw error;
  }
};

exports.setUserPosition = async (uId, scriptId, valanId, flag) => {
  try {
    const userId = new mongoose.Types.ObjectId(uId);
    const vId = new mongoose.Types.ObjectId(valanId);

    // ALWAYS recalculate position from transactions - never skip
    const response = await StockTransaction.aggregate([
      {
        $match: {
          userId,
          valanId: vId,
          transactionStatus: "COMPLETED",
          scriptId: scriptId
        },
      },
      {
        $sort: { createdAt: 1 },
      },
      {
        $group: {
          _id: null,
          marketId: { $first: "$marketId" },
          marketName: { $first: "$marketName" },
          scriptId: { $first: "$scriptId" },
          scriptName: { $first: "$scriptName" },
          label: { $first: "$label" },
          expiry: { $first: "$expiry" },
          parentIds: { $first: "$parentIds" },
          buyQuantity: {
            $sum: {
              $cond: [{ $eq: ["$transactionType", "BUY"] }, "$quantity", 0],
            },
          },
          sellQuantity: {
            $sum: {
              $cond: [{ $eq: ["$transactionType", "SELL"] }, "$quantity", 0],
            },
          },
          buyLot: {
            $sum: { $cond: [{ $eq: ["$transactionType", "BUY"] }, "$lot", 0] },
          },
          sellLot: {
            $sum: { $cond: [{ $eq: ["$transactionType", "SELL"] }, "$lot", 0] },
          },
          buyPrice: {
            $sum: {
              $cond: [{ $eq: ["$transactionType", "BUY"] }, "$m2mPrice", 0],
            },
          },
          sellPrice: {
            $sum: {
              $cond: [{ $eq: ["$transactionType", "SELL"] }, "$m2mPrice", 0],
            },
          },
        },
      },
    ]);

    if (response.length > 0) {
      const item = { ...response[0] };
      delete item._id;

      item.userId = userId;
      item.valanId = vId;
      item.isSquaredOff = (item.buyQuantity === item.sellQuantity);

      // ALWAYS upsert the position - even if squared off (for reporting/history)
      await UserPosition.updateOne(
        { userId, scriptId, valanId: vId },
        { $set: { ...item } },
        { upsert: true },
      );
    } else {
      // No completed transactions - delete the position if it exists
      await UserPosition.deleteOne({ userId, scriptId, valanId: vId });
    }

    // Invalidate M2M Redis caches after position update
    try {
      await del(`m2m:${userId}:${valanId}:NSE_MCX_NOPT`);
      await del(`m2m:${userId}:${valanId}:FOREX_COMEX`);
      await del(`m2m_alert_state:${userId}:NSE_MCX_NOPT`);
      await del(`m2m_breach_state:${userId}:NSE_MCX_NOPT`);
      await del(`m2m_alert_state:${userId}:FOREX_COMEX`);
      await del(`m2m_breach_state:${userId}:FOREX_COMEX`);
    } catch (redisErr) {
      console.error("Error invalidating M2M cache in setUserPosition:", redisErr);
    }
  } catch (error) {
    console.error("Error in setUserPosition:", error);
    throw error;
  }
};

exports.getUserPosition = async (match) => {
  try {
    return await UserPosition.find({ ...match }).lean();
  } catch (error) {
    console.error("Error fetching data:", error);
    throw error;
  }
};

exports.getFilterStockTransaction = async (match, project, order) => {
  try {
    return await StockTransaction.findOne({ ...match })
      .select({ ...project })
      .sort({ ...order })
      .lean();
  } catch (error) {
    console.error("Error fetching data:", error);
    throw error;
  }
};

/**
 * Get active users (have at least one transaction for this Valan) for a given account type level.
 */

async function getActiveUserIdsForValan(valanId) {
  const valanObjId = new mongoose.Types.ObjectId(valanId);
  const [tradedUserIds, positionRows] = await Promise.all([
    StockTransaction.distinct("userId", { valanId: valanObjId }),
    UserPosition.aggregate([
      { $match: { $expr: { $ne: ["$buyQuantity", "$sellQuantity"] } } },
      { $group: { _id: "$userId" } },
      { $project: { _id: 1 } },
    ]),
  ]);
  const positionUserIds = positionRows.map((r) => r._id);
  const descendantIdStrs = [
    ...new Set([...tradedUserIds.map(String), ...positionUserIds.map(String)]),
  ];
  const parentIdSet = new Set(descendantIdStrs);
  if (descendantIdStrs.length === 0) return [];
  const descendantIdObjs = descendantIdStrs.map(
    (s) => new mongoose.Types.ObjectId(s),
  );
  const usersWithParents = await userModel
    .find({ _id: { $in: descendantIdObjs } })
    .select("parentIds")
    .lean();
  usersWithParents.forEach((u) => {
    (u.parentIds || []).forEach((pid) => parentIdSet.add(pid.toString()));
  });
  return Array.from(parentIdSet).map((s) => new mongoose.Types.ObjectId(s));
}
async function activeUsersByLevel(
  valanId,
  level,
  activeUserIdsFromDescendants,
  isRequesterDemo = false
) {
  const getLevel = await userTypeModel.findOne({ level }).lean();
  if (!getLevel) return [];
  const orConditions = [
    { $expr: { $gt: [{ $size: "$transactions" }, 0] } },
    {
      $and: [
        { $expr: { $eq: [{ $size: "$transactions" }, 0] } },
        { status: true },
      ],
    },
  ];
  if (activeUserIdsFromDescendants && activeUserIdsFromDescendants.length > 0) {
    orConditions.push({ _id: { $in: activeUserIdsFromDescendants } });
  }
  const users = await userModel.aggregate([
    {
      $match: {
        accountType: getLevel._id,
        ...(isRequesterDemo ? {} : { $or: [{ demoid: { $ne: true } }, { demoid: { $exists: false } }] }),
      },
    },
    {
      $lookup: {
        from: "stocktransactions",
        let: { userId: "$_id" },
        pipeline: [
          {
            $match: {
              $expr: {
                $and: [
                  { $eq: ["$userId", "$$userId"] },
                  { $eq: ["$valanId", new mongoose.Types.ObjectId(valanId)] },
                ],
              },
            },
          },
          { $limit: 1 },
        ],
        as: "transactions",
      },
    },
    {
      $match: {
        $or: orConditions,
      },
    },
    {
      $lookup: {
        from: "usertypes",
        localField: "accountType",
        foreignField: "_id",
        as: "accountTypeDoc",
      },
    },
    {
      $unwind: { path: "$accountTypeDoc", preserveNullAndEmptyArrays: true },
    },
    {
      $project: {
        _id: 1,
        accountCode: 1,
        accountName: 1,
        demoid: 1,
        status: {
          $cond: [
            {
              $and: [
                { $eq: [{ $size: "$transactions" }, 0] },
                { $ne: ["$status", true] },
              ],
            },
            true,
            "$status",
          ],
        },
        accountTypeLabel: { $ifNull: ["$accountTypeDoc.label", ""] },
      },
    },
  ]);
  return users;
}

/**
 * Get no-active users (no transactions for this Valan) for a given account type level.
 */
async function noActiveUsersByLevel(
  valanId,
  level,
  activeUserIdsFromDescendants,
  isRequesterDemo = false
) {
  const getLevel = await userTypeModel.findOne({ level }).lean();
  if (!getLevel) return [];
  const matchStage = {
    $expr: { $eq: [{ $size: "$transactions" }, 0] },
  };
  const baseStages = [
    {
      $match: {
        accountType: getLevel._id,
        ...(isRequesterDemo ? {} : { $or: [{ demoid: { $ne: true } }, { demoid: { $exists: false } }] }),
      },
    },
    {
      $lookup: {
        from: "stocktransactions",
        let: { userId: "$_id" },
        pipeline: [
          {
            $match: {
              $expr: {
                $and: [
                  { $eq: ["$userId", "$$userId"] },
                  { $eq: ["$valanId", new mongoose.Types.ObjectId(valanId)] },
                ],
              },
            },
          },
          { $limit: 1 },
        ],
        as: "transactions",
      },
    },
    { $match: matchStage },
    { $match: { status: { $ne: true } } },
  ];
  if (activeUserIdsFromDescendants && activeUserIdsFromDescendants.length > 0) {
    baseStages.push({
      $match: { _id: { $nin: activeUserIdsFromDescendants } },
    });
  }
  const users = await userModel.aggregate([
    ...baseStages,
    {
      $lookup: {
        from: "usertypes",
        localField: "accountType",
        foreignField: "_id",
        as: "accountTypeDoc",
      },
    },
    {
      $unwind: { path: "$accountTypeDoc", preserveNullAndEmptyArrays: true },
    },
    {
      $project: {
        _id: 1,
        accountCode: 1,
        accountName: 1,
        demoid: 1,
        status: 1,
        accountTypeLabel: { $ifNull: ["$accountTypeDoc.label", ""] },
      },
    },
  ]);
  return users;
}

/**
 * No-active users report: clients (level 7), admin-to-master (level 2–5; super admin level 1 excluded), brokers (level 6).
 * Returns { clients, masters, brokers } each with accountName, accountCode, accountTypeLabel.
 */
exports.noActiveUsers = async (valanId, isRequesterDemo = false) => {
  try {
    const activeIds = await getActiveUserIdsForValan(valanId);
    const clientsPromise = noActiveUsersByLevel(valanId, 7, activeIds, isRequesterDemo);
    const brokersPromise = noActiveUsersByLevel(valanId, 6, activeIds, isRequesterDemo);
    const mastersPromise = Promise.all(
      [2, 3, 4, 5].map((level) =>
        noActiveUsersByLevel(valanId, level, activeIds, isRequesterDemo),
      ),
    ).then((arrays) => arrays.flat());

    const [clients, masters, brokers] = await Promise.all([
      clientsPromise,
      mastersPromise,
      brokersPromise,
    ]);
    return { clients, masters, brokers };
  } catch (error) {
    console.error("Error in noActiveUsers:", error);
    throw error;
  }
};

/**
 * Active users report (have at least one transaction for this Valan).
 * Same shape as noActiveUsers: { clients, masters, brokers }. Super admin (level 1) excluded.
 */
exports.activeUsers = async (valanId, isRequesterDemo = false) => {
  try {
    const activeIds = await getActiveUserIdsForValan(valanId);
    const clientsPromise = activeUsersByLevel(valanId, 7, activeIds, isRequesterDemo);
    const brokersPromise = activeUsersByLevel(valanId, 6, activeIds, isRequesterDemo);
    const mastersPromise = Promise.all(
      [2, 3, 4, 5].map((level) =>
        activeUsersByLevel(valanId, level, activeIds, isRequesterDemo),
      ),
    ).then((arrays) => arrays.flat());

    const [clients, masters, brokers] = await Promise.all([
      clientsPromise,
      mastersPromise,
      brokersPromise,
    ]);
    return { clients, masters, brokers };
  } catch (error) {
    console.error("Error in activeUsers:", error);
    throw error;
  }
};

/**
 * Deactivate users (client/admin/master/broker, excluding super admin level 1) who have done no trades in the last 15 days
 * and have no open position. 15-day period is from activation: users activated within last
 * 15 days are not deactivated. Used by nightly cron at 12 AM.
 */
exports.deactivateNoActivityUsers = async () => {
  try {
    const levels = await userTypeModel
      .find({ level: { $in: [2, 3, 4, 5, 6, 7] } })
      .select("_id")
      .lean();
    const levelIds = levels.map((l) => l._id);
    const cutoff = moment().subtract(15, "days").toDate();

    const activeUsersList = await userModel
      .find({
        accountType: { $in: levelIds },
        status: true,
        deletedAt: null,
        $or: [{ demoid: { $ne: true } }, { demoid: { $exists: false } }],
      })
      .select("_id activatedAt")
      .lean();
    const activeUserIds = activeUsersList
      .filter(
        (u) => !u.activatedAt || (u.activatedAt && u.activatedAt < cutoff),
      )
      .map((u) => u._id);
    if (activeUserIds.length === 0) return { deactivated: 0 };

    const [tradedUserIds, positionUserIds] = await Promise.all([
      StockTransaction.distinct("userId", {
        userId: { $in: activeUserIds },
        createdAt: { $gte: cutoff },
      }),
      UserPosition.aggregate([
        { $match: { userId: { $in: activeUserIds } } },
        { $match: { $expr: { $ne: ["$buyQuantity", "$sellQuantity"] } } },
        { $group: { _id: "$userId" } },
        { $project: { _id: 1 } },
      ]).then((rows) => rows.map((r) => r._id)),
    ]);

    const tradedSet = new Set(tradedUserIds.map((id) => id.toString()));
    const positionSet = new Set(positionUserIds.map((id) => id.toString()));
    const toDeactivate = activeUserIds.filter(
      (id) => !tradedSet.has(id.toString()) && !positionSet.has(id.toString()),
    );
    if (toDeactivate.length === 0) return { deactivated: 0 };

    await userModel.updateMany(
      { _id: { $in: toDeactivate } },
      { status: false, activatedAt: null },
    );
    return { deactivated: toDeactivate.length };
  } catch (error) {
    console.error("Error in deactivateNoActivityUsers:", error);
    throw error;
  }
};

/**
 * Deactivate all users that appear in the No Active User report for a valan (block their accounts).
 * Call when loading No Active User list so all listed users are deactivated.
 */
exports.deactivateAllNoActiveUsers = async (valanId) => {
  try {
    const data = await exports.noActiveUsers(valanId);
    const clients = data.clients || [];
    const masters = data.masters || [];
    const brokers = data.brokers || [];
    const allIds = [...clients, ...masters, ...brokers]
      .map((u) => u._id)
      .filter(Boolean);
    if (allIds.length === 0) return { deactivated: 0 };
    await userModel.updateMany(
      { _id: { $in: allIds } },
      { status: false, activatedAt: null },
    );
    return { deactivated: allIds.length };
  } catch (error) {
    console.error("Error in deactivateAllNoActiveUsers:", error);
    throw error;
  }
};

exports.updateTransaction = async (id, stockDetails) => {
  try {
    return await StockTransaction.updateOne({ _id: id }, { ...stockDetails });
  } catch (error) {
    console.error("Error updating data:", error);
    throw error;
  }
};

exports.deleteTradeRecord = async ({
  tradeId,
  userId,
  marketId,
  scriptId,
  valanId,
  quantity,
  transactionType,
  createdAt,
  deletedBy,
  deletedPrice,
}) => {
  try {
    // 1. Hard delete the transaction record
    await StockTransaction.deleteOne({ _id: tradeId });

    // 2. Update user position (re-calculates based on remaining transactions)
    await exports.setUserPosition(userId, scriptId, valanId, false);

    // 3. Update user quantity tracker
    await exports.setUserQuantity({
      userId,
      marketId,
      scriptId,
      quantity,
      transactionType,
      createdAt,
    });
    return true;
  } catch (error) {
    console.error("Error in deleteTradeRecord service:", error);
    throw error;
  }
};

exports.setUserQuantity = async ({
  userId,
  marketId,
  scriptId,
  quantity,
  transactionType,
  createdAt,
}) => {
  try {
    const doc = await UserQuantityModel.findOne({ userId, marketId, scriptId });
    if (!doc) return;

    const { previous, current } = doc;
    const tradeMoment = moment(createdAt);
    const isSameDayAsCurrent = moment(current.date).isSame(tradeMoment, "day");

    // Determine field names dynamically
    const buyField = transactionType === "BUY" ? "buyQty" : "sellQty";
    const currentBuyField =
      transactionType === "BUY" ? "currentBuyQty" : "currentSellQty";

    if (isSameDayAsCurrent) {
      let offsetPortion = previous[currentBuyField];
      let updatedQty = current[buyField] - quantity;

      current[buyField] = updatedQty;
      if (offsetPortion > updatedQty) {
        previous[currentBuyField] = updatedQty;
      }
    } else {
      previous[buyField] -= quantity;
    }

    // Calculate leftover difference
    let leftoverDiff =
      previous.buyQty +
      previous.currentBuyQty -
      (previous.sellQty + previous.currentSellQty);

    previous.isSettled = leftoverDiff === 0;

    await doc.save();
  } catch (error) {
    console.error("Error deleting trade:", error);
    throw error;
  }
};

exports.getShortTrades = async (match, timeRange) => {
  try {
    const pipeline = [
      {
        $match: {
          ...match,
          transactionStatus: "COMPLETED",
        },
      },
      {
        $project: {
          userId: 1,
          createdAt: 1,
          transactionType: 1,
          quantity: 1,
          lot: 1,
          m2mPrice: 1,
          netPrice: 1,
          scriptId: 1,
          ip: 1,
          transactionStatus: 1,
          orderType: 1,
          createdBy: 1,
          label: 1,
        },
      },
      { $sort: { userId: 1, scriptId: 1, createdAt: 1 } },

      // SIMPLIFIED: Keep original window logic, handle consumption in JS only
      {
        $setWindowFields: {
          partitionBy: { userId: "$userId", scriptId: "$scriptId" },
          sortBy: { createdAt: 1 },
          output: {
            windowBuyQty: {
              $sum: {
                $cond: [{ $eq: ["$transactionType", "BUY"] }, "$quantity", 0],
              },
              window: { range: [0, timeRange], unit: "millisecond" },
            },
            windowSellQty: {
              $sum: {
                $cond: [{ $eq: ["$transactionType", "SELL"] }, "$quantity", 0],
              },
              window: { range: [0, timeRange], unit: "millisecond" },
            },
            windowBuyM2m: {
              $sum: {
                $cond: [{ $eq: ["$transactionType", "BUY"] }, "$m2mPrice", 0],
              },
              window: { range: [0, timeRange], unit: "millisecond" },
            },
            windowSellM2m: {
              $sum: {
                $cond: [{ $eq: ["$transactionType", "SELL"] }, "$m2mPrice", 0],
              },
              window: { range: [0, timeRange], unit: "millisecond" },
            },
          },
        },
      },

      {
        $match: {
          $expr: {
            $and: [
              { $gt: ["$windowBuyQty", 0] },
              { $gt: ["$windowSellQty", 0] },
            ],
          },
        },
      },

      {
        $addFields: {
          matchedQty: { $min: ["$windowBuyQty", "$windowSellQty"] },
          avgBuyPrice: { $divide: ["$windowBuyM2m", "$windowBuyQty"] },
          avgSellPrice: { $divide: ["$windowSellM2m", "$windowSellQty"] },
        },
      },

      {
        $addFields: {
          profit: {
            $multiply: [
              { $subtract: ["$avgSellPrice", "$avgBuyPrice"] },
              "$matchedQty",
            ],
          },
        },
      },

      { $match: { profit: { $gt: 0 } } },

      {
        $addFields: {
          windowStart: "$createdAt",
          windowEnd: { $add: ["$createdAt", timeRange] },
        },
      },

      {
        $lookup: {
          from: "stocktransactions",
          let: {
            user: "$userId",
            script: "$scriptId",
            start: "$windowStart",
            end: "$windowEnd",
          },
          pipeline: [
            {
              $match: {
                $expr: {
                  $and: [
                    { $eq: ["$userId", "$$user"] },
                    { $eq: ["$scriptId", "$$script"] },
                    { $gte: ["$createdAt", "$$start"] },
                    { $lt: ["$createdAt", "$$end"] },
                  ],
                },
                transactionStatus: "COMPLETED",
              },
            },
            { $sort: { createdAt: 1 } },
            {
              $project: {
                userId: 1,
                scriptId: 1,
                quantity: 1,
                lot: 1,
                orderPrice: 1,
                netPrice: 1,
                createdAt: 1,
                transactionType: 1,
                m2mPrice: 1,
                label: 1,
                ip: 1,
                transactionStatus: 1,
                orderType: 1,
                createdBy: 1,
              },
            },
          ],
          as: "windowDocs",
        },
      },

      {
        $project: {
          _id: 1,
          userId: 1,
          scriptId: 1,
          createdAt: 1,
          windowStart: 1,
          windowEnd: 1,
          windowBuyQty: 1,
          windowSellQty: 1,
          windowBuyM2m: 1,
          windowSellM2m: 1,
          profit: 1,
          windowDocs: 1,
        },
      },
    ];

    const response = await StockTransaction.aggregate(pipeline);

    const userIds = response.map((r) => r.userId);
    const users = await userModel
      .find({ _id: { $in: userIds } })
      .select({ accountName: 1, accountCode: 1 })
      .lean();

    const usersMap = new Map(
      users.map((u) => [
        u._id.toString(),
        { accountName: u.accountName, accountCode: u.accountCode },
      ]),
    );

    // ✅ FIXED: Sequential consumption tracking across ALL windows per partition
    const partitionConsumed = new Map(); // `${userId}_${scriptId}` -> {buyConsumed: 0, sellConsumed: 0}

    const finalResults = [];

    for (const dt of response.sort((a, b) => a.createdAt - b.createdAt)) {
      // Process chronologically
      const partitionKey = `${dt.userId}_${dt.scriptId}`;
      let consumed = partitionConsumed.get(partitionKey);
      if (!consumed) {
        consumed = { buyConsumed: 0, sellConsumed: 0 };
        partitionConsumed.set(partitionKey, consumed);
      }

      const docs = (dt.windowDocs || []).sort(
        (a, b) => a.createdAt - b.createdAt,
      );

      // Find FIRST unmatched pair in this window with remaining qty
      let firstTrade = null;
      let secondTrade = null;
      let matchedQty = 0;

      tradesLoop: for (let i = 0; i < docs.length; i++) {
        const curr = docs[i];
        const currType = curr.transactionType;
        const currAvailable =
          curr.quantity -
          (currType === "BUY" ? consumed.buyConsumed : consumed.sellConsumed);

        if (currAvailable <= 0) continue;

        for (let j = i + 1; j < docs.length; j++) {
          const opp = docs[j];
          if (opp.transactionType === currType) continue;

          const oppAvailable =
            opp.quantity -
            (opp.transactionType === "BUY"
              ? consumed.buyConsumed
              : consumed.sellConsumed);
          if (oppAvailable <= 0) continue;

          const potentialMatch = Math.min(currAvailable, oppAvailable);

          // Profit check with actual prices
          const isBuyFirst = currType === "BUY";
          const buyPrice = isBuyFirst ? curr.netPrice : opp.netPrice;
          const sellPrice = isBuyFirst ? opp.netPrice : curr.netPrice;

          if (sellPrice > buyPrice) {
            firstTrade = curr;
            secondTrade = opp;
            matchedQty = potentialMatch;

            // CONSUME quantities for future windows
            if (isBuyFirst) {
              consumed.buyConsumed += potentialMatch;
              consumed.sellConsumed += potentialMatch;
            } else {
              consumed.sellConsumed += potentialMatch;
              consumed.buyConsumed += potentialMatch;
            }

            break tradesLoop;
          }
        }
      }

      if (firstTrade && secondTrade && matchedQty > 0) {
        const userInfo = usersMap.get(dt.userId.toString());
        const tradeType =
          firstTrade.transactionType === "BUY" ? "Long" : "Short";

        finalResults.push({
          ...dt,
          index: finalResults.length + 1,
          user: userInfo,
          tradeType,
          entryPrice: firstTrade.netPrice,
          firstTrade,
          secondTrade,
          matchedQty, // Use actual matched qty
        });
      }
    }

    return finalResults;
  } catch (error) {
    console.error("Error fetching short trades:", error);
    throw error;
  }
};

exports.getLineTrades = async (
  match,
  timeRange,
  buyRateFrom,
  buyRateTo,
  sellRateFrom,
  sellRateTo,
) => {
  try {
    // 1️⃣ Fetch raw trades
    const trades = await StockTransaction.find(match)
      .sort({ userId: 1, scriptId: 1, createdAt: 1 })
      .lean();

    // 2️⃣ Group by user + script
    const grouped = new Map();

    for (const t of trades) {
      const key = `${t.userId}_${t.scriptId}`;
      if (!grouped.has(key)) grouped.set(key, []);
      grouped.get(key).push(t);
    }

    const results = [];

    const inRange = (val, from, to) => {
      const v = Number(val);
      if (Number.isNaN(v)) return false;
      const f = from != null && from !== "" ? Number(from) : null;
      const t = to != null && to !== "" ? Number(to) : null;
      if (f != null && !Number.isNaN(f) && v < f) return false;
      if (t != null && !Number.isNaN(t) && v > t) return false;
      return true;
    };

    // 3️⃣ Pair BUY–SELL within time window
    for (const [, txns] of grouped.entries()) {
      for (let i = 0; i < txns.length; i++) {
        for (let j = i + 1; j < txns.length; j++) {
          const first = txns[i];
          const second = txns[j];

          // Must be BUY–SELL or SELL–BUY
          if (first.transactionType === second.transactionType) continue;

          // Must be within minute window (diff in ms)
          const diff = Math.abs(
            new Date(second.createdAt).getTime() -
            new Date(first.createdAt).getTime(),
          );
          if (diff > timeRange) continue;

          // Buy rate filter: BUY leg netPrice in buyRateFrom–buyRateTo; SELL leg in sellRateFrom–sellRateTo
          const buyPrice =
            first.transactionType === "BUY" ? first.netPrice : second.netPrice;
          const sellPrice =
            first.transactionType === "SELL" ? first.netPrice : second.netPrice;
          if (!inRange(buyPrice, buyRateFrom, buyRateTo)) continue;
          if (!inRange(sellPrice, sellRateFrom, sellRateTo)) continue;

          // Valid logical pair found
          results.push({
            userId: first.userId,
            scriptId: first.scriptId,
            marketId: first.marketId,
            firstTrade: first,
            secondTrade: second,
          });

          // ⛔ Stop after first valid pair for this window
          break;
        }
      }
    }

    // 4️⃣ Attach user info
    const userIds = [...new Set(results.map((r) => r.userId.toString()))];

    const users = await userModel
      .find({ _id: { $in: userIds } })
      .select({ accountName: 1, accountCode: 1 })
      .lean();

    const userMap = new Map(
      users.map((u) => [
        u._id.toString(),
        { accountName: u.accountName, accountCode: u.accountCode },
      ]),
    );

    // 5️⃣ Final shaping
    return results.map((row, index) => {
      const first = row.firstTrade;
      const second = row.secondTrade;

      const tradeType = first.transactionType === "BUY" ? "Long" : "Short";

      const qty = Math.min(first.quantity, second.quantity);

      const profit =
        tradeType === "Long"
          ? (second.netPrice - first.netPrice) * qty
          : (first.netPrice - second.netPrice) * qty;

      return {
        index: index + 1,
        user: userMap.get(row.userId.toString()),
        marketId: row.marketId,
        scriptId: row.scriptId,
        tradeType,
        firstTrade: first,
        secondTrade: second,
        profit,
      };
    });
  } catch (error) {
    console.error("Error in getLineTrades:", error);
    throw error;
  }
};

exports.getCurrentDateRange = (inputDate = new Date()) => {
  const m = moment(inputDate);
  const startOfDay = m.clone().startOf("day").toDate();
  const endOfDay = m.clone().endOf("day").toDate();
  return { startOfDay, endOfDay };
};
/**
 * Save a deleted line trade to history (so it shows in line trade table after refresh).
 * Payload: reportContextKey, userId, firstTradeId, secondTradeId, label, rate, buy, profit, accountName, accountCode.
 */

/**
 * Save a deleted line trade to history (so it shows in line trade table after refresh).
 * Payload: reportContextKey, userId, firstTradeId, secondTradeId, label, rate, buy, profit, accountName, accountCode.
 */
const toObjectIdSafe = (v, fieldName) => {
  if (v == null || (typeof v === "string" && v.trim() === "")) {
    throw new Error(`${fieldName || "id"} is required`);
  }
  const s = String(v).trim();
  if (!mongoose.Types.ObjectId.isValid(s)) {
    throw new Error(`Invalid ObjectId for ${fieldName || "id"}: ${s}`);
  }
  return new mongoose.Types.ObjectId(s);
};

exports.saveDeletedLineTrade = async (payload) => {
  try {
    const {
      reportContextKey,
      userId,
      firstTradeId,
      secondTradeId,
      label,
      rate,
      buy,
      profit,
      accountName,
      accountCode,
      buyRateFrom,
      buyRateTo,
      sellRateFrom,
      sellRateTo,
      minute,
      firstOrderPrice,
      firstQty,
      firstCreatedAt,
      firstType,
      secondOrderPrice,
      secondQty,
      secondCreatedAt,
      secondType,
    } = payload || {};
    if (
      !reportContextKey ||
      typeof reportContextKey !== "string" ||
      reportContextKey.trim() === ""
    ) {
      throw new Error(
        "reportContextKey, userId, firstTradeId, secondTradeId are required",
      );
    }
    const uid = toObjectIdSafe(userId, "userId");
    const tid1 = toObjectIdSafe(firstTradeId, "firstTradeId");
    const tid2 = toObjectIdSafe(secondTradeId, "secondTradeId");
    const doc = {
      reportContextKey: reportContextKey.trim(),
      userId: uid,
      firstTradeId: tid1,
      secondTradeId: tid2,
      label: label != null ? String(label) : "-",
      rate: rate != null ? Number(rate) : null,
      buy: buy != null ? Number(buy) : null,
      profit: profit != null ? Number(profit) : null,
      accountName: accountName != null ? String(accountName) : "",
      accountCode: accountCode != null ? String(accountCode) : "",
      buyRateFrom: buyRateFrom != null ? Number(buyRateFrom) : null,
      buyRateTo: buyRateTo != null ? Number(buyRateTo) : null,
      sellRateFrom: sellRateFrom != null ? Number(sellRateFrom) : null,
      sellRateTo: sellRateTo != null ? Number(sellRateTo) : null,
      minute: minute != null ? Number(minute) : null,
      firstOrderPrice: firstOrderPrice != null ? Number(firstOrderPrice) : null,
      firstQty: firstQty != null ? Number(firstQty) : null,
      firstCreatedAt: firstCreatedAt ? new Date(firstCreatedAt) : null,
      firstType: firstType != null ? String(firstType) : "",
      secondOrderPrice:
        secondOrderPrice != null ? Number(secondOrderPrice) : null,
      secondQty: secondQty != null ? Number(secondQty) : null,
      secondCreatedAt: secondCreatedAt ? new Date(secondCreatedAt) : null,
      secondType: secondType != null ? String(secondType) : "",
    };
    await DeletedLineTradeHistory.findOneAndUpdate(
      {
        reportContextKey: doc.reportContextKey,
        firstTradeId: doc.firstTradeId,
        secondTradeId: doc.secondTradeId,
      },
      { $set: doc },
      { upsert: true, new: true },
    );
    return { success: true };
  } catch (error) {
    console.error("Error in saveDeletedLineTrade:", error);
    throw error;
  }
};
/**
 * Get deleted line trades for a report context (same key used when saving).
 * Returns array of { label, rate, buy, profit, user: { accountName, accountCode }, firstTradeId, secondTradeId, deletedAt }.
 */
exports.getDeletedLineTrades = async (filterOrKey) => {
  try {
    let filter = {};
    if (filterOrKey && typeof filterOrKey === "object") {
      filter = filterOrKey;
    } else if (filterOrKey && String(filterOrKey).trim()) {
      filter = { reportContextKey: String(filterOrKey).trim() };
    }

    const docs = await DeletedLineTradeHistory.find(filter)
      .sort({ createdAt: -1 })
      .lean();
    return docs.map((d) => {
      let market = "";
      let script = "";
      let buyRateFrom = d.buyRateFrom;
      let buyRateTo = d.buyRateTo;
      let sellRateFrom = d.sellRateFrom;
      let sellRateTo = d.sellRateTo;
      let minute = d.minute;
      try {
        const ctx = d.reportContextKey ? JSON.parse(d.reportContextKey) : {};
        market = ctx.market != null ? String(ctx.market) : "";
        script = ctx.script != null ? String(ctx.script) : "";
        if (buyRateFrom == null && ctx.buyRateFrom != null)
          buyRateFrom = Number(ctx.buyRateFrom);
        if (buyRateTo == null && ctx.buyRateTo != null)
          buyRateTo = Number(ctx.buyRateTo);
        if (sellRateFrom == null && ctx.sellRateFrom != null)
          sellRateFrom = Number(ctx.sellRateFrom);
        if (sellRateTo == null && ctx.sellRateTo != null)
          sellRateTo = Number(ctx.sellRateTo);
        if (minute == null && ctx.minute != null) minute = Number(ctx.minute);
      } catch (e) {
        /* ignore */
      }
      return {
        market,
        script,
        buyRateFrom,
        buyRateTo,
        sellRateFrom,
        sellRateTo,
        minute,
        label: d.label,
        rate: d.rate,
        buy: d.buy,
        profit: d.profit,
        userId: d.userId,
        user: { accountName: d.accountName, accountCode: d.accountCode },
        firstTradeId: d.firstTradeId,
        secondTradeId: d.secondTradeId,
        deletedAt: d.createdAt,
        status: "Deleted",
        firstOrderPrice: d.firstOrderPrice,
        firstQty: d.firstQty,
        firstCreatedAt: d.firstCreatedAt,
        firstType: d.firstType,
        secondOrderPrice: d.secondOrderPrice,
        secondQty: d.secondQty,
        secondCreatedAt: d.secondCreatedAt,
        secondType: d.secondType,
      };
    });
  } catch (error) {
    console.error("Error in getDeletedLineTrades:", error);
    throw error;
  }
};
/**
 * Bulk Trade Report: finds groups of trades that meet all of:
 * - At least nOfTrades in any continuous timeRange window (e.g. 4 trades in 5 minutes)
 * - All trades in the group are SELL
 * - All trades are COMPLETED (executed)
 * - PnL > 0 per trade: not enforced here; StockTransaction has no per-trade profit field.
 *   To add: either store realizedPnl on the transaction or join with P&L report and filter.
 */
exports.getBulkTrading = async (match, timeRange, nOfTrades) => {
  try {
    const pipeline = [
      { $match: match },
      { $sort: { createdAt: 1 } },
      {
        $group: {
          _id: "$label",
          trades: {
            $push: {
              _id: "$_id",
              createdAt: "$createdAt",
              label: "$label",
              userId: "$userId",
              marketName: "$marketName",
              transactionType: "$transactionType",
              orderType: "$orderType",
              quantity: "$quantity",
              lot: "$lot",
              orderPrice: "$orderPrice",
              netPrice: "$netPrice",
              ip: "$ip",
              transactionStatus: "$transactionStatus",
            },
          },
        },
      },
      {
        $project: {
          trades: {
            $reduce: {
              input: "$trades",
              initialValue: {
                lastTime: null,
                groupId: 1,
                processed: [],
              },
              in: {
                lastTime: "$$this.createdAt",
                groupId: {
                  $cond: [
                    {
                      $or: [
                        { $eq: ["$$value.lastTime", null] },
                        {
                          $lte: [
                            {
                              $subtract: [
                                "$$this.createdAt",
                                "$$value.lastTime",
                              ],
                            },
                            timeRange,
                          ],
                        },
                      ],
                    },
                    "$$value.groupId",
                    { $add: ["$$value.groupId", 1] },
                  ],
                },
                processed: {
                  $concatArrays: [
                    "$$value.processed",
                    [
                      {
                        $mergeObjects: [
                          {
                            _id: "$$this._id",
                            createdAt: "$$this.createdAt",
                            label: "$$this.label",
                            userId: "$$this.userId",
                            marketName: "$$this.marketName",
                            transactionType: "$$this.transactionType",
                            orderType: "$$this.orderType",
                            quantity: "$$this.quantity",
                            lot: "$$this.lot",
                            orderPrice: "$$this.orderPrice",
                            netPrice: "$$this.netPrice",
                            ip: "$$this.ip",
                            transactionStatus: "$$this.transactionStatus",
                          },
                          {
                            groupId: {
                              $cond: [
                                {
                                  $or: [
                                    { $eq: ["$$value.lastTime", null] },
                                    {
                                      $lte: [
                                        {
                                          $subtract: [
                                            "$$this.createdAt",
                                            "$$value.lastTime",
                                          ],
                                        },
                                        timeRange,
                                      ],
                                    },
                                  ],
                                },
                                "$$value.groupId",
                                { $add: ["$$value.groupId", 1] },
                              ],
                            },
                          },
                        ],
                      },
                    ],
                  ],
                },
              },
            },
          },
        },
      },
      { $project: { trades: "$trades.processed" } },
      { $unwind: "$trades" },
      { $replaceRoot: { newRoot: "$trades" } },
      {
        $group: {
          _id: { label: "$label", groupId: "$groupId" },
          trades: { $push: "$$ROOT" },
          startTime: { $min: "$createdAt" },
          endTime: { $max: "$createdAt" },
          count: { $sum: 1 },
        },
      },
      // At least nOfTrades in the time window (e.g. at least 4 trades in 5 min)
      { $match: { count: { $gte: nOfTrades } } },
      // Only groups where ALL trades are SELL (ignore any group that has BUY)
      {
        $addFields: {
          sellCount: {
            $size: {
              $filter: {
                input: "$trades",
                as: "t",
                cond: { $eq: ["$$t.transactionType", "SELL"] },
              },
            },
          },
        },
      },
      { $match: { $expr: { $eq: ["$sellCount", "$count"] } } },
      // Optional: filter to only COMPLETED trades (already executed)
      {
        $addFields: {
          trades: {
            $filter: {
              input: "$trades",
              as: "t",
              cond: { $eq: ["$$t.transactionStatus", "COMPLETED"] },
            },
          },
        },
      },
      // Recompute count after filtering to completed only; keep only groups that still have >= nOfTrades
      {
        $addFields: {
          count: { $size: "$trades" },
        },
      },
      { $match: { count: { $gte: nOfTrades } } },
      { $sort: { startTime: 1 } },
    ];

    const response = await StockTransaction.aggregate(pipeline);
    const userIds = response
      .map((dt) => dt.trades.map((txn) => txn.userId))
      .flat(1);

    const users = await userModel
      .find({ _id: { $in: userIds } })
      .select({ accountName: 1, accountCode: 1 })
      .lean();

    const usersMap = new Map(
      users.map((user) => [
        user._id.toString(),
        { accountName: user.accountName, accountCode: user.accountCode },
      ]),
    );

    return response.map((dt) => ({
      ...dt,
      trades: dt.trades.map((txn) => {
        const userInfo = usersMap.get(txn.userId.toString());
        return {
          ...txn,
          user: userInfo,
        };
      }),
    }));
  } catch (error) {
    console.error("Error fetching bulk trading data:", error);
    throw error;
  }
};

// exports.sameIpReport = async (valanId) => {
//   try {
//     const users = await StockTransaction.aggregate([
//       {
//         $match: {
//           valanId: new mongoose.Types.ObjectId(valanId),
//         },
//       },
//       {
//         $lookup: {
//           from: "users",
//           localField: "userId",
//           foreignField: "_id",
//           as: "userDetails",
//         },
//       },
//       { $unwind: "$userDetails" },
//       {
//         $group: {
//           _id: "$ip",
//           userAgent: { $first: "$userAgent" },
//           users: {
//             $addToSet: {
//               userId: "$userDetails._id",
//               accountName: "$userDetails.accountName",
//               accountCode: "$userDetails.accountCode",
//             },
//           },
//           count: { $sum: 1 },
//         },
//       },
//       { $match: { count: { $gt: 1 } } },
//     ]);
//     return users;
//   } catch (error) {
//     console.error("Error updating data:", error);
//     throw error;
//   }
// };
exports.getUsersScriptWisePosition = async (
  match,
  level,
  originalUserIds = [],
) => {
  try {
    const userIds =
      originalUserIds && originalUserIds.length > 0
        ? originalUserIds
        : match.userId?.$in || [];

    // Fetch user details for all requested users to ensure we have names/codes regardless of trade history
    const allUsers = await userModel
      .find({ _id: { $in: userIds } })
      .select("accountName accountCode")
      .lean();

    const userDetailMap = new Map(allUsers.map((u) => [u._id.toString(), u]));

    // Get script-level docs (your aggregation)
    const scriptLevelDocs = await exports.getProfitLoss(match, level, null, {
      scriptLevelOnly: true,
    });

    const scriptIds = [
      ...new Set(scriptLevelDocs.map((d) => d.scriptId).filter(Boolean)),
    ];
    const priceMap = {};

    if (scriptIds.length > 0) {
      const redisPrices = await getMultipleStockData(scriptIds);
      scriptIds.forEach((id, i) => {
        const data = redisPrices[i];
        if (
          data &&
          (data.BuyPrice != null || data.SellPrice != null || data.Ltp != null)
        ) {
          priceMap[id] = data;
        }
      });
    }

    const sumTxnField = (txns = [], condType, fieldName) => {
      if (!Array.isArray(txns)) return 0;
      return txns.reduce((acc, t) => {
        if (!t || typeof t !== "object") return acc;
        if (!condType || t.transactionType === condType) {
          const v = Number(t[fieldName]);
          return acc + (Number.isFinite(v) ? v : 0);
        }
        return acc;
      }, 0);
    };

    const enriched = scriptLevelDocs.map((row) => {
      const total = row.total || {};
      const txns = row.transactions || row.txn || row.txns || [];

      const buyQty =
        Number(
          total.buyQuantity ??
          total.BUY_QTY ??
          sumTxnField(txns, "BUY", "quantity"),
        ) || 0;
      const sellQty =
        Number(
          total.sellQuantity ??
          total.SELL_QTY ??
          sumTxnField(txns, "SELL", "quantity"),
        ) || 0;

      const buyNet =
        Number(
          total.buyNetPrice ??
          row.buyNetPrice ??
          sumTxnField(txns, "BUY", "totalNetPrice"),
        ) || 0;
      const sellNet =
        Number(
          total.sellNetPrice ??
          row.sellNetPrice ??
          sumTxnField(txns, "SELL", "totalNetPrice"),
        ) || 0;

      const avgBuyPrice = buyQty > 0 ? buyNet / buyQty : 0;
      const avgSellPrice = sellQty > 0 ? sellNet / sellQty : 0;

      const brokerage =
        Number(
          total.brokerage ??
          row.brokerage ??
          sumTxnField(txns, null, "netBrokerage"),
        ) || 0;
      const remainingQty = Number(row.remainingQty ?? buyQty - sellQty) || 0;

      const live = priceMap[row.scriptId];

      let gross = 0;
      let m2m = 0;

      if (!remainingQty) {
        gross = sellNet - buyNet;
        m2m = Number(row.m2m ?? 0);
      } else {
        const bid = live
          ? Number(live.SellPrice ?? live.ask ?? live.Ltp ?? 0)
          : 0;
        const ask = live
          ? Number(live.BuyPrice ?? live.bid ?? live.Ltp ?? 0)
          : 0;

        if (remainingQty > 0) {
          let avgEntry =
            buyQty > 0 ? buyNet / buyQty : (buyNet - sellNet) / remainingQty;
          const livePrice =
            ask || (live ? Number(live.Ltp ?? live.LastTradePrice ?? 0) : 0);

          if (livePrice > 0 && Number.isFinite(livePrice)) {
            gross = (livePrice - avgEntry) * remainingQty;
            m2m = gross;
          } else {
            gross = Number(row.bill ?? sellNet - buyNet ?? 0);
            m2m = Number(row.m2m ?? 0);
          }
        } else if (remainingQty < 0) {
          let avgEntry =
            sellQty > 0
              ? sellNet / sellQty
              : (sellNet - buyNet) / Math.abs(remainingQty);
          const livePrice =
            bid || (live ? Number(live.Ltp ?? live.LastTradePrice ?? 0) : 0);

          if (livePrice > 0 && Number.isFinite(livePrice)) {
            gross = (avgEntry - livePrice) * Math.abs(remainingQty);
            m2m = gross;
          } else {
            gross = Number(row.bill ?? sellNet - buyNet ?? 0);
            m2m = Number(row.m2m ?? 0);
          }
        }
      }

      gross = gross + brokerage;

      let otherBrokerageSum = 0;
      if (Array.isArray(row.summedOtherBrokerage)) {
        const flat = row.summedOtherBrokerage.flat(2);
        otherBrokerageSum = flat.reduce((acc, item) => {
          if (!item) return acc;
          if (typeof item === "object") {
            return (
              acc +
              (Number.isFinite(Number(item.netBrokerage))
                ? Number(item.netBrokerage)
                : 0)
            );
          }
          return acc + (Number.isFinite(Number(item)) ? Number(item) : 0);
        }, 0);
      }

      const bill = Number(gross) - brokerage;
      let finalM2M = bill + otherBrokerageSum;

      // Extract accountCode from nested objects
      let accountCode = row.accountCode;
      let accountName = row.accountName;
      if (!accountCode && row.userInfo) {
        accountCode = row.userInfo.accountCode;
        accountName = row.userInfo.accountName;
      }
      if (!accountCode && txns.length > 0 && txns[0].userInfo) {
        accountCode = txns[0].userInfo.accountCode;
        accountName = txns[0].userInfo.accountName;
      }

      // Now prepare clean row
      return {
        userId: row.userId.toString(),
        accountCode: accountCode || "-",
        accountName: accountName || "-",
        scriptId: row.scriptId,
        scriptName: row.scriptName,
        label:
          row.transactions?.[0]?.label ||
          row.txns?.[0]?.label ||
          row.txn?.[0]?.label ||
          row.label ||
          row.scriptName,
        buyQuantity: buyQty,
        sellQuantity: sellQty,
        avgBuyPrice: Number(avgBuyPrice.toFixed(4)),
        avgSellPrice: Number(avgSellPrice.toFixed(4)),
        remainingQty,
        gross: Number(gross.toFixed(4)),
        m2m: Number(finalM2M.toFixed(4)),
      };
    });

    let resultRows = enriched;

    // Special Logic for Multi-User Comparison: Aggregate by original requested parents
    if (originalUserIds && originalUserIds.length >= 1) {
      const inputSet = new Set(originalUserIds.map((id) => id.toString()));
      const aggregated = {}; // Key format: OwnerId_ScriptId

      enriched.forEach((e, idx) => {
        const row = scriptLevelDocs[idx];
        const rowParentIds = (row.parentIds || []).map((p) => p.toString());

        // Find which in userIds list is the logical owner
        let ownerId = null;
        if (inputSet.has(e.userId)) {
          ownerId = e.userId;
        } else {
          // Check parent hierarchy from bottom up to find the closest requested parent
          for (let i = rowParentIds.length - 1; i >= 0; i--) {
            if (inputSet.has(rowParentIds[i])) {
              ownerId = rowParentIds[i];
              break;
            }
          }
        }

        if (ownerId) {
          const key = `${ownerId}_${e.scriptId}`;
          if (!aggregated[key]) {
            const ownerUser = userDetailMap.get(ownerId) || {};
            aggregated[key] = {
              userId: ownerId,
              accountCode: ownerUser.accountCode || "-",
              accountName: ownerUser.accountName || "-",
              scriptId: e.scriptId,
              scriptName: e.scriptName,
              label: e.label,
              buyQuantity: 0,
              sellQuantity: 0,
              avgBuyPrice: 0,
              avgSellPrice: 0,
              remainingQty: 0,
              gross: 0,
              m2m: 0,
              _buyNet: 0,
              _sellNet: 0,
            };
          }
          const a = aggregated[key];
          a.buyQuantity += e.buyQuantity;
          a.sellQuantity += e.sellQuantity;
          a.remainingQty += e.remainingQty;
          a.gross += e.gross;
          a.m2m += e.m2m;
          a._buyNet += e.buyQuantity * e.avgBuyPrice;
          a._sellNet += e.sellQuantity * e.avgSellPrice;
        }
      });

      resultRows = Object.values(aggregated).map((a) => {
        if (a.buyQuantity > 0)
          a.avgBuyPrice = Number((a._buyNet / a.buyQuantity).toFixed(4));
        if (a.sellQuantity > 0)
          a.avgSellPrice = Number((a._sellNet / a.sellQuantity).toFixed(4));
        delete a._buyNet;
        delete a._sellNet;
        return a;
      });
    }

    // Group by ScriptId
    const scriptMap = {};
    const scriptInfoMap = {}; // To store scriptName and label

    resultRows.forEach((e) => {
      if (!scriptMap[e.scriptId]) {
        scriptMap[e.scriptId] = new Map();
        scriptInfoMap[e.scriptId] = {
          scriptName: e.scriptName,
          label: e.label,
        };
      }
      scriptMap[e.scriptId].set(e.userId, e);
    });

    // Generate response ensuring every requested user is present for every active script
    const finalGrouped = Object.keys(scriptMap).map((scriptId) => {
      const { scriptName, label } = scriptInfoMap[scriptId];
      let totalRemainingQty = 0;
      let totalM2M = 0;

      const users = userIds.map((uid) => {
        const uIdStr = uid.toString();
        const existingData = scriptMap[scriptId].get(uIdStr);

        if (existingData) {
          totalRemainingQty += existingData.remainingQty;
          totalM2M += existingData.m2m;
          return existingData;
        } else {
          // Provide default zeroed entry for comparison
          const userData = userDetailMap.get(uIdStr) || {};
          return {
            userId: uIdStr,
            accountCode: userData.accountCode || "-",
            accountName: userData.accountName || "-",
            scriptId: scriptId,
            scriptName: scriptName,
            label: label,
            buyQuantity: 0,
            sellQuantity: 0,
            avgBuyPrice: 0,
            avgSellPrice: 0,
            remainingQty: 0,
            gross: 0,
            m2m: 0,
          };
        }
      });

      return {
        scriptId,
        scriptName,
        label,
        totalRemainingQty: Number(totalRemainingQty.toFixed(4)),
        totalM2M: Number(totalM2M.toFixed(4)),
        users,
      };
    });

    return finalGrouped;
  } catch (error) {
    console.error("Error getUsersScriptWisePosition:", error);
    throw error;
  }
};

exports.sameIpReport = async (valanId) => {
  try {
    const valanObjId = new mongoose.Types.ObjectId(valanId);
    // Step 1: Identify IP Groups first (Trade IP from StockTransaction)
    const ipGroups = await StockTransaction.aggregate([
      {
        $match: {
          valanId: valanObjId,
          transactionStatus: "COMPLETED",
          ip: { $ne: "" },
        },
      },
      {
        $lookup: {
          from: "users",
          localField: "userId",
          foreignField: "_id",
          as: "userDetails",
        },
      },
      { $unwind: "$userDetails" },
      {
        $group: {
          _id: "$ip",
          userAgent: { $first: "$userAgent" },
          users: {
            $addToSet: {
              userId: "$userDetails._id",
              accountName: "$userDetails.accountName",
              accountCode: "$userDetails.accountCode",
            },
          },
        },
      },
      {
        $addFields: {
          userCount: { $size: "$users" },
        },
      },
      {
        $match: {
          userCount: { $gte: 2 },
        },
      },
      { $sort: { userCount: -1 } },
    ]);

    // // console.log(`[SameIpReport] Found ${ipGroups.length} IP groups with 2+ users.`);

    const finalResults = [];

    // Step 2: Calculate per-user per-script data within each IP group
    const finalScriptGroups = [];

    for (const group of ipGroups) {
      const scriptToUsersMap = {}; // scriptId -> { scriptName, users: [] }
      const userOverallProfits = new Map(); // userId -> totalProfit

      for (const user of group.users) {
        const uId = new mongoose.Types.ObjectId(user.userId);

        const summaries = await StockTransaction.aggregate([
          {
            $match: {
              userId: uId,
              valanId: valanObjId,
              transactionStatus: "COMPLETED",
            },
          },
          {
            $group: {
              _id: "$scriptId",
              scriptName: { $first: "$scriptName" },
              buyQty: {
                $sum: {
                  $cond: [{ $eq: ["$transactionType", "BUY"] }, "$quantity", 0],
                },
              },
              sellQty: {
                $sum: {
                  $cond: [
                    { $eq: ["$transactionType", "SELL"] },
                    "$quantity",
                    0,
                  ],
                },
              },
              buyVal: {
                $sum: {
                  $cond: [
                    { $eq: ["$transactionType", "BUY"] },
                    "$totalNetPrice",
                    0,
                  ],
                },
              },
              sellVal: {
                $sum: {
                  $cond: [
                    { $eq: ["$transactionType", "SELL"] },
                    "$totalNetPrice",
                    0,
                  ],
                },
              },
              transactions: { $push: "$$ROOT" },
            },
          },
        ]);

        if (summaries.length === 0) continue;

        const scriptIds = summaries.map((s) => s._id);
        const livePrices = await getMultipleStockData(scriptIds);
        const priceMap = new Map();
        livePrices.forEach((l, i) => {
          if (l) priceMap.set(scriptIds[i], l);
        });

        let totalUserProfit = 0;
        const scriptProfits = []; // [{ scriptId, scriptName, profit, transactions }]

        for (const s of summaries) {
          const netQty = s.buyQty - s.sellQty;
          const bookedPart = s.sellVal - s.buyVal;
          let liveValuation = 0;

          if (netQty !== 0) {
            const live = priceMap.get(s._id);
            let price = 0;
            if (live) {
              price =
                netQty > 0
                  ? parseFloat(live.BuyPrice) || 0
                  : parseFloat(live.SellPrice) || 0;
            }
            if (price <= 0) {
              price = netQty > 0 ? s.buyVal / s.buyQty : s.sellVal / s.sellQty;
            }
            liveValuation = netQty * price;
          }
          const scriptProfit = bookedPart + liveValuation;
          totalUserProfit += scriptProfit;

          if (scriptProfit > 0) {
            scriptProfits.push({
              scriptId: s._id,
              scriptName: s.scriptName,
              profit: scriptProfit,
              transactions: s.transactions,
            });
          }
        }

        userOverallProfits.set(user.userId.toString(), totalUserProfit);

        // Only process for users who are overall profitable
        if (totalUserProfit > 0) {
          scriptProfits.forEach((sp) => {
            if (!scriptToUsersMap[sp.scriptId]) {
              scriptToUsersMap[sp.scriptId] = {
                scriptId: sp.scriptId,
                scriptName: sp.scriptName,
                users: [],
              };
            }
            scriptToUsersMap[sp.scriptId].users.push({
              ...user,
              profit: sp.profit,
              overallProfit: totalUserProfit,
              transactions: sp.transactions,
            });
          });
        }
      }

      // Step 3: Convert the map into final script-wise entries for this IP
      Object.values(scriptToUsersMap).forEach((scriptGroup) => {
        // Condition: 2 or more overall-profitable users made profit in this specific script on this IP
        if (scriptGroup.users.length >= 2) {
          finalScriptGroups.push({
            _id: group._id, // IP address as ID to follow previous structure
            scriptId: scriptGroup.scriptId,
            scriptName: scriptGroup.scriptName,
            userAgent: group.userAgent,
            userCount: scriptGroup.users.length,
            totalUsers: group.userCount,
            users: scriptGroup.users,
            totalProfit: scriptGroup.users.reduce(
              (acc, u) => acc + u.profit,
              0,
            ),
          });
        }
      });
    }

    return finalScriptGroups.sort((a, b) => b.userCount - a.userCount);
  } catch (error) {
    console.error("[SameIpReport] ERROR:", error);
    throw error;
  }
};
exports.getExpiry = (key) => {
  if (!key) return "NA";
  const parts = key.trim().split(/\s+/);

  // Market 3 (NOPT): labels are "NAME STRIKE TYPE DATE" (4 parts)
  if (parts.length === 4) {
    return parts[3];
  }

  // Market 2 (NSE-FO) / MCX: labels are "NAME DATE" (2 parts)
  return parts.length > 1 ? parts[1] : "NA";
};

exports.getFilterStockTransactions = async (match, project, order) => {
  try {
    return await StockTransaction.find({ ...match })
      .select({ ...project })
      .sort({ ...order })
      .lean();
  } catch (error) {
    console.error("Error fetching data:", error);
    throw error;
  }
};
exports.getDownlineSummaryReport = async (match, level, userId, scriptName) => {
  try {
    const userIdObj = userId ? new mongoose.Types.ObjectId(userId) : null;
    let dynamicBuyPrice = 0;
    let dynamicSellPrice = 0;

    // Resolve scriptId from a matching transaction
    const sampleTx = await StockTransaction.findOne(match, {
      scriptId: 1,
    }).lean();
    if (sampleTx && sampleTx.scriptId) {
      const stockPrice = await getMultipleStockData([sampleTx.scriptId]);
      if (stockPrice && stockPrice.length > 0 && stockPrice[0]) {
        dynamicBuyPrice = stockPrice[0].BuyPrice || 0;
        dynamicSellPrice = stockPrice[0].SellPrice || 0;
      }
    }

    const result = await StockTransaction.aggregate([
      {
        $match: match,
      },
      {
        $group: {
          _id: "$userId",
          scriptId: { $first: "$scriptId" },
          scriptName: { $first: "$scriptName" },
          marketName: { $first: "$marketName" },
          label: { $first: "$label" },
          parentIds: { $first: "$parentIds" },
          // Don't use partnership from transactions - fetch from users instead
          // partnership: { $first: "$partnership" },
          buyQuantity: {
            $sum: {
              $cond: [{ $eq: ["$transactionType", "BUY"] }, "$quantity", 0],
            },
          },
          sellQuantity: {
            $sum: {
              $cond: [{ $eq: ["$transactionType", "SELL"] }, "$quantity", 0],
            },
          },
          buyLot: {
            $sum: {
              $cond: [{ $eq: ["$transactionType", "BUY"] }, "$lot", 0],
            },
          },
          sellLot: {
            $sum: {
              $cond: [{ $eq: ["$transactionType", "SELL"] }, "$lot", 0],
            },
          },
          buyOrderPrice: {
            $sum: {
              $cond: [
                { $eq: ["$transactionType", "BUY"] },
                "$totalOrderPrice",
                0,
              ],
            },
          },
          sellOrderPrice: {
            $sum: {
              $cond: [
                { $eq: ["$transactionType", "SELL"] },
                "$totalOrderPrice",
                0,
              ],
            },
          },
          buyNetPrice: {
            $sum: {
              $cond: [
                { $eq: ["$transactionType", "BUY"] },
                "$totalNetPrice",
                0,
              ],
            },
          },
          sellNetPrice: {
            $sum: {
              $cond: [
                { $eq: ["$transactionType", "SELL"] },
                "$totalNetPrice",
                0,
              ],
            },
          },
          buyNetAveragePrice: {
            $avg: {
              $cond: [{ $eq: ["$transactionType", "BUY"] }, "$netPrice", null],
            },
          },
          sellNetAveragePrice: {
            $avg: {
              $cond: [{ $eq: ["$transactionType", "SELL"] }, "$netPrice", null],
            },
          },
          brokerage: { $sum: "$netBrokerage" },
          brokerBrokerage: {
            $sum: {
              $let: {
                vars: {
                  newSum: {
                    $reduce: {
                      input: { $ifNull: ["$brockersBrokerage", []] },
                      initialValue: 0,
                      in: { $add: ["$$value", "$$this.rate"] },
                    },
                  },
                },
                in: {
                  $cond: [
                    { $gt: ["$$newSum", 0] },
                    "$$newSum",
                    "$brokerTotalBrokerage",
                  ],
                },
              },
            },
          },
          myBrokerage: {
            $sum: {
              $let: {
                vars: {
                  myBkr: {
                    $filter: {
                      input: { $ifNull: ["$brockersBrokerage", []] },
                      as: "b",
                      cond: {
                        $eq: ["$$b.brokerId", userIdObj],
                      },
                    },
                  },
                },
                in: {
                  $cond: [
                    { $gt: [{ $size: "$$myBkr" }, 0] },
                    { $arrayElemAt: ["$$myBkr.rate", 0] },
                    0,
                  ],
                },
              },
            },
          },
        },
      },
      {
        $addFields: {
          remainingQty: { $subtract: ["$buyQuantity", "$sellQuantity"] },
          remainingQtyAbs: {
            $abs: { $subtract: ["$buyQuantity", "$sellQuantity"] },
          },
          remainingLot: { $subtract: ["$buyLot", "$sellLot"] },
        },
      },
      {
        $match: {
          remainingQty: { $ne: 0 },
        },
      },
      // Fetch partnership from users collection (not from stocktransactions)
      {
        $lookup: {
          from: "users",
          localField: "_id",
          foreignField: "_id",
          pipeline: [
            {
              $project: {
                partnership: 1,
              },
            },
          ],
          as: "userPartnership",
        },
      },
      {
        $addFields: {
          // Use partnership from users collection
          partnership: {
            $cond: [
              { $gt: [{ $size: "$userPartnership" }, 0] },
              { $arrayElemAt: ["$userPartnership.partnership", 0] },
              [0, 0, 0, 0, 0, 0], // Fallback
            ],
          },
          // Correct orderPrice for valuation: Long -> SellPrice(Bid), Short -> BuyPrice(Ask)
          orderPrice: {
            $cond: [
              { $eq: ["$remainingQty", 0] },
              0,
              {
                $cond: {
                  if: { $gt: ["$remainingQty", 0] },
                  then: dynamicSellPrice,
                  else: dynamicBuyPrice,
                },
              },
            ],
          },
          livePrice: {
            $cond: [
              { $eq: ["$remainingQty", 0] },
              0,
              {
                $cond: {
                  if: { $gt: ["$remainingQty", 0] },
                  then: dynamicSellPrice,
                  else: dynamicBuyPrice,
                },
              },
            ],
          },
          // gross (Total Gross Profit) = (SellOrderPrice - BuyOrderPrice) + (remainingQty * livePrice)
          gross: {
            $add: [
              { $subtract: ["$sellOrderPrice", "$buyOrderPrice"] },
              { $multiply: ["$remainingQty", "$livePrice"] },
            ],
          },
          // totalm2m (Client Total Net P&L) = (sellNetPrice - buyNetPrice) + (remainingQty * livePrice)
          totalm2m: {
            $add: [
              { $subtract: ["$sellNetPrice", "$buyNetPrice"] },
              { $multiply: ["$remainingQty", "$livePrice"] },
            ],
          },
        },
      },
      {
        $addFields: {
          myIndex: { $arrayElemAt: ["$partnership", level - 1] },
          // Get broker commission for calculations
          brokerIndex: {
            $cond: [
              { $gte: [{ $size: "$partnership" }, 6] },
              { $arrayElemAt: ["$partnership", 5] },
              0,
            ],
          },
          // For downline calculation
          // childIndex: hierarchy share at next level
          childIndex: {
            $cond: [
              { $gt: [{ $size: "$partnership" }, level] },
              { $arrayElemAt: ["$partnership", level] },
              0,
            ],
          },
          // Downline = 100% - myIndex%
          // When Super Admin (level=1, 5%) views users:
          //   - myIndex = partnership[0] = 5% (Super Admin's share)
          //   - totalDownlineIndex = 100 - 5 = 95% (Everything except Super Admin)
          // This ensures downline is always complementary to Self
          totalDownlineIndex: {
            $subtract: [100, { $sum: { $slice: ["$partnership", level] } }],
          },
          m2m: {
            $subtract: [{ $multiply: ["$totalm2m", -1] }, "$brokerBrokerage"],
          },
        },
      },
      {
        $project: {
          userId: "$_id",
          scriptId: "$scriptId",
          scriptName: "$scriptName",
          marketName: "$marketName",
          label: 1,
          buyQuantity: 1,
          sellQuantity: 1,
          remainingQty: 1,
          buyNetAveragePrice: 1,
          sellNetAveragePrice: 1,
          orderPrice: 1,
          livePrice: 1,
          gross: 1,
          m2m: 1,
          brokerage: 1,
          brokerBrokerage: 1,
          myIndex: 1, // Pass through for debugging
          childIndex: 1, // Pass through for debugging
          brokerIndex: 1, // Pass through for debugging
          totalDownlineIndex: 1, // Pass through for debugging
          partnership: 1, // Pass through for debugging
          selfQty: {
            $divide: [
              {
                $multiply: [
                  {
                    $cond: [
                      { $in: ["$marketName", ["NSE", "INDEX"]] },
                      "$remainingQty",
                      "$remainingLot",
                    ],
                  },
                  "$myIndex",
                ],
              },
              100,
            ],
          },
          selfNetPrice: {
            $divide: [{ $multiply: ["$m2m", "$myIndex"] }, 100],
          },
          brokerNetPrice: {
            $divide: [{ $multiply: ["$m2m", "$brokerIndex"] }, 100],
          },
          uplineNetPrice: {
            $divide: [
              {
                $multiply: [
                  "$m2m",
                  { $sum: { $slice: ["$partnership", level - 1] } },
                ],
              },
              100,
            ],
          },
          // Downline Net Price: Use totalDownlineIndex which is the sum of ALL partnership
          // indices after the current level (includes all child levels + broker)
          // Example: For partnership [5, 95], if level=1, totalDownlineIndex=95
          // Example: For partnership [5, 65, 0, 0, 0, 30], if level=1, totalDownlineIndex=95
          downlineNetPrice: {
            $divide: [
              {
                $multiply: ["$m2m", "$totalDownlineIndex"],
              },
              100,
            ],
          },
          selfBrokerage: {
            $cond: [
              { $eq: [level, 6] },
              "$myBrokerage",
              {
                $divide: [
                  {
                    $multiply: [
                      { $subtract: ["$brokerage", "$brokerBrokerage"] },
                      "$myIndex",
                    ],
                  },
                  100,
                ],
              },
            ],
          },
          userInfo: 1,
          parentIds: 1,
        },
      },
    ]);

    return result;
  } catch (error) {
    console.error("Error creating data:", error);
    throw error;
  }
};
/**
 * Fetch aggregated client stock data for ONE specific scriptId
 * (Reference-based clone of clientStockByMaster pipeline)
 */
exports.clientStockByMasterByScript = async (
  matchFilter,
  level,
  scriptId,
  label,
  isRequesterDemo = false
) => {
  try {
    const pipeline = [
      // 0️⃣ Match (parent + valan + status + scriptId)
      {
        $match: {
          ...matchFilter,
          label: label,
          scriptId: scriptId,
        },
      },

      // 1️⃣ Group at USER + SCRIPT level
      {
        $group: {
          _id: {
            userId: "$userId",
            scriptId: "$scriptId",
          },

          label: { $first: "$label" },
          scriptName: { $first: "$scriptName" },
          marketName: { $first: "$marketName" },
          partnership: { $first: "$partnership" },

          buyQty: {
            $sum: {
              $cond: [{ $eq: ["$transactionType", "BUY"] }, "$quantity", 0],
            },
          },
          sellQty: {
            $sum: {
              $cond: [{ $eq: ["$transactionType", "SELL"] }, "$quantity", 0],
            },
          },
          buyLot: {
            $sum: {
              $cond: [{ $eq: ["$transactionType", "BUY"] }, "$lot", 0],
            },
          },
          sellLot: {
            $sum: {
              $cond: [{ $eq: ["$transactionType", "SELL"] }, "$lot", 0],
            },
          },

          buyNetPrice: {
            $sum: {
              $cond: [
                { $eq: ["$transactionType", "BUY"] },
                "$totalNetPrice",
                0,
              ],
            },
          },
          sellNetPrice: {
            $sum: {
              $cond: [
                { $eq: ["$transactionType", "SELL"] },
                "$totalNetPrice",
                0,
              ],
            },
          },
        },
      },

      // 2️⃣ Net qty
      {
        $addFields: {
          netQty: { $subtract: ["$buyQty", "$sellQty"] },
          absQty: { $abs: { $subtract: ["$buyQty", "$sellQty"] } },
          netLot: { $subtract: ["$buyLot", "$sellLot"] },
        },
      },

      // 3️⃣ Live price lookup
      {
        $lookup: {
          from: "stocks",
          localField: "scriptName",
          foreignField: "InstrumentIdentifier",
          as: "stockInfo",
        },
      },

      // 4️⃣ Order price
      {
        $addFields: {
          orderPrice: {
            $cond: [
              { $gte: ["$netQty", 0] },
              {
                $ifNull: [{ $arrayElemAt: ["$stockInfo.BuyPrice", 0] }, 0],
              },
              {
                $ifNull: [{ $arrayElemAt: ["$stockInfo.SellPrice", 0] }, 0],
              },
            ],
          },
        },
      },

      // 5️⃣ M2M
      {
        $addFields: {
          totalm2m: { $subtract: ["$sellNetPrice", "$buyNetPrice"] },
        },
      },
      {
        $addFields: {
          m2m: {
            $cond: [
              { $gte: ["$totalm2m", 0] },
              {
                $subtract: [
                  "$totalm2m",
                  { $multiply: ["$absQty", "$orderPrice"] },
                ],
              },
              {
                $add: ["$totalm2m", { $multiply: ["$absQty", "$orderPrice"] }],
              },
            ],
          },
        },
      },

      // 3.5️⃣ User Lookup for Demo Filter and Partnership
      {
        $lookup: {
          from: "users",
          localField: "_id.userId",
          foreignField: "_id",
          pipeline: [
            {
              $project: {
                _id: 0,
                partnership: 1,
                demoid: 1,
                isDeleted: 1,
              },
            },
          ],
          as: "userDetails",
        },
      },
      {
        $addFields: {
          userDetails: { $arrayElemAt: ["$userDetails", 0] },
        },
      },
      {
        $match: {
          $and: [
            isRequesterDemo
              ? { "userDetails.demoid": true }
              : {
                $or: [
                  { "userDetails.demoid": { $ne: true } },
                  { "userDetails.demoid": { $exists: false } },
                  { userDetails: null },
                ],
              },
            {
              $or: [{ "userDetails.isDeleted": false }, { userDetails: null }],
            },
          ],
        },
      },

      // 6.0️⃣ Flatten Fresh Partnership (in its own stage)
      {
        $addFields: {
          freshUserPartnership: "$userDetails",
        },
      },
      // 6.1️⃣ Calculate myIndex (safe from sequential addFields array pitfall)
      {
        $addFields: {
          myIndex: {
            $cond: [
              { $gt: [level, 0] },
              {
                $ifNull: [
                  {
                    $arrayElemAt: [
                      "$freshUserPartnership.partnership",
                      { $subtract: [level, 1] },
                    ],
                  },
                  {
                    $arrayElemAt: ["$partnership", { $subtract: [level, 1] }],
                  },
                ],
              },
              0,
            ],
          },
        },
      },

      // 7️⃣ Projection
      {
        $project: {
          label: 1,

          totalTxn: {
            $round: [
              {
                $divide: [
                  {
                    $multiply: [
                      {
                        $cond: [
                          { $in: ["$marketName", ["NSE", "INDEX"]] },
                          "$netQty",
                          "$netLot",
                        ],
                      },
                      "$myIndex",
                    ],
                  },
                  100,
                ],
              },
              2,
            ],
          },

          totalM2M: {
            $round: [
              {
                $divide: [{ $multiply: ["$m2m", "$myIndex", -1] }, 100],
              },
              2,
            ],
          },
        },
      },

      // 8️⃣ Final group (single script)
      {
        $group: {
          _id: "$label",
          label: { $first: "$label" },
          totalTxn: { $sum: "$totalTxn" },
          totalM2M: { $sum: "$totalM2M" },
        },
      },
    ];

    return await StockTransaction.aggregate(pipeline);
  } catch (error) {
    console.error("Error fetching script-wise data:", error);
    throw error;
  }
};
exports.getClientStockTransactions = async (matchFilter, label = null) => {
  try {
    if (label) {
      matchFilter.label = label;
    }

    const pipeline = [
      { $match: matchFilter },

      // Normalize txn qty (NSE/INDEX use quantity, others lot)
      {
        $addFields: {
          txn: {
            $cond: [
              { $in: ["$marketName", ["NSE", "INDEX"]] },
              "$quantity",
              "$lot",
            ],
          },
        },
      },

      // GROUP per label (collect price + qty info)
      {
        $group: {
          _id: "$label",

          marketName: { $first: "$marketName" },
          scriptName: { $first: "$scriptName" },

          buyQty: {
            $sum: {
              $cond: [{ $eq: ["$transactionType", "BUY"] }, "$txn", 0],
            },
          },
          sellQty: {
            $sum: {
              $cond: [{ $eq: ["$transactionType", "SELL"] }, "$txn", 0],
            },
          },

          buyNetPrice: {
            $sum: {
              $cond: [
                { $eq: ["$transactionType", "BUY"] },
                "$totalNetPrice",
                0,
              ],
            },
          },
          sellNetPrice: {
            $sum: {
              $cond: [
                { $eq: ["$transactionType", "SELL"] },
                "$totalNetPrice",
                0,
              ],
            },
          },
        },
      },

      // Compute net/abs qty
      {
        $addFields: {
          netQty: { $subtract: ["$buyQty", "$sellQty"] },
          absQty: { $abs: { $subtract: ["$buyQty", "$sellQty"] } },
        },
      },

      // Live price lookup (same as master)
      {
        $lookup: {
          from: "stocks",
          localField: "scriptName",
          foreignField: "InstrumentIdentifier",
          as: "stockInfo",
        },
      },

      // Order price + totalm2m
      {
        $addFields: {
          orderPrice: {
            $cond: [
              { $gte: ["$netQty", 0] },
              { $ifNull: [{ $arrayElemAt: ["$stockInfo.BuyPrice", 0] }, 0] },
              { $ifNull: [{ $arrayElemAt: ["$stockInfo.SellPrice", 0] }, 0] },
            ],
          },
          totalm2m: { $subtract: ["$sellNetPrice", "$buyNetPrice"] },
        },
      },

      // Final M2M (same formula used in clientStockByMaster)
      {
        $addFields: {
          m2m: {
            $cond: [
              { $gte: ["$totalm2m", 0] },
              {
                $subtract: [
                  "$totalm2m",
                  { $multiply: ["$absQty", "$orderPrice"] },
                ],
              },
              {
                $add: ["$totalm2m", { $multiply: ["$absQty", "$orderPrice"] }],
              },
            ],
          },
        },
      },

      // Final output
      {
        $project: {
          _id: 0,
          label: "$_id",

          // same totalTxn you had
          totalTxn: { $round: ["$netQty", 2] },

          // new calculated totalM2M
          totalM2M: { $round: ["$m2m", 2] },
        },
      },
    ];

    const result = await StockTransaction.aggregate(pipeline);

    if (label) return result.length ? result[0] : null;

    return result;
  } catch (error) {
    console.error("Error fetching data:", error);
    throw error;
  }
};

exports.clientStockByMaster = async (matchFilter, level, isRequesterDemo = false) => {
  try {
    const pipeline = [
      // 0️⃣ Match Filter
      { $match: matchFilter },

      // 1️⃣ Group at USER + SCRIPT level
      {
        $group: {
          _id: {
            userId: "$userId",
            scriptId: "$scriptId",
            label: "$label",
          },
          label: { $first: "$label" },
          scriptId: { $first: "$scriptId" },
          scriptName: { $first: "$scriptName" },
          marketName: { $first: "$marketName" },
          buyQty: {
            $sum: {
              $cond: [{ $eq: ["$transactionType", "BUY"] }, "$quantity", 0],
            },
          },
          sellQty: {
            $sum: {
              $cond: [{ $eq: ["$transactionType", "SELL"] }, "$quantity", 0],
            },
          },
          buyLot: {
            $sum: {
              $cond: [{ $eq: ["$transactionType", "BUY"] }, "$lot", 0],
            },
          },
          sellLot: {
            $sum: {
              $cond: [{ $eq: ["$transactionType", "SELL"] }, "$lot", 0],
            },
          },
          buyNetPrice: {
            $sum: {
              $cond: [
                { $eq: ["$transactionType", "BUY"] },
                "$totalNetPrice",
                0,
              ],
            },
          },
          sellNetPrice: {
            $sum: {
              $cond: [
                { $eq: ["$transactionType", "SELL"] },
                "$totalNetPrice",
                0,
              ],
            },
          },
        },
      },

      // 2️⃣ Net qty (same as remainingQty in getDownlineSummaryReport)
      {
        $addFields: {
          netQty: { $subtract: ["$buyQty", "$sellQty"] },
          absQty: { $abs: { $subtract: ["$buyQty", "$sellQty"] } },
          netLot: { $subtract: ["$buyLot", "$sellLot"] },
        },
      },

      // 3️⃣ Live price lookup
      {
        $lookup: {
          from: "stocks",
          localField: "scriptName",
          foreignField: "InstrumentIdentifier",
          as: "stockInfo",
        },
      },

      // 3.5️⃣ User Lookup for Demo Filter and Partnership
      {
        $lookup: {
          from: "users",
          localField: "_id.userId",
          foreignField: "_id",
          pipeline: [
            {
              $project: {
                _id: 0,
                partnership: 1,
                demoid: 1,
                isDeleted: 1,
              },
            },
          ],
          as: "userInfo",
        },
      },
      {
        $addFields: {
          userInfo: { $arrayElemAt: ["$userInfo", 0] },
        },
      },
      {
        $match: {
          $and: [
            isRequesterDemo
              ? { "userInfo.demoid": true }
              : {
                $or: [
                  { "userInfo.demoid": { $ne: true } },
                  { "userInfo.demoid": { $exists: false } },
                  { userInfo: null },
                ],
              },
            {
              $or: [{ "userInfo.isDeleted": false }, { userInfo: null }],
            },
          ],
        },
      },

      // 4️⃣ Order price & Data prep (same logic as getDownlineSummaryReport)
      {
        $addFields: {
          orderPrice: {
            $cond: [
              { $gte: ["$netQty", 0] },
              { $ifNull: [{ $arrayElemAt: ["$stockInfo.BuyPrice", 0] }, 0] },
              { $ifNull: [{ $arrayElemAt: ["$stockInfo.SellPrice", 0] }, 0] },
            ],
          },
          totalm2m: { $subtract: ["$sellNetPrice", "$buyNetPrice"] },
        },
      },

      // 5️⃣ Calculate M2M (same formula as getDownlineSummaryReport)
      {
        $addFields: {
          m2m: {
            $cond: [
              { $gte: ["$totalm2m", 0] },
              {
                $subtract: [
                  "$totalm2m",
                  { $multiply: ["$absQty", "$orderPrice"] },
                ],
              },
              {
                $add: ["$totalm2m", { $multiply: ["$absQty", "$orderPrice"] }],
              },
            ],
          },
          // Partnership Share (myIndex same as getDownlineSummaryReport)
          myIndex: {
            $cond: [
              { $gt: [level, 0] },
              {
                $ifNull: [
                  { $arrayElemAt: ["$userInfo.partnership", level - 1] },
                  0,
                ],
              },
              0,
            ],
          },
        },
      },

      // 6️⃣ Project & Calculate totalTxn and totalM2M (matching selfQty and selfNetPrice)
      {
        $project: {
          label: 1,
          scriptId: 1,
          label: 1,
          // totalTxn matches selfQty: (marketPreferredQty * myIndex) / 100
          totalTxn: {
            $divide: [
              {
                $multiply: [
                  {
                    $cond: [
                      { $in: ["$marketName", ["NSE", "INDEX"]] },
                      "$netQty",
                      "$netLot",
                    ],
                  },
                  "$myIndex",
                ],
              },
              100,
            ],
          },
          // totalM2M matches selfNetPrice: (m2m * myIndex * -1) / 100
          totalM2M: {
            $divide: [{ $multiply: ["$m2m", "$myIndex", -1] }, 100],
          },
        },
      },

      // 7️⃣ FINAL GROUP by LABEL + SCRIPTID (unique by both)
      {
        $group: {
          _id: {
            label: "$label",
            scriptId: "$scriptId",
          },
          label: { $first: "$label" },
          scriptId: { $first: "$scriptId" },
          totalTxn: { $sum: "$totalTxn" },
          totalM2M: { $sum: "$totalM2M" },
        },
      },

      // 8️⃣ Rounding and final projection
      {
        $project: {
          _id: 0,
          label: 1,
          scriptId: 1,
          totalTxn: { $round: ["$totalTxn", 2] },
          totalM2M: { $round: ["$totalM2M", 2] },
        },
      },
    ];

    const result = await StockTransaction.aggregate(pipeline);
    return result;
  } catch (error) {
    console.error("Error fetching data:", error);
    throw error;
  }
};
exports.saveStockTransactions = async (details) => {
  try {
    return await StockTransaction.create(details);
  } catch (error) {
    console.error("Error fetching data:", error);
    throw error;
  }
};

exports.getClientProfitLossReport = async (getValan) => {
  try {
    const match = { transactionStatus: "COMPLETED", valanId: getValan._id };
    const response = await getProfitLossReport(match);

    // Process each document to compute brokerwise net brokerage
    response.forEach((doc) => {
      const brokerwiseNetBrokerage = {};
      doc.allOtherBrokerage.forEach((ob) => {
        for (const [key, val] of Object.entries(ob)) {
          if (key === "totalOrderBrokerage" || key === "totalBrokerPercentage")
            continue;
          const net = val?.netBrokerage || 0;
          const partnership = val?.partnership || 0;
          if (!brokerwiseNetBrokerage[key]) {
            brokerwiseNetBrokerage[key] = { brokerage: 0, myShare: 0 };
          }
          brokerwiseNetBrokerage[key].brokerage += net;
          if (brokerwiseNetBrokerage[key].myShare === 0) {
            brokerwiseNetBrokerage[key].myShare +=
              (doc.m2m * partnership * -1) / 100;
          }
        }
      });
      doc.otherBrokerShare = brokerwiseNetBrokerage;
      delete doc.allOtherBrokerage;
    });

    // Append valan details and create ledger entries
    const newResponse = response.map((item) => ({
      ...item,
      valanId: getValan._id,
      valanName: getValan.label,
    }));
    const ledgerResponse = newResponse.map(
      ({
        parentIds,
        brokerIds,
        scriptId,
        scriptName,
        marketId,
        marketName,
        label,
        valanId,
        valanName,
        m2m,
        otherBrokerShare,
        userId,
      }) => ({
        parentIds,
        brokerIds,
        scriptId,
        scriptName,
        marketId,
        marketName,
        label,
        valanId,
        valanName,
        amount: m2m,
        uplineAmount: -m2m,
        downlineAmount: 0,
        otherBrokerShare,
        userId,
        transactionType: "BILL",
        level: 7,
      }),
    );

    await saveReport(newResponse);
    await saveLedger(ledgerResponse);
    await generateMasterReport(newResponse);
    await generateBrokerReport(newResponse);

    //update valan report status: billStatus: true
  } catch (error) {
    console.error("Error in getClientProfitLossReport:", error);
  }
};

const generateMasterReport = async (reports) => {
  try {
    const parentIds = [...new Set(reports.flatMap((doc) => doc.parentIds))];
    const masters = await userModel
      .find({ _id: { $in: parentIds } })
      .populate("accountType", "label level")
      .select({ accountName: 1, accountCode: 1, accountType: 1, parentIds: 1 })
      .lean();

    for (let master of masters) {
      const level = master.accountType.level;
      const getReport = reports.filter((rep) =>
        rep.parentIds.some((id) => areObjectIdsEqual(id, master._id)),
      );
      const groupedData = getReport.reduce((acc, record) => {
        const {
          scriptId,
          scriptName,
          marketId,
          marketName,
          label,
          valanId,
          valanName,
          uplineM2M,
          otherBrokerShare,
        } = record;
        const value = uplineM2M[level - 1] || 0;
        if (!acc[marketId]) {
          acc[marketId] = {
            scriptId,
            scriptName,
            marketId,
            marketName,
            label,
            valanId,
            valanName,
            amount: 0,
            uplineAmount: 0,
            downlineAmount: 0,
            userId: master._id,
            transactionType: "BILL",
            level,
            parentIds: master.parentIds,
            otherBrokerShare: {},
            brokerIds: [],
          };
        }
        acc[marketId].amount += value;
        acc[marketId].uplineAmount += sumFirstN(uplineM2M, 0, level - 1);
        acc[marketId].downlineAmount += sumFirstN(
          uplineM2M,
          level,
          uplineM2M.length,
        );
        for (let bkg in otherBrokerShare) {
          if (!acc[marketId].otherBrokerShare[bkg]) {
            acc[marketId].otherBrokerShare[bkg] = { brokerage: 0, myShare: 0 };
            acc[marketId].brokerIds.push(new mongoose.Types.ObjectId(bkg));
          }
          acc[marketId].otherBrokerShare[bkg].brokerage +=
            otherBrokerShare[bkg].brokerage;
          acc[marketId].otherBrokerShare[bkg].myShare +=
            otherBrokerShare[bkg].myShare;
        }
        acc[marketId].brokerIds = [...new Set(acc[marketId].brokerIds)];
        return acc;
      }, {});
      const ledger = Object.values(groupedData);
      await saveLedger(ledger);
    }
  } catch (error) {
    console.error("Error in generateMasterReport:", error);
  }
};

// const generateBrokerReport = async (reports) => {
//   try {
//     const brokerIds = [...new Set(reports.flatMap((doc) => doc.brokerIds))];
//     const brokers = await userModel
//       .find({ _id: { $in: brokerIds } })
//       .populate("accountType", "label level")
//       .select({ accountName: 1, accountCode: 1, accountType: 1, parentIds: 1 })
//       .lean();

//     for (let broker of brokers) {
//       const level = broker.accountType.level;
//       const getReport = reports.filter((rep) =>
//         rep.brokerIds.some((id) => areObjectIdsEqual(id, broker._id)),
//       );
//       const groupedData = getReport.reduce((acc, record) => {
//         const {
//           scriptId,
//           scriptName,
//           marketId,
//           marketName,
//           label,
//           valanId,
//           valanName,
//           uplineM2M,
//           otherBrokerShare,
//         } = record;
//         const value = uplineM2M[level - 1] || 0;
//         if (!acc[marketId]) {
//           acc[marketId] = {
//             scriptId,
//             scriptName,
//             marketId,
//             marketName,
//             label,
//             valanId,
//             valanName,
//             amount: 0,
//             uplineAmount: 0,
//             downlineAmount: 0,
//             userId: broker._id,
//             transactionType: "BILL",
//             level,
//             parentIds: broker.parentIds,
//             otherBrokerShare: {},
//             brokerIds: [broker._id],
//           };
//         }
//         if (otherBrokerShare[broker._id.toString()]) {
//           acc[marketId].amount +=
//             otherBrokerShare[broker._id.toString()].myShare;
//         }
//         acc[marketId].uplineAmount += sumFirstN(uplineM2M, 0, level - 1);
//         acc[marketId].downlineAmount += sumFirstN(
//           uplineM2M,
//           level,
//           uplineM2M.length,
//         );
//         for (let bkg in otherBrokerShare) {
//           if (bkg === broker._id.toString()) {
//             if (!acc[marketId].otherBrokerShare[bkg]) {
//               acc[marketId].otherBrokerShare[bkg] = {
//                 brokerage: 0,
//                 myShare: 0,
//               };
//               acc[marketId].brokerIds.push(new mongoose.Types.ObjectId(bkg));
//             }
//             acc[marketId].otherBrokerShare[bkg].brokerage +=
//               otherBrokerShare[bkg].brokerage;
//             acc[marketId].otherBrokerShare[bkg].myShare +=
//               otherBrokerShare[bkg].myShare;
//           }
//         }
//         return acc;
//       }, {});
//       const ledger = Object.values(groupedData);
//       await saveLedger(ledger);
//     }
//   } catch (error) {
//     console.error("Error in generateBrokerReport:", error);
//   }
// };

// const areObjectIdsEqual = (id1, id2) => id1.toString() === id2.toString();

// function sumFirstN(arr, start, end) {
//   return arr.slice(start, end).reduce((acc, val) => acc + val, 0);
// }

//         acc[marketId].downlineAmount += sumFirstN(
//           uplineM2M,
//           level,
//           uplineM2M.length,
//         );
//         for (let bkg in otherBrokerShare) {
//           if (!acc[marketId].otherBrokerShare[bkg]) {
//             acc[marketId].otherBrokerShare[bkg] = { brokerage: 0, myShare: 0 };
//             acc[marketId].brokerIds.push(new mongoose.Types.ObjectId(bkg));
//           }
//           acc[marketId].otherBrokerShare[bkg].brokerage +=
//             otherBrokerShare[bkg].brokerage;
//           acc[marketId].otherBrokerShare[bkg].myShare +=
//             otherBrokerShare[bkg].myShare;
//         }
//         acc[marketId].brokerIds = [...new Set(acc[marketId].brokerIds)];
//         return acc;
//       }, {});
//       const ledger = Object.values(groupedData);
//       await saveLedger(ledger);
//     }
//   } catch (error) {
//     console.error("Error in generateMasterReport:", error);
//   }
// };

const generateBrokerReport = async (reports) => {
  try {
    const brokerIds = [...new Set(reports.flatMap((doc) => doc.brokerIds))];
    const brokers = await userModel
      .find({ _id: { $in: brokerIds } })
      .populate("accountType", "label level")
      .select({ accountName: 1, accountCode: 1, accountType: 1, parentIds: 1 })
      .lean();

    for (let broker of brokers) {
      const level = broker.accountType.level;
      const getReport = reports.filter((rep) =>
        rep.brokerIds.some((id) => areObjectIdsEqual(id, broker._id)),
      );
      const groupedData = getReport.reduce((acc, record) => {
        const {
          scriptId,
          scriptName,
          marketId,
          marketName,
          label,
          valanId,
          valanName,
          uplineM2M,
          otherBrokerShare,
        } = record;
        const value = uplineM2M[level - 1] || 0;
        if (!acc[marketId]) {
          acc[marketId] = {
            scriptId,
            scriptName,
            marketId,
            marketName,
            label,
            valanId,
            valanName,
            amount: 0,
            uplineAmount: 0,
            downlineAmount: 0,
            userId: broker._id,
            transactionType: "BILL",
            level,
            parentIds: broker.parentIds,
            otherBrokerShare: {},
            brokerIds: [broker._id],
          };
        }
        if (otherBrokerShare[broker._id.toString()]) {
          acc[marketId].amount +=
            otherBrokerShare[broker._id.toString()].myShare;
        }
        acc[marketId].uplineAmount += sumFirstN(uplineM2M, 0, level - 1);
        acc[marketId].downlineAmount += sumFirstN(
          uplineM2M,
          level,
          uplineM2M.length,
        );
        for (let bkg in otherBrokerShare) {
          if (bkg === broker._id.toString()) {
            if (!acc[marketId].otherBrokerShare[bkg]) {
              acc[marketId].otherBrokerShare[bkg] = {
                brokerage: 0,
                myShare: 0,
              };
              acc[marketId].brokerIds.push(new mongoose.Types.ObjectId(bkg));
            }
            acc[marketId].otherBrokerShare[bkg].brokerage +=
              otherBrokerShare[bkg].brokerage;
            acc[marketId].otherBrokerShare[bkg].myShare +=
              otherBrokerShare[bkg].myShare;
          }
        }
        return acc;
      }, {});
      const ledger = Object.values(groupedData);
      await saveLedger(ledger);
    }
  } catch (error) {
    console.error("Error in generateBrokerReport:", error);
  }
};

const areObjectIdsEqual = (id1, id2) => id1.toString() === id2.toString();

function sumFirstN(arr, start, end) {
  return arr.slice(start, end).reduce((acc, val) => acc + val, 0);
}

// ─── NSE-EQ LOAN INTEREST HELPER ──────────────────────────────────────────────

/**
 * Returns a map of { userId -> totalInterest } for NSE-EQ interest records
 * accumulated between startDate and endDate (both inclusive, format 'YYYY-MM-DD').
 * If endDate is not provided it defaults to today.
 *
 * @param {string[]} userIds  - array of user ObjectId strings
 * @param {string} [startDate] - 'YYYY-MM-DD' (optional – no lower bound if omitted)
 * @param {string} [endDate]   - 'YYYY-MM-DD' (defaults to today)
 * @returns {Promise<Map<string, number>>}
 */
exports.getNseEqInterestMap = async (userIds, startDate, endDate) => {
  try {
    const NseEqInterestModel = require('../models/NseEqInterestModel');
    const moment = require('moment');

    const toDate = endDate || moment().format('YYYY-MM-DD');
    const matchStage = {
      userId: { $in: userIds.map(id => new mongoose.Types.ObjectId(id)) }
    };
    if (startDate) matchStage.date = { $gte: startDate, $lte: toDate };
    else matchStage.date = { $lte: toDate };

    const rows = await NseEqInterestModel.aggregate([
      { $match: matchStage },
      {
        $group: {
          _id: '$userId',
          totalInterest: { $sum: '$interestAmount' }
        }
      }
    ]);

    const interestMap = new Map();
    rows.forEach(r => interestMap.set(r._id.toString(), r.totalInterest));
    return interestMap;
  } catch (err) {
    console.error('[getNseEqInterestMap] error:', err.message);
    return new Map();
  }
};

/**
 * Recalculates and saves final bills for all users for a given valan and market.
 * Used during the bill generation process after all CF/BF entries are saved.
 */
exports.generateFinalBills = async (valanId, marketId, options = {}) => {
  try {
    const valan = await WeekValanModel.findById(valanId).lean();
    if (!valan) throw new Error("Valan not found");

    // Skip current active Valan if not explicitly forced (for safety during general API calls)
    if (valan.status === true && !options.force) {
      // console.log(`[generateFinalBills] Skipping active Valan ${valanId} for market ${marketId}`);
      return;
    }

    // We use level 1 (Super Admin perspective) to get all users in the system at once
    const match = {
      transactionStatus: "COMPLETED",
      valanId: new mongoose.Types.ObjectId(valanId),
      marketId: String(marketId)
    };

    // Calculate profit/loss using the canonical JS-level logic for parity with reports
    const { data: results } = await exports.getProfitLossWithLivePrices(match, 1, null);

    if (!results || results.length === 0) {
      // console.log(`[generateFinalBills] No trades found for Valan ${valanId} in market ${marketId}`);
      return;
    }

    // Map all brokers to their levels for accurate margin matching
    const allBrokerIds = [...new Set(results.flatMap(row => Array.isArray(row.brokerIds) ? row.brokerIds : []))];
    const brokersInfo = await userModel.find({ _id: { $in: allBrokerIds } }).populate('accountType', 'level').lean();
    const brokerLevelMap = new Map();
    brokersInfo.forEach(b => brokerLevelMap.set(b._id.toString(), b.accountType?.level));

    const bulkOps = results.map(row => {
      // 1. Calculate Brokerage Details (Per-broker sum)
      const brokerDetails = (row?.summedOtherBrokerage || []).reduce((acc, bObj) => {
        if (bObj && bIdStrObj(bObj.brokerId)) {
          const bid = bIdStrObj(bObj.brokerId);
          const existing = acc.find(e => e.brokerId.toString() === bid);
          if (existing) existing.amount += (bObj.netBrokerage || 0);
          else acc.push({ brokerId: new mongoose.Types.ObjectId(bid), amount: (bObj.netBrokerage || 0) });
        }
        return acc;
      }, []);

      function bIdStrObj(id) {
        if (!id) return null;
        return id._id ? id._id.toString() : id.toString();
      }

      // 2. Calculate Broker Margin Details (Based on Partnership)
      const userPartnership = Array.isArray(row.userInfo?.partnership) ? row.userInfo.partnership : [];
      const rowBrokerIds = Array.isArray(row.brokerIds) ? row.brokerIds : [];

      const brokerMarginDetails = [];
      let totalBrokerMargin = 0;

      rowBrokerIds.forEach(bId => {
        const bIdStr = bId.toString();
        const level = brokerLevelMap.get(bIdStr);
        // Only levels 5 and 6 are considered "Brokers" for margin deduction
        if (level && level >= 5 && level <= 6) {
          const sharePercent = Number(userPartnership[level - 1]) || 0;
          if (sharePercent > 0) {
            const marginAmount = (Number(row.m2m) || 0) * (sharePercent / 100);
            brokerMarginDetails.push({
              brokerId: new mongoose.Types.ObjectId(bIdStr),
              amount: marginAmount
            });
            totalBrokerMargin += marginAmount;
          }
        }
      });

      const billData = {
        userId: row.userId,
        valanId: new mongoose.Types.ObjectId(valanId),
        marketId: String(marketId),
        grossTotal: Number(row?.gross || 0),
        clientBrokerage: Number(row?.brokerage || 0),
        totalBrokerage: Number(row?.brokerBrokerage || 0),
        brokerDetails: brokerDetails,
        brokerMarginDetails: brokerMarginDetails,
        totalBrokerMargin: totalBrokerMargin,
        billAmount: Number(row?.bill || 0),
        totalM2M: Number(row?.m2m || 0)
      };

      return {
        updateOne: {
          filter: { userId: row.userId, valanId: billData.valanId, marketId: billData.marketId },
          update: { $set: billData },
          upsert: true
        }
      };
    });

    if (bulkOps.length > 0) {
      await FinalBillModel.bulkWrite(bulkOps);
    }

  } catch (error) {
    console.error("[generateFinalBills] Error:", error.message);
    throw error;
  }
};

/**
 * Deletes final bills for a given valan and market.
 * Used during the bill revert process.
 */
exports.deleteFinalBills = async (valanId, marketId) => {
  try {
    await FinalBillModel.deleteMany({
      valanId: new mongoose.Types.ObjectId(valanId),
      marketId: String(marketId)
    });
  } catch (error) {
    console.error("[deleteFinalBills] Error:", error.message);
    throw error;
  }
};

/**
 * Recalculates the final bill for a specific user, valan, and market.
 * Used when a previous valan's trade is edited.
 */
exports.recalculateFinalBill = async (userId, valanId, marketId) => {
  try {
    // Only recalculate if a final bill already exists (meaning the bill was already generated)
    const existing = await FinalBillModel.findOne({ userId, valanId, marketId }).lean();
    if (!existing) return;

    const match = {
      userId: new mongoose.Types.ObjectId(userId),
      transactionStatus: "COMPLETED",
      valanId: new mongoose.Types.ObjectId(valanId),
      marketId: String(marketId)
    };

    // Recalculate from perspective of Level 1 to get full brokerage details
    const results = await exports.getProfitLoss(match, 1, null, { scriptLevelOnly: false });
    const row = results.find(r => r.userId.toString() === userId.toString());

    if (!row) {
      // If no trades remain, we can either delete or zero out the bill. 
      // User said "delte those entries for current valan" in revert, 
      // but for edit, "recalculate the final bill and set those values again".
      await FinalBillModel.deleteOne({ userId, valanId, marketId });
      return;
    }

    // Fetch Broker levels for recalculate
    const brokerIdsArr = Array.isArray(row.brokerIds) ? row.brokerIds : [];
    const brokersInfo = await userModel.find({ _id: { $in: brokerIdsArr } }).populate('accountType', 'level').lean();
    const brokerLevelMapRecalc = new Map();
    brokersInfo.forEach(b => brokerLevelMapRecalc.set(b._id.toString(), b.accountType?.level));

    const userPartnership = Array.isArray(row.userInfo?.partnership) ? row.userInfo.partnership : [];
    const brokerMarginDetails = [];
    let totalBrokerMargin = 0;

    brokerIdsArr.forEach(bId => {
      const bIdStr = bId.toString();
      const level = brokerLevelMapRecalc.get(bIdStr);
      if (level && level >= 5 && level <= 6) {
        const sharePercent = Number(userPartnership[level - 1]) || 0;
        if (sharePercent > 0) {
          const mAmount = (Number(row.m2m) || 0) * (sharePercent / 100);
          brokerMarginDetails.push({ brokerId: new mongoose.Types.ObjectId(bIdStr), amount: mAmount });
          totalBrokerMargin += mAmount;
        }
      }
    });

    const updatedBill = {
      grossTotal: Number(row.gross) || 0,
      clientBrokerage: Number(row.brokerage) || 0,
      totalBrokerage: Number(row.brokerBrokerage) || 0,
      brokerDetails: brokerDetails,
      brokerMarginDetails: brokerMarginDetails,
      totalBrokerMargin: totalBrokerMargin,
      billAmount: Number(row.bill) || 0,
      totalM2M: Number(row.m2m) || 0
    };

    await FinalBillModel.findByIdAndUpdate(existing._id, updatedBill);
  } catch (error) {
    console.error("[recalculateFinalBill] Error:", error.message);
  }
};

exports.recalculateUserPositions = async (userId, valanId) => {
  try {
    const uId = new mongoose.Types.ObjectId(userId);
    const vId = new mongoose.Types.ObjectId(valanId);

    // Get all unique scripts for this user in this valan
    const scripts = await StockTransaction.aggregate([
      {
        $match: {
          userId: uId,
          valanId: vId,
          transactionStatus: 'COMPLETED'
        }
      },
      {
        $group: {
          _id: {
            scriptId: '$scriptId',
            marketId: '$marketId',
            scriptName: '$scriptName',
            marketName: '$marketName'
          }
        }
      },
      {
        $sort: { '_id.marketId': 1, '_id.scriptName': 1 }
      }
    ]);

    if (scripts.length === 0) {
      return {
        message: 'No transactions found for this user and valan',
        recalculated: 0,
        total: 0,
        scripts: []
      };
    }

    // Recalculate position for each script
    let recalculated = 0;
    const errors = [];
    const recalculatedScripts = [];

    for (const script of scripts) {
      try {
        await exports.setUserPosition(userId, script._id.scriptId, valanId, false);
        recalculated++;
        recalculatedScripts.push({
          scriptId: script._id.scriptId,
          scriptName: script._id.scriptName,
          marketId: script._id.marketId,
          marketName: script._id.marketName,
          status: 'success'
        });
      } catch (error) {
        console.error(`Error recalculating position for script ${script._id.scriptId}:`, error);
        errors.push({
          scriptId: script._id.scriptId,
          scriptName: script._id.scriptName,
          marketId: script._id.marketId,
          marketName: script._id.marketName,
          error: error.message,
          status: 'failed'
        });
      }
    }

    return {
      message: `Successfully recalculated ${recalculated} out of ${scripts.length} positions`,
      recalculated,
      total: scripts.length,
      scripts: recalculatedScripts,
      errors: errors.length > 0 ? errors : undefined
    };
  } catch (error) {
    console.error('Error in recalculateUserPositions service:', error);
    throw error;
  }
};

/**
 * Transaction Analysis Service
 * Analyzes stock transactions based on date ranges or valan IDs
 * 
 * @param {Object} params - Analysis parameters
 * @param {string} params.scriptName - Script name (required)
 * @param {string} params.marketId - Market ID (required)
 * @param {string} params.effectiveUserId - Effective user ID for downline filtering (required)
 * @param {number} params.level - User account level (required)
 * @param {string} params.startDate - Start date (YYYY-MM-DD)
 * @param {string} params.endDate - End date (YYYY-MM-DD)
 * @param {string} params.valanId - Single valan ID
 * @param {Array<string>} params.valanIds - Multiple valan IDs
 * @param {string} params.userId - User ID filter (optional)
 * 
 * @returns {Object} Analysis data with period comparison and totals
 */
exports.getTransactionAnalysis = async ({
  startDate,
  endDate,
  valanId,
  valanIds,
  scriptName,
  marketId,
  effectiveUserId,
  level,
  userId
}) => {
  try {
    // Build match filter
    const matchFilter = {
      scriptName: scriptName,
      marketId: marketId,
      transactionStatus: 'COMPLETED'
    };

    // Filter by downline + self based on user level
    const effectiveUserIdObj = new mongoose.Types.ObjectId(effectiveUserId);

    if (level === 7) {
      // Client level - only their own transactions
      matchFilter.userId = effectiveUserIdObj;
    } else if (level === 6) {
      // Broker level - their downline + self
      matchFilter.brokerIds = effectiveUserIdObj;
    } else {
      // Master/Admin level - their downline + self
      matchFilter.parentIds = effectiveUserIdObj;
    }

    // Additional userId filter if provided (must be within downline)
    if (userId) {
      matchFilter.userId = new mongoose.Types.ObjectId(userId);
    }

    let groupBy = null;
    let comparisonType = null;

    // Priority 1: Date range (ignore valan if dates are provided)
    if (startDate && endDate) {
      const start = new Date(startDate + 'T00:00:00.000+05:30');
      const end = new Date(endDate + 'T23:59:59.999+05:30');
      matchFilter.createdAt = { $gte: start, $lte: end };
      groupBy = {
        $dateToString: { format: '%Y-%m-%d', date: '$createdAt', timezone: '+05:30' }
      };
      comparisonType = 'day-wise';
    }
    // Priority 2: Multiple valan IDs
    else if (valanIds && Array.isArray(valanIds) && valanIds.length > 0) {
      matchFilter.valanId = {
        $in: valanIds.map(id => new mongoose.Types.ObjectId(id))
      };
      groupBy = '$valanId';
      comparisonType = 'valan-wise';
    }
    // Priority 3: Single valan ID
    else if (valanId) {
      matchFilter.valanId = new mongoose.Types.ObjectId(valanId);
      groupBy = {
        $dateToString: { format: '%Y-%m-%d', date: '$createdAt', timezone: '+05:30' }
      };
      comparisonType = 'day-wise';
    }
    // Priority 4: Active valan (default)
    else {
      const activeValan = await exports.getActiveWeekValan();
      if (!activeValan) {
        throw new Error('No active valan found');
      }
      matchFilter.valanId = activeValan._id;
      groupBy = {
        $dateToString: { format: '%Y-%m-%d', date: '$createdAt', timezone: '+05:30' }
      };
      comparisonType = 'day-wise';
    }

    // Aggregation pipeline
    const pipeline = [
      { $match: matchFilter },
      {
        $group: {
          _id: groupBy,
          buyCount: {
            $sum: {
              $cond: [{ $eq: ['$transactionType', 'BUY'] }, 1, 0]
            }
          },
          sellCount: {
            $sum: {
              $cond: [{ $eq: ['$transactionType', 'SELL'] }, 1, 0]
            }
          },
          buyQuantity: {
            $sum: {
              $cond: [{ $eq: ['$transactionType', 'BUY'] }, '$quantity', 0]
            }
          },
          sellQuantity: {
            $sum: {
              $cond: [{ $eq: ['$transactionType', 'SELL'] }, '$quantity', 0]
            }
          },
          avgBuyPrice: {
            $avg: {
              $cond: [{ $eq: ['$transactionType', 'BUY'] }, '$orderPrice', null]
            }
          },
          avgSellPrice: {
            $avg: {
              $cond: [{ $eq: ['$transactionType', 'SELL'] }, '$orderPrice', null]
            }
          },
          totalBuyValue: {
            $sum: {
              $cond: [{ $eq: ['$transactionType', 'BUY'] }, '$totalOrderPrice', 0]
            }
          },
          totalSellValue: {
            $sum: {
              $cond: [{ $eq: ['$transactionType', 'SELL'] }, '$totalOrderPrice', 0]
            }
          }
        }
      },
      { $sort: { _id: 1 } }
    ];

    const periodData = await StockTransaction.aggregate(pipeline);

    // Calculate totals
    const totals = {
      totalBuyTransactions: 0,
      totalSellTransactions: 0,
      totalBuyQuantity: 0,
      totalSellQuantity: 0,
      totalBuyValue: 0,
      totalSellValue: 0,
      overallAvgBuyPrice: 0,
      overallAvgSellPrice: 0
    };

    let buyPriceSum = 0;
    let buyPriceCount = 0;
    let sellPriceSum = 0;
    let sellPriceCount = 0;

    periodData.forEach(period => {
      totals.totalBuyTransactions += period.buyCount;
      totals.totalSellTransactions += period.sellCount;
      totals.totalBuyQuantity += period.buyQuantity;
      totals.totalSellQuantity += period.sellQuantity;
      totals.totalBuyValue += period.totalBuyValue;
      totals.totalSellValue += period.totalSellValue;

      if (period.avgBuyPrice) {
        buyPriceSum += period.avgBuyPrice * period.buyCount;
        buyPriceCount += period.buyCount;
      }
      if (period.avgSellPrice) {
        sellPriceSum += period.avgSellPrice * period.sellCount;
        sellPriceCount += period.sellCount;
      }
    });

    totals.overallAvgBuyPrice = buyPriceCount > 0
      ? parseFloat((buyPriceSum / buyPriceCount).toFixed(4))
      : 0;
    totals.overallAvgSellPrice = sellPriceCount > 0
      ? parseFloat((sellPriceSum / sellPriceCount).toFixed(4))
      : 0;

    // Format period data based on comparison type
    const formattedPeriodData = await Promise.all(
      periodData.map(async (period) => {
        let periodLabel = period._id;

        // If valan-wise, fetch valan details
        if (comparisonType === 'valan-wise' && period._id) {
          const valan = await WeekValanModel.findById(period._id).lean();
          if (valan) {
            periodLabel = {
              valanId: period._id,
              label: valan.label,
              startDate: moment(valan.startDate).format('YYYY-MM-DD'),
              endDate: moment(valan.endDate).format('YYYY-MM-DD')
            };
          }
        }

        return {
          period: periodLabel,
          buyTransactions: period.buyCount,
          sellTransactions: period.sellCount,
          buyQuantity: period.buyQuantity,
          sellQuantity: period.sellQuantity,
          avgBuyPrice: period.avgBuyPrice ? parseFloat(period.avgBuyPrice.toFixed(4)) : null,
          avgSellPrice: period.avgSellPrice ? parseFloat(period.avgSellPrice.toFixed(4)) : null,
          totalBuyValue: parseFloat(period.totalBuyValue.toFixed(4)),
          totalSellValue: parseFloat(period.totalSellValue.toFixed(4)),
          netQuantity: period.buyQuantity - period.sellQuantity
        };
      })
    );

    return {
      scriptName,
      marketId,
      comparisonType,
      periodData: formattedPeriodData,
      totals,
      filters: {
        startDate: startDate || null,
        endDate: endDate || null,
        valanId: valanId || null,
        valanIds: valanIds || null,
        userId: userId || null,
        marketId: marketId,
        effectiveUserId: effectiveUserId,
        level: level
      }
    };
  } catch (error) {
    console.error('Error in getTransactionAnalysis service:', error);
    throw error;
  }
};






