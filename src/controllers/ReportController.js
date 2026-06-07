const {
  getLedgers,
  getLedgerList,
  saveCashLedger,
  getCashLedger,
  deleteCashLedger,
  updateCashLedger,
  saveDepositWithdraw,
  getDepositWithdraw,
  updateDepositWithdraw,
  deleteDepositWithdraw,
  getUserCashLedger,
  getDownlineCashLedger,
  saveJVLedger,
  getJVLedger,
  deleteJVLedger,
  updateJVLedger,
  getJVLedgerList,
  getCombineLedger,
} = require("../services/ProfitLossService");

// getBaseScriptName is now imported from StockUtils.js
const {
  getLedgerLog,
  getRejectionLog,
  getTradeLog,
  getUserEditLog,
  getUserEditLogDetail,
  getLoginLog,
  getQuantitySettingLog,
  saveLog,
} = require("../services/LogService");
const {
  getCurrentDateRange,
  getFilterStockTransaction,
  getFilterStockTransactions,
} = require("../services/StockService");
const {
  noActiveUsers,
  activeUsers,
  sameIpReport,
  getActiveWeekValan,
  deactivateAllNoActiveUsers,
  deleteTradeRecord,
  getProfitLoss,
  getProfitLossWithLivePrices,
} = require("../services/StockService");
const { MARKET_NAMES, CONVERSION_MARKET_IDS } = require("../config/marketConstants");
const { hgetall } = require("../services/RedisService");
const mongoose = require("mongoose");
const moment = require("moment");

// COMEX_MARKET_IDS: market IDs whose values are in USD and need currency conversion
const COMEX_MARKET_IDS = new Set(CONVERSION_MARKET_IDS || ["6", "7"]); 

// Get USD->INR conversion rate for a given market from the currencyMap
// Mirrors the exact lookup pattern used in StockService.getProfitLossWithLivePrices
const getCurrencyRate = (currencyMap, marketId, marketName) => {
  if (!COMEX_MARKET_IDS.has(String(marketId))) return 1;
  return Number(
    currencyMap[String(marketId)] ||
    currencyMap[marketName] ||
    currencyMap[marketName?.toUpperCase()] ||
    currencyMap[marketName?.toLowerCase()] ||
    currencyMap["dollar"] ||
    currencyMap["Dollar"] ||
    currencyMap["DOLLAR"] ||
    currencyMap["usd"] ||
    currencyMap["USD"] ||
    90  // fallback if Redis has no rate
  );
};

const getMarketGroupName = (marketId) => {
  const mId = String(marketId);
  if (mId === "12") return "NSE_EQ";
  if ((CONVERSION_MARKET_IDS || ["6", "7", "8", "9", "11"]).includes(mId)) return "COMEX";
  return "NSE_FO"; 
};
const UserModel = require("../models/UserModel");
const WeekValanModel = require("../models/WeekValanModel");
const StockTransaction = require("../models/StockTransactionModel");
const FinalBillModel = require("../models/FinalBillModel");
const MonthlyFinalBillModel = require("../models/MonthlyFinalBill");
const CashLedgerModel = require("../models/CashLedgerModel");
const JVLedgerModel = require("../models/JVLedgerModel");
const LedgerModel = require("../models/LedgerModel");
const {
  getClientProfitLossReport,
  getBrokerageRefresh,
} = require("../services/LedgerService");
const BrokerageRefreshModel = require("../models/BrokerageRefreshModel");

function monthKeyFromDate(d) {
  const dt = new Date(d);
  return `${dt.getFullYear()}-${String(dt.getMonth() + 1).padStart(2, '0')}`;
}

function startOfMonth(dateLike) {
  const d = new Date(dateLike);
  return new Date(d.getFullYear(), d.getMonth(), 1, 0, 0, 0, 0);
}

function getCashEffect(cashDoc) {
  const amt = Number(cashDoc.amount || 0);
  return cashDoc.transactionType === 'RECEIPT' ? amt : -amt;  // RECEIPT = Debit (positive), PAYMENT = Credit (negative)
}

function getJVEffect(jvDoc, branchUserIdsSet) {
  const debitId = jvDoc.debitAccount?.toString();
  const creditId = jvDoc.creditAccount?.toString();
  const isCredit = branchUserIdsSet.has(creditId);
  const isDebit = branchUserIdsSet.has(debitId);
  if (isCredit) return Number(jvDoc.amount || 0);
  if (isDebit) return -Number(jvDoc.amount || 0);
  return 0;
}


function oid(v) {
  return new mongoose.Types.ObjectId(String(v));
}

async function getMonthlyOpeningForUser(userId, monthKey, marketId, parentId, isSelfView = false, requesterIsBroker = false, isViewingUpline = false, targetUser = null, requesterIdStr = null) {
  const parentIdStr = parentId.toString();
  const userIdStr = userId.toString();
  
  // Check if this user is a broker (levels 5 or 6)
  const user = targetUser || await UserModel.findById(userId).select('accountType partnership parentIds').populate('accountType', 'level').lean();
  const userLevel = Number(user?.accountType?.level) || 0;
  const isBroker = userLevel === 6;
  const isClient = userLevel === 7;
  
  const [yearNum, monthNum] = monthKey.split('-').map(Number);
  const monthStart = new Date(yearNum, monthNum - 1, 1, 0, 0, 0, 0);

  const valansBefore = await WeekValanModel.find({
    endDate: { $lt: monthStart }
  }).select('_id endDate').lean();

  if (!valansBefore.length) return 0;

  let total = 0;
  
  // Determine negation based on view type (same as getLedgerList)
  const shouldNegateBills = !isSelfView;
  const neg = (v) => shouldNegateBills ? -v : v;

  // Fetch bills based on user type and view context
  let billQuery;
  
  if (isViewingUpline) {
    // When viewing upline, fetch REQUESTER's bills created by that upline
    billQuery = {
      userId: oid(parentIdStr),
      createdBy: oid(userIdStr),
      valanId: { $in: valansBefore.map(v => v._id) }
    };
  } else if (isBroker) {
    // For brokers, fetch bills where they appear in partnershipBreakdown OR as userId
    billQuery = {
      $or: [
        { userId: oid(userId) },
        { 'partnershipBreakdown.userId': oid(userId) },
        { 'brockersBrokerage.brokerId': oid(userId) }
      ],
      valanId: { $in: valansBefore.map(v => v._id) }
    };
  } else if (requesterIsBroker && isClient && !isSelfView) {
    // Broker viewing client - fetch client's bills where broker has partnership
    billQuery = {
      userId: oid(userId),
      'partnershipBreakdown.userId': oid(parentIdStr),
      valanId: { $in: valansBefore.map(v => v._id) }
    };
  } else {
    // Regular case
    billQuery = {
      userId: oid(userId),
      valanId: { $in: valansBefore.map(v => v._id) }
    };
  }
  
  // Add market filter if specified
  if (marketId && marketId !== 'ALL' && marketId !== 'AIO') {
    billQuery.marketId = String(marketId);
  }

  const bills = await FinalBillModel.find(billQuery).lean();

  // Calculate bill total using SAME logic as getParentShareFromBill
  for (const bill of bills) {
    const groupName = getMarketGroupName(bill.marketId);
    
    // Apply market group filter if specified
    if (marketId && marketId !== 'ALL' && marketId !== 'AIO') {
      const filterGroupName = getMarketGroupName(marketId);
      if (groupName !== filterGroupName) continue;
    }
    
    const billUserId = bill.userId?._id?.toString() || bill.userId?.toString();
    const isNseEq = String(bill.marketId) === '12';
    const interestAmount = isNseEq ? Number(bill.interestAmount || 0) : 0;
    
    // VIEWING UPLINE CASE
    if (isViewingUpline) {
      if (billUserId === parentIdStr) {
        // This is MY bill created by the upline
        // For NSE_EQ: Direct parent sees M2M WITH interest deduction
        total += neg(Number(bill.totalM2M || 0) - interestAmount);
      } else if (Array.isArray(bill.partnershipBreakdown)) {
        const myShare = bill.partnershipBreakdown.find(
          pb => pb.userId && pb.userId.toString() === parentIdStr
        );
        if (myShare) {
          // Partnership share is based on M2M WITHOUT interest
          total += neg(Number(myShare.amount || 0));
        }
      }
      continue;
    }
    
    // SELF-VIEW CASE
    if (isSelfView) {
      // For NSE_EQ: Self-view sees M2M WITH interest deduction
      total += neg(Number(bill.totalM2M || 0) - interestAmount);
      continue;
    }
    
    // UPLINE VIEW CASE
    
    // Viewing a BROKER's ledger
    if (isBroker) {
      if (Array.isArray(bill.partnershipBreakdown)) {
        const brokerShare = bill.partnershipBreakdown.find(
          pb => pb.userId && pb.userId.toString() === userIdStr
        );
        if (brokerShare) {
          // Broker's partnership share is based on M2M WITHOUT interest
          total += neg(Number(brokerShare.amount || 0));
        }
      }
      
      // Add brokerage earnings
      if (Array.isArray(bill.brockersBrokerage)) {
        bill.brockersBrokerage.forEach(brok => {
          if (brok.brokerId?.toString() === userIdStr) {
            total += neg(Number(brok.rate || 0));
          }
        });
      }
      continue;
    }
    
    // Viewing a CLIENT
    if (isClient) {
      // Check if requester is the DIRECT PARENT
      const isDirectParent = Array.isArray(user.parentIds) && 
        user.parentIds.some(pid => pid.toString() === parentIdStr);
      
      if (isDirectParent) {
        // Direct parent sees M2M WITH interest deduction
        total += neg(Number(bill.totalM2M || 0) - interestAmount);
        continue;
      }
      
      // If REQUESTER is a broker viewing a client
      if (requesterIsBroker) {
        if (Array.isArray(bill.partnershipBreakdown)) {
          const brokerShare = bill.partnershipBreakdown.find(
            pb => pb.userId && pb.userId.toString() === parentIdStr
          );
          if (brokerShare) {
            // Broker's partnership share is based on M2M WITHOUT interest
            total += neg(Number(brokerShare.amount || 0));
          }
        }
        
        // Add brokerage earnings
        if (Array.isArray(bill.brockersBrokerage)) {
          bill.brockersBrokerage.forEach(brok => {
            if (brok.brokerId?.toString() === parentIdStr) {
              total += neg(Number(brok.rate || 0));
            }
          });
        }
        continue;
      }
      
      // Other uplines see their partnership share
      if (Array.isArray(bill.partnershipBreakdown)) {
        const uplineShare = bill.partnershipBreakdown.find(
          pb => pb.userId && pb.userId.toString() === parentIdStr
        );
        if (uplineShare) {
          total += neg(Number(uplineShare.amount || 0));
        }
      }
      continue;
    }
    
    // NON-CLIENTS (admin, subadmin, master, ADL, etc.)
    if (!Array.isArray(bill.partnershipBreakdown) || bill.partnershipBreakdown.length === 0) {
      total += neg(Number(bill.selfNetPrice || 0));
      continue;
    }
    
    // Find my position in the breakdown
    const myIndex = bill.partnershipBreakdown.findIndex(
      pb => pb.userId && pb.userId.toString() === parentIdStr
    );
    
    if (myIndex === -1) continue;
    
    // Sum myShare + all upline shares before me
    let totalShare = 0;
    for (let i = 0; i <= myIndex; i++) {
      totalShare += Number(bill.partnershipBreakdown[i].amount || 0);
    }
    
    total += neg(totalShare);
  }

  // Historical cash transactions (no market filter)
  const cashDocs = await CashLedgerModel.find({
    userId: oid(userId),
    date: { $lt: monthStart }
  }).lean();
  
  for (const c of cashDocs) {
    const effect = c.transactionType === 'RECEIPT' ? Number(c.amount || 0) : -Number(c.amount || 0);
    total += shouldNegateBills ? -effect : effect;
  }

  // Historical JV transactions (no market filter)
  const jvDocs = await JVLedgerModel.find({
    $or: [{ debitAccount: oid(userId) }, { creditAccount: oid(userId) }],
    date: { $lt: monthStart }
  }).lean();
  
  for (const j of jvDocs) {
    const isCredit = j.creditAccount?.toString() === userIdStr;
    const effect = isCredit ? Number(j.amount || 0) : -Number(j.amount || 0);
    total += shouldNegateBills ? -effect : effect;
  }

  return total;
}

async function getMonthlyOpeningForUsers(userIds, monthKey, marketId, parentId) {
  let sum = 0;
  for (const uid of userIds) {
    sum += await getMonthlyOpeningForUser(uid, monthKey, marketId, parentId);
  }
  return sum;
}
const { getEffectiveUserId, getLoginUserId, getUserContext, isDemoUser } = require("../utils/contextHelpers");
const { getOtherBrokerDetails, getBaseScriptName } = require("../utils/StockUtils");
const { generatePDF, generateHTML } = require("../telegram/pdfHelper");
const { redisClient } = require("../config/redis");


exports.getLedgerList = async (req, res) => {
  try {
    const { userId } = req.params;
    let { date, endDate, txnType, market } = req.query;

    const id = new mongoose.Types.ObjectId(userId);
    const parentId = getEffectiveUserId(req);
    const requesterIdStr = parentId.toString();
    
    // Declare requesterLevel and requesterIsBroker once at the top
    const requesterLevel = Number(req.user.accountType?.level) || 1;
    const requesterIsBroker = requesterLevel === 6;
    
    // console.log('[getLedgerList] userId param:', userId);
    // console.log('[getLedgerList] requesterIdStr:', requesterIdStr);
    // console.log('[getLedgerList] id.toString():', id.toString());
    
    // 🔹 NEW: Detect if viewing an UPLINE's ledger (user is in requester's parentIds)
    const requesterUser = await UserModel.findById(parentId)
      .select('parentIds accountType')
      .populate('accountType', 'level')
      .lean();
    
    const requesterParentIds = (requesterUser?.parentIds || []).map(p => p.toString());
    const isViewingUpline = requesterParentIds.includes(id.toString());
    
    const isSelfView = !isViewingUpline && (userId === requesterIdStr || id.toString() === requesterIdStr);
    const isUplineView = isViewingUpline || (userId !== requesterIdStr && id.toString() !== requesterIdStr);
    
    // console.log('[getLedgerList] isViewingUpline:', isViewingUpline);
    // console.log('[getLedgerList] isSelfView:', isSelfView);
    // console.log('[getLedgerList] isUplineView:', isUplineView);
    const parentLevel = Number(requesterUser?.accountType?.level || req.user.accountType?.level);
    const isRequesterDemo = isDemoUser(req);

    const filterMarketGroup = (market && market !== 'AIO')
      ? market.toUpperCase().replace(/-/g, '_')
      : null;

    const targetUser = await UserModel.findById(id)
      .populate('accountType', 'label level')
      .select('accountName accountCode partnership accountType parentIds createdBy')
      .lean();

    if (!targetUser) {
      return res.status(404).json({ status: false, message: 'User not found' });
    }

    const isClient = Number(targetUser.accountType?.level) === 7;
    const targetUserLevel = Number(targetUser.accountType?.level) || 1;
    const targetIsBroker = targetUserLevel === 6;
    const shouldNegateBills = !isSelfView;
    const shouldNegateCashJV = !isSelfView;
    const neg = (v) => shouldNegateBills ? -v : v;

    let branchUserIds = [id];

    if (!isClient && !targetIsBroker) {
      const downline = await UserModel.find({
        parentIds: id,
        isDeleted: false,
        demoid: isRequesterDemo ? true : { $ne: true }
      }).select('_id').lean();

      branchUserIds = [id, ...downline.map(u => u._id)];
    }

    const branchUserIdStrings = branchUserIds.map(v => v.toString());
    const branchUserObjectIds = branchUserIds.map(v => new mongoose.Types.ObjectId(v));

    const allValans = await WeekValanModel.find({}).sort({ startDate: -1 }).lean();
    const valanMap = new Map(allValans.map(v => [v._id.toString(), v]));

    const currencyMap = (await hgetall('currency_rate')) || {};
    const applyForexRate = (mId, mName, amount) => amount * getCurrencyRate(currencyMap, mId, mName);

    const startDate = date ? new Date(date) : null;
    const rangeStart = (startDate && !isNaN(startDate.getTime())) ? startDate : startOfMonth(new Date());

    const rangeEnd = endDate ? new Date(endDate) : new Date();
    const safeEnd = isNaN(rangeEnd.getTime()) ? new Date() : rangeEnd;

    const monthKey = monthKeyFromDate(rangeStart);
    const monthFirst = startOfMonth(rangeStart);

    // Check if user explicitly provided a date filter
    const userProvidedDateFilter = date && date !== '';

    // Determine which valans belong to the current month by their endDate.
    // A valan belongs to the month its endDate falls in — this correctly assigns
    // cross-month valans (e.g. "27APR-02MAY" endDate=May 2 → belongs to May).
    const valanIdsInMonth = allValans
      .filter(v => {
        const ve = new Date(v.endDate);
        return ve >= monthFirst && ve <= safeEnd;
      })
      .map(v => v._id);

    // For self-view (admin looking at their own account), bills are stored with
    // *their own parent* as parentId, not themselves. Use that for queries.
    const ownParentIds = Array.isArray(targetUser.parentIds) ? targetUser.parentIds : [];
    const selfParentId = isSelfView && ownParentIds.length > 0
      ? new mongoose.Types.ObjectId(ownParentIds[ownParentIds.length - 1])
      : oid(parentId);

    // Bills are always stored with the TARGET user's direct parent as createdBy.
    // selfParentId is the REQUESTER's parent (for opening balance lookups).
    // billCreatedBy is the TARGET's direct parent (for fetching bills).
    const billCreatedBy = ownParentIds.length > 0
      ? new mongoose.Types.ObjectId(ownParentIds[ownParentIds.length - 1])
      : oid(parentId);

    // 🔹 NEW: For upline view, calculate opening balance for REQUESTER, not the upline
    const openingUserId = isViewingUpline ? parentId : id;
    
    // No more negation needed - getMonthlyOpeningForUser handles it internally
    const absoluteOpeningBalance = await getMonthlyOpeningForUser(
      openingUserId, 
      monthKey, 
      market, 
      selfParentId, 
      isSelfView, 
      requesterIsBroker,
      isViewingUpline,
      targetUser,
      requesterIdStr
    );

    // 🔹 NEW: When viewing upline, fetch REQUESTER's cash/JV transactions
    const cashMatch = {
      userId: isViewingUpline ? oid(parentId) : id,
      date: { $gte: monthFirst, $lte: safeEnd }
    };

    const jvMatch = {
      $or: [
        { debitAccount: isViewingUpline ? oid(parentId) : id },
        { creditAccount: isViewingUpline ? oid(parentId) : id }
      ],
      date: { $gte: monthFirst, $lte: safeEnd }
    };

    const [billedData, cashData, jvData] = await Promise.all([
      // Fetch bills by valanId (not createdAt) to correctly assign cross-month valans
      (() => {
        // 🔹 NEW: When viewing UPLINE, fetch bills where REQUESTER is the userId
        if (isViewingUpline) {
          return FinalBillModel.find({
            userId: oid(parentId),  // Requester's bills
            createdBy: id,          // Created by the upline
            valanId: { $in: valanIdsInMonth }
          })
          .sort({ createdAt: -1 })
          .populate('userId', 'accountName accountCode')
          .lean();
        }

        if (targetIsBroker) {
          return FinalBillModel.find({
            $or: [
              { userId: id },
              { 'partnershipBreakdown.userId': id },
              { 'brockersBrokerage.brokerId': id }
            ],
            valanId: { $in: valanIdsInMonth }
          })
          .sort({ createdAt: -1 })
          .lean();
        } else if (requesterIsBroker && !isSelfView) {
          return FinalBillModel.find({
            userId: id,
            'partnershipBreakdown.userId': oid(parentId),
            valanId: { $in: valanIdsInMonth }
          })
          .sort({ createdAt: -1 })
          .populate('userId', 'accountName accountCode')
          .lean();
        } else {
          return FinalBillModel.find({
            createdBy: billCreatedBy,
            userId: id,
            valanId: { $in: valanIdsInMonth }
          })
            .sort({ createdAt: -1 })
            .populate('userId', 'accountName accountCode')
            .lean();
        }
      })(),
      CashLedgerModel.find(cashMatch).lean(),
      JVLedgerModel.find(jvMatch).lean()
    ]);

    // ENHANCED: Consistent self-view logic with explicit view type support
    // For self-view, the user sees their own cumulative balance from their perspective
    // For upline view, the upline sees their share of the user's balance
    // 🔹 NEW: For viewing UPLINE's ledger, show requester's exposure to that upline
    const getParentShareFromBill = (bill) => {
      const requesterLevel = Number(requesterUser?.accountType?.level || req.user.accountType?.level) || 1;
      const requesterIsBroker = requesterLevel === 6; // Only Level 6 are brokers
      const billUserId = bill.userId?._id?.toString() || bill.userId?.toString();
      const billUserLevel = Number(bill.level) || 7;
      const isNseEq = String(bill.marketId) === '12';
      const interestAmount = isNseEq ? Number(bill.interestAmount || 0) : 0;
      
      // 🔹 NEW: VIEWING UPLINE CASE - Show requester's share/exposure from bills created by upline
      if (isViewingUpline) {
        // When viewing upline's ledger, show MY (requester's) share from bills where I'm the user
        if (billUserId === requesterIdStr) {
          // This is MY bill created by the upline - show my totalM2M
          // For NSE_EQ: Direct parent sees M2M WITH interest deduction
          return neg(Number(bill.totalM2M || 0) - interestAmount);
        }
        
        // For bills of other users under this upline, show my partnership share if I'm in breakdown
        if (Array.isArray(bill.partnershipBreakdown)) {
          const myShare = bill.partnershipBreakdown.find(
            pb => pb.userId && pb.userId.toString() === requesterIdStr
          );
          if (myShare) {
            // Partnership share is based on M2M WITHOUT interest (uplines don't see interest)
            return neg(Number(myShare.amount || 0));
          }
        }
        
        return 0;
      }
      
      // SELF-VIEW CASE: When viewing YOUR OWN ledger
      // Show the user's FULL totalM2M impact (what they gained/lost)
      // For NSE_EQ: Self-view sees M2M WITH interest deduction
      if (isSelfView) {
        return neg(Number(bill.totalM2M || 0) - interestAmount);
      }
      
      // UPLINE VIEW CASE: When an upline views a downline user's ledger
      // Show the upline's share/exposure from this user's activity
      
      // If viewing a BROKER's ledger
      if (targetIsBroker) {
        if (!Array.isArray(bill.partnershipBreakdown)) {
          return 0;
        }
        
        const brokerShare = bill.partnershipBreakdown.find(
          pb => pb.userId && pb.userId.toString() === id.toString()
        );
        
        // Broker's partnership share is based on M2M WITHOUT interest
        return neg(brokerShare ? Number(brokerShare.amount || 0) : 0);
      }

      // If viewing a CLIENT (level 7)
      if (isClient) {
        // Check if requester is the DIRECT PARENT of this client
        const isDirectParent = Array.isArray(targetUser.parentIds) && 
          targetUser.parentIds.some(pid => pid.toString() === requesterIdStr);
        
        if (isDirectParent) {
          // Direct parent sees M2M WITH interest deduction
          return neg(Number(bill.totalM2M || 0) - interestAmount);
        }
        
        // If REQUESTER is a broker viewing a client
        if (requesterIsBroker) {
          if (!Array.isArray(bill.partnershipBreakdown)) {
            return 0;
          }
          
          const brokerShare = bill.partnershipBreakdown.find(
            pb => pb.userId && pb.userId.toString() === requesterIdStr
          );
          
          // Broker's partnership share is based on M2M WITHOUT interest
          return neg(brokerShare ? Number(brokerShare.amount || 0) : 0);
        }

        // Other uplines see their partnership share (M2M WITHOUT interest)
        if (Array.isArray(bill.partnershipBreakdown)) {
          const uplineShare = bill.partnershipBreakdown.find(
            pb => pb.userId && pb.userId.toString() === requesterIdStr
          );
          return neg(uplineShare ? Number(uplineShare.amount || 0) : 0);
        }

        return 0;
      }

      // For NON-CLIENTS (admin, subadmin, master, ADL, etc.)
      // Show myShare + all upline shares before me in partnershipBreakdown
      
      if (!Array.isArray(bill.partnershipBreakdown) || bill.partnershipBreakdown.length === 0) {
        // No interest for non-clients
        return neg(Number(bill.selfNetPrice || 0));
      }
      
      // Find my position in the breakdown
      const myIndex = bill.partnershipBreakdown.findIndex(
        pb => pb.userId && pb.userId.toString() === requesterIdStr
      );
      
      if (myIndex === -1) {
        return 0;
      }
      
      // Sum myShare + all upline shares before me (NO interest for non-direct parents)
      let totalShare = 0;
      for (let i = 0; i <= myIndex; i++) {
        totalShare += Number(bill.partnershipBreakdown[i].amount || 0);
      }
      
      return neg(totalShare);
    };

    // getBillDate: use valan endDate for display/sorting purposes
    const getBillDate = (b) => {
      const v = valanMap.get(b.valanId?.toString());
      return v ? new Date(v.endDate) : new Date(b.createdAt);
    };

    // For date filters within the month: only cash and JV have per-day granularity.
    // Bills are whole-valan — they either belong to this month or not (via valanIdsInMonth).
    // 
    // IMPORTANT: When filtering by date, we should NOT adjust the opening balance.
    // The opening balance represents the cumulative balance at the start of the month.
    // We should only show transactions from the filter date forward, but keep the 
    // opening balance as-is to maintain proper cumulative balance tracking.
    //
    // REMOVED: The logic that was adding pre-filter cash/JV to opening balance
    // This was causing incorrect cumulative balances when date filters were applied.

    // 🔹 Calculate effective opening balance if date filter is applied
    let effectiveOpeningBalance = absoluteOpeningBalance;
    let preFilterTransactions = 0;
    
    if (userProvidedDateFilter && rangeStart > monthFirst) {
      // Date filter is within the current month (e.g., filtering to April 20 when viewing April)
      // Opening should be: start of month opening + transactions from month start to filter date
      
      // Calculate bills that fall before the filter date (within current month)
      const preFilterBills = billedData.filter(b => {
        const billDate = new Date(b.createdAt);
        return billDate < rangeStart;
      });
      
      for (const bill of preFilterBills) {
        preFilterTransactions += getParentShareFromBill(bill);
      }
      
      // Calculate cash transactions before filter date (within current month)
      const preFilterCash = cashData.filter(c => c.date < rangeStart);
      for (const c of preFilterCash) {
        preFilterTransactions += shouldNegateCashJV ? -getCashEffect(c) : getCashEffect(c);
      }

      // Calculate JV transactions before filter date (within current month)
      const preFilterJV = jvData.filter(j => j.date < rangeStart);
      for (const j of preFilterJV) {
        const effectUserId = isViewingUpline ? parentId.toString() : id.toString();
        const rawEffect = (j.creditAccount?.toString() === effectUserId ? (j.amount || 0) : -(j.amount || 0));
        const effect = shouldNegateCashJV ? -rawEffect : rawEffect;
        preFilterTransactions += effect;
      }
      
      effectiveOpeningBalance = absoluteOpeningBalance + preFilterTransactions;
    } else if (userProvidedDateFilter && rangeStart < monthFirst) {
      // Date filter is in a PREVIOUS month (e.g., filtering to Feb 20 when current month is May)
      // Need to recalculate opening balance for that month
      const filterMonthKey = monthKeyFromDate(rangeStart);
      const filterMonthFirst = startOfMonth(rangeStart);
      
      // Get opening balance at the start of the filter month
      const filterMonthOpening = await getMonthlyOpeningForUser(
        openingUserId, 
        filterMonthKey, 
        market, 
        selfParentId, 
        isSelfView, 
        requesterIsBroker,
        isViewingUpline,
        targetUser,
        requesterIdStr
      );
      
      // Get all valans that belong to the filter month (by endDate)
      const filterMonthValans = allValans.filter(v => {
        const ve = new Date(v.endDate);
        return ve >= filterMonthFirst && ve < rangeStart;
      });
      const filterMonthValanIds = filterMonthValans.map(v => v._id);
      
      // Fetch bills for the filter month up to the filter date
      let filterMonthBills;
      if (isViewingUpline) {
        filterMonthBills = await FinalBillModel.find({
          userId: oid(parentId),
          createdBy: id,
          valanId: { $in: filterMonthValanIds }
        }).lean();
      } else if (targetIsBroker) {
        filterMonthBills = await FinalBillModel.find({
          $or: [
            { userId: id },
            { 'partnershipBreakdown.userId': id },
            { 'brockersBrokerage.brokerId': id }
          ],
          valanId: { $in: filterMonthValanIds }
        }).lean();
      } else if (requesterIsBroker && !isSelfView) {
        filterMonthBills = await FinalBillModel.find({
          userId: id,
          'partnershipBreakdown.userId': oid(parentId),
          valanId: { $in: filterMonthValanIds }
        }).lean();
      } else {
        filterMonthBills = await FinalBillModel.find({
          createdBy: billCreatedBy,
          userId: id,
          valanId: { $in: filterMonthValanIds }
        }).lean();
      }
      
      // Calculate bill total for filter month up to filter date
      let filterMonthBillTotal = 0;
      for (const bill of filterMonthBills) {
        filterMonthBillTotal += getParentShareFromBill(bill);
      }
      
      // Get cash/JV for filter month up to filter date
      const filterMonthCash = await CashLedgerModel.find({
        userId: isViewingUpline ? oid(parentId) : id,
        date: { $gte: filterMonthFirst, $lt: rangeStart }
      }).lean();
      
      let filterMonthCashTotal = 0;
      for (const c of filterMonthCash) {
        filterMonthCashTotal += shouldNegateCashJV ? -getCashEffect(c) : getCashEffect(c);
      }
      
      const filterMonthJV = await JVLedgerModel.find({
        $or: [
          { debitAccount: isViewingUpline ? oid(parentId) : id },
          { creditAccount: isViewingUpline ? oid(parentId) : id }
        ],
        date: { $gte: filterMonthFirst, $lt: rangeStart }
      }).lean();
      
      let filterMonthJVTotal = 0;
      for (const j of filterMonthJV) {
        const effectUserId = isViewingUpline ? parentId.toString() : id.toString();
        const rawEffect = (j.creditAccount?.toString() === effectUserId ? (j.amount || 0) : -(j.amount || 0));
        const effect = shouldNegateCashJV ? -rawEffect : rawEffect;
        filterMonthJVTotal += effect;
      }
      
      effectiveOpeningBalance = filterMonthOpening + filterMonthBillTotal + filterMonthCashTotal + filterMonthJVTotal;
      
      // Clear the current month data since we're viewing a previous month
      billedData.length = 0;
      cashData.length = 0;
      jvData.length = 0;
    }

    const interleavedList = [];

    // Filter bills to only show those on or after the filter date
    // Bills with endDate before the filter date are already included in opening balance
    const displayBills = userProvidedDateFilter 
      ? billedData.filter(b => {
          const valan = valanMap.get(b.valanId?.toString());
          if (!valan) return true; // Include if valan not found
          const valanEndDate = new Date(valan.endDate);
          return valanEndDate >= rangeStart;
        })
      : billedData;

    // Use broker-specific grouping if:
    // 1. Target user is a broker (viewing their own ledger), OR
    // 2. Requester is a broker viewing a client (to show partnership breakdown)
    const useBrokerGrouping = targetIsBroker || (requesterIsBroker && !isSelfView);

    if (useBrokerGrouping) {
      // console.log('[getLedgerList] Using broker-specific grouping - targetIsBroker:', targetIsBroker, 'requesterIsBroker:', requesterIsBroker);
      
      // For brokers, separate partnership and brokerage entries
      const brokerPartnershipGroups = new Map();
      const brokerBrokerageGroups = new Map();
      
      displayBills.forEach(b => {
        const groupName = getMarketGroupName(b.marketId);
        if (filterMarketGroup && groupName !== filterMarketGroup) return;

        const key = `${b.valanId.toString()}_${groupName}`;
        
        // Extract broker's partnership share and brokerage earnings
        let partnershipAmount = 0;
        let brokerageAmount = 0;
        
        // Determine which user ID to look for in the breakdown
        const brokerUserId = targetIsBroker ? id.toString() : requesterIdStr;
        
        if (Array.isArray(b.partnershipBreakdown)) {
          const brokerShare = b.partnershipBreakdown.find(
            pb => pb.userId && pb.userId.toString() === brokerUserId
          );
          if (brokerShare) {
            partnershipAmount = -Number(brokerShare.amount || 0);
          }
        }

        if (Array.isArray(b.brockersBrokerage)) {
          b.brockersBrokerage.forEach(brok => {
            if (brok && brok.brokerId && brok.brokerId.toString() === brokerUserId) {
              brokerageAmount += Number(brok.rate || 0);
            }
          });
        }
        
        // Add to partnership group
        if (Math.abs(partnershipAmount) > 0.001) {
          const current = brokerPartnershipGroups.get(key) || {
            amount: 0,
            valanId: b.valanId,
            date: b.createdAt,
            marketId: b.marketId,
            markets: [],
            groupName
          };
          current.amount += applyForexRate(b.marketId, groupName, partnershipAmount);
          if (!current.markets.includes(String(b.marketId))) {
            current.markets.push(String(b.marketId));
          }
          brokerPartnershipGroups.set(key, current);
        }
        
        // Add to brokerage group
        if (Math.abs(brokerageAmount) > 0.001) {
          const current = brokerBrokerageGroups.get(key) || {
            amount: 0,
            valanId: b.valanId,
            date: b.createdAt,
            marketId: b.marketId,
            markets: [],
            groupName
          };
          current.amount += applyForexRate(b.marketId, groupName, brokerageAmount);
          if (!current.markets.includes(String(b.marketId))) {
            current.markets.push(String(b.marketId));
          }
          brokerBrokerageGroups.set(key, current);
        }
      });
      
      brokerPartnershipGroups.forEach(data => {
        if (Math.abs(data.amount) > 0.001) {
          interleavedList.push({
            type: 'VALAN_PARTNERSHIP',
            amount: data.amount,
            valanName: `${valanMap.get(data.valanId.toString())?.label || 'Previous Valan'} ${data.groupName} Partnership`,
            date: data.date,
            status: 'BILLED',
            isLive: false,
            remark: `${valanMap.get(data.valanId.toString())?.label || 'Previous Valan'} ${data.groupName} Partnership`,
            valanId: data.valanId,
            markets: data.markets
          });
        }
      });

      brokerBrokerageGroups.forEach(data => {
        if (Math.abs(data.amount) > 0.001) {
          interleavedList.push({
            type: 'VALAN_BROKERAGE',
            amount: data.amount,
            valanName: `${valanMap.get(data.valanId.toString())?.label || 'Previous Valan'} ${data.groupName} Brokerage`,
            date: data.date,
            status: 'BILLED',
            isLive: false,
            remark: `${valanMap.get(data.valanId.toString())?.label || 'Previous Valan'} ${data.groupName} Brokerage`,
            valanId: data.valanId,
            markets: data.markets
          });
        }
      });
    } else {
      // Regular grouping for non-brokers
      const billedGroups = new Map();

      displayBills.forEach(b => {
        const groupName = getMarketGroupName(b.marketId);
        if (filterMarketGroup && groupName !== filterMarketGroup) return;

        const key = `${b.valanId.toString()}_${groupName}`;
        
        const current = billedGroups.get(key) || {
          amount: 0,
          valanId: b.valanId,
          date: b.createdAt,
          marketId: b.marketId,
          markets: [],
          groupName
        };

        const parentShare = getParentShareFromBill(b);
        current.amount += applyForexRate(b.marketId, groupName, parentShare);
        if (!current.markets.includes(String(b.marketId))) {
          current.markets.push(String(b.marketId));
        }
        billedGroups.set(key, current);
      });

      billedGroups.forEach(data => {
        if (Math.abs(data.amount) > 0.001) {
          interleavedList.push({
            type: 'VALAN',
            amount: data.amount,
            valanName: `${valanMap.get(data.valanId.toString())?.label || 'Previous Valan'} ${data.groupName}`,
            date: data.date,
            status: 'BILLED',
            isLive: false,
            remark: `${valanMap.get(data.valanId.toString())?.label || 'Previous Valan'} ${data.groupName}`,
            valanId: data.valanId,
            markets: data.markets
          });
        }
      });
    }

    cashData.forEach(c => {
      if (c.date < rangeStart) return;
      const flippedType = shouldNegateCashJV
        ? (c.transactionType === 'RECEIPT' ? 'PAYMENT' : 'RECEIPT')
        : c.transactionType;
      interleavedList.push({
        type: 'CASH',
        amount: shouldNegateCashJV ? -getCashEffect(c) : getCashEffect(c),
        date: c.date,
        remarks: c.remarks || (flippedType === 'RECEIPT' ? 'Cash Receipt (Debit)' : 'Cash Payment (Credit)'),
        transactionType: flippedType,
        accountEffect: flippedType === 'RECEIPT' ? 'DEBIT' : 'CREDIT',
        accountName: !isClient && !isViewingUpline ? '[Branch]' : null
      });
    });

    jvData.forEach(j => {
      if (j.date < rangeStart) return;
      // 🔹 NEW: Use correct userId for JV effect calculation
      const effectUserId = isViewingUpline ? parentId.toString() : id.toString();
      const rawEffect = (j.creditAccount?.toString() === effectUserId ? (j.amount || 0) : -(j.amount || 0));
      const effect = shouldNegateCashJV ? -rawEffect : rawEffect;

      if (!effect) return;

      interleavedList.push({
        type: 'JV',
        amount: effect,
        date: j.date,
        remarks: j.remarks || 'JV Record'
      });
    });

    interleavedList.sort((a, b) => new Date(a.date) - new Date(b.date));

    let runningAmount = effectiveOpeningBalance;
    const finalData = [];
    
    // Show opening balance (effective opening if date filter applied)
    // Always show it unless it's zero
    if (Math.abs(effectiveOpeningBalance) > 0.001) {
      const openingLabel = userProvidedDateFilter && rangeStart > monthFirst
        ? `Opening balance as of ${rangeStart.toLocaleDateString()} (includes transactions up to this date)`
        : `Opening balance as of ${rangeStart.toLocaleDateString()} (Previous Month Final)`;
      
      finalData.push({
        type: 'OPENING',
        amount: effectiveOpeningBalance,
        balance: effectiveOpeningBalance,
        date: rangeStart,
        remarks: openingLabel,
        isOpening: true
      });
    }

    interleavedList.forEach(item => {
      runningAmount += item.amount;
      finalData.push({
        ...item,
        balance: runningAmount
      });
    });

    // Final consolidated object as required
    const result = {
      status: true,
      amount: runningAmount, // Final total for that user
      data: finalData.reverse() // Descending for UI
    };

    res.status(200).json(result);
  } catch (error) {
    console.error('[getLedgerList] Error:', error);
    res.status(500).json({ status: false, message: error.message });
  }
};
exports.getLedgers = async (req, res) => {
  try {
    const parentId = new mongoose.Types.ObjectId(getEffectiveUserId(req));
    const parentIdStr = parentId.toString();
    const parentLevel = Number(req.user.accountType?.level);
    const { clientId, marketId, date, viewType } = req.query;
    const isRequesterDemo = isDemoUser(req);

    // 🔹 NEW: Fetch requester info to detect upline viewing
    const requesterUser = await UserModel.findById(parentId)
      .select('parentIds accountType')
      .populate('accountType', 'level')
      .lean();

    // 🔹 Get all direct children (users created by this parent)
    const directChildren = await UserModel.find({
      'createdBy.userId': parentId,
      isDeleted: false,
      demoid: isRequesterDemo ? true : { $ne: true }
    })
      .select('_id parentIds accountType accountCode accountName createdBy')
      .populate('accountType', 'level label')
      .lean();

    // 🔹 If requester is a broker, find clients they have partnerships with
    const requesterIsBroker = parentLevel === 6; // Only Level 6 are brokers
    
    if (requesterIsBroker) {
      // Find all bills where this broker appears in partnershipBreakdown
      const brokerBills = await FinalBillModel.find({
        'partnershipBreakdown.userId': parentId
      }).select('userId').lean();
      
      const clientIds = [...new Set(brokerBills.map(b => b.userId.toString()))];
      
      if (clientIds.length > 0) {
        const clients = await UserModel.find({
          _id: { $in: clientIds },
          isDeleted: false,
          demoid: isRequesterDemo ? true : { $ne: true }
        })
          .select('_id parentIds accountType accountCode accountName createdBy')
          .populate('accountType', 'level label')
          .lean();
        
        // Add clients to directChildren if not already there
        const existingIds = new Set(directChildren.map(u => u._id.toString()));
        clients.forEach(client => {
          if (!existingIds.has(client._id.toString())) {
            directChildren.push(client);
          }
        });
      }
    }

    // 🔹 Also get users who have bills with this parent (includes brokers)
    const billUserIds = await FinalBillModel.distinct('userId', {
      createdBy: oid(parentIdStr)
    });

    // 🔹 Also get users who are in partnershipBreakdown (brokers who earn from clients)
    // BUT exclude uplines - only include brokers (levels 5 and 6)
    const billsWithBreakdown = await FinalBillModel.find({
      createdBy: oid(parentIdStr),
      'partnershipBreakdown.userId': { $exists: true }
    }).select('partnershipBreakdown').lean();

    const breakdownUserIds = new Set();
    billsWithBreakdown.forEach(bill => {
      if (Array.isArray(bill.partnershipBreakdown)) {
        bill.partnershipBreakdown.forEach(pb => {
          if (pb.userId && pb.userId.toString() !== parentIdStr) {
            breakdownUserIds.add(pb.userId.toString());
          }
        });
      }
    });

    // Get user details for bill users not already in directChildren
    const existingIds = new Set(directChildren.map(u => u._id.toString()));
    const additionalUserIds = [
      ...billUserIds.filter(id => !existingIds.has(id.toString())),
      ...Array.from(breakdownUserIds).filter(id => !existingIds.has(id))
    ];
    
    if (additionalUserIds.length > 0) {
      const additionalUsers = await UserModel.find({
        _id: { $in: additionalUserIds },
        isDeleted: false,
        demoid: isRequesterDemo ? true : { $ne: true }
      })
        .select('_id parentIds accountType accountCode accountName createdBy')
        .populate('accountType', 'level label')
        .lean();
      
      // Only add brokers (level 6 only), not uplines or masters
      const brokersOnly = additionalUsers.filter(u => {
        const level = Number(u.accountType?.level) || 0;
        return level === 6; // Only Level 6 are brokers
      });
      
      directChildren.push(...brokersOnly);
    }

    if (!directChildren.length) {
      return res.status(200).json({ status: true, data: [] });
    }

    const targetUsers = clientId
      ? directChildren.filter(c => c._id.toString() === clientId.toString())
      : directChildren;

    // 🔹 Date handling
    const startDate = date ? new Date(date) : new Date();
    const monthStart = new Date(startDate.getFullYear(), startDate.getMonth(), 1);
    const monthEndCandidate = new Date(monthStart.getFullYear(), monthStart.getMonth() + 1, 0, 23, 59, 59, 999);
    const monthEnd = monthEndCandidate < new Date() ? monthEndCandidate : new Date();

    const monthKey = monthKeyFromDate(monthStart);

    // Determine which valans belong to this month by their endDate.
    // Same rule as generateMonthlyFinalBills — avoids double-counting cross-month valans.
    const allValansForMonth = await WeekValanModel.find({
      endDate: { $gte: monthStart, $lte: monthEnd }
    }).select('_id').lean();
    const valanIdsInMonth = allValansForMonth.map(v => v._id);

    const finalReport = [];

    for (const targetUser of targetUsers) {
      const tId = targetUser._id.toString();

      // Calculate target user level early - needed for opening balance calculation
      const targetUserLevel = Number(targetUser.accountType?.level) || 1;
      const targetIsBroker = targetUserLevel === 6; // Only Level 6 are brokers
      const targetIsClient = targetUserLevel === 7;

      // 🔹 NEW: Detect if viewing an UPLINE
      const requesterParentIds = (requesterUser?.parentIds || []).map(p => p.toString());
      const isViewingUpline = requesterParentIds.includes(tId);

      // 1. Get opening balance
      // 🔹 NEW: For upline view, get REQUESTER's opening balance with that upline
      const openingUserId = isViewingUpline ? parentIdStr : tId;
      const isSelfView = tId === parentIdStr;
      
      // No more negation needed - getMonthlyOpeningForUser handles it internally
      const openingBalance = await getMonthlyOpeningForUser(
        openingUserId, 
        monthKey, 
        marketId, 
        parentId, 
        isSelfView, 
        requesterIsBroker,
        isViewingUpline,
        targetUser,
        parentIdStr
      );

      // 2. Aggregate Final Bills — fetch by valanId (not createdAt) to correctly
      //    assign cross-month valans to the month their startDate falls in.
      let bills;

      // Bills are stored with the TARGET's direct parent as createdBy, not the requester.
      const targetParentIdsForBills = Array.isArray(targetUser.parentIds) ? targetUser.parentIds : [];
      const billCreatedBy = targetParentIdsForBills.length > 0
        ? targetParentIdsForBills[targetParentIdsForBills.length - 1].toString()
        : parentIdStr;

      // 🔹 NEW: When viewing upline, fetch REQUESTER's bills created by that upline
      if (isViewingUpline) {
        bills = await FinalBillModel.find({
          userId: oid(parentIdStr),  // Requester's bills
          createdBy: oid(tId),       // Created by the upline
          valanId: { $in: valanIdsInMonth },
          ...(marketId && marketId !== 'ALL' && marketId !== 'AIO' ? { marketId: String(marketId) } : {})
        }).lean();
      } else if (requesterIsBroker) {
        bills = await FinalBillModel.find({
          userId: oid(tId),
          'partnershipBreakdown.userId': parentId,
          valanId: { $in: valanIdsInMonth },
          ...(marketId && marketId !== 'ALL' && marketId !== 'AIO' ? { marketId: String(marketId) } : {})
        }).lean();
      } else {
        bills = await FinalBillModel.find({
          createdBy: oid(billCreatedBy),
          userId: oid(tId),
          valanId: { $in: valanIdsInMonth },
          ...(marketId && marketId !== 'ALL' && marketId !== 'AIO' ? { marketId: String(marketId) } : {})
        }).lean();
      }

      // Calculate bill total using the same logic as getLedgerList's getParentShareFromBill

      // Determine the effective "parent" ID to use for bill share lookups.
      // Bills are stored with the target user's direct parent as createdBy, so we
      // need that parent's ID — not necessarily the requester — for self-view cases.
      const targetParentIds = Array.isArray(targetUser.parentIds) ? targetUser.parentIds : [];
      const effectiveParentId = targetParentIds.length > 0
        ? targetParentIds[targetParentIds.length - 1].toString()
        : parentIdStr;

      // FIXED: Consistent bill share calculation logic with explicit view type support
      const getBillShare = (bill) => {
        const billUserId = bill.userId?._id?.toString() || bill.userId?.toString();
        
        // 🔹 NEW: VIEWING UPLINE CASE - Show requester's exposure to upline
        if (isViewingUpline) {
          // When viewing upline's ledger in getLedgers, show MY (requester's) bills under that upline
          if (billUserId === parentIdStr) {
            // This is MY bill - show my totalM2M
            return -Number(bill.totalM2M || 0);
          }
          
          // For other users' bills, show my partnership share if I'm in breakdown
          if (Array.isArray(bill.partnershipBreakdown)) {
            const myShare = bill.partnershipBreakdown.find(
              pb => pb.userId && pb.userId.toString() === parentIdStr
            );
            if (myShare) {
              return -Number(myShare.amount || 0);
            }
          }
          
          return 0;
        }
        
        const isSelfView = tId === parentIdStr;

        if (isSelfView) {
          return -Number(bill.totalM2M || 0);
        }

        // UPLINE VIEW CASE: Upline viewing downline user's ledger
        
        // Viewing a BROKER's ledger — negate so broker shows opposite sign to client
        // (client gain → broker negative, client loss → broker positive), consistent
        // with how all other non-client uplines are displayed.
        if (targetIsBroker) {
          if (!Array.isArray(bill.partnershipBreakdown)) return 0;
          const brokerShare = bill.partnershipBreakdown.find(
            pb => pb.userId && pb.userId.toString() === tId
          );
          return -(brokerShare ? Number(brokerShare.amount || 0) : 0);
        }

        // Viewing a CLIENT (level 7)
        if (targetIsClient) {
          // Check if requester is the DIRECT PARENT of this client
          const isDirectParent = Array.isArray(targetUser.parentIds) && 
            targetUser.parentIds.some(pid => pid.toString() === parentIdStr);
          
          if (isDirectParent) {
            return -Number(bill.totalM2M || 0);
          }
          
          if (requesterIsBroker) {
            if (!Array.isArray(bill.partnershipBreakdown)) return 0;
            const brokerShare = bill.partnershipBreakdown.find(
              pb => pb.userId && pb.userId.toString() === parentIdStr
            );
            return -(brokerShare ? Number(brokerShare.amount || 0) : 0);
          }
          
          if (Array.isArray(bill.partnershipBreakdown)) {
            const uplineShare = bill.partnershipBreakdown.find(
              pb => pb.userId && pb.userId.toString() === parentIdStr
            );
            return -(uplineShare ? Number(uplineShare.amount || 0) : 0);
          }

          return 0;
        }

        // NON-CLIENT (admin, subadmin, master, ADL, etc.)
        // Show myShare + all upline shares before me in partnershipBreakdown
        
        if (!Array.isArray(bill.partnershipBreakdown) || bill.partnershipBreakdown.length === 0) {
          return -Number(bill.selfNetPrice || 0);
        }
        
        // Find my position in the breakdown
        const myIndex = bill.partnershipBreakdown.findIndex(
          pb => pb.userId && pb.userId.toString() === parentIdStr
        );
        
        if (myIndex === -1) {
          return 0;
        }
        
        // Sum myShare + all upline shares before me
        let totalShare = 0;
        for (let i = 0; i <= myIndex; i++) {
          totalShare += Number(bill.partnershipBreakdown[i].amount || 0);
        }
        
        return -totalShare;
      };

      let billTotal = 0;

      if (requesterIsBroker && targetIsClient) {
        // Special case: Broker viewing client - calculate broker's share only
        for (const bill of bills) {
          const groupName = getMarketGroupName(bill.marketId);
          
          // Partnership share (negated to match display)
          if (Array.isArray(bill.partnershipBreakdown)) {
            const brokerShare = bill.partnershipBreakdown.find(
              pb => pb.userId && pb.userId.toString() === parentIdStr
            );
            if (brokerShare) {
              billTotal += -Number(brokerShare.amount || 0); // Negated
            }
          }
          
          // Brokerage earnings (positive)
          if (Array.isArray(bill.brockersBrokerage)) {
            bill.brockersBrokerage.forEach(brok => {
              if (brok && brok.brokerId && brok.brokerId.toString() === parentIdStr) {
                billTotal += Number(brok.rate || 0);
              }
            });
          }
        }
      } else if (targetIsBroker) {
        // For brokers, fetch bills where they appear in partnershipBreakdown OR as userId
        const brokerBills = await FinalBillModel.find({
          $or: [
            { userId: oid(tId) },
            { 'partnershipBreakdown.userId': oid(tId) },
            { 'brockersBrokerage.brokerId': oid(tId) }  // 🔹 Also fetch bills where broker earned brokerage
          ],
          valanId: { $in: valanIdsInMonth },
          ...(marketId && marketId !== 'ALL' && marketId !== 'AIO' ? { marketId: String(marketId) } : {})
        }).lean();

        for (const bill of brokerBills) {
          // Get partnership share
          const partnershipShare = getBillShare(bill);
          billTotal += partnershipShare;
          
          if (Array.isArray(bill.brockersBrokerage)) {
            bill.brockersBrokerage.forEach(brok => {
              if (brok && brok.brokerId && brok.brokerId.toString() === tId) {
                billTotal += Number(brok.rate || 0);
              }
            });
          }
        }
      } else {
        for (const bill of bills) {
          billTotal += getBillShare(bill);
        }
      }

      // 3. Aggregate Cash
      // 🔹 NEW: For upline view, get REQUESTER's cash transactions
      const cashUserId = isViewingUpline ? oid(parentIdStr) : oid(tId);
      const cashMatch = {
        userId: cashUserId,
        date: { $gte: monthStart, $lte: monthEnd }
      };
      if (marketId && marketId !== 'ALL' && marketId !== 'AIO') {
        cashMatch.marketId = String(marketId);
      }
      const cashAgg = await CashLedgerModel.aggregate([
        { $match: cashMatch },
        {
          $group: {
            _id: null,
            total: {
              $sum: {
                $cond: [
                  { $eq: ["$transactionType", "RECEIPT"] },
                  "$amount",  // RECEIPT = positive (money in)
                  { $multiply: ["$amount", -1] }  // PAYMENT = negative (money out)
                ]
              }
            }
          }
        }
      ]);
      const cashTotal = cashAgg[0]?.total || 0;

      // 4. Aggregate JV
      // 🔹 NEW: For upline view, get REQUESTER's JV transactions
      const jvUserId = isViewingUpline ? oid(parentIdStr) : oid(tId);
      const jvMatch = {
        $or: [{ debitAccount: jvUserId }, { creditAccount: jvUserId }],
        date: { $gte: monthStart, $lte: monthEnd }
      };
      if (marketId && marketId !== 'ALL' && marketId !== 'AIO') {
        jvMatch.marketId = String(marketId);
      }
      const jvAgg = await JVLedgerModel.aggregate([
        { $match: jvMatch },
        {
          $project: {
            effect: {
              $cond: [
                { $eq: ["$creditAccount", jvUserId] },
                "$amount",
                { $multiply: ["$amount", -1] }
              ]
            }
          }
        },
        { $group: { _id: null, total: { $sum: "$effect" } } }
      ]);
      const jvTotal = jvAgg[0]?.total || 0;

      const displayCash = -cashTotal;
      const displayJV = -jvTotal;
      const totalAmount = openingBalance + billTotal + displayCash + displayJV;

      if (Math.abs(totalAmount) > 0.001 || Math.abs(openingBalance) > 0.001 || Math.abs(billTotal) > 0.001) {
        finalReport.push({
          ...targetUser,
          openingBalance,
          billTotal,
          cashTotal: displayCash,
          jvTotal: displayJV,
          amount: totalAmount
        });
      }
    }

    res.status(200).json({
      status: true,
      data: finalReport
    });

  } catch (error) {
    console.error("[getLedgers] Error:", error);
    res.status(500).json({ status: false, message: error.message });
  }
};


// helper
function getPrevMonth(monthStr) {
  const [y, m] = monthStr.split("-").map(Number);
  const d = new Date(y, m - 2, 1);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`;
}
exports.getMyLedger = async (req, res) => {
  try {
    const userId = getEffectiveUserId(req);
    const { viewType, month, market } = req.query;

    if (viewType === 'upline') {
      // Aggregate ALL downline client bills by valan, showing requester's cumulative share.
      // Query level=7 only — master/admin bills already aggregate client data, querying both double-counts.
      const now = new Date();
      const monthKey = month || `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`;
      const [yearNum, monthNum] = monthKey.split('-').map(Number);
      const monthFirst = new Date(yearNum, monthNum - 1, 1, 0, 0, 0, 0);
      const monthLast = new Date(yearNum, monthNum, 0, 23, 59, 59, 999);

      const filterMarketGroup = (market && market !== 'AIO')
        ? market.toUpperCase().replace(/-/g, '_')
        : null;

      const currencyMap = (await hgetall('currency_rate')) || {};
      const applyFx = (mId, mName, amt) => amt * getCurrencyRate(currencyMap, mId, mName);

      const valansInMonth = await WeekValanModel.find({
        endDate: { $gte: monthFirst, $lte: monthLast }
      }).lean();
      const valanIds = valansInMonth.map(v => v._id);
      const valanMap = new Map(valansInMonth.map(v => [v._id.toString(), v]));

      // Only client bills (level 7) where requester appears in partnershipBreakdown
      const billQuery = {
        level: 7,
        'partnershipBreakdown.userId': oid(userId),
        valanId: { $in: valanIds }
      };

      const bills = await FinalBillModel.find(billQuery).lean();

      const valanGroups = new Map();
      for (const bill of bills) {
        const groupName = getMarketGroupName(bill.marketId);
        if (filterMarketGroup && groupName !== filterMarketGroup) continue;
        const key = `${bill.valanId.toString()}_${groupName}`;

        const myIndex = bill.partnershipBreakdown.findIndex(
          pb => pb.userId?.toString() === userId.toString()
        );
        if (myIndex === -1) continue;

        // Sum only what goes ABOVE requester (indices 0..myIndex-1), negated
        let uplineTotal = 0;
        for (let i = 0; i < myIndex; i++) {
          uplineTotal -= Number(bill.partnershipBreakdown[i].amount || 0);
        }
        const amount = applyFx(bill.marketId, groupName, uplineTotal);

        const cur = valanGroups.get(key) || {
          amount: 0,
          valanId: bill.valanId,
          date: bill.createdAt,
          groupName
        };
        cur.amount += amount;
        valanGroups.set(key, cur);
      }

      const interleavedList = [];
      valanGroups.forEach(data => {
        if (Math.abs(data.amount) > 0.001) {
          const valan = valanMap.get(data.valanId.toString());
          interleavedList.push({
            type: 'VALAN',
            amount: data.amount,
            valanName: `${valan?.label || 'Valan'} ${data.groupName}`,
            date: valan?.endDate || data.date,
            status: 'BILLED',
            isLive: false,
            remark: `${valan?.label || 'Valan'} ${data.groupName}`
          });
        }
      });

      // Requester's own cash this month
      const cashData = await CashLedgerModel.find({
        userId: oid(userId),
        date: { $gte: monthFirst, $lte: monthLast }
      }).lean();
      cashData.forEach(c => {
        interleavedList.push({
          type: 'CASH',
          amount: getCashEffect(c),
          date: c.date,
          remark: c.remarks,
          transactionType: c.transactionType,
          status: 'CASH'
        });
      });

      // Requester's own JV this month
      const jvData = await JVLedgerModel.find({
        $or: [{ debitAccount: oid(userId) }, { creditAccount: oid(userId) }],
        date: { $gte: monthFirst, $lte: monthLast }
      }).lean();
      jvData.forEach(j => {
        const isCredit = j.creditAccount?.toString() === userId.toString();
        interleavedList.push({
          type: 'JV',
          amount: isCredit ? Number(j.amount || 0) : -Number(j.amount || 0),
          date: j.date,
          remark: j.remark || j.remarks,
          status: 'JV'
        });
      });

      interleavedList.sort((a, b) => new Date(a.date) - new Date(b.date));

      let balance = 0;
      const ledger = interleavedList.map(item => {
        balance += item.amount;
        return { ...item, balance };
      });

      return res.json({
        status: true,
        data: { openingBalance: 0, ledger, totalAmount: balance, month: monthKey }
      });
    }

    req.params.userId = userId;
    return await exports.getLedgerList(req, res);
  } catch (error) {
    console.error("[getMyLedger] Error:", error);
    res.status(500).json({ status: "false", message: error.message });
  }
};

// Upline share from a single bill: sum partnershipBreakdown[0..myIndex-1] negated.
// myIndex = requester's position in the breakdown.
function getUplineShareFromBill(bill, userIdStr, applyFx) {
  if (!Array.isArray(bill.partnershipBreakdown) || !bill.partnershipBreakdown.length) return 0;
  const myIndex = bill.partnershipBreakdown.findIndex(
    pb => pb.userId?.toString() === userIdStr
  );
  if (myIndex === -1) return 0;
  let uplineTotal = 0;
  for (let i = 0; i < myIndex; i++) {
    uplineTotal -= Number(bill.partnershipBreakdown[i].amount || 0);
  }
  return applyFx(bill.marketId, getMarketGroupName(bill.marketId), uplineTotal);
}

// Opening balance for upline settlement - mirrors getMonthlyOpeningForUser logic
// Uses monthKey (YYYY-MM format) to calculate opening balance for that specific month
async function getUplineMonthlyOpening(userId, monthKey, filterMarketGroup, currencyMap) {
  const userIdStr = userId.toString();
  const applyFx = (mId, mName, amt) => amt * getCurrencyRate(currencyMap, mId, mName);

  const user = await UserModel.findById(userId).select('accountType').populate('accountType', 'level').lean();
  const userLevel = Number(user?.accountType?.level) || 0;
  const isLevel7 = userLevel === 7;
  const isBroker = userLevel === 6;

  const [yearNum, monthNum] = monthKey.split('-').map(Number);
  const monthStart = new Date(yearNum, monthNum - 1, 1, 0, 0, 0, 0);

  // BROKER SPECIAL HANDLING (same as getMonthlyOpeningForUser)
  if (isBroker) {
    const valansBefore = await WeekValanModel.find({ endDate: { $lt: monthStart } }).select('_id').lean();
    let total = 0;

    if (valansBefore.length) {
      const brokerBillQuery = {
        $or: [
          { 'partnershipBreakdown.userId': oid(userId) },
          { 'brockersBrokerage.brokerId': oid(userId) }
        ],
        valanId: { $in: valansBefore.map(v => v._id) }
      };
      if (filterMarketGroup && filterMarketGroup !== 'ALL' && filterMarketGroup !== 'AIO') {
        brokerBillQuery.marketId = String(filterMarketGroup);
      }
      
      const brokerHistBills = await FinalBillModel.find(brokerBillQuery).lean();
      for (const bill of brokerHistBills) {
        const groupName = getMarketGroupName(bill.marketId);
        if (filterMarketGroup && groupName !== filterMarketGroup) continue;
        
        // Partnership share (AS-IS for upline settlement)
        if (Array.isArray(bill.partnershipBreakdown)) {
          const brokerShare = bill.partnershipBreakdown.find(
            pb => pb.userId?.toString() === userIdStr
          );
          if (brokerShare) {
            total += applyFx(bill.marketId, groupName, Number(brokerShare.amount || 0)); // AS-IS
          }
        }
        
        // Brokerage earnings (AS-IS, positive)
        if (Array.isArray(bill.brockersBrokerage)) {
          bill.brockersBrokerage.forEach(brok => {
            if (brok.brokerId?.toString() === userIdStr) {
              total += applyFx(bill.marketId, groupName, Number(brok.rate || 0)); // AS-IS
            }
          });
        }
      }
    }

    // Historical cash (no market filter)
    const brokerCashDocs = await CashLedgerModel.find({
      userId: oid(userId),
      date: { $lt: monthStart }
    }).lean();
    for (const c of brokerCashDocs) {
      total += c.transactionType === 'RECEIPT' ? Number(c.amount || 0) : -Number(c.amount || 0);
    }

    // Historical JV (no market filter)
    const brokerJvDocs = await JVLedgerModel.find({
      $or: [{ debitAccount: oid(userId) }, { creditAccount: oid(userId) }],
      date: { $lt: monthStart }
    }).lean();
    for (const j of brokerJvDocs) {
      const isCredit = j.creditAccount?.toString() === userIdStr;
      total += isCredit ? Number(j.amount || 0) : -Number(j.amount || 0);
    }

    return total;
  }

  // NON-BROKER LOGIC (existing code)
  const valansBefore = await WeekValanModel.find({ endDate: { $lt: monthStart } }).select('_id').lean();
  if (!valansBefore.length) return 0;

  const valanIdsBefore = valansBefore.map(v => v._id);
  const bills = await FinalBillModel.find(
    isLevel7
      ? { userId: oid(userId), valanId: { $in: valanIdsBefore } }
      : { level: 7, 'partnershipBreakdown.userId': oid(userId), valanId: { $in: valanIdsBefore } }
  ).lean();

  let total = 0;

  // Calculate bill total (NOT negated - negation happens when opening balance is returned)
  for (const bill of bills) {
    const groupName = getMarketGroupName(bill.marketId);
    if (filterMarketGroup && groupName !== filterMarketGroup) continue;
    
    if (isLevel7) {
      // Level 7: use full totalM2M (positive for client gain, negative for client loss)
      total += applyFx(bill.marketId, groupName, Number(bill.totalM2M || 0));
    } else {
      // Non-level 7: use upline share from partnershipBreakdown
      if (!Array.isArray(bill.partnershipBreakdown) || !bill.partnershipBreakdown.length) continue;
      const myIndex = bill.partnershipBreakdown.findIndex(
        pb => pb.userId?.toString() === userIdStr
      );
      if (myIndex === -1) continue;
      
      // Sum all upline shares before my index
      let uplineTotal = 0;
      for (let i = 0; i < myIndex; i++) {
        uplineTotal += Number(bill.partnershipBreakdown[i].amount || 0);
      }
      total += applyFx(bill.marketId, groupName, uplineTotal);
    }
  }

  // Historical cash transactions (as-is - same as getMonthlyOpeningForUser)
  const cashDocs = await CashLedgerModel.find({
    userId: oid(userId),
    date: { $lt: monthStart }
  }).lean();
  for (const c of cashDocs) {
    total += c.transactionType === 'RECEIPT' ? Number(c.amount || 0) : -Number(c.amount || 0);
  }

  // Historical JV transactions (as-is - same as getMonthlyOpeningForUser)
  const jvDocs = await JVLedgerModel.find({
    $or: [{ debitAccount: oid(userId) }, { creditAccount: oid(userId) }],
    date: { $lt: monthStart }
  }).lean();
  for (const j of jvDocs) {
    const isCredit = j.creditAccount?.toString() === userIdStr;
    total += isCredit ? Number(j.amount || 0) : -Number(j.amount || 0);
  }

  return total;
}

// GET /getUplineSettlement?month=YYYY-MM&market=NSE_FO
// Summary: opening (monthly bills) + current month bill/cash/JV totals.
// Returns ABSOLUTE amount (like getLedgers) and individual totals.
exports.getUplineSettlement = async (req, res) => {
  try {
    const userId = getEffectiveUserId(req);
    const userIdStr = userId.toString();
    const { month, market } = req.query;

    const now = new Date();
    const monthKey = month || `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`;
    const [yearNum, monthNum] = monthKey.split('-').map(Number);
    const monthFirst = new Date(yearNum, monthNum - 1, 1, 0, 0, 0, 0);
    const monthLast = new Date(yearNum, monthNum, 0, 23, 59, 59, 999);
    const filterMarketGroup = (market && market !== 'AIO') ? market.toUpperCase().replace(/-/g, '_') : null;
    const currencyMap = (await hgetall('currency_rate')) || {};
    const applyFx = (mId, mName, amt) => amt * getCurrencyRate(currencyMap, mId, mName);

    const requesterUser = await UserModel.findById(userId).select('accountType').populate('accountType', 'level').lean();
    const userLevel = Number(requesterUser?.accountType?.level) || 0;
    const isLevel7 = userLevel === 7;
    const isBroker = userLevel === 6;

    const openingBalance = await getUplineMonthlyOpening(userId, monthKey, filterMarketGroup, currencyMap); // NO negation for upline settlement

    // Bills this month
    const valansInMonth = await WeekValanModel.find({ endDate: { $gte: monthFirst, $lte: monthLast } }).select('_id').lean();
    const valanIdsInMonth = valansInMonth.map(v => v._id);
    
    // For brokers, fetch bills where they appear in partnershipBreakdown OR brockersBrokerage
    const billedData = await FinalBillModel.find(
      isBroker
        ? {
            $or: [
              { 'partnershipBreakdown.userId': oid(userId) },
              { 'brockersBrokerage.brokerId': oid(userId) }
            ],
            valanId: { $in: valanIdsInMonth }
          }
        : isLevel7
          ? { userId: oid(userId), valanId: { $in: valanIdsInMonth } }
          : { level: 7, 'partnershipBreakdown.userId': oid(userId), valanId: { $in: valanIdsInMonth } }
    ).lean();
    
    let billTotal = 0;
    for (const bill of billedData) {
      const groupName = getMarketGroupName(bill.marketId);
      if (filterMarketGroup && groupName !== filterMarketGroup) continue;
      
      if (isBroker) {
        // Broker: partnership AS-IS, brokerage AS-IS
        let partnershipAmount = 0;
        let brokerageAmount = 0;
        
        if (Array.isArray(bill.partnershipBreakdown)) {
          const brokerShare = bill.partnershipBreakdown.find(
            pb => pb.userId && pb.userId.toString() === userIdStr
          );
          if (brokerShare) {
            partnershipAmount = Number(brokerShare.amount || 0); // AS-IS
          }
        }
        
        if (Array.isArray(bill.brockersBrokerage)) {
          bill.brockersBrokerage.forEach(brok => {
            if (brok && brok.brokerId && brok.brokerId.toString() === userIdStr) {
              brokerageAmount += Number(brok.rate || 0); // AS-IS
            }
          });
        }
        
        billTotal += applyFx(bill.marketId, groupName, partnershipAmount + brokerageAmount);
      } else {
        // Non-broker logic
        billTotal += isLevel7
          ? applyFx(bill.marketId, groupName, -Number(bill.totalM2M || 0))
          : -getUplineShareFromBill(bill, userIdStr, applyFx);
      }
    }

    // Cash this month (as-is, not negated)
    const cashDocs = await CashLedgerModel.find({ userId: oid(userId), date: { $gte: monthFirst, $lte: monthLast } }).lean();
    let cashTotal = 0;
    for (const c of cashDocs) {
      cashTotal += getCashEffect(c); // As-is
    }

    // JV this month (as-is, not negated)
    const jvDocs = await JVLedgerModel.find({
      $or: [{ debitAccount: oid(userId) }, { creditAccount: oid(userId) }],
      date: { $gte: monthFirst, $lte: monthLast }
    }).lean();
    let jvTotal = 0;
    for (const j of jvDocs) {
      const effect = j.creditAccount?.toString() === userIdStr ? Number(j.amount || 0) : -Number(j.amount || 0);
      jvTotal += effect; // As-is
    }

    const amount = openingBalance + billTotal + cashTotal + jvTotal;
    return res.json({ status: true, amount, openingBalance, billTotal, cashTotal, jvTotal });
  } catch (error) {   
    console.error('[getUplineSettlement] Error:', error);
    res.status(500).json({ status: false, message: error.message });
  }
};

// GET /getUplineSettlementList?date=YYYY-MM-DD&endDate=YYYY-MM-DD&market=NSE_FO
// Identical flow to getLedgerList — opening from monthly bills, current month from weekly bills,
// interleaved with cash/JV, running balance, descending.
// When date filter is applied, calculates effective opening balance including pre-filter transactions.
exports.getUplineSettlementList = async (req, res) => {
  try {
    const userId = getEffectiveUserId(req);
    const userIdStr = userId.toString();
    let { date, endDate, market } = req.query;

    const filterMarketGroup = (market && market !== 'AIO') ? market.toUpperCase().replace(/-/g, '_') : null;
    const currencyMap = (await hgetall('currency_rate')) || {};
    const applyFx = (mId, mName, amt) => amt * getCurrencyRate(currencyMap, mId, mName);

    const now = new Date();
    const startDate = date ? new Date(date) : null;
    const rangeStart = (startDate && !isNaN(startDate.getTime())) ? startDate : new Date(now.getFullYear(), now.getMonth(), 1, 0, 0, 0, 0);
    const rangeEnd = endDate ? new Date(endDate) : now;
    const safeEnd = isNaN(rangeEnd.getTime()) ? now : rangeEnd;
    
    // IMPORTANT: monthFirst is based on the FILTER date, not current date (same as getLedgerList)
    const monthFirst = new Date(rangeStart.getFullYear(), rangeStart.getMonth(), 1, 0, 0, 0, 0);
    const userProvidedDateFilter = !!(date && date !== '');

    console.log('[getUplineSettlementList] now:', now);
    console.log('[getUplineSettlementList] date param:', date);
    console.log('[getUplineSettlementList] rangeStart:', rangeStart);
    console.log('[getUplineSettlementList] monthFirst:', monthFirst);

    const allValans = await WeekValanModel.find({}).sort({ startDate: -1 }).lean();
    const valanMap = new Map(allValans.map(v => [v._id.toString(), v]));

    // Valans whose endDate falls in [monthFirst, safeEnd] (same as getLedgerList)
    const valanIdsInRange = allValans
      .filter(v => { const ve = new Date(v.endDate); return ve >= monthFirst && ve <= safeEnd; })
      .map(v => v._id);

    const requesterUser = await UserModel.findById(userId).select('accountType').populate('accountType', 'level').lean();
    const userLevel = Number(requesterUser?.accountType?.level) || 0;
    const isLevel7 = userLevel === 7;
    const isBroker = userLevel === 6;

    // Opening balance is calculated for the FILTER month (same as getLedgerList)
    const monthKey = monthKeyFromDate(rangeStart);
    let absoluteOpeningBalance = await getUplineMonthlyOpening(userId, monthKey, filterMarketGroup, currencyMap); // NO negation for upline settlement
    console.log('[getUplineSettlementList] absoluteOpeningBalance:', absoluteOpeningBalance);

    // Fetch bills, cash, JV in the range [monthFirst, safeEnd] (same as getLedgerList)
    const [billedData, cashData, jvData] = await Promise.all([
      // For brokers, fetch bills where they appear in partnershipBreakdown OR brockersBrokerage
      isBroker
        ? FinalBillModel.find({
            $or: [
              { 'partnershipBreakdown.userId': oid(userId) },
              { 'brockersBrokerage.brokerId': oid(userId) }
            ],
            valanId: { $in: valanIdsInRange }
          }).sort({ createdAt: -1 }).lean()
        : FinalBillModel.find(
            isLevel7
              ? { userId: oid(userId), valanId: { $in: valanIdsInRange } }
              : { level: 7, 'partnershipBreakdown.userId': oid(userId), valanId: { $in: valanIdsInRange } }
          ).sort({ createdAt: -1 }).lean(),
      CashLedgerModel.find({ userId: oid(userId), date: { $gte: monthFirst, $lte: safeEnd } }).lean(),
      JVLedgerModel.find({
        $or: [{ debitAccount: oid(userId) }, { creditAccount: oid(userId) }],
        date: { $gte: monthFirst, $lte: safeEnd }
      }).lean()
    ]);

    // Calculate effective opening balance (same logic as getLedgerList)
    let effectiveOpeningBalance = absoluteOpeningBalance;
    let preFilterTransactions = 0;

    if (userProvidedDateFilter && rangeStart > monthFirst) {
      // User filtered to a date WITHIN the month (same as getLedgerList logic)
      console.log('[getUplineSettlementList] Calculating pre-filter transactions');
      
      // Calculate bills that fall before the filter date
      const preFilterBills = billedData.filter(b => {
        const billDate = new Date(b.createdAt);
        return billDate < rangeStart;
      });

      for (const bill of preFilterBills) {
        const groupName = getMarketGroupName(bill.marketId);
        if (filterMarketGroup && groupName !== filterMarketGroup) continue;
        
        if (isBroker) {
          // Broker: partnership AS-IS, brokerage AS-IS
          let partnershipAmount = 0;
          let brokerageAmount = 0;
          
          if (Array.isArray(bill.partnershipBreakdown)) {
            const brokerShare = bill.partnershipBreakdown.find(
              pb => pb.userId && pb.userId.toString() === userIdStr
            );
            if (brokerShare) {
              partnershipAmount = Number(brokerShare.amount || 0); // AS-IS
            }
          }
          
          if (Array.isArray(bill.brockersBrokerage)) {
            bill.brockersBrokerage.forEach(brok => {
              if (brok && brok.brokerId && brok.brokerId.toString() === userIdStr) {
                brokerageAmount += Number(brok.rate || 0); // AS-IS
              }
            });
          }
          
          preFilterTransactions += applyFx(bill.marketId, groupName, partnershipAmount + brokerageAmount);
        } else {
          // Non-broker logic
          const share = isLevel7
            ? applyFx(bill.marketId, groupName, -Number(bill.totalM2M || 0))
            : -getUplineShareFromBill(bill, userIdStr, applyFx);
          preFilterTransactions += share;
        }
      }

      // Calculate cash transactions before filter date (as-is)
      const preFilterCash = cashData.filter(c => c.date < rangeStart);
      for (const c of preFilterCash) {
        preFilterTransactions += getCashEffect(c); // As-is
      }

      // Calculate JV transactions before filter date (as-is)
      const preFilterJV = jvData.filter(j => j.date < rangeStart);
      for (const j of preFilterJV) {
        const isCredit = j.creditAccount?.toString() === userIdStr;
        const effect = isCredit ? Number(j.amount || 0) : -Number(j.amount || 0);
        preFilterTransactions += effect; // As-is
      }

      effectiveOpeningBalance = absoluteOpeningBalance + preFilterTransactions;
      console.log('[getUplineSettlementList] preFilterTransactions:', preFilterTransactions);
      console.log('[getUplineSettlementList] effectiveOpeningBalance:', effectiveOpeningBalance);
    }

    // Group bills by valan+market
    const interleavedList = [];
    
    console.log('[getUplineSettlementList] isBroker:', isBroker, 'userLevel:', userLevel);
    console.log('[getUplineSettlementList] billedData count:', billedData.length);
    
    // For brokers, separate partnership and brokerage entries (same as getLedgerList)
    if (isBroker) {
      console.log('[getUplineSettlementList] Using BROKER-specific grouping logic');
      const brokerPartnershipGroups = new Map();
      const brokerBrokerageGroups = new Map();
      
      for (const bill of billedData) {
        const groupName = getMarketGroupName(bill.marketId);
        if (filterMarketGroup && groupName !== filterMarketGroup) continue;
        
        const key = `${bill.valanId.toString()}_${groupName}`;
        
        // Extract broker's partnership share and brokerage earnings
        // For upline settlement, amounts are AS-IS (not negated)
        let partnershipAmount = 0;
        let brokerageAmount = 0;
        
        if (Array.isArray(bill.partnershipBreakdown)) {
          const brokerShare = bill.partnershipBreakdown.find(
            pb => pb.userId && pb.userId.toString() === userIdStr
          );
          if (brokerShare) {
            partnershipAmount = Number(brokerShare.amount || 0); // AS-IS for upline settlement
          }
        }
        
        if (Array.isArray(bill.brockersBrokerage)) {
          bill.brockersBrokerage.forEach(brok => {
            if (brok && brok.brokerId && brok.brokerId.toString() === userIdStr) {
              brokerageAmount += Number(brok.rate || 0); // AS-IS (positive)
            }
          });
        }
        
        // Add to partnership group
        if (Math.abs(partnershipAmount) > 0.001) {
          const current = brokerPartnershipGroups.get(key) || {
            amount: 0,
            valanId: bill.valanId,
            date: bill.createdAt,
            marketId: bill.marketId,
            markets: [],
            groupName
          };
          current.amount += applyFx(bill.marketId, groupName, partnershipAmount);
          if (!current.markets.includes(String(bill.marketId))) {
            current.markets.push(String(bill.marketId));
          }
          brokerPartnershipGroups.set(key, current);
        }
        
        // Add to brokerage group
        if (Math.abs(brokerageAmount) > 0.001) {
          const current = brokerBrokerageGroups.get(key) || {
            amount: 0,
            valanId: bill.valanId,
            date: bill.createdAt,
            marketId: bill.marketId,
            markets: [],
            groupName
          };
          current.amount += applyFx(bill.marketId, groupName, brokerageAmount);
          if (!current.markets.includes(String(bill.marketId))) {
            current.markets.push(String(bill.marketId));
          }
          brokerBrokerageGroups.set(key, current);
        }
      }
      
      // Add partnership entries
      brokerPartnershipGroups.forEach(data => {
        if (Math.abs(data.amount) > 0.001) {
          const valan = valanMap.get(data.valanId.toString());
          interleavedList.push({
            type: 'VALAN_PARTNERSHIP',
            amount: data.amount,
            valanName: `${valan?.label || 'Previous Valan'} ${data.groupName} Partnership`,
            date: valan?.endDate || data.date,
            status: 'BILLED',
            isLive: false,
            remark: `${valan?.label || 'Previous Valan'} ${data.groupName} Partnership`,
            valanId: data.valanId,
            markets: data.markets
          });
        }
      });
      
      console.log('[getUplineSettlementList] BROKER - partnership entries:', brokerPartnershipGroups.size);
      console.log('[getUplineSettlementList] BROKER - brokerage entries:', brokerBrokerageGroups.size);
      
      // Add brokerage entries
      brokerBrokerageGroups.forEach(data => {
        if (Math.abs(data.amount) > 0.001) {
          const valan = valanMap.get(data.valanId.toString());
          interleavedList.push({
            type: 'VALAN_BROKERAGE',
            amount: data.amount,
            valanName: `${valan?.label || 'Previous Valan'} ${data.groupName} Brokerage`,
            date: valan?.endDate || data.date,
            status: 'BILLED',
            isLive: false,
            remark: `${valan?.label || 'Previous Valan'} ${data.groupName} Brokerage`,
            valanId: data.valanId,
            markets: data.markets
          });
        }
      });
    } else {
      // Non-broker logic (existing)
      const billedGroups = new Map();
      for (const bill of billedData) {
        const groupName = getMarketGroupName(bill.marketId);
        if (filterMarketGroup && groupName !== filterMarketGroup) continue;
        const key = `${bill.valanId.toString()}_${groupName}`;
        const share = isLevel7
          ? applyFx(bill.marketId, groupName, -Number(bill.totalM2M || 0))
          : -getUplineShareFromBill(bill, userIdStr, applyFx);
        const cur = billedGroups.get(key) || { amount: 0, valanId: bill.valanId, date: bill.createdAt, groupName };
        cur.amount += share;
        billedGroups.set(key, cur);
      }
      
      billedGroups.forEach(data => {
        if (Math.abs(data.amount) > 0.001) {
          const valan = valanMap.get(data.valanId.toString());
          interleavedList.push({
            type: 'VALAN',
            amount: data.amount,
            valanName: `${valan?.label || 'Previous Valan'} ${data.groupName}`,
            date: valan?.endDate || data.date,
            status: 'BILLED',
            isLive: false,
            remark: `${valan?.label || 'Previous Valan'} ${data.groupName}`,
            valanId: data.valanId
          });
        }
      });
    }

    // Add cash transactions (as-is, not negated)
    cashData.forEach(c => {
      if (c.date < rangeStart) return;
      interleavedList.push({
        type: 'CASH',
        amount: getCashEffect(c), // As-is for upline settlement
        date: c.date,
        remarks: c.remarks || (c.transactionType === 'RECEIPT' ? 'Cash Receipt' : 'Cash Payment'),
        transactionType: c.transactionType
      });
    });

    // Add JV transactions (as-is, not negated)
    jvData.forEach(j => {
      if (j.date < rangeStart) return;
      const isCredit = j.creditAccount?.toString() === userIdStr;
      const effect = isCredit ? Number(j.amount || 0) : -Number(j.amount || 0);
      if (!effect) return;
      interleavedList.push({ type: 'JV', amount: effect, date: j.date, remarks: j.remarks || 'JV Record' }); // As-is for upline settlement
    });

    interleavedList.sort((a, b) => new Date(a.date) - new Date(b.date));

    let runningAmount = effectiveOpeningBalance;
    const finalData = [];

    console.log('[getUplineSettlementList] effectiveOpeningBalance:', effectiveOpeningBalance);
    console.log('[getUplineSettlementList] interleavedList count:', interleavedList.length);
    console.log('[getUplineSettlementList] interleavedList total:', interleavedList.reduce((sum, item) => sum + item.amount, 0));

    if (Math.abs(effectiveOpeningBalance) > 0.001) {
      const label = userProvidedDateFilter && rangeStart > monthFirst
        ? `Opening balance as of ${rangeStart.toLocaleDateString()} (includes transactions up to this date)`
        : `Opening balance as of ${rangeStart.toLocaleDateString()} (Previous Month Final)`;
      finalData.push({ type: 'OPENING', amount: effectiveOpeningBalance, balance: effectiveOpeningBalance, date: rangeStart, remarks: label, isOpening: true });
    }

    interleavedList.forEach(item => {
      runningAmount += item.amount;
      finalData.push({ ...item, balance: runningAmount });
    });

    console.log('[getUplineSettlementList] final runningAmount:', runningAmount);

    return res.json({ status: true, amount: runningAmount, data: finalData.reverse() });
  } catch (error) {
    console.error('[getUplineSettlementList] Error:', error);
    res.status(500).json({ status: false, message: error.message });
  }
};

exports.createCashLedger = async (req, res) => {
  try {
    const createdBy = getEffectiveUserId(req);
    const { userId, transactionType, remarks, date, amount } = req.body;
    const now = new Date();
    const setDateTime = new Date(date).setHours(
      now.getHours(),
      now.getMinutes(),
      now.getSeconds(),
      now.getMilliseconds()
    );
    const ip = req.headers["x-forwarded-for"] || req.socket.remoteAddress || req.ip;
    await saveCashLedger({
      userId,
      transactionType: transactionType.toUpperCase(),
      remarks,
      date: setDateTime,
      amount,
      createdBy,
      ip,
    });

    res.status(200).json({ status: true, message: "Successfully saved" });
  } catch (error) {
    // console.log(error);
    res.status(500).json({ status: "false", message: error.message });
  }
};

exports.getCashLedger = async (req, res) => {
  try {
    const userId = getEffectiveUserId(req);
    const { user, startDate, endDate } = req.body;

    const id = new mongoose.Types.ObjectId(userId);
    let matchFilter = {
      $or: [{ createdBy: id }, { userId: id }],
    };

    if (user) {
      matchFilter = {
        $or: [
          {
            $and: [
              { createdBy: id },
              { userId: new mongoose.Types.ObjectId(user) },
            ],
          },
          {
            $and: [
              { userId: id },
              { createdBy: new mongoose.Types.ObjectId(user) },
            ],
          },
        ],
      };
    }

    if (startDate || endDate) {
      matchFilter.createdAt = {};
      if (startDate) {
        const { startOfDay: sDate } = getCurrentDateRangeLocal(startDate);
        matchFilter.createdAt.$gte = sDate;
      }
      if (endDate) {
        const { endOfDay: eDate } = getCurrentDateRangeLocal(endDate);
        matchFilter.createdAt.$lte = eDate;
      }
    }

    const isRequesterDemo = isDemoUser(req);

    const response = await getCashLedger(matchFilter, id, isRequesterDemo);
    res.status(200).json({ status: true, data: response });
  } catch (error) {
    // console.log(error);
    res.status(500).json({ status: "false", message: error.message });
  }
};

exports.deleteCashLedger = async (req, res) => {
  try {
    const userId = getEffectiveUserId(req);
    const ip = req.headers["x-forwarded-for"] || req.socket.remoteAddress || req.ip;
    const { _id } = req.body;
    const response = await deleteCashLedger(_id, userId, ip);
    res.status(200).json({ status: true, data: response });
  } catch (error) {
    // console.log(error);
    res.status(500).json({ status: "false", message: error.message });
  }
};

exports.updateCashLedger = async (req, res) => {
  try {
    const userId = getEffectiveUserId(req);
    const ip = req.headers["x-forwarded-for"] || req.socket.remoteAddress || req.ip;
    const { _id, transactionType, amount, date, remarks } = req.body;
    const now = new Date();
    const setDateTime = new Date(date).setHours(
      now.getHours(),
      now.getMinutes(),
      now.getSeconds(),
      now.getMilliseconds()
    );
    const details = {
      transactionType,
      amount: Math.abs(amount),
      date: setDateTime,
      remarks,
      ip,
    };
    const response = await updateCashLedger(_id, details);
    res.status(200).json({ status: true, data: response });
  } catch (error) {
    // console.log(error);
    res.status(500).json({ status: "false", message: error.message });
  }
};

exports.createDepositWithdraw = async (req, res) => {
  try {
    const createdBy = getLoginUserId(req);
    const { userId, transactionType, remarks, date, amount } = req.body;
    const now = new Date();
    const setDateTime = new Date(date).setHours(
      now.getHours(),
      now.getMinutes(),
      now.getSeconds(),
      now.getMilliseconds()
    );
    const ip = req.headers["x-forwarded-for"] || req.socket.remoteAddress || req.ip;
    await saveDepositWithdraw({
      userId,
      transactionType: transactionType.toUpperCase(),
      remarks,
      date: setDateTime,
      amount,
      createdBy,
      ip,
    });
    res.status(200).json({ status: true, message: "Successfully saved" });
  } catch (error) {
    // console.log(error);
    res.status(500).json({ status: "false", message: error.message });
  }
};

exports.getDepositWithdraw = async (req, res) => {
  try {
    const userId = getEffectiveUserId(req);
    const { user, startDate, endDate } = req.body;

    const id = new mongoose.Types.ObjectId(userId);
    let matchFilter = {
      $or: [{ createdBy: id }, { userId: id }],
    };

    if (user) {
      matchFilter = {
        $or: [
          {
            $and: [
              { createdBy: id },
              { userId: new mongoose.Types.ObjectId(user) },
            ],
          },
          {
            $and: [
              { userId: id },
              { createdBy: new mongoose.Types.ObjectId(user) },
            ],
          },
        ],
      };
    }

    if (startDate || endDate) {
      matchFilter.createdAt = {};
      if (startDate) {
        const { startOfDay: sDate } = getCurrentDateRangeLocal(startDate);
        matchFilter.createdAt.$gte = sDate;
      }
      if (endDate) {
        const { endOfDay: eDate } = getCurrentDateRangeLocal(endDate);
        matchFilter.createdAt.$lte = eDate;
      }
    }

    const isRequesterDemo = isDemoUser(req);

    const response = await getDepositWithdraw(matchFilter, id, isRequesterDemo);
    res.status(200).json({ status: true, data: response });
  } catch (error) {
    // console.log(error);
    res.status(500).json({ status: "false", message: error.message });
  }
};

exports.deleteDepositWithdraw = async (req, res) => {
  try {
    const userId = getLoginUserId(req);
    const ip = req.headers["x-forwarded-for"] || req.socket.remoteAddress || req.ip;
    const { _id } = req.body;
    const response = await deleteDepositWithdraw(_id, userId, ip);
    res.status(200).json({ status: true, data: response });
  } catch (error) {
    // console.log(error);
    res.status(500).json({ status: "false", message: error.message });
  }
};

exports.updateDepositWithdraw = async (req, res) => {
  try {
    const userId = getLoginUserId(req);
    const { _id, transactionType, amount, date, remarks } = req.body;
    const now = new Date();
    const setDateTime = new Date(date).setHours(
      now.getHours(),
      now.getMinutes(),
      now.getSeconds(),
      now.getMilliseconds()
    );
    const ip = req.headers["x-forwarded-for"] || req.socket.remoteAddress || req.ip;
    const details = {
      transactionType,
      amount: Math.abs(amount),
      date: setDateTime,
      remarks,
      ip,
    };
    const response = await updateDepositWithdraw(_id, details);
    res.status(200).json({ status: true, data: response });
  } catch (error) {
    // console.log(error);
    res.status(500).json({ status: "false", message: error.message });
  }
};

exports.getLedgerLog = async (req, res) => {
  try {
    const userId = getEffectiveUserId(req);

    const isRequesterDemo = isDemoUser(req);

    const { type, from_date, to_date, clientId } = req.body;
    let query = {};
    query[`${type}Log.createdBy`] = userId;
    if (clientId) {
      query[`${type}Log.userId`] = clientId;
    }
    if (from_date || to_date) {
      query[`${type}Log.add_time`] = {};

      if (from_date) {
        query[`${type}Log.add_time`].$gte = new Date(from_date).getTime();
      }

      if (to_date) {
        query[`${type}Log.add_time`].$lte = new Date(to_date).setHours(
          23,
          59,
          59,
          999
        );
      }
    }
    const response = await getLedgerLog(query, type, isRequesterDemo);
    res.status(200).json({ status: true, data: response });
  } catch (error) {
    // console.log(error);
    res.status(500).json({ status: "false", message: error.message });
  }
};

exports.getRejectionLog = async (req, res) => {
  try {
    const userId = getEffectiveUserId(req);
    const level = req.user.accountType?.level;

    // Fetch current user to check demoid status and get market access
    const { getUserWithMarketAccess } = require('../utils/brokerHelpers');
    const currentUser = await getUserWithMarketAccess(userId, { demoid: 1, marketAccess: 1, accountType: 1, parentIds: 1 });
    const isRequesterDemo = currentUser?.demoid === true;

    const { market, script, transactionType, startDate, endDate, client, all } =
      req.body;
    const isAll = all === true || all === "true";
    const { startOfDay, endOfDay } = getCurrentDateRange();
    let query = {
      [level == 7 ? "rejectionLog.clientId" : "rejectionLog.parentIds"]:
        new mongoose.Types.ObjectId(userId),
      type: "rejection",
    };

    if (!isAll) {
      query.createdAt = { $gte: startOfDay, $lte: endOfDay };
    }

    if (market && market != "") {
      query["rejectionLog.marketId"] = market;
    }
    if (script && script != "") {
      query["rejectionLog.scriptId"] = script;
    }
    if (transactionType && transactionType != "") {
      query["rejectionLog.txn_type"] = transactionType;
    }
    if (client && client != "") {
      query["rejectionLog.clientId"] = new mongoose.Types.ObjectId(client);
    }
    if (startDate && startDate !== "" && startDate !== undefined) {
      const { startOfDay: sDate } = getCurrentDateRange(startDate);
      if (!query.createdAt) query.createdAt = {};
      query["createdAt"].$gte = sDate;
    }
    if (endDate && endDate !== "" && endDate !== undefined) {
      const { endOfDay: eDate } = getCurrentDateRange(endDate);
      if (!query.createdAt) query.createdAt = {};
      query["createdAt"].$lte = eDate;
    }

    // If user is a broker with inherited marketAccess, filter by those markets
    if (currentUser && currentUser.accountType?.level === 6 && currentUser.marketAccess && currentUser.marketAccess.length > 0) {
      const { getMarketIds } = require('../utils/brokerHelpers');
      const marketIds = getMarketIds(currentUser.marketAccess);
      if (marketIds.length > 0 && !market) {
        // Only apply market filter if user didn't specify a market
        query["rejectionLog.marketId"] = { $in: marketIds };
      }
    }

    const response = await getRejectionLog(query, isRequesterDemo);

    res.status(200).json({ status: true, data: response });
  } catch (error) {
    // console.log(error);
    res.status(500).json({ status: "false", message: error.message });
  }
};

exports.noActiveUsers = async (req, res) => {
  try {
    const { valanId, userType } = req.body;
    const ignoreDemo = isDemoUser(req);
    const data =
      userType === "active"
        ? await activeUsers(valanId, ignoreDemo)
        : await noActiveUsers(valanId, ignoreDemo);
    res.status(200).json({ status: true, data });
  } catch (error) {
    // console.log(error);
    res.status(500).json({ status: "false", message: error.message });
  }
};
exports.deactivateNoActiveUsers = async (req, res) => {
  try {
    const { valanId } = req.body;
    if (!valanId) {
      return res.status(400).json({ status: false, message: "valanId is required" });
    }
    const result = await deactivateAllNoActiveUsers(valanId);
    res.status(200).json({ status: true, message: `${result.deactivated} no-active user(s) deactivated.`, data: result });
  } catch (error) {
    // console.log(error);
    res.status(500).json({ status: false, message: error.message });
  }
};


// exports.noActiveUsers = async (req, res) => {
//   try {
//     const { valanId } = req.body;
//     const data = await noActiveUsers(valanId);
//     res.status(200).json({ status: true, data });
//   } catch (error) {
//     // console.log(error);
//     res.status(500).json({ status: "false", message: error.message });
//   }
// };

exports.sameIpReport = async (req, res) => {
  try {
    const { valanId } = req.body;
    const data = await sameIpReport(valanId);
    res.status(200).json({ status: true, data });
  } catch (error) {
    // console.log(error);
    res.status(500).json({ status: "false", message: error.message });
  }
};

exports.deleteProfitableUserTrades = async (req, res) => {
  try {
    const { userId: targetUserId, valanId } = req.body;
    const deletedBy = getLoginUserId(req);

    if (!targetUserId || !valanId) {
      return res.status(400).json({ status: false, message: "userId and valanId are required" });
    }

    // 1. Fetch all COMPLETED transactions for this specific User and Valan
    const transactions = await StockTransaction.find({
      userId: new mongoose.Types.ObjectId(targetUserId),
      valanId: new mongoose.Types.ObjectId(valanId),
      transactionStatus: "COMPLETED"
    }).sort({ createdAt: 1 }).lean();

    if (transactions.length === 0) {
      return res.status(200).json({ status: true, message: "No trades found for this user in the specified valan." });
    }

    // 2. Group trades by Script
    const scriptGroups = {};
    for (const tx of transactions) {
      if (!scriptGroups[tx.scriptId]) scriptGroups[tx.scriptId] = [];
      scriptGroups[tx.scriptId].push(tx);
    }

    let deletedTradeCount = 0;

    // 3. Process each group using Weighted Average Logic
    for (const scriptId in scriptGroups) {
      const scriptTrades = scriptGroups[scriptId];

      let totalBuyQty = 0, totalBuyVal = 0;
      let totalSellQty = 0, totalSellVal = 0;

      for (const t of scriptTrades) {
        if (t.transactionType === 'BUY') {
          totalBuyQty += t.quantity;
          totalBuyVal += t.totalNetPrice;
        } else {
          totalSellQty += t.quantity;
          totalSellVal += t.totalNetPrice;
        }
      }

      const avgBuy = totalBuyQty > 0 ? (totalBuyVal / totalBuyQty) : 0;
      const avgSell = totalSellQty > 0 ? (totalSellVal / totalSellQty) : 0;
      const matchedQty = Math.min(totalBuyQty, totalSellQty);

      // Check if this script's matched portion is profitable
      if (matchedQty > 0 && avgSell > avgBuy) {

        const idsToDelete = new Set();

        // Identify Buy trades to delete (FIFO up to matchedQty)
        let runningBuyQty = 0;
        for (const t of scriptTrades.filter(tr => tr.transactionType === 'BUY')) {
          if (runningBuyQty < matchedQty) {
            idsToDelete.add(t._id.toString());
            runningBuyQty += t.quantity;
          }
        }

        // Identify Sell trades to delete (FIFO up to matchedQty)
        let runningSellQty = 0;
        for (const t of scriptTrades.filter(tr => tr.transactionType === 'SELL')) {
          if (runningSellQty < matchedQty) {
            idsToDelete.add(t._id.toString());
            runningSellQty += t.quantity;
          }
        }

        // 4. Hard Delete the identified trades
        for (const tradeId of idsToDelete) {
          const trade = scriptTrades.find(t => t._id.toString() === tradeId);
          if (trade) {
            try {
              await deleteTradeRecord({
                tradeId: trade._id,
                userId: trade.userId,
                marketId: trade.marketId,
                scriptId: trade.scriptId,
                valanId: trade.valanId,
                quantity: trade.quantity,
                transactionType: trade.transactionType,
                createdAt: trade.createdAt,
                deletedBy: deletedBy
              });

              // Log the hard delete action
              const rejectionLog = {
                action: "HARD_DEL",
                userId: trade.userId,
                symbol: trade.label,
                marketId: trade.marketId,
                scriptId: trade.scriptId,
                order_type: trade.orderType,
                lot: trade.lot,
                qty: trade.quantity,
                order_price: trade.orderPrice || trade.price,
                message: "Hard deleted profitable trade via Bulk ip Report",
                ip: req.headers["x-forwarded-for"] || req.socket.remoteAddress || req.ip,
                time: trade.createdAt,
                parentIds: trade.parentIds,
                created_by: deletedBy,
                txn_type: trade.transactionType,
              };
              await saveLog("trade", rejectionLog);

              deletedTradeCount++;
            } catch (delError) {
              console.error(`[User-Trade-Deletion] Failed to delete trade ${tradeId}:`, delError.message);
            }
          }
        }
      }
    }

    res.status(200).json({
      status: true,
      message: `Deleted ${deletedTradeCount} profitable trades for User ID: ${targetUserId}.`
    });

  } catch (error) {
    console.error("[deleteProfitableUserTrades] Error:", error);
    res.status(500).json({ status: false, message: error.message });
  }
};

exports.getBrokerageReport = async (req, res) => {
  try {
    const userId = getEffectiveUserId(req);
    const { market, script, valan, startDate, endDate, client } = req.body;
    const matchFilter = {};
    const { _id: valanId } = await getActiveWeekValan();
    matchFilter["valanId"] = valanId;

    const filterKeys = {
      market,
      script,
      valan,
      startDate,
      endDate,
      client,
    };

    Object.keys(filterKeys).forEach((data) => {
      if (data == "market" && filterKeys[data]) {
        matchFilter["marketId"] = market;
      }
      if (data == "script" && filterKeys[data]) {
        matchFilter["scriptId"] = script;
      }
      if (data == "valan" && filterKeys[data]) {
        matchFilter["valanId"] = new mongoose.Types.ObjectId(valan);
      }
      if (data == "client" && filterKeys[data]) {
        matchFilter["userId"] = client;
      }
      if (data == "startDate" && filterKeys[data]) {
        const { startOfDay: sDate } = getCurrentDateRangeLocal(filterKeys[data]);
        matchFilter["createdAt"] = { ...matchFilter["createdAt"], $gte: sDate };
      }
      if (data == "endDate" && filterKeys[data]) {
        const { endOfDay: eDate } = getCurrentDateRangeLocal(filterKeys[data]);
        matchFilter["createdAt"] = { ...matchFilter["createdAt"], $lte: eDate };
      }
    });
    const response = await getFilterStockTransactions(
      {
        parentIds: new mongoose.Types.ObjectId(userId),
        transactionStatus: "COMPLETED",
        brokerTotalBrokerage: { $gt: 0 },
        ...matchFilter,
      },
      {
        createdAt: 1,
        userId: 1,
        orderPrice: 1,
        label: 1,
        transactionType: 1,
        lot: 1,
        quantity: 1,
        brokerTotalBrokerage: 1,
      },
      { createdAt: -1 }
    );

    const isRequesterDemo = isDemoUser(req);

    const userIds = response.map((dt) => dt.userId);

    const userQuery = { _id: { $in: userIds } };
    userQuery.demoid = isRequesterDemo ? true : { $ne: true };

    const users = await UserModel.find(userQuery)
      .select({ accountName: 1, accountCode: 1, accountType: 1 })
      .populate("accountType", "level")
      .lean();

    const usersMap = new Map(
      users.map((user) => [
        user._id.toString(),
        {
          accountName: user.accountName,
          accountCode: user.accountCode,
          level: user.accountType?.level,
        },
      ])
    );

    const data = response
      .map((item) => {
        const user = usersMap.get(item.userId.toString());
        if (!user) return null;
        return { ...item, user };
      })
      .filter((item) => item !== null);

    res.status(200).json({ status: true, data });
  } catch (error) {
    // console.log(error);
    res.status(500).json({ status: "false", message: error.message });
  }
};

function getCurrentDateRangeLocal(inputDate = new Date()) {
  const date = new Date(inputDate);
  const startOfDay = new Date(
    date.getFullYear(),
    date.getMonth(),
    date.getDate()
  );
  const endOfDay = new Date(
    date.getFullYear(),
    date.getMonth(),
    date.getDate(),
    23,
    59,
    59,
    999
  );
  return { startOfDay, endOfDay };
};

exports.getTradeLog = async (req, res) => {
  try {
    const userId = getEffectiveUserId(req);
    const { accountType } = req.user;

    const isRequesterDemo = isDemoUser(req);

    // Defensive check for accountType
    const level = accountType ? accountType.level : undefined;
    if (!level) {
      throw new Error("User account level is missing");
    }

    const { market, script, updated, deleted, startDate, endDate, client, all } = req.body;

    const isAll = all === true || all === "true";

    // Use local function to avoid import issues
    const { startOfDay, endOfDay } = getCurrentDateRangeLocal();

    let query = {
      [level == 7 ? "tradeLog.userId" : "tradeLog.parentIds"]: new mongoose.Types.ObjectId(userId),
      type: "trade",
    };

    if (!isAll) {
      query.createdAt = { $gte: startOfDay, $lte: endOfDay };
    }

    let actionType = [];

    if (market && market !== "") {
      query["tradeLog.marketId"] = market;
    }
    if (script && script !== "") {
      query["tradeLog.scriptId"] = script;
    }
    if (client && client !== "") {
      query["tradeLog.userId"] = new mongoose.Types.ObjectId(client);
    }
    if (startDate && startDate !== "") {
      const { startOfDay: sDate } = getCurrentDateRangeLocal(startDate);
      if (!query.createdAt) query.createdAt = {};
      query["createdAt"].$gte = sDate;
    }
    if (endDate && endDate !== "") {
      const { endOfDay: eDate } = getCurrentDateRangeLocal(endDate);
      if (!query.createdAt) query.createdAt = {};
      query["createdAt"].$lte = eDate;
    }

    // Ensure boolean conversion if sent as strings
    const isUpdated = updated === true || updated === "true";
    const isDeleted = deleted === true || deleted === "true";
    if (isUpdated) {
      actionType.push("EDT");
    }
    if (isDeleted) {
      actionType.push("DEL");
    }
    if (actionType?.length) {
      // Case 1: explicit action types
      query["tradeLog.action"] = { $in: actionType };

    } else {
      const actions = [];

      if (isUpdated) actions.push("EDT");
      if (isDeleted) actions.push("DEL");

      if (actions.length) {
        // Case 2: one or both flags true
        query["tradeLog.action"] = { $in: actions };
      } else {
        // Case 3: no filter → show all actions (INS, DEL, EDT) so delete/cancel entries appear in trades log
        // Do not add tradeLog.action filter; all log entries are returned
      }
    }



    const response = await getTradeLog(query, isRequesterDemo);
    const safeResponse = response || [];
    res.status(200).json({ status: true, data: safeResponse });
  } catch (error) {
    console.error("getTradeLog Error:", error);
    res.status(500).json({ status: "false", message: error.message });
  }
};

exports.getQuantitySettingLog = async (req, res) => {
  try {
    const userId = getEffectiveUserId(req);
    const level = req.user.accountType?.level;

    const { market, script, startDate, endDate, client, all } = req.body;
    const isAll = all === true || all === "true";
    const { startOfDay, endOfDay } = getCurrentDateRangeLocal();

    let query = {
      type: "quantitySetting",
    };

    // Level 7 is likely "Client" or "User" - adjust if necessary based on your system
    if (level == 7) {
      query["quantitySettingLog.clientId"] = new mongoose.Types.ObjectId(userId);
    } else {
      query["quantitySettingLog.parentIds"] = new mongoose.Types.ObjectId(userId);
    }

    if (!isAll) {
      query.createdAt = { $gte: startOfDay, $lte: endOfDay };
    }

    if (market && market != "") {
      query["quantitySettingLog.marketId"] = market;
    }
    if (script && script != "") {
      query["quantitySettingLog.scriptId"] = script;
    }
    if (client && client != "") {
      query["quantitySettingLog.clientId"] = new mongoose.Types.ObjectId(client);
    }

    if (startDate && startDate !== "") {
      const { startOfDay: sDate } = getCurrentDateRangeLocal(startDate);
      if (!query.createdAt) query.createdAt = {};
      query["createdAt"].$gte = sDate;
    }
    if (endDate && endDate !== "") {
      const { endOfDay: eDate } = getCurrentDateRangeLocal(endDate);
      if (!query.createdAt) query.createdAt = {};
      query["createdAt"].$lte = eDate;
    }

    const isRequesterDemo = isDemoUser(req);
    const response = await getQuantitySettingLog(query, isRequesterDemo);

    res.status(200).json({ status: true, data: response });
  } catch (error) {
    // console.log(error);
    res.status(500).json({ status: "false", message: error.message });
  }
};

exports.setBrokerageRefresh = async (req, res, next) => {
  try {
    const createdBy = getLoginUserId(req);
    let { userId, marketId, valanId } = req.body;

    userId = new mongoose.Types.ObjectId(userId);
    valanId = new mongoose.Types.ObjectId(valanId);

    const getValan = await WeekValanModel.findOne({ _id: valanId })
      .select({ label: 1, segment: 1 })
      .lean();

    if (!getValan) {
      return res
        .status(400)
        .json({ status: "false", message: "No valan exists" });
    }

    const segmentDetails = getValan.segment.find((sgm) => sgm.id == marketId);
    if (!segmentDetails) {
      return res
        .status(400)
        .json({ status: "false", message: "No valan name exists" });
    }

    const marketName = segmentDetails.name;
    const valanName = getValan.label + " " + segmentDetails.name;

    const getUserDetails = await UserModel.findOne({ _id: userId })
      .select({
        accountName: 1,
        accountCode: 1,
        marketAccess: 1,
        basicDetails: 1,
        parentIds: 1,
      })
      .lean();

    if (!getUserDetails) {
      return res
        .status(400)
        .json({ status: "false", message: "User not exists" });
    }

    const market = getUserDetails.marketAccess.find(
      (mkt) => mkt.marketId == marketId
    );
    if (!market) {
      return res
        .status(400)
        .json({ status: "false", message: "No market exists" });
    }

    let brokerageIntradayPercentage = market.brokerage.intradayCommission || 0;
    let brokerageDeliveryPercentage = market.brokerage.deliveryCommission || 0;

    const trades = await StockTransaction.aggregate([
      {
        $match: {
          userId,        // ← only this client's trades
          marketId,
          valanId,
          transactionStatus: "COMPLETED",
        },
      },
      {
        $group: {
          _id: "$scriptId",
          items: { $push: "$$ROOT" },
        },
      },
      // No $limit — process ALL scripts for this client
    ]);

    if (trades.length == 0) {
      return res
        .status(400)
        .json({ status: "false", message: "No trade exists" });
    }

    let changeTrades = [];

    for (let script of trades) {
      const normalizedTradeScript = getBaseScriptName(script._id);

      const checkScriptBrokerage = market.brokerage.scriptWiseBrokerage.find(
        (s) => s.script && (normalizedTradeScript === getBaseScriptName(s.script) || (script.items[0] && script.items[0].scriptName && script.items[0].scriptName.toUpperCase().trim() === s.script.toUpperCase().trim()))
      );


      let isClientScriptWise = false;
      let scriptIntradayPercentage = brokerageIntradayPercentage;
      let scriptDeliveryPercentage = brokerageDeliveryPercentage;
      if (checkScriptBrokerage) {
        scriptIntradayPercentage = checkScriptBrokerage.intradayCommission || 0;
        scriptDeliveryPercentage = checkScriptBrokerage.deliveryCommission || 0;
        isClientScriptWise = true;
      }

      for (let trade of script.items) {
        let editDetails = { id: trade._id };

        let netBrokerage = 0;
        let orderBrokerage = 0;
        let netPrice = 0;
        let totalNetPrice = 0;
        let brokerageIntraday = 0;
        let brokerageDelivery = 0;
        
        // Declare delivery commission variables at trade level scope
        let delBrokerageToAdd = 0;
        let delBrokerBrokerageToAdd = [];

        if (trade.type === "NRM" || trade.type === "AUTO_SQ" ) {
          // Normal Trade: Calculate based on current commissions
          
          // Check if this is NSE-EQ and has DEL applied
          const isNseEq = marketId === '12';
          const hasDelApplied = trade.delDetails && trade.delDetails.delApplied;
          
          if (isNseEq && hasDelApplied) {
            // For NSE-EQ with DEL applied, split calculation:
            // - Use delivery rate for the quantity that has DEL applied
            // - Use intraday rate for the remaining quantity
            const delAppliedQty = trade.delDetails.appliedQty || 0;
            const intradayQty = trade.quantity - delAppliedQty;
            
            // console.log(`[BrokerageRefresh] Trade ${trade._id}: NSE-EQ with DEL - DEL qty=${delAppliedQty}, Intraday qty=${intradayQty}`);
            
            if (market.brokerage.type == "lot") {
              const lotFactor = trade.quantity > 0 ? (trade.lot / trade.quantity) : 0;
              const delBrokerage = delAppliedQty * scriptDeliveryPercentage * lotFactor;
              const intradayBrokerage = intradayQty * scriptIntradayPercentage * lotFactor;
              netBrokerage = delBrokerage + intradayBrokerage;
              orderBrokerage = trade.quantity > 0 ? (netBrokerage / trade.quantity) : 0;
            } else {
              const delBrokerage = (delAppliedQty * trade.orderPrice * scriptDeliveryPercentage) / 100;
              const intradayBrokerage = (intradayQty * trade.orderPrice * scriptIntradayPercentage) / 100;
              netBrokerage = delBrokerage + intradayBrokerage;
              orderBrokerage = trade.quantity > 0 ? (netBrokerage / trade.quantity) : 0;
            }
          } else {
            // Standard calculation for non-NSE-EQ or positions without DEL
            if (market.brokerage.type == "lot") {
              const lotFactor = trade.quantity > 0 ? (trade.lot / trade.quantity) : 0;
              netBrokerage =
                (trade.quantityType.intraday * scriptIntradayPercentage * lotFactor) +
                (trade.quantityType.delivery * scriptDeliveryPercentage * lotFactor);
              orderBrokerage = trade.quantity > 0 ? (netBrokerage / trade.quantity) : 0;
            } else {
              netBrokerage =
                (trade.quantityType.intraday *
                  trade.orderPrice *
                  scriptIntradayPercentage) /
                100 +
                (trade.quantityType.delivery *
                  trade.orderPrice *
                  scriptDeliveryPercentage) /
                100;
              orderBrokerage = trade.quantity > 0 ? (netBrokerage / trade.quantity) : 0;
            }
          }

          if (trade.transactionType == "BUY") {
            netPrice = trade.orderPrice + orderBrokerage;
            totalNetPrice = netPrice * trade.quantity;
          } else {
            netPrice = trade.orderPrice - orderBrokerage;
            totalNetPrice = netPrice * trade.quantity;
          }
          brokerageIntraday = scriptIntradayPercentage;
          brokerageDelivery = scriptDeliveryPercentage;
        } else {
          // Non-NRM Trade: Revert brokerage (NetRate = Rate)
          netBrokerage = 0;
          orderBrokerage = 0;
          netPrice = trade.orderPrice;
          totalNetPrice = netPrice * trade.quantity;
          brokerageIntraday = 0;
          brokerageDelivery = 0;
        }

        const _pct = trade.orderPrice && Number.isFinite(Number(trade.orderPrice)) ? (orderBrokerage * 100) / trade.orderPrice : 0;
        const brokeragePercentage = Number.isFinite(_pct) ? Number(_pct.toFixed(4)) : 0;

        const brokeragePercentageType = {
          intraday: brokerageIntraday,
          delivery: brokerageDelivery,
        };

        editDetails = {
          ...editDetails,
          netPrice,
          totalNetPrice,
          orderBrokerage,
          netBrokerage,
          brokeragePercentage,
          brokeragePercentageType,
        };

        const getBrokerData = getOtherBrokerDetails(
          marketId,
          trade.lot,
          market.brokerage.brokerCommission,
          trade.scriptId,
          trade.orderPrice,
          trade.quantity,
          trade.quantityType,
          trade.totalOrderPrice,
          getUserDetails.basicDetails.brokerPartnership,
          trade.type === "NRM",
          netBrokerage,
          brokerageIntraday,
          brokerageDelivery,
          trade.transactionType,
          isClientScriptWise
        );

        // Add delivery broker brokerage if delDetails exists or was just calculated
        let finalBrockersBrokerage = getBrokerData.brockersBrokerage || [];
        if (delBrokerBrokerageToAdd && delBrokerBrokerageToAdd.length > 0) {
          // Merge delivery broker brokerage with existing
          for (const delBroker of delBrokerBrokerageToAdd) {
            const existingBroker = finalBrockersBrokerage.find(
              (b) => b.brokerId.toString() === delBroker.brokerId.toString()
            );
            if (existingBroker) {
              existingBroker.rate = Number((existingBroker.rate + delBroker.amount).toFixed(4));
            } else {
              finalBrockersBrokerage.push({
                brokerId: delBroker.brokerId,
                rate: delBroker.amount,
              });
            }
          }
          
          // console.log(`[BrokerageRefresh] Trade ${trade._id}: Merged delivery broker brokerage`);
        }

        let m2mPrice = 0;
        if (trade.transactionType == "BUY") {
          m2mPrice = totalNetPrice - getBrokerData.totalOrderBrokerage;
        } else {
          m2mPrice = totalNetPrice + getBrokerData.totalOrderBrokerage;
        }

        // Recalculate broker total brokerage including delivery portion
        const totalDelBrokerBrokerage = delBrokerBrokerageToAdd.reduce((sum, b) => sum + b.amount, 0);
        const brokerTotalBrokerage = getBrokerData.totalOrderBrokerage + totalDelBrokerBrokerage;
        const brockersBrokerage = finalBrockersBrokerage;

        // Recalculate m2mPrice with delivery broker brokerage
        if (trade.transactionType == "BUY") {
          m2mPrice = totalNetPrice - brokerTotalBrokerage;
        } else {
          m2mPrice = totalNetPrice + brokerTotalBrokerage;
        }

        const _btp = getBrokerData.totalBrokerPercentage;
        const brokerTotalPercentage = Number.isFinite(_btp) ? Number(Number(_btp).toFixed(4)) : 0;
        const otherBrokerage = getBrokerData;

        trade.m2mPrice = m2mPrice;
        trade.otherBrokerage = otherBrokerage;
        trade.brokerTotalBrokerage = brokerTotalBrokerage;
        trade.brokerTotalPercentage = brokerTotalPercentage;
        trade.brockersBrokerage = brockersBrokerage;

        editDetails = {
          ...editDetails,
          m2mPrice,
          otherBrokerage,
          brokerTotalBrokerage,
          brokerTotalPercentage,
          brockersBrokerage,
        };

        changeTrades.push(editDetails);
      }
    }

    // BulkWrite ONCE after all scripts are processed (not inside the loop)
    if (changeTrades.length > 0) {
      const updateTxn = changeTrades.map((trade) => {
        const id = trade.id;
        delete trade.id;
        return {
          updateOne: {
            filter: { _id: id },
            update: { $set: trade },
          },
        };
      });

      await StockTransaction.bulkWrite(updateTxn);

      const parentIds = getUserDetails.parentIds;
      const brokerIds = getUserDetails.basicDetails.brokerPartnership.map(
        (bkr) => bkr.broker._id
      );
      await getClientProfitLossReport(getValan, marketId, parentIds, brokerIds);

      const brokerageRefreshEntry = new BrokerageRefreshModel({
        valanId: getValan._id,
        valanName,
        userId,
        marketId,
        marketName,
        ip: req.ip,
        createdBy,
      });

      await brokerageRefreshEntry.save();
      res.status(200).json({ status: "true", message: "Successfully refresh" });
    }
  } catch (error) {
    // console.log(error);
    res.status(500).json({ status: "false", message: error.message });
  }
};

// getOtherBrokerDetails is now imported from StockUtils.js (canonical version with brockersBrokerage support)

exports.getBrokerageRefresh = async (req, res) => {
  try {
    const userId = getEffectiveUserId(req);
    const response = await getBrokerageRefresh(userId);
    res.status(200).json({ status: true, data: response });
  } catch (error) {
    // console.log(error);
    res.status(500).json({ status: "false", message: error.message });
  }
};

exports.createJVLedger = async (req, res) => {
  try {
    const createdBy = getLoginUserId(req);
    const {
      debitAccount,
      debitAccountName,
      creditAccount,
      creditAccountName,
      transactionType,
      remarks,
      date,
      amount,
    } = req.body;
    await saveJVLedger({
      debitAccount,
      creditAccount,
      transactionType: transactionType.toUpperCase(),
      remarks: `CREDIT TO ${creditAccountName.toUpperCase()} ${remarks.toUpperCase()}`,
      date,
      amount,
      createdBy,
    });
    res.status(200).json({ status: true, message: "Successfully saved" });
  } catch (error) {
    // console.log(error);
    res.status(500).json({ status: "false", message: error.message });
  }
};

exports.getJVLedger = async (req, res) => {
  try {
    const userId = getEffectiveUserId(req);
    const { user, startDate, endDate } = req.body;

    const id = new mongoose.Types.ObjectId(userId);
    let matchFilter = {
      createdBy: id,
    };

    if (user) {
      matchFilter.$or = [
        { debitAccount: new mongoose.Types.ObjectId(user) },
        { creditAccount: new mongoose.Types.ObjectId(user) },
      ];
    }

    if (startDate || endDate) {
      matchFilter.createdAt = {};
      if (startDate) {
        matchFilter.createdAt.$gte = new Date(startDate);
      }
      if (endDate) {
        matchFilter.createdAt.$lte = new Date(endDate);
      }
    }

    const isRequesterDemo = isDemoUser(req);

    const response = await getJVLedger(matchFilter, user, isRequesterDemo);
    res.status(200).json({ status: true, data: response });
  } catch (error) {
    // console.log(error);
    res.status(500).json({ status: "false", message: error.message });
  }
};

exports.deleteJVLedger = async (req, res) => {
  try {
    const userId = getLoginUserId(req);
    const { _id } = req.body;
    const response = await deleteJVLedger(_id);
    res.status(200).json({ status: true, data: response });
  } catch (error) {
    // console.log(error);
    res.status(500).json({ status: "false", message: error.message });
  }
};

exports.updateJVLedger = async (req, res) => {
  try {
    const userId = getLoginUserId(req);
    const { _id, transactionType, amount, date, remarks } = req.body;
    const details = {
      transactionType,
      amount,
      date,
      remarks,
    };
    const response = await updateJVLedger(_id, details);
    res.status(200).json({ status: true, data: response });
  } catch (error) {
    // console.log(error);
    res.status(500).json({ status: "false", message: error.message });
  }
};

exports.getUserEditLog = async (req, res) => {
  try {
    const userId = getEffectiveUserId(req);

    const isRequesterDemo = isDemoUser(req);

    const { from_date, to_date, clientId } = req.body;
    let query = {};
    query[`userEditLog.parentIds`] = userId;
    if (clientId) {
      query[`userEditLog.clientId`] = clientId;
    }
    if (from_date || to_date) {
      query[`userEditLog.time`] = {};

      if (from_date) {
        query[`userEditLog.time`].$gte = new Date(from_date).getTime();
      }

      if (to_date) {
        query[`userEditLog.time`].$lte = new Date(to_date).setHours(
          23,
          59,
          59,
          999
        );
      }
    }
    const response = await getUserEditLog(query, isRequesterDemo);
    res.status(200).json({ status: true, data: response });
  } catch (error) {
    // console.log(error);
    res.status(500).json({ status: "false", message: error.message });
  }
};

exports.getUserEditLogDetail = async (req, res) => {
  try {
    const userId = getLoginUserId(req);
    const { _id, type } = req.body;
    const response = await getUserEditLogDetail(_id, type);
    res.status(200).json({ status: true, data: response });
  } catch (error) {
    // console.log(error);
    res.status(500).json({ status: "false", message: error.message });
  }
};

exports.getLoginLog = async (req, res) => {
  try {
    const userId = getEffectiveUserId(req);

    const isRequesterDemo = isDemoUser(req);

    const { clientId, from_date, to_date } = req.body;
    let query = { type: "login" };
    if (clientId) {
      query[`loginLog.clientId`] = new mongoose.Types.ObjectId(clientId);
    }
    if (from_date || to_date) {
      query.createdAt = {};
      if (from_date) query.createdAt.$gte = new Date(from_date);
      if (to_date) query.createdAt.$lte = new Date(new Date(to_date).setHours(23, 59, 59, 999));
    }
    const response = await getLoginLog(query, isRequesterDemo);
    res.status(200).json({ status: true, data: response });
  } catch (error) {
    // console.log(error);
    res.status(500).json({ status: "false", message: error.message });
  }
};

/**
 * GET PROFIT/LOSS FILTERED USERS
 * POST /report/getProfitLossUsers
 *
 * Body:
 *   valanId    {string}  - (optional) filter by valanId (takes priority over dates)
 *   fromDate   {string}  - (optional) e.g. "2026-02-14"
 *   toDate     {string}  - (optional) e.g. "2026-02-16"
 *   type       {string}  - "profit" | "loss"
 *
 * Returns users grouped by account level:
 *   { clients: [], brokers: [], sub_masters: [], masters: [], sub_admins: [], admins: [] }
 *
 * For upper levels (admin, master etc.) their P&L = sum of ALL downline clients' P&L.
 * Open positions use live price (unrealized P&L is INCLUDED in totalPnL, not separated).
 */
exports.getProfitLossUsers = async (req, res) => {
  try {
    const userId = getEffectiveUserId(req);
    const { valanId, fromDate, toDate, type } = req.body;

    if (!type || !['profit', 'loss'].includes(type.toLowerCase())) {
      return res.status(400).json({ status: false, message: "type must be 'profit' or 'loss'" });
    }
    const filterType = type.toLowerCase(); // "profit" | "loss"

    // ── Step 1: Build match filter (Date range takes priority) ─────────────
    const match = {
      transactionStatus: "COMPLETED",
      $or: [
        { userId: new mongoose.Types.ObjectId(userId) },
        { parentIds: new mongoose.Types.ObjectId(userId) },
        { createdBy: new mongoose.Types.ObjectId(userId) },
        { brokerIds: new mongoose.Types.ObjectId(userId) }
      ]
    };

    if (fromDate || toDate) {
      match.createdAt = {};
      if (fromDate) {
        match.createdAt.$gte = new Date(`${fromDate}T00:00:00.000+05:30`);
      }
      if (toDate) {
        match.createdAt.$lte = new Date(`${toDate}T23:59:59.999+05:30`);
      }
    } else if (valanId) {
      if (Array.isArray(valanId)) {
        match.valanId = { $in: valanId.map(id => new mongoose.Types.ObjectId(id)) };
      } else {
        match.valanId = new mongoose.Types.ObjectId(valanId);
      }
    } else {
      // If nothing provided, fall back to current active valan
      const activeValan = await getActiveWeekValan();
      if (activeValan) match.valanId = activeValan._id;
    }

    // ── Step 2: Aggregate P&L per (userId, scriptId) ──────────────────────
    const userScriptRows = await StockTransaction.aggregate([
      { $match: match },
      {
        $group: {
          _id: { userId: "$userId", scriptId: "$scriptId", valanId: "$valanId" },
          scriptId: { $first: "$scriptId" },
          scriptName: { $first: "$scriptName" },
          buyQuantity: { $sum: { $cond: [{ $eq: ["$transactionType", "BUY"] }, "$quantity", 0] } },
          sellQuantity: { $sum: { $cond: [{ $eq: ["$transactionType", "SELL"] }, "$quantity", 0] } },
          buyNetPrice: { $sum: { $cond: [{ $eq: ["$transactionType", "BUY"] }, "$totalNetPrice", 0] } },
          sellNetPrice: { $sum: { $cond: [{ $eq: ["$transactionType", "SELL"] }, "$totalNetPrice", 0] } },
          brokerage: { $sum: "$netBrokerage" },
          partnership: { $first: "$partnership" },
          parentIds: { $first: "$parentIds" },
          myParent: { $first: "$myParent" },
          brockersBrokerage: { $push: "$brockersBrokerage" },
          otherBrokerage: { $push: "$otherBrokerage" }
        },
      },
      {
        $lookup: {
          from: "weekvalans",
          localField: "_id.valanId",
          foreignField: "_id",
          as: "valanInfo",
        },
      },
      {
        $addFields: {
          valanLabel: { $arrayElemAt: ["$valanInfo.label", 0] },
        },
      },
    ]);

    // ── Step 3: Fetch live prices for scripts with open positions ──────────
    const openScriptIds = [
      ...new Set(
        userScriptRows
          .filter(r => r.buyQuantity !== r.sellQuantity)
          .map(r => r.scriptId)
      ),
    ];

    let livePriceMap = {};
    if (openScriptIds.length > 0) {
      const { getMultipleStockData } = require("../services/RedisService");
      const liveData = await getMultipleStockData(openScriptIds).catch(() => []);
      liveData.forEach(stock => {
        if (stock && stock.InstrumentIdentifier) {
          livePriceMap[stock.InstrumentIdentifier] = stock;
        }
      });
    }

    // ── Step 4: Fetch ALL users for level mapping ─────────
    const isRequesterDemo = isDemoUser(req);
    const allDownlineUsers = await UserModel.find({
      $or: [
        { _id: new mongoose.Types.ObjectId(userId) },
        { parentIds: new mongoose.Types.ObjectId(userId) },
        { createdBy: new mongoose.Types.ObjectId(userId) },
        { brokerIds: new mongoose.Types.ObjectId(userId) }
      ],
      isDeleted: false,
      demoid: isRequesterDemo ? true : { $ne: true }
    })
      .select("_id accountName accountCode parentIds accountType basicDetails")
      .populate("accountType", "label level")
      .lean();

    const userMap = new Map(allDownlineUsers.map(u => [u._id.toString(), u]));
    const reqUser = userMap.get(userId.toString());
    if (!reqUser) {
      return res.status(404).json({ status: false, message: "Requester not found in hierarchy" });
    }
    const reqLvl = reqUser.accountType?.level || 1;

    // ── Step 5: Compute Effective P&L per user per valan based on REQUESTER'S share ────
    const effectiveMap = {};

    for (const row of userScriptRows) {
      const vid = row._id.valanId.toString();
      const vLabel = row.valanLabel;
      const clientUid = row._id.userId.toString();
      const client = userMap.get(clientUid);
      if (!client) continue;

      // Calculate script-level Net Bill for the client (Realized Net P&L + Unrealized)
      let clientNetBill = row.sellNetPrice - row.buyNetPrice;
      const remainingQty = row.buyQuantity - row.sellQuantity;
      if (remainingQty !== 0) {
        const live = livePriceMap[row.scriptId];
        if (live) {
          // For LONG position: price we can SELL at (Bid/SellPrice)
          // For SHORT position: price we can BUY at (Ask/BuyPrice)
          const livePrice = (remainingQty > 0)
            ? Number(live.SellPrice ?? live.ask ?? live.Ltp ?? 0)
            : Number(live.BuyPrice ?? live.bid ?? live.Ltp ?? 0);

          if (livePrice > 0) {
            clientNetBill += (remainingQty * livePrice);
          }
        }
      }

      // Reconstruct "House Pooled M2M" (Gross Result - House Brokerage)
      // This matches the 'm2m' field used in summary reports for distribution.
      // houseM2M = Client Bill + Sum(All Broker Shares)
      let scriptTotalBrokersBrok = 0;
      const scriptEarnedByUserId = {};

      // Process modern flattened brokerage array
      if (Array.isArray(row.brockersBrokerage)) {
        row.brockersBrokerage.forEach(tb => {
          if (Array.isArray(tb)) {
            tb.forEach(b => {
              if (b && b.brokerId) {
                const bid = b.brokerId.toString();
                const rate = Number(b.rate) || 0;
                scriptEarnedByUserId[bid] = (scriptEarnedByUserId[bid] || 0) + rate;
                scriptTotalBrokersBrok += rate;
              }
            });
          }
        });
      }
      // Process legacy object-based brokerage (if present in the script's history)
      if (Array.isArray(row.otherBrokerage)) {
        row.otherBrokerage.forEach(ob => {
          if (ob) {
            Object.entries(ob).forEach(([bid, d]) => {
              if (d && typeof d.netBrokerage === 'number') {
                const rate = d.netBrokerage;
                // Only add if not already counted via modern format (modern format is preferred)
                if (!scriptEarnedByUserId[bid]) {
                  scriptEarnedByUserId[bid] = rate;
                  scriptTotalBrokersBrok += rate;
                }
              }
            });
          }
        });
      }

      const houseM2M = clientNetBill + scriptTotalBrokersBrok;

      // Determine the Requester's shared portion from this trade
      const transPartnership = row.partnership || [];
      let mySharePct = Number(transPartnership[reqLvl - 1]);
      if (isNaN(mySharePct)) mySharePct = 0;

      // Fallback: If it's a direct child of the requester and share is explicitly 0, 
      // assume 100% house share as requested for direct clients.
      if (mySharePct === 0 && row.myParent?.toString() === userId.toString()) {
        mySharePct = 100;
      }

      // If the Requester IS the client, they see their own Net Bill.
      // If the Requester is an Upline, they see the client's share of the House Pooled P&L.
      const myPnLFromThisRow = (userId.toString() === clientUid)
        ? clientNetBill
        : (houseM2M * mySharePct) / 100;

      // My direct brokerage earned as a broker for this trade (index 5 usually)
      const myBrokFromThisRow = scriptEarnedByUserId[userId.toString()] || 0;

      // Credit this contribution to EACH user in the hierarchy path down to the client
      const ancestors = row.parentIds || [];
      const combinedPath = [clientUid, ...ancestors.map(a => a.toString())];

      for (const pathUid of combinedPath) {
        const pathUser = userMap.get(pathUid);
        if (!pathUser) continue;

        // User must be either the Requester or a downline user of the Requester
        const isSelfOrDownline = (pathUid === userId.toString()) || pathUser.parentIds?.some(pid => pid.toString() === userId.toString());
        if (!isSelfOrDownline) continue;

        const uKey = `${pathUid}_${vid}`;
        if (!effectiveMap[uKey]) {
          effectiveMap[uKey] = {
            _id: pathUser._id,
            accountName: pathUser.accountName,
            accountCode: pathUser.accountCode,
            valanId: row._id.valanId,
            valanName: vLabel,
            level: pathUser.accountType?.level,
            levelLabel: pathUser.accountType?.label,
            totalPnL: 0,
            brokerage: 0
          };
        }
        effectiveMap[uKey].totalPnL += myPnLFromThisRow;
        effectiveMap[uKey].brokerage += myBrokFromThisRow;
      }
    }

    const finalEffectiveEntries = Object.values(effectiveMap);

    // ── Step 7: Filter by profit / loss from the Requester's Perspective ──
    const filtered = finalEffectiveEntries.filter(u => {
      // netResult is the total profit/loss for 'me' (requester) from this user
      const netResult = u.totalPnL + u.brokerage;
      // Precision check
      return filterType === 'loss' ? netResult < -0.01 : netResult > 0.01;
    });

    // ── Step 8: Group by account type level ───────────────────────────────
    const normaliseLabel = (label = "") =>
      label.toString().toLowerCase().trim().replace(/\s+/g, "_");

    const grouped = {};
    for (const user of filtered) {
      const key = normaliseLabel(user.levelLabel) || "unknown";
      if (!grouped[key]) grouped[key] = [];

      grouped[key].push({
        _id: user._id,
        accountName: user.accountName,
        accountCode: user.accountCode,
        valanId: user.valanId,
        valanName: user.valanName,
        level: user.level,
        levelLabel: user.levelLabel,
        totalPnL: Number(user.totalPnL.toFixed(4)),
        brokerage: Number(user.brokerage.toFixed(4)),
      });
    }

    // Sort each group: worst loss (or best profit) first from requester's perspective
    for (const key of Object.keys(grouped)) {
      grouped[key].sort((a, b) => {
        const netA = a.totalPnL + a.brokerage;
        const netB = b.totalPnL + b.brokerage;
        return filterType === 'loss' ? netA - netB : netB - netA;
      });
    }

    // Build ordered response object based on levels found in downline
    const orderedResponse = {};
    const seenLabels = [
      ...new Set(
        allDownlineUsers
          .filter(u => u.accountType?.level && u.accountType.level !== 1)
          .sort((a, b) => b.accountType.level - a.accountType.level)
          .map(u => normaliseLabel(u.accountType?.label))
      ),
    ];

    // Explicitly add "customer" if not present but found in grouped
    if (!seenLabels.includes("customer")) seenLabels.push("customer");

    seenLabels.forEach(lbl => {
      if (grouped[lbl]) orderedResponse[lbl] = grouped[lbl];
    });

    res.status(200).json({
      status: true,
      filterType,
      totalMatched: filtered.length,
      data: orderedResponse,
    });
  } catch (error) {
    console.error("[getProfitLossUsers] Error:", error);
    res.status(500).json({ status: false, message: error.message });
  }
};

exports.viewPdf = async (req, res) => {
  try {
    const { id: rawId } = req.params;
    if (!rawId) return res.status(400).send("Report ID required");

    const id = rawId.replace(/\.pdf$/i, "");

    const dataRaw = await redisClient.get(`tg_report:${id}`);
    if (!dataRaw) {
      return res.status(404).send("Report expired or not found. Please regenerate from the bot.");
    }

    const data = JSON.parse(dataRaw);
    const { title, subtitle, pdfSections } = data;

    // Generate HTML for direct browser viewing
    const html = generateHTML(title, pdfSections, subtitle);

    res.setHeader("Content-Type", "text/html");
    res.setHeader("Cache-Control", "no-cache, no-store, must-revalidate");
    res.send(html);
  } catch (err) {
    console.error("viewPdf error:", err);
    res.status(500).send("Error generating report view");
  }
};

exports.getFinalBillsAllClients = async (req, res) => {
  try {
    const parentId = new mongoose.Types.ObjectId(getEffectiveUserId(req));
    const parentLevel = Number(req.user.accountType?.level);
    const { valanId, clientId, marketId } = req.query;
    const isRequesterDemo = isDemoUser(req);

    // 1. Fetch ALL downline users to identify direct children and build hierarchy mapping
    const allReportingUsers = await UserModel.find({
      parentIds: parentId,
      isDeleted: false,
      demoid: isRequesterDemo ? true : { $ne: true }
    })
      .select({ parentIds: 1, partnership: 1, createdBy: 1, accountType: 1, accountCode: 1, accountName: 1 })
      .populate('accountType', 'label level')
      .lean();

    // 2. Identify Direct Children (those whose immediate parent is the requester)
    const directClients = allReportingUsers.filter(u => 
      u.parentIds && u.parentIds.length === parentLevel && u.parentIds[parentLevel - 1].toString() === parentId.toString()
    );

    // If specific clientId was passed, filter further
    if (clientId) {
      const targetChildId = clientId.toString();
      const exists = directClients.some(c => c._id.toString() === targetChildId);
      if (!exists) {
        // Find if it exists in downline at all
        const specificUser = await UserModel.findOne({ _id: clientId, parentIds: parentId }).lean();
        if (specificUser) {
           // We might need to handle single-user drill-down, but getLedgers is usually for direct.
        }
      }
    }

    if (!directClients.length && !clientId) {
      return res.status(200).json({ status: true, data: [] });
    }

    const directClientIdsStrings = directClients.map(c => c._id.toString());

    const userToDirectChildMap = new Map();
    allReportingUsers.forEach(u => {
      const dChildId = u.parentIds[parentLevel];
      const uidS = u._id.toString();
      if (dChildId && directClientIdsStrings.includes(dChildId.toString())) {
        userToDirectChildMap.set(uidS, dChildId.toString());
      } else if (directClientIdsStrings.includes(uidS)) {
        userToDirectChildMap.set(uidS, uidS);
      }
    });

    const relevantUserIds = [...userToDirectChildMap.keys()];
    const relevantUserIdObjects = relevantUserIds.map(id => new mongoose.Types.ObjectId(id));

    // 3. Fetch Valans
    const allValans = await WeekValanModel.find({}).sort({ startDate: -1 }).lean();
    const activeValan = allValans.find(v => v.status === true) || allValans[0];

    const valanMap = new Map();
    allValans.forEach(v => valanMap.set(v._id.toString(), v));

    // Forex rate helper for this scope
    const currencyMapTB = (await hgetall("currency_rate")) || {};
    const applyForex = (marketId, marketName, amount) =>
      amount * getCurrencyRate(currencyMapTB, marketId, marketName);


    // 4. Fetch Persistent Final Bills for all relevant users
    const billMatch = { userId: { $in: relevantUserIdObjects } };
    if (valanId) billMatch.valanId = new mongoose.Types.ObjectId(valanId);
    if (marketId) billMatch.marketId = String(marketId);

    const persistentBills = await FinalBillModel.find(billMatch)
      .populate('userId', 'accountName accountCode partnership')
      .lean();


    // 5. Fetch Live M2M for Active Valan (Excluding already billed segments)
    const liveMatch = {
      transactionStatus: 'COMPLETED',
      valanId: activeValan._id
    };

    // Filter out billed segments to avoid double-counting billed results
    // Using market_type_id as it matches StockTransaction.marketId
    const billedSegmentIds = (activeValan.segment || [])
      .filter(s => s.billStatus === true)
      .map(s => s.market_type_id || s.id);

    if (marketId) {
      if (billedSegmentIds.includes(String(marketId))) {
        // If the requested market is already billed, its data is in FinalBillModel
        liveMatch.marketId = "NON_EXISTENT_MARKET_ID";
      } else {
        liveMatch.marketId = String(marketId);
      }
    } else if (billedSegmentIds.length > 0) {
      liveMatch.marketId = { $nin: billedSegmentIds };
    }

    // We get all results for requester and then sum up by direct child.
    // Use getProfitLossWithLivePrices to match the Summary Report logic and avoid aggregation bugs.
    const liveResults = await getProfitLossWithLivePrices(liveMatch, parentLevel, parentId);

    // 6. Fetch Cash Ledger entries for relevant users
    // Include both string and ObjectId to be safe with legacy/mixed fields
    const cashMatch = {
      $or: [
        { userId: { $in: relevantUserIdObjects } },
        { userId: { $in: relevantUserIds } }
      ]
    };

    if (valanId) {
      const selectedV = valanMap.get(valanId.toString());
      if (selectedV) {
        cashMatch.date = { $gte: selectedV.startDate, $lte: selectedV.endDate };
      }
    }
    const cashEntries = await CashLedgerModel.find(cashMatch).lean();

    // 7. Fetch JV Ledger entries for relevant users
    const jvMatch = {
      $or: [
        { debitAccount: { $in: relevantUserIdObjects } },
        { creditAccount: { $in: relevantUserIdObjects } }
      ]
    };
    if (valanId) {
      const selectedV = valanMap.get(valanId.toString());
      if (selectedV) {
        jvMatch.date = { $gte: selectedV.startDate, $lte: selectedV.endDate };
      }
    }
    const jvEntries = await JVLedgerModel.find(jvMatch).lean();

    // -- OPTIMIZATION: Pre-aggregate Live Results by Direct Child --
    const masterLiveM2MMap = new Map(); // dcid -> total_m2m
    const liveResultsArray = (liveResults && liveResults.data) ? liveResults.data : [];
    liveResultsArray.forEach(r => {
      const uid = r.userId?.toString();
      const dcid = userToDirectChildMap.get(uid);
      if (dcid) {
        // Use selfNetPrice from the requester's perspective (share-based and negated)
        const current = masterLiveM2MMap.get(dcid) || 0;
        masterLiveM2MMap.set(dcid, current + (Number(r.selfNetPrice) || 0));
      }
    });
    // 7. Aggregate everything per Direct Client and Valan
    const userMapData = new Map();
    [...directClients, ...allReportingUsers].forEach(u => userMapData.set(u._id.toString(), u));

    const finalReport = directClients.map(dClient => {
      const dcid = dClient._id.toString();

      // Breakdown by valan
      const valanDetails = allValans.map(v => {
        const vid = v._id.toString();
        if (valanId && valanId.toString() !== vid) return null;

        // Sum persistent bills of ALL users in this direct client's subtree
        const billedAmount = persistentBills.reduce((acc, b) => {
          const uidS = b.userId?._id?.toString() || b.userId?.toString();
          if (b.valanId && b.valanId.toString() === vid && userToDirectChildMap.get(uidS) === dcid) {
            
            // NEW STRUCTURE: Extract parent's share from partnershipBreakdown
            let myShareAmount = 0;
            const requesterId = parentId.toString();
            
            if (Array.isArray(b.partnershipBreakdown)) {
              const myShare = b.partnershipBreakdown.find(
                pb => pb.userId && pb.userId.toString() === requesterId
              );
              if (myShare) {
                myShareAmount = Number(myShare.amount || 0);
              }
            }
            
            // Fallback: If parent not in breakdown, calculate from totalM2M and partnership
            if (myShareAmount === 0) {
              const clientPartnership = (b.userId && Array.isArray(b.userId.partnership)) ? b.userId.partnership : [];
              const mySharePercent = Number(clientPartnership[parentLevel - 1]) || 0;
              myShareAmount = (b.totalM2M || 0) * (mySharePercent / 100);
            }

            return acc + applyForex(b.marketId, b.marketName, myShareAmount);
          }
          return acc;
        }, 0);

        // Sum Cash entries of ALL users in this direct client's subtree
        const cashAmount = cashEntries.reduce((acc, c) => {
          const cidString = c.userId.toString();
          const targetDC = userToDirectChildMap.get(cidString);

          if (targetDC === dcid) {
            const cDate = moment(c.date);
            const vStart = moment(v.startDate);
            const vEnd = moment(v.endDate);

            const isDateMatch = cDate.isSameOrAfter(vStart, 'day') && cDate.isSameOrBefore(vEnd, 'day');

            if (isDateMatch) {
              const val = c.amount || 0;
              return acc + (c.transactionType === 'RECEIPT' ? -val : val);
            }
          }
          return acc;
        }, 0);

        // Sum JV entries of ALL users in this direct client's subtree
        const jvAmount = jvEntries.reduce((acc, j) => {
          const debId = j.debitAccount.toString();
          const crId = j.creditAccount.toString();

          const debDC = userToDirectChildMap.get(debId);
          const crDC = userToDirectChildMap.get(crId);

          let effect = 0;
          if (debDC === dcid) effect += j.amount;
          if (crDC === dcid) effect -= j.amount;

          if (effect !== 0) {
            const jDate = moment(j.date);
            const vStart = moment(v.startDate);
            const vEnd = moment(v.endDate);
            const isDateMatch = jDate.isSameOrAfter(vStart, 'day') && jDate.isSameOrBefore(vEnd, 'day');
            if (isDateMatch) return acc + effect;
          }
          return acc;
        }, 0);

        // -- Optimized Summation --
        const m2mTotalForBranch = masterLiveM2MMap.get(dcid) || 0;
        const m2m = (vid === activeValan._id.toString()) ? m2mTotalForBranch : 0;

        // Only include if there is data or it is the active valan or specific valan requested
        if (billedAmount === 0 && cashAmount === 0 && jvAmount === 0 && m2m === 0 && !valanId && vid !== activeValan._id.toString()) return null;

        return {
          valanId: vid,
          valanName: v.label,
          billedAmount,
          cashAmount,
          jvAmount,
          m2m,
          total: billedAmount + cashAmount + jvAmount + m2m
        };
      }).filter(Boolean);

      const amount = valanDetails.reduce((acc, v) => acc + (v.total || 0), 0);
      const cash = valanDetails.reduce((acc, v) => acc + (v.cashAmount || 0), 0);
      const jv = valanDetails.reduce((acc, v) => acc + (v.jvAmount || 0), 0);

      return {
        ...dClient,
        amount,
        cash,
        jv,
        valanBreakdown: valanDetails
      };
    }).filter(row => {
      // If a specific client filter was requested, always show it.
      if (clientId) return true;
      // If valan or market filters are applied, show even if balance is zero (for data completeness)
      if (valanId || marketId) return true;
      // Strictly exclude direct users with zero total balance when no specific filter is applied
      return Math.abs(row.amount || 0) > 0.001 || Math.abs(row.cash || 0) > 0.001 || Math.abs(row.jv || 0) > 0.001;
    });

    res.status(200).json({ status: true, data: finalReport });
  } catch (error) {
    console.error("[getFinalBillsAllClients] Error:", error);
    res.status(500).json({ status: false, message: error.message });
  }
};
