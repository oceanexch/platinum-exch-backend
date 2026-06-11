const mongoose = require("mongoose");
const { redisClient } = require("../config/redis");
const { getUserById, getOnlineUserIds } = require("./UserService");
const { clientStockByMasterByScript, setUserPosition, updateUserQuantity, getUserQuantity, getUserPosition, getClientStockTransactions } = require("./StockService");
const UserScript = require("../models/UserScriptModel");
const { publishScriptEvent } = require("./RedisService");

async function syncLimitTrade(trade) {
  setImmediate(async () => {
    try {
      // 1. Update User Position
      await setUserPosition(trade.userId, trade.scriptId, trade.valanId, false);

      // 2. Update User Quantity
      const checkQuantity = await getUserQuantity({
        userId: trade.userId,
        marketId: trade.marketId,
        marketName: trade.marketName,
        scriptId: trade.scriptId,
        scriptName: trade.scriptName,
        quantity: trade.quantity,
        transactionType: trade.transactionType,
      });

      await updateUserQuantity(
        { userId: trade.userId, scriptId: trade.scriptId, marketId: trade.marketId },
        { previous: checkQuantity.previous, current: checkQuantity.current }
      );

      // 3. Emit Socket Notification
      let userScript = await UserScript.findOne({
        createdBy: trade.userId,
        scriptId: trade.scriptId,
        label: trade.label,
        // valanId: trade.valanId,
      }).lean();

      if (userScript) {
        await publishScriptEvent({
          type: "SCRIPT_ADDED",
          userId: trade.userId,
          data: userScript,
        });
      }

      await StockTransactionEvent({
        userId: trade.userId,
        parentIds: trade.parentIds,
        marketId: trade.marketId,
        scriptId: trade.scriptId,
        transactionType: trade.transactionType,
        valanId: trade.valanId,
        userScriptId: userScript ? userScript._id : null,
        lot: trade.lot,
        quantity: trade.quantity,
        orderType: trade.orderType,
        price: trade.orderPrice || trade.price,
        label: trade.label,
        scriptName: trade.scriptName
      });
      await DashboardStockEvent({
        userId: trade.userId,
        parentIds: trade.parentIds,
        marketId: trade.marketId,
        scriptId: trade.scriptId,
        transactionType: trade.transactionType,
        valanId: trade.valanId,
        userScriptId: userScript ? userScript._id : null,
        lot: trade.lot,
        quantity: trade.quantity,
        orderType: trade.orderType,
        price: trade.orderPrice || trade.price,
        status: "COMPLETED",
        _id: trade._id,
        label: trade.label,
        scriptName: trade.scriptName
      });
    } catch (err) {
      console.error(`❌ Error in background syncLimitTrade for trade ${trade._id}:`, err);
    }
  });
}

// async function StockTransactionEvent({
//   userId,
//   parentIds,
//   marketId,
//   scriptId,
//   transactionType,
//   valanId,
//   userScriptId,
//   lot,
//   quantity,
//   orderType,
//   price,
//   scriptName = null,
//   label = null
// }) {
//   setImmediate(async () => {
//     try {
//       const toObjectId = (id) => {
//         if (!id || !mongoose.isValidObjectId(id)) return null;
//         try { return new mongoose.Types.ObjectId(id); } catch (e) { return null; }
//       };

//       const uId_obj = toObjectId(userId);
//       const vId_obj = toObjectId(valanId);
//       const pId_objs = (parentIds || []).map(p => toObjectId(p)).filter(Boolean);

//       // 1. Fetch base script (Strictly for this VALAN)
//       let baseScript = await UserScript.findOne({ _id: userScriptId, valanId }).lean();

//       if (!baseScript && (label || scriptName)) {
//         baseScript = await UserScript.findOne({ createdBy: userId, scriptId, label, valanId }).lean();
//         if (!baseScript) {
//           baseScript = await UserScript.findOne({ createdBy: userId, scriptId, valanId }).lean();
//         }
//       }

//       // 2. Handle missing script for downline
//       if (!baseScript) {
//         let templateScript = await UserScript.findOne({
//           createdBy: { $in: parentIds },
//           scriptId: scriptId,
//           label: label || { $exists: true }
//         }).sort({ createdAt: -1 }).lean();

//         if (!templateScript) {
//           templateScript = await UserScript.findOne({
//             createdBy: { $in: parentIds },
//             scriptId: scriptId
//           }).sort({ createdAt: -1 }).lean();
//         }

//         if (templateScript) {
//           try {
//             const clone = { ...templateScript };
//             delete clone._id;
//             delete clone.createdAt;
//             delete clone.updatedAt;
//             clone.createdBy = uId_obj;
//             clone.valanId = vId_obj;

//             const newScript = await UserScript.create(clone);
//             baseScript = (newScript && typeof newScript.toObject === "function") ? newScript.toObject() : newScript;

//             await publishScriptEvent({
//               type: "SCRIPT_ADDED",
//               userId: userId,
//               data: baseScript
//             });
//           } catch (e) {
//             console.error(`[StockTransactionEvent] ERROR adding script:`, e.message);
//           }
//         }
//       }

//       // 3. Parent loop for margin and propagation
//       const dataofscriptmargin = await Promise.all(
//         (parentIds || []).map(async (parentId) => {
//           try {
//             const pId_obj = toObjectId(parentId);
//             if (!pId_obj) return null;

//             let exists = null;
//             if (baseScript) {
//               exists = await UserScript.findOne({
//                 createdBy: parentId,
//                 scriptId: baseScript.scriptId,
//                 expiryId: baseScript.expiryId,
//                 valanId: valanId
//               }).lean();
//             }

//             if (!exists && baseScript) {
//               const clone = { ...baseScript };
//               delete clone._id;
//               delete clone.createdAt;
//               delete clone.updatedAt;
//               clone.createdBy = pId_obj;
//               clone.valanId = vId_obj;

//               const newScript = await UserScript.create(clone);
//               await publishScriptEvent({
//                 type: "SCRIPT_ADDED",
//                 userId: parentId,
//                 data: newScript
//               });
//             }

//             const matchFilter = {
//               parentIds: { $in: [pId_obj] },
//               valanId,
//               transactionStatus: "COMPLETED"
//             };

//             const parentUser = await getUserById(parentId);
//             if (!parentUser || !parentUser.accountType) return null;

//             const scriptSummary = await clientStockByMasterByScript(
//               matchFilter,
//               +parentUser.accountType.level,
//               scriptId,
//               baseScript?.label || label,
//               !!parentUser.demoid
//             );

//             return { scriptSummary, targetUser: parentId };
//           } catch (pe) {
//             console.error(`[StockTransactionEvent] ERROR in parent ${parentId}:`, pe.message);
//             return null;
//           }
//         })
//       );

//       const filteredMarginData = dataofscriptmargin.filter(Boolean);

//       // 4. Broadacst trade
//       let totalLot = 0;
//       const currentTxn = await getClientStockTransactions({
//         userId: uId_obj,
//         scriptId,
//         valanId,
//         transactionStatus: "COMPLETED"
//       }, baseScript?.label || label || "");

//       if (currentTxn) totalLot = currentTxn.totalTxn;

//       const payload = {
//         type: "ADD",
//         data: filteredMarginData,
//         meta: {
//           targetUser: userId,
//           parentIds,
//           marketId,
//           scriptId,
//           transactionType,
//           lot: totalLot,
//           quantity,
//           orderType,
//           scriptName: baseScript?.scriptName || scriptName,
//           label: baseScript?.label || label || "",
//           price: price,
//           orderPrice: price
//         }
//       };

//       await redisClient.publish("stock-transaction", JSON.stringify(payload));

//     } catch (err) {
//       console.error("❌ Background stock processing failed:", err);
//     }
//   });
// }
async function StockTransactionEvent({
  userId,
  parentIds,
  marketId,
  scriptId,
  transactionType,
  valanId,
  userScriptId,
  lot,
  quantity,
  orderType,
  price,
  scriptName = null,
  label = null
}) {
  setImmediate(async () => {
    try {
      // fetch base script ONCE

      let baseScript = await UserScript.findById(userScriptId).lean();
      // console.log("baseScript", baseScript);
      if (!baseScript && (label || scriptName)) {

        // Try strict match first
        baseScript = await UserScript.findOne({ createdBy: userId, scriptId, label }).lean();

        // Fallback: Try match by scriptId only if label match fails
        if (!baseScript) {
          baseScript = await UserScript.findOne({ createdBy: userId, scriptId }).lean();
          if (baseScript) {
            console.warn(`⚠️ userScript fallback match for ${scriptId} (Label mismatch: ${label} vs ${baseScript.label})`);
          }
        }
      }

      // Fetch the user early — needed for downline clone and parent loop
      const user = await getUserById(userId);
      // console.log("user", user);
      if (!user) {
        console.error("❌ User not found for background processing:", userId);
        return;
      }

      if (baseScript && baseScript.createdBy.toString() !== userId.toString()) {
        // console.log("baseScript not found ..!");
        // Downline user missing script — clone from a parent who has it
        const templateScript = await UserScript.findOne({
          createdBy: { $in: user.parentIds || [] },
          scriptId: scriptId
        }).sort({ createdAt: -1 }).lean();

        if (templateScript) {
          const clone = { ...templateScript };
          delete clone._id;
          delete clone.createdAt;
          delete clone.updatedAt;
          clone.createdBy = new mongoose.Types.ObjectId(userId);

          try {
            const newScript = await UserScript.create(clone);
            baseScript = newScript.toObject ? newScript.toObject() : newScript;
          } catch (e) {
            if (e.code === 11000) {
              baseScript = await UserScript.findOne({ createdBy: userId, keyIdentifier: templateScript.keyIdentifier }).lean();
            }
          }

          if (baseScript) {
            // console.log("baseScript found ..!", baseScript);
            await publishScriptEvent({ type: "SCRIPT_ADDED", userId, data: baseScript });
          }
        } else {
          console.error(`❌ No template found in parents for downline ${userId}, scriptId: ${scriptId}`);
        }
      }

      // online list cache
      const onlineUsers = await getOnlineUserIds();
      const onlineSet = new Set(onlineUsers.map(String));

      const dataofscriptmargin = await Promise.all(
        (user.parentIds || []).map(async (parentId) => {

          // --- A: ensure this parent has this script ---
          let exists = null;
          if (baseScript) {
            exists = await UserScript.findOne({
              createdBy: parentId,
              scriptId: baseScript.scriptId,
              expiryId: baseScript.expiryId,
            }).lean();
          }

          if (!exists && baseScript) {
            const clone = { ...baseScript };

            delete clone._id;
            delete clone.createdAt;
            delete clone.updatedAt;

            clone.createdBy = parentId;

            const newScript = await UserScript.create(clone);

            if (onlineSet.has(String(parentId))) {
              await publishScriptEvent({
                type: "SCRIPT_ADDED",
                userId: parentId,
                data: newScript
              });
            }
          }

          // --- B: margin summary logic (unchanged) ---
          const matchFilter = {
            parentIds: { $in: [new mongoose.Types.ObjectId(parentId)] },
            valanId,
            transactionStatus: "COMPLETED"
          };

          const parentUser = await getUserById(parentId);
          if (!parentUser || !parentUser.accountType) {
            return null;
          }
          const level = +parentUser.accountType.level;

          const scriptSummary = await clientStockByMasterByScript(
            matchFilter,
            level,
            scriptId,
            baseScript?.label || label,
            !!parentUser.demoid
          );

          return { scriptSummary, targetUser: parentId };
        })
      );

      // Filter out nulls from skipped parents
      const filteredMarginData = dataofscriptmargin.filter(d => d !== null);

      // --- Calculate Dual Lot Options ---
      let totalLot = 0;

      const currentTxn = await getClientStockTransactions({
        userId: new mongoose.Types.ObjectId(userId),
        scriptId,
        valanId,
        transactionStatus: "COMPLETED"
      }, baseScript?.label || label || "");
      if (currentTxn) {
        totalLot = currentTxn.totalTxn;
      }
      // --- C: Always publish stock transaction ---
      const payload = {
        type: "ADD",
        data: filteredMarginData,
        meta: {
          targetUser: userId,
          parentIds,
          marketId,
          scriptId,
          transactionType,
          lot: totalLot,
          quantity,
          orderType,
          scriptName: baseScript?.scriptName || scriptName,
          label: baseScript?.label || label || "",
          price: price,
          orderPrice: price
        }
      };

      await redisClient.publish("stock-transaction", JSON.stringify(payload));

    } catch (err) {
      console.error("❌ Background stock processing failed:", err);
    }
  });
}

async function DashboardStockEvent({
  userId,
  parentIds,
  marketId,
  scriptId,
  transactionType,
  valanId,
  userScriptId,
  lot,
  quantity,
  orderType,
  price,
  status = "COMPLETED",
  _id = null,
  label = null,
  scriptName = null
}) {
  setImmediate(async () => {
    try {
      const user = await getUserById(userId);
      if (!user) {
        console.warn(`[DashboardStockEvent] User not found: ${userId}`);
        return;
      }
      let userScript = null;
      if (userScriptId && mongoose.isValidObjectId(userScriptId)) {
        userScript = await UserScript.findById(userScriptId).lean();
      }

      if (!userScript && (label || scriptId)) {
        userScript = await UserScript.findOne({ createdBy: userId, scriptId, label }).lean();
        if (!userScript) {
          userScript = await UserScript.findOne({ createdBy: userId, scriptId }).lean();
        }
      }

      let type = "COMPLETED_TRADE";
      if (status === "PENDING") type = "PENDING_TRADE";
      if (status === "DELETED") type = "DELETED_TRADE";

      const payload = {
        type: type,
        data: {
          _id,
          userId,
          username: user.accountName,
          accountcode: user.accountCode,
          parentIds,
          marketId,
          scriptId,
          scriptName: userScript?.scriptName || scriptName,
          label: userScript?.label || label,
          transactionType,
          orderType,
          valanId,
          userScriptId: userScript?._id || userScriptId,
          lot,
          quantity,
          price,
          status,
          createdby: user.createdBy,
          time: new Date()
        }
      };

      await redisClient.publish("dashboard-stock-event", JSON.stringify(payload));
    } catch (err) {
      console.error("❌ DashboardStockEvent failed:", err);
    }
  });
}



async function LimitTradeExecutedEvent({
  userId,
  parentIds,
  marketId,
  scriptId,
  scriptName,
  label,
  transactionType,
  lot,
  quantity,
  price,
  orderPrice,
  orderType,
  message,
}) {
  try {
    const user = await getUserById(userId);
    const payload = {
      userId,
      accountCode: user?.accountCode || "",
      accountName: user?.accountName || "",
      parentIds,
      marketId,
      scriptId,
      scriptName,
      label,
      transactionType,
      lot,
      quantity,
      price,
      orderPrice,
      orderType,
      message,
    };
    await redisClient.publish("limit-order-executed", JSON.stringify(payload));
  } catch (err) {
    console.error("❌ LimitTradeExecutedEvent failed:", err);
  }
}

async function publishM2MEvent({ userId, parentIds, type, data }) {
  setImmediate(async () => {
    try {
      const payload = {
        type, // e.g., 'ALERT', 'BREACH', 'SQUARE_OFF_STARTED', 'SQUARE_OFF_COMPLETED'
        userId,
        parentIds,
        data: {
          ...data,
          _emittedAt: Date.now()
        }
      };

      // Publish to system-wide M2M_EVENTS channel
      await redisClient.publish("M2M_EVENTS", JSON.stringify(payload));
    } catch (err) {
      console.error("❌ publishM2MEvent failed:", err);
    }
  });
}

async function PositionUpdateEvent({ userId, parentIds, position, accountCode, accountName }) {
  setImmediate(async () => {
    try {
      const payload = {
        userId,
        accountCode: accountCode || "",
        accountName: accountName || "",
        parentIds: parentIds || [],
        ...position,
      };
      await redisClient.publish("position-update", JSON.stringify(payload));
    } catch (err) {
      console.error("❌ PositionUpdateEvent failed:", err);
    }
  });
}

module.exports = { StockTransactionEvent, syncLimitTrade, DashboardStockEvent, publishM2MEvent, LimitTradeExecutedEvent, PositionUpdateEvent };
