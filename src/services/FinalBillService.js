const mongoose = require('mongoose');
const moment = require('moment');
require('dotenv').config();

const UserModel = require('../models/UserModel');
const WeekValanModel = require('../models/WeekValanModel');
const FinalBillModel = require('../models/FinalBillModel');
const MonthlyFinalBillModel = require('../models/MonthlyFinalBill');
const CashLedgerModel = require('../models/CashLedgerModel');
const JVLedgerModel = require('../models/JVLedgerModel');
const StockTransactionModel = require('../models/StockTransactionModel');
const { getProfitLossWithLivePrices, getPAndLWithLivePricesForNseEq } = require('./StockService');

// ============================================================================
// CONNECTION HEALTH MANAGEMENT
// ============================================================================

async function ensureConnection() {
  if (mongoose.connection.readyState !== 1) {
    console.log('[FinalBillService] ⚠ Connection lost, attempting to reconnect...');
    throw new Error('MongoDB connection lost during bill generation');
  }
  
  // Test the connection with a simple ping
  try {
    await mongoose.connection.db.admin().ping();
  } catch (pingError) {
    console.log('[FinalBillService] ⚠ Connection ping failed');
    throw new Error('MongoDB connection ping failed during bill generation');
  }
}

// ============================================================================
// HELPER FUNCTIONS
// ============================================================================

function oid(v) {
  if (!v) return null;
  return new mongoose.Types.ObjectId(String(v));
}

function toId(v) {
  if (!v) return null;
  return v._id ? v._id.toString() : v.toString();
}

function monthKeyFromDate(d) {
  const dt = new Date(d);
  return `${dt.getFullYear()}-${String(dt.getMonth() + 1).padStart(2, '0')}`;
}

function nextMonthKey(monthKey) {
  const [y, m] = monthKey.split('-').map(Number);
  const d = new Date(y, m, 1);
  return monthKeyFromDate(d);
}

function compareMonthKeys(a, b) {
  return a === b ? 0 : a < b ? -1 : 1;
}

/**
 * Get user's own cash total for a valan period
 */
async function getUserCash(userId, valanId, marketId) {
  const valan = await WeekValanModel.findById(valanId).lean();
  if (!valan) return 0;

  const cashDocs = await CashLedgerModel.find({
    userId: oid(userId),
    marketId: String(marketId),
    date: { $gte: valan.startDate, $lte: valan.endDate }
  }).lean();

  return cashDocs.reduce((sum, c) => {
    const amt = Number(c.amount || 0);
    return sum + (c.transactionType === 'RECEIPT' ? -amt : amt);
  }, 0);
}

/**
 * Get user's own JV total for a valan period
 */
async function getUserJV(userId, valanId, marketId) {
  const valan = await WeekValanModel.findById(valanId).lean();
  if (!valan) return 0;

  const jvDocs = await JVLedgerModel.find({
    $or: [
      { debitAccount: oid(userId) },
      { creditAccount: oid(userId) }
    ],
    marketId: String(marketId),
    date: { $gte: valan.startDate, $lte: valan.endDate }
  }).lean();

  return jvDocs.reduce((sum, j) => {
    const amt = Number(j.amount || 0);
    const isCredit = toId(j.creditAccount) === toId(userId);
    return sum + (isCredit ? amt : -amt);
  }, 0);
}

/**
 * Calculate partnership breakdown for a user
 * Returns array of { userId, partnership, amount }
 * 
 * LOGIC: When a user has M2M, their uplines get proportional share with SAME SIGN
 * - If user loses (-100), uplines also lose their percentage (-15, -3)
 * - If user gains (+100), uplines also gain their percentage (+15, +3)
 */
function calculatePartnershipBreakdown(totalM2M, partnership, parentIds, userMap, brokerIds = []) {
  const breakdown = [];

  const safePartnership = Array.isArray(partnership) ? partnership.map(p => Number(p) || 0) : [];

  parentIds.forEach((parentId) => {
    const parentIdStr = toId(parentId);
    const parent = userMap.get(parentIdStr);
    if (!parent) return;

    const parentLevel = Number(parent.accountType?.level) || 1;
    const partnershipPercent = safePartnership[parentLevel - 1] || 0;

    if (partnershipPercent > 0) {
      breakdown.push({
        userId: oid(parentIdStr),
        partnership: partnershipPercent,
        amount: (totalM2M * partnershipPercent) / 100
      });
    }
  });

  if (Array.isArray(brokerIds) && brokerIds.length > 0) {
    brokerIds.forEach(brokerId => {
      const brokerIdStr = toId(brokerId);
      const broker = userMap.get(brokerIdStr);
      if (!broker) return;

      const brokerLevel = Number(broker.accountType?.level) || 0;

      if (brokerLevel === 6) {
        const brokerPercent = safePartnership[brokerLevel - 1] || 0;

        if (brokerPercent > 0) {
          breakdown.push({
            userId: oid(brokerIdStr),
            partnership: brokerPercent,
            amount: (totalM2M * brokerPercent) / 100
          });
        }
      }
    });
  }

  return breakdown;
}

// ============================================================================
// MAIN GENERATION FUNCTIONS
// ============================================================================

/**
 * Generate final bills for a specific valan and market
 * 
 * FLOW:
 * 1. Get all Level 7 users (clients) who have transactions
 * 2. Generate bills for clients with FULL M2M and partnershipBreakdown
 * 3. For each upline user, calculate their totalM2M by summing FULL M2M from all downline clients
 *    (not just their partnership share - this ensures ledger shows full downline exposure)
 * 4. Upline's selfNetPrice shows their actual earning (partnership percentage of totalM2M)
 */
exports.generateFinalBills = async (valanId, marketId, options = {}) => {
  try {
    console.log(`[generateFinalBills] Starting for valan ${valanId}, market ${marketId}`);
    
    // Ensure connection is healthy at start
    await ensureConnection();
    
    const valan = await WeekValanModel.findById(valanId).lean();
    if (!valan) throw new Error('Valan not found');

    // Only skip active valan if not explicitly forced
    if (valan.status === true && !options.force) {
      console.log(`[generateFinalBills] Skipping active Valan ${valanId} (use force:true to override)`);
      return;
    }
    
    if (valan.status === true && options.force) {
      console.log(`[generateFinalBills] WARNING: Generating bills for ACTIVE valan ${valanId} (forced)`);
    }

    const market = String(marketId);

    // Clean existing bills if requested
    if (options.clean !== false) {
      await FinalBillModel.deleteMany({
        valanId: oid(valanId),
        marketId: market
      });
      console.log(`[generateFinalBills] Cleaned existing bills`);
    }

    // Load all users
    const users = await UserModel.find({ isDeleted: false })
      .select('_id parentIds partnership accountType accountName accountCode createdBy basicDetails accountDetails')
      .populate('accountType', 'level label')
      .lean();

    const userMap = new Map();
    users.forEach(u => userMap.set(u._id.toString(), u));

    const superAdmin = users.find(u => u.accountType?.level === 1);
    if (!superAdmin) {
      console.log("[generateFinalBills] No Super Admin found");
      return;
    }

    // STEP 1: Get all Level 7 users (clients) who have transactions
    console.log(`[generateFinalBills] Step 1: Finding Level 7 clients with transactions...`);
    
    const clientUserIds = await StockTransactionModel.distinct('userId', {
      valanId: oid(valanId),
      marketId: market,
      transactionStatus: 'COMPLETED'
    });

    if (!clientUserIds || clientUserIds.length === 0) {
      console.log(`[generateFinalBills] No clients with transactions found`);
      return;
    }

    // Filter to only Level 7 users
    const level7Clients = clientUserIds
      .map(uid => toId(uid))
      .filter(uid => {
        const user = userMap.get(uid);
        return user && Number(user.accountType?.level) === 7;
      });

    console.log(`[generateFinalBills] Found ${level7Clients.length} Level 7 clients with transactions`);

    const allDocuments = [];
    const creationDate = valan.endDate ? new Date(valan.endDate) : new Date();

    // STEP 2: Generate bills for Level 7 clients
    console.log(`\n[generateFinalBills] Step 2: Generating bills for Level 7 clients...`);

    // Ensure connection is healthy before major operations
    await ensureConnection();

    const match = {
      transactionStatus: 'COMPLETED',
      valanId: oid(valanId),
      marketId: market
    };

    // Fetch ALL client P&L data in ONE call using level=7.
    // level=1 would return Level 2 admins (aggregated view) — client IDs would never be found.
    // level=7 causes the function to group by each client's own userId, returning individual client data.
    console.log(`[generateFinalBills]   Fetching P&L data at client level (level=7)...`);
    const isNseEqMarket = String(market) === '12';
    const summaryResults = isNseEqMarket
      ? await getPAndLWithLivePricesForNseEq(match, 7, null)
      : await getProfitLossWithLivePrices(match, 7, superAdmin._id.toString());


    if (!summaryResults || !summaryResults.data || summaryResults.data.length === 0) {
      console.log(`[generateFinalBills]   ⚠ No data from summary report for this valan/market`);
      return { success: true, count: 0 };
    }

    console.log(`[generateFinalBills]   Got P&L data for ${summaryResults.data.length} client(s)`);

    for (const userId of level7Clients) {
      const user = userMap.get(userId);
      if (!user) continue;

      console.log(`[generateFinalBills] Processing client: ${user.accountName} (${user.accountCode})`);

      try {
        // Find this client's data from the pre-fetched summary
        const clientData = summaryResults.data.find(r => toId(r.userId) === userId);

        if (!clientData) {
          console.log(`[generateFinalBills]   ⚠ Client not found in summary data (no transactions?)`);
          continue;
        }

        console.log(`[generateFinalBills]   ✓ Found client data:`);
        console.log(`[generateFinalBills]     - gross: ${clientData.gross}`);
        console.log(`[generateFinalBills]     - brokerage: ${clientData.brokerage}`);
        console.log(`[generateFinalBills]     - bill: ${clientData.bill}`);
        console.log(`[generateFinalBills]     - m2m: ${clientData.m2m}`);
        console.log(`[generateFinalBills]     - brokerBrokerage: ${clientData.brokerBrokerage}`);
        console.log(`[generateFinalBills]     - selfNetPrice: ${clientData.selfNetPrice}`);
        console.log(`[generateFinalBills]     - myShare: ${clientData.myShare}`);
        console.log(`[generateFinalBills]     - interestAmount: ${clientData.interestAmount}`);

        // Get self cash, JV, and per-broker brokerage in parallel
        const [selfCash, selfJV, brokerBrokerageRows] = await Promise.all([
          getUserCash(userId, valanId, market),
          getUserJV(userId, valanId, market),
          StockTransactionModel.aggregate([
            {
              $match: {
                userId: oid(userId),
                valanId: oid(valanId),
                marketId: market,
                transactionStatus: 'COMPLETED'
              }
            },
            { $unwind: { path: '$brockersBrokerage', preserveNullAndEmptyArrays: false } },
            {
              $group: {
                _id: '$brockersBrokerage.brokerId',
                rate: { $sum: '$brockersBrokerage.rate' }
              }
            },
            { $project: { _id: 0, brokerId: '$_id', rate: 1 } }
          ])
        ]);

        console.log(`[generateFinalBills]     - selfCash: ${selfCash}`);
        console.log(`[generateFinalBills]     - selfJV: ${selfJV}`);
        console.log(`[generateFinalBills]     - brockersBrokerage: ${JSON.stringify(brokerBrokerageRows)}`);

        const partnership = Array.isArray(user.partnership) ? user.partnership : [];
        const parentIds = Array.isArray(user.parentIds) ? user.parentIds : [];
        const createdBy = user.createdBy?.userId || (parentIds.length > 0 ? parentIds[parentIds.length - 1] : superAdmin._id);

        const isNseEq = String(market) === '12';
        const interestAmount = isNseEq ? Number(clientData.interestAmount || 0) : 0;
        // clientData.m2m includes brokerBrokerage and already has interest deducted
        const m2mAfterInterest = Number(clientData.m2m || 0);
        // Full M2M before interest — used as base for uplines that don't absorb interest
        const totalM2M = m2mAfterInterest + interestAmount;

        // Direct parent and level-6 brokers see M2M - interest (interestAdjustedM2M)
        // All other uplines see full M2M (totalM2M)
        // Non-NSE EQ: interestAmount=0 so both values equal → zero impact on other markets
        const partnershipBreakdown = calculatePartnershipBreakdown(
          totalM2M,
          partnership,
          parentIds,
          userMap,
          clientData.brokerIds || []
        );

        const document = {
          userId: oid(userId),
          createdBy: oid(createdBy),
          valanId: oid(valanId),
          marketId: market,
          accountCode: user.accountCode,
          accountName: user.accountName,
          level: 7,
          partnership: partnership,
          
          // Self data
          selfCash: selfCash,
          selfJV: selfJV,
          
          // Full M2M before interest — uplines aggregate this to get their downline exposure
          totalM2M: totalM2M,

          // Partnership breakdown - shows distribution to uplines
          partnershipBreakdown: partnershipBreakdown,

          // Brokerage from summary report
          gross: Number(clientData.gross || 0),
          brokerage: Number(clientData.brokerage || 0),
          brokerBrokerage: Number(clientData.brokerBrokerage || 0),
          selfBrokerage: Number(clientData.selfBrokerage || 0),
          summedOtherBrokerage: Array.isArray(clientData.summedOtherBrokerage) ? clientData.summedOtherBrokerage : [],
          // Per-broker brokerage: summed from StockTransaction.brockersBrokerage per broker _id
          brockersBrokerage: brokerBrokerageRows,

          // Client's own net: M2M after interest deduction (what the client actually owes/receives)
          selfNetPrice: m2mAfterInterest,
          uplineNetPrice: Number(clientData.uplineNetPrice || 0),
          downlineNetPrice: Number(clientData.downlineNetPrice || 0),
          brokerNetPrice: Number(clientData.brokerNetPrice || 0),
          
          // NSE EQ interest (stored for reference and for direct parent calculation)
          interestAmount: interestAmount,
          
          // Additional fields
          // For NSE_EQ, bill should have interest subtracted
          bill: Number(clientData.bill || 0) - interestAmount,
          myShare: Number(clientData.myShare || 0),
          uplineShare: Number(clientData.uplineShare || 0),
          m2mProfitLimit: user.accountDetails?.m2mProfit_NSE_MCX_NOPT,
          m2mLossLimit: user.accountDetails?.m2mLoss_NSE_MCX_NOPT,
          
          createdAt: creationDate
        };

        allDocuments.push(document);
        console.log(`[generateFinalBills]   ✓ Generated bill - M2M: ${document.totalM2M}`);

        // Small delay to prevent overwhelming the connection
        if (allDocuments.length % 10 === 0) {
          await new Promise(resolve => setTimeout(resolve, 100));
        }

      } catch (error) {
        console.error(`[generateFinalBills]   Error:`, error.message);
      }
    }

    console.log(`[generateFinalBills] Generated ${allDocuments.length} client bills`);

    // STEP 3: Calculate upline bills from partnershipBreakdown arrays
    console.log(`\n[generateFinalBills] Step 3: Calculating upline bills from partnership breakdowns...`);
    
    // Ensure connection is healthy before processing uplines
    await ensureConnection();
    
    // Map to accumulate M2M for each upline user
    const uplineM2MMap = new Map(); // userId -> totalM2M

    // Go through all client bills and accumulate FULL M2M for every ancestor (parentIds)
    // Using parentIds instead of partnershipBreakdown so every upline is included,
    // even when the client's partnership array has zeros/empty values.
    allDocuments.forEach(clientBill => {
      const clientUser = userMap.get(toId(clientBill.userId));
      if (!clientUser) return;

      const parentIds = Array.isArray(clientUser.parentIds) ? clientUser.parentIds : [];
      parentIds.forEach(parentId => {
        const parentIdStr = toId(parentId);
        if (!parentIdStr) return;
        const current = uplineM2MMap.get(parentIdStr) || 0;
        uplineM2MMap.set(parentIdStr, current + Number(clientBill.totalM2M || 0));
      });
    });

    console.log(`[generateFinalBills] Found ${uplineM2MMap.size} upline users with M2M`);

    // STEP 4: Generate bills for upline users (L1–L4 and L5 Masters)
    // L5/L6 brokers are handled in Step 5 with different totalM2M semantics
    // (brokers show net earnings = partnership share + brokerage, not full downline exposure)
    // 
    // DISTINCTION: Level 5 are Masters, Level 6 are Brokers:
    // - Masters: Level 5 users with NO brokerage earnings → get FULL downline M2M
    // - Brokers: Level 6 users with brokerage earnings → get net earnings only
    for (const [uplineUserId, totalM2M] of uplineM2MMap.entries()) {
      const user = userMap.get(uplineUserId);
      if (!user) {
        console.log(`[generateFinalBills] Upline user ${uplineUserId} not found`);
        continue;
      }

      const userLevel = Number(user.accountType?.level) || 1;

      // Check if this Level 6 user is actually a broker (has brokerage earnings)
      // Level 5 are Masters, Level 6 are Brokers
      let isBroker = false;
      if (userLevel === 6) {
        // Check if this user appears in any client's brockersBrokerage array
        for (const clientBill of allDocuments.filter(d => d.level === 7)) {
          if (Array.isArray(clientBill.brockersBrokerage)) {
            const hasBrokerage = clientBill.brockersBrokerage.some(bb => 
              toId(bb.brokerId) === uplineUserId
            );
            if (hasBrokerage) {
              isBroker = true;
              break;
            }
          }
        }
      }

      // Skip brokers - they'll be handled in Step 5 with net earnings logic
      if (isBroker) {
        console.log(`[generateFinalBills] Skipping ${user.accountName} (Level ${userLevel}) - identified as broker`);
        continue;
      }

      // Level 6 users without brokerage are still treated as brokers (skip them)
      if (userLevel === 6) {
        console.log(`[generateFinalBills] Skipping ${user.accountName} (Level 6) - Level 6 always treated as broker`);
        continue;
      }

      console.log(`[generateFinalBills] Processing upline: ${user.accountName} (${user.accountCode}) - Level ${userLevel} - M2M: ${totalM2M}`);
      if (userLevel === 5) {
        console.log(`[generateFinalBills]   ✓ Level 5 Master (no brokerage) - gets FULL downline M2M`);
      }

      // Get self cash and JV
      const [selfCash, selfJV] = await Promise.all([
        getUserCash(uplineUserId, valanId, market),
        getUserJV(uplineUserId, valanId, market)
      ]);

      const partnership = Array.isArray(user.partnership) ? user.partnership : [];
      const parentIds = Array.isArray(user.parentIds) ? user.parentIds : [];
      const createdBy = user.createdBy?.userId || (parentIds.length > 0 ? parentIds[parentIds.length - 1] : superAdmin._id);

      // Calculate partnership breakdown for this upline user based on their FULL M2M
      const partnershipBreakdown = calculatePartnershipBreakdown(
        totalM2M,
        partnership,
        parentIds,
        userMap,
        [] // Uplines don't have brokerIds
      );

      const document = {
        userId: oid(uplineUserId),
        createdBy: oid(createdBy),
        valanId: oid(valanId),
        marketId: market,
        accountCode: user.accountCode,
        accountName: user.accountName,
        level: userLevel,
        partnership: partnership,
        
        // Self data
        selfCash: selfCash,
        selfJV: selfJV,
        
        // FULL downline M2M (not just their share)
        totalM2M: totalM2M,
        
        // Partnership breakdown - shows distribution to their uplines
        partnershipBreakdown: partnershipBreakdown,
        
        // Uplines don't have direct transactions, so these are 0
        gross: 0,
        brokerage: 0,
        brokerBrokerage: 0,
        selfBrokerage: 0,
        summedOtherBrokerage: [],
        
        // FIXED: For upline users, selfNetPrice should be FULL totalM2M for self-view
        // The partnership breakdown is for upline calculations, not self-view deductions
        selfNetPrice: totalM2M, // User sees their FULL exposure/impact
        uplineNetPrice: 0,
        downlineNetPrice: 0,
        brokerNetPrice: 0,
        
        // NSE EQ interest
        interestAmount: 0,
        
        // Additional fields
        bill: 0,
        myShare: partnership[userLevel - 1] || 0,
        uplineShare: 0,
        m2mProfitLimit: user.accountDetails?.m2mProfit_NSE_MCX_NOPT,
        m2mLossLimit: user.accountDetails?.m2mLoss_NSE_MCX_NOPT,
        
        createdAt: creationDate
      };

      allDocuments.push(document);
      console.log(`[generateFinalBills]   ✓ Generated upline bill`);
    }

    // STEP 5: Generate bills for BROKERS (level 6 only with actual brokerage earnings)
    // totalM2M for brokers = their net earnings (partnership share + brokerage),
    // NOT the full downline exposure (that's only correct for L1-L4 admins and L5 masters).
    console.log(`\n[generateFinalBills] Step 5: Generating broker bills...`);

    // Seed broker map with L5/L6 users who have actual brokerage earnings
    const brokerMap = new Map(); // brokerId -> { partnershipAmount, brokerageEarnings }

    // Accumulate per-broker data from client bills
    allDocuments.forEach(clientBill => {
      if (clientBill.level !== 7) return;

      // Brokerage earnings from StockTransaction-level aggregation (authoritative)
      if (Array.isArray(clientBill.brockersBrokerage)) {
        clientBill.brockersBrokerage.forEach(bb => {
          const brokerId = toId(bb.brokerId);
          if (!brokerId) return;
          const broker = userMap.get(brokerId);
          if (!broker) return;
          const lvl = Number(broker.accountType?.level) || 0;
          if (lvl !== 5 && lvl !== 6) return;
          if (!brokerMap.has(brokerId)) brokerMap.set(brokerId, { partnershipAmount: 0, brokerageEarnings: 0 });
          brokerMap.get(brokerId).brokerageEarnings += Number(bb.rate || 0);
        });
      }
    });

    // Add partnership amounts for brokers who have brokerage earnings
    allDocuments.forEach(clientBill => {
      if (clientBill.level !== 7) return;

      // Partnership share (only for users who are already identified as brokers)
      if (Array.isArray(clientBill.partnershipBreakdown)) {
        clientBill.partnershipBreakdown.forEach(pb => {
          const pbId = toId(pb.userId);
          if (!pbId) return;
          // Only add partnership if this user is already in brokerMap (has brokerage earnings)
          if (brokerMap.has(pbId)) {
            brokerMap.get(pbId).partnershipAmount += Number(pb.amount || 0);
          }
        });
      }
    });

    console.log(`[generateFinalBills] Found ${brokerMap.size} brokers to bill`);

    for (const [brokerId, brokerData] of brokerMap.entries()) {
      const broker = userMap.get(brokerId);
      if (!broker) continue;

      const brokerLevel = Number(broker.accountType?.level) || 1;
      const totalM2M = brokerData.partnershipAmount + brokerData.brokerageEarnings;
      console.log(`[generateFinalBills] Processing broker: ${broker.accountName} (${broker.accountCode}) Level ${brokerLevel}`);
      console.log(`[generateFinalBills]   - Brokerage: ${brokerData.brokerageEarnings}, Partnership: ${brokerData.partnershipAmount}, Net: ${totalM2M}`);

      const [selfCash, selfJV] = await Promise.all([
        getUserCash(brokerId, valanId, market),
        getUserJV(brokerId, valanId, market)
      ]);

      const partnership = Array.isArray(broker.partnership) ? broker.partnership : [];
      const parentIds = Array.isArray(broker.parentIds) ? broker.parentIds : [];
      const createdBy = broker.createdBy?.userId || (parentIds.length > 0 ? parentIds[parentIds.length - 1] : superAdmin._id);

      const partnershipBreakdown = calculatePartnershipBreakdown(totalM2M, partnership, parentIds, userMap, []);

      const summedOtherBrokerage = brokerData.brokerageEarnings !== 0
        ? [{ brokerId: oid(brokerId), netBrokerage: brokerData.brokerageEarnings }]
        : [];

      const document = {
        userId: oid(brokerId),
        createdBy: oid(createdBy),
        valanId: oid(valanId),
        marketId: market,
        accountCode: broker.accountCode,
        accountName: broker.accountName,
        level: brokerLevel,
        partnership,
        selfCash,
        selfJV,
        totalM2M,
        partnershipBreakdown,
        gross: 0,
        brokerage: 0,
        brokerBrokerage: brokerData.brokerageEarnings,
        selfBrokerage: brokerData.brokerageEarnings,
        summedOtherBrokerage,
        // FIXED: Broker should see their FULL earning, not reduced by partnership
        selfNetPrice: totalM2M, // Full amount broker earns from their clients
        uplineNetPrice: 0,
        downlineNetPrice: 0,
        brokerNetPrice: brokerData.brokerageEarnings,
        interestAmount: 0,
        bill: totalM2M,
        myShare: partnership[brokerLevel - 1] || 100,
        uplineShare: 0,
        m2mProfitLimit: broker.accountDetails?.m2mProfit_NSE_MCX_NOPT,
        m2mLossLimit: broker.accountDetails?.m2mLoss_NSE_MCX_NOPT,
        createdAt: creationDate
      };

      allDocuments.push(document);
      console.log(`[generateFinalBills]   ✓ Generated broker bill with totalM2M: ${totalM2M}`);
    }

    // STEP 6: Save all bills
    if (allDocuments.length > 0) {
      console.log(`\n[generateFinalBills] Step 6: Saving ${allDocuments.length} bills...`);
      
      // Ensure connection is healthy before saving
      await ensureConnection();
      
      // Log level distribution
      const levelCounts = {};
      allDocuments.forEach(d => {
        levelCounts[d.level] = (levelCounts[d.level] || 0) + 1;
      });
      console.log(`[generateFinalBills] Level distribution:`, levelCounts);
      
      // Log broker bills specifically
      const brokerBills = allDocuments.filter(d => d.level === 5 || d.level === 6);
      if (brokerBills.length > 0) {
        console.log(`\n[generateFinalBills] 📋 BROKER BILLS GENERATED (${brokerBills.length}):`);
        brokerBills.forEach(b => {
          console.log(`   - ${b.accountName} (${b.accountCode}) Level ${b.level}`);
          console.log(`     Total M2M: ${b.totalM2M}, Brokerage: ${b.brokerBrokerage}, Partnership: ${b.totalM2M - b.brokerBrokerage}`);
        });
      } else {
        console.log(`\n[generateFinalBills] ⚠️  NO BROKER BILLS GENERATED!`);
      }
      
      try {
        const result = await FinalBillModel.insertMany(allDocuments, { ordered: false });
        console.log(`\n[generateFinalBills] ✓ Successfully inserted ${result.length} bills`);
        
        // After saving, verify broker bills in database
        const savedBrokerBills = await FinalBillModel.find({
          valanId: oid(valanId),
          marketId: market,
          level: { $in: [5, 6] }
        }).lean();
        
        console.log(`\n[generateFinalBills] 🔍 VERIFICATION: ${savedBrokerBills.length} broker bills saved to database`);
        if (savedBrokerBills.length > 0) {
          savedBrokerBills.forEach(b => {
            console.log(`   ✓ ${b.accountName} (${b.accountCode}) - M2M: ${b.totalM2M}`);
          });
        }
        
      } catch (insertError) {
        if (insertError.writeErrors) {
          console.error(`[generateFinalBills] Write errors (showing first 3):`, 
            insertError.writeErrors.slice(0, 3).map(e => ({
              index: e.index,
              code: e.code,
              message: e.errmsg
            }))
          );
          console.log(`[generateFinalBills] Successfully inserted ${insertError.insertedDocs?.length || 0} bills despite errors`);
        } else {
          console.error(`[generateFinalBills] Insert error:`, insertError.message);
          throw insertError;
        }
      }
    } else {
      console.log(`[generateFinalBills] No bills to save`);
    }

    return { success: true, count: allDocuments.length };
  } catch (error) {
    console.error('[generateFinalBills] Error:', error.message, error.stack);
    throw error;
  }
};

/**
 * Generate monthly bills by aggregating weekly valan bills.
 *
 * NEW CUMULATIVE LOGIC:
 *   totalM2M     = sum of this month's valan FinalBill.totalM2M (current month P&L only)
 *   selfCash     = sum of this month's valan FinalBill.selfCash  
 *   selfJV       = sum of this month's valan FinalBill.selfJV
 *   openingBalance = previous month's closingBalance (cumulative balance from last month)
 *   closingBalance = openingBalance + totalM2M + selfCash + selfJV (NEW: cumulative running total)
 *
 * The monthly bill now stores BOTH:
 *   - totalM2M: current month P&L only (for analysis)
 *   - closingBalance: cumulative running total (for ledger display)
 *
 * This ensures consistent cumulative balance tracking across all user levels.
 */
exports.generateMonthlyFinalBills = async (year, month) => {
  try {
    const y = Number(year);
    const m = String(month).padStart(2, '0');
    const monthKey = `${y}-${m}`;
    const monthStart = new Date(y, Number(m) - 1, 1);
    const monthEnd = new Date(y, Number(m), 0, 23, 59, 59, 999);

    console.log(`[generateMonthlyFinalBills] Processing ${monthKey}`);

    // Get previous month key
    const prevMonthDate = new Date(y, Number(m) - 2, 1);
    const prevMonthKey = monthKeyFromDate(prevMonthDate);

    // ── Step 1: Find all valans whose period falls within this month ──────
    // A valan belongs to a month if its endDate falls within that month.
    // Using endDate ensures cross-month valans (e.g. "27APR-02MAY" endDate=May 2)
    // are assigned to the month they settle in (May), not the month they start in (April).
    const valansInMonth = await WeekValanModel.find({
      endDate: { $gte: monthStart, $lte: monthEnd }
    }).lean();

    if (!valansInMonth.length) {
      console.log(`[generateMonthlyFinalBills] No valans found with endDate in ${monthKey}`);
      return { success: true, count: 0 };
    }

    const valanIdsInMonth = valansInMonth.map(v => v._id);
    console.log(`[generateMonthlyFinalBills] Found ${valanIdsInMonth.length} valans in ${monthKey}: ${valansInMonth.map(v => v.label).join(', ')}`);

    // ── Step 2: Fetch all weekly FinalBills for those valans ──────────────
    const weeklyBills = await FinalBillModel.find({
      valanId: { $in: valanIdsInMonth }
    }).lean();

    if (!weeklyBills.length) {
      console.log(`[generateMonthlyFinalBills] No weekly bills found for valans in ${monthKey}`);
      return { success: true, count: 0 };
    }

    console.log(`[generateMonthlyFinalBills] Found ${weeklyBills.length} weekly bill records`);

    // ── Step 3: Group by userId + marketId ───────────────────────────────
    const userMarketMap = new Map();

    weeklyBills.forEach(bill => {
      const key = `${bill.userId}_${bill.marketId}`;
      if (!userMarketMap.has(key)) {
        userMarketMap.set(key, {
          userId: bill.userId,
          createdBy: bill.createdBy,
          marketId: bill.marketId,
          accountCode: bill.accountCode,
          accountName: bill.accountName,
          level: bill.level,
          partnership: bill.partnership,
          bills: []
        });
      }
      userMarketMap.get(key).bills.push(bill);
    });

    console.log(`[generateMonthlyFinalBills] Found ${userMarketMap.size} user-market combinations`);

    // ── Step 4: Fetch previous month's MonthlyFinalBills for opening balance ──
    const prevMonthBills = await MonthlyFinalBillModel.find({
      month: prevMonthKey
    }).lean();

    const prevMonthMap = new Map();
    prevMonthBills.forEach(pb => {
      // Key must match the same format used below
      const key = `${pb.userId}_${pb.marketId}`;
      prevMonthMap.set(key, pb);
    });

    console.log(`[generateMonthlyFinalBills] Found ${prevMonthBills.length} previous month (${prevMonthKey}) bills`);

    // ── Step 5: Build monthly records ────────────────────────────────────
    const documents = [];

    for (const [key, data] of userMarketMap.entries()) {
      // Opening balance = previous month's closing balance (cumulative)
      const prevMonthBill = prevMonthMap.get(key);
      const openingBalance = prevMonthBill ? Number(prevMonthBill.closingBalance || 0) : 0;

      // Current month aggregates — sum ONLY this month's valan bills
      const weeklyM2M    = data.bills.reduce((sum, b) => sum + Number(b.totalM2M || 0), 0);
      const selfCash     = data.bills.reduce((sum, b) => sum + Number(b.selfCash || 0), 0);
      const selfJV       = data.bills.reduce((sum, b) => sum + Number(b.selfJV || 0), 0);

      // NEW: Calculate cumulative closing balance
      const closingBalance = openingBalance + weeklyM2M + selfCash + selfJV;

      // totalM2M stored = current month P&L only (for analysis)
      const totalM2M = weeklyM2M;

      const gross          = data.bills.reduce((sum, b) => sum + Number(b.gross || 0), 0);
      const brokerage      = data.bills.reduce((sum, b) => sum + Number(b.brokerage || 0), 0);
      const brokerBrokerage= data.bills.reduce((sum, b) => sum + Number(b.brokerBrokerage || 0), 0);
      const selfBrokerage  = data.bills.reduce((sum, b) => sum + Number(b.selfBrokerage || 0), 0);
      const selfNetPrice   = data.bills.reduce((sum, b) => sum + Number(b.selfNetPrice || 0), 0);
      const uplineNetPrice = data.bills.reduce((sum, b) => sum + Number(b.uplineNetPrice || 0), 0);
      const downlineNetPrice = data.bills.reduce((sum, b) => sum + Number(b.downlineNetPrice || 0), 0);
      const brokerNetPrice = data.bills.reduce((sum, b) => sum + Number(b.brokerNetPrice || 0), 0);
      const interestAmount = data.bills.reduce((sum, b) => sum + Number(b.interestAmount || 0), 0);
      const bill           = data.bills.reduce((sum, b) => sum + Number(b.bill || 0), 0);

      // Aggregate partnershipBreakdown — sum amounts per partner across all valan bills
      const partnershipMap = new Map();
      data.bills.forEach(b => {
        if (!Array.isArray(b.partnershipBreakdown)) return;
        b.partnershipBreakdown.forEach(pb => {
          const pbUserId = toId(pb.userId);
          if (!pbUserId) return;
          if (!partnershipMap.has(pbUserId)) {
            partnershipMap.set(pbUserId, {
              userId: oid(pbUserId),
              partnership: pb.partnership,
              amount: 0
            });
          }
          partnershipMap.get(pbUserId).amount += Number(pb.amount || 0);
        });
      });

      const partnershipBreakdown = Array.from(partnershipMap.values());
      const valanIds = [...new Set(data.bills.map(b => b.valanId).filter(Boolean))];

      documents.push({
        userId: oid(data.userId),
        createdBy: oid(data.createdBy),
        month: monthKey,
        marketId: data.marketId,
        accountCode: data.accountCode,
        accountName: data.accountName,
        level: data.level,
        partnership: data.partnership,

        selfCash,
        selfJV,
        totalM2M,          // current month valan P&L only
        openingBalance,    // previous month closing balance
        closingBalance,    // NEW: cumulative running total

        partnershipBreakdown,

        gross,
        brokerage,
        brokerBrokerage,
        selfBrokerage,

        selfNetPrice,
        uplineNetPrice,
        downlineNetPrice,
        brokerNetPrice,

        interestAmount,
        bill,

        valanIds
      });
    }

    // ── Step 6: Upsert monthly records ───────────────────────────────────
    if (documents.length) {
      console.log(`[generateMonthlyFinalBills] Writing ${documents.length} monthly records for ${monthKey}...`);

      // Delete existing records for this month first (clean regeneration)
      await MonthlyFinalBillModel.deleteMany({
        month: monthKey,
        userId: { $in: documents.map(d => d.userId) }
      });

      try {
        const result = await MonthlyFinalBillModel.insertMany(documents, { ordered: false });
        console.log(`[generateMonthlyFinalBills] Successfully generated ${result.length} monthly bills for ${monthKey}`);
      } catch (insertError) {
        if (insertError.insertedDocs && insertError.insertedDocs.length > 0) {
          console.log(`[generateMonthlyFinalBills] Inserted ${insertError.insertedDocs.length} bills despite errors`);
        } else {
          console.error(`[generateMonthlyFinalBills] Insert error:`, insertError.message);
          throw insertError;
        }
      }
    }

    return { success: true, count: documents.length };
  } catch (error) {
    console.error('[generateMonthlyFinalBills] Error:', error.message, error.stack);
    throw error;
  }
};

/**
 * Revert/delete final bills for a specific valan and market
 */
exports.revertFinalBills = async (valanId, marketId) => {
  try {
    const result = await FinalBillModel.deleteMany({
      valanId: oid(valanId),
      marketId: String(marketId)
    });
    
    console.log(`[revertFinalBills] Deleted ${result.deletedCount} bills`);
    return { success: true, deletedCount: result.deletedCount };
  } catch (error) {
    console.error('[revertFinalBills] Error:', error.message);
    throw error;
  }
};

/**
 * Rebuild monthly bills from a specific month onwards
 */
exports.rebuildMonthlyFinalBillsFromMonth = async (startMonthKey) => {
  try {
    const nowKey = monthKeyFromDate(new Date());
    let cursor = startMonthKey;
    let totalCount = 0;

    while (compareMonthKeys(cursor, nowKey) <= 0) {
      const [y, m] = cursor.split('-').map(Number);
      const result = await exports.generateMonthlyFinalBills(y, m);
      totalCount += result.count || 0;
      cursor = nextMonthKey(cursor);
    }

    console.log(`[rebuildMonthlyFinalBillsFromMonth] Rebuilt ${totalCount} monthly bills`);
    return { success: true, totalCount };
  } catch (error) {
    console.error('[rebuildMonthlyFinalBillsFromMonth] Error:', error.message);
    throw error;
  }
};
