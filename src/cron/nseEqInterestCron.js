const mongoose = require('mongoose');
const moment = require('moment');
const UserModel = require('../models/UserModel');
const NseEqInterestModel = require('../models/NseEqInterestModel');
const UserPositionModel = require('../models/UserPositionModel');
const StockTransactionModel = require('../models/StockTransactionModel');
const WeekValanModel = require('../models/WeekValanModel');
const StockModel = require('../models/StockModel');
const { getSingleStockData } = require('../services/RedisService');

// NSE-EQ market ID (matches config/marketConstants.js)
const NSE_EQ_MARKET_ID = '12';

/**
 * Get current market price for a script from Redis
 * @param {string} scriptName - Script name (e.g., "AFFLE", "RELIANCE")
 * @returns {Promise<number>} - Current sell price or 0 if not found
 */
async function getCurrentPrice(scriptName) {
  try {
    // Get from Redis using script name as key
    const stockData = await getSingleStockData(scriptName);
    if (stockData) {
      const parsed = typeof stockData === 'string' ? JSON.parse(stockData) : stockData;
      // Use SellPrice for long positions (what you can sell at)
      return Number(parsed.SellPrice || parsed.Ltp || parsed.BuyPrice || 0);
    }
    
    console.log(`[getCurrentPrice] No price found in Redis for ${scriptName}`);
    return 0;
  } catch (err) {
    console.error(`[getCurrentPrice] Error for script ${scriptName}:`, err.message);
    return 0;
  }
}

/**
 * Calculate holding worth and booked P&L for a user in NSE-EQ market
 * Uses current market prices from Redis and considers unrealized P&L
 * @param {ObjectId} userId - User ID
 * @param {ObjectId} valanId - Current valan ID
 * @param {string} date - Date in YYYY-MM-DD format
 * @returns {Promise<{holdingWorth: number, bookedPnl: number}>}
 */
async function calculateHoldingAndBookedPnL(userId, valanId, date) {
  try {
    console.log(`[calculateHoldingAndBookedPnL] Starting for user ${userId}, valan ${valanId}, date ${date}`);

    // Get all completed transactions for the entire valan period
    const transactions = await StockTransactionModel.find({
      userId,
      valanId,
      marketId: NSE_EQ_MARKET_ID,
      transactionStatus: 'COMPLETED'
    }).lean();

    console.log(`[calculateHoldingAndBookedPnL] Found ${transactions.length} transactions for valan`);

    // Group transactions by script
    const scriptMap = new Map();

    for (const txn of transactions) {
      const scriptId = txn.scriptId.toString();
      if (!scriptMap.has(scriptId)) {
        scriptMap.set(scriptId, {
          scriptId: txn.scriptId,
          scriptName: txn.scriptName,
          buyQty: 0,
          sellQty: 0,
          buyTotal: 0,
          sellTotal: 0
        });
      }

      const script = scriptMap.get(scriptId);
      const totalNetPrice = Number(txn.totalNetPrice || 0);
      const qty = Number(txn.quantity || 0);

      if (txn.transactionType === 'BUY') {
        script.buyQty += qty;
        script.buyTotal += totalNetPrice;
        console.log(`[calculateHoldingAndBookedPnL] ${script.scriptName} BUY: ${qty} qty @ ₹${totalNetPrice.toFixed(2)} total`);
      } else if (txn.transactionType === 'SELL') {
        script.sellQty += qty;
        script.sellTotal += totalNetPrice;
        console.log(`[calculateHoldingAndBookedPnL] ${script.scriptName} SELL: ${qty} qty @ ₹${totalNetPrice.toFixed(2)} total`);
      }
    }

    let totalHoldingWorth = 0;
    let totalBookedPnl = 0;

    console.log(`[calculateHoldingAndBookedPnL] Processing ${scriptMap.size} scripts`);

    // Calculate for each script
    for (const [scriptIdKey, data] of scriptMap) {
      const netQty = data.buyQty - data.sellQty;
      const closedQty = Math.min(data.buyQty, data.sellQty);

      console.log(`[calculateHoldingAndBookedPnL] ${data.scriptName}: buyQty=${data.buyQty}, sellQty=${data.sellQty}, netQty=${netQty}, closedQty=${closedQty}`);

      // Calculate booked P&L for closed portion
      if (closedQty > 0) {
        const avgBuyPrice = data.buyTotal / data.buyQty;
        const avgSellPrice = data.sellTotal / data.sellQty;
        const realizedPnL = closedQty * (avgSellPrice - avgBuyPrice);
        
        // Booked P&L: positive = loss (increases loan), negative = profit (reduces loan)
        const bookedPnl = -realizedPnL;
        totalBookedPnl += bookedPnl;
        console.log(`[calculateHoldingAndBookedPnL] ${data.scriptName} Booked P&L: avgBuy=₹${avgBuyPrice.toFixed(2)}, avgSell=₹${avgSellPrice.toFixed(2)}, realizedPnL=₹${realizedPnL.toFixed(2)}, bookedPnl=₹${bookedPnl.toFixed(2)}`);
      }

      // Calculate holding worth for open portion with unrealized P&L
      if (netQty !== 0) {
        const remainingQty = Math.abs(netQty);
        
        console.log(`[calculateHoldingAndBookedPnL] ${data.scriptName}: Getting current price for open position`);
        
        if (netQty > 0) {
          // Long position (bought more than sold) - use current SELL price
          const avgBuyPrice = data.buyTotal / data.buyQty;
          const currentPrice = await getCurrentPrice(data.scriptName);
          const unrealizedPnL = (currentPrice - avgBuyPrice) * remainingQty;
          // Holding = Cost Basis - Unrealized P&L
          // If profit (unrealizedPnL > 0): holding reduces
          // If loss (unrealizedPnL < 0): holding increases
          const holdingValue = (remainingQty * avgBuyPrice) - unrealizedPnL;
          totalHoldingWorth += holdingValue;
          console.log(`[calculateHoldingAndBookedPnL] ${data.scriptName} LONG: remainingQty=${remainingQty}, avgBuy=₹${avgBuyPrice.toFixed(2)}, currentPrice=₹${currentPrice.toFixed(2)}, unrealizedPnL=₹${unrealizedPnL.toFixed(2)}, holdingValue=₹${holdingValue.toFixed(2)}`);
        } else {
          // Short position (sold more than bought) - use current BUY price
          const avgSellPrice = data.sellTotal / data.sellQty;
          const currentPrice = await getCurrentPrice(data.scriptName);
          const unrealizedPnL = (avgSellPrice - currentPrice) * remainingQty;
          // Holding = Cost Basis - Unrealized P&L
          const holdingValue = (remainingQty * avgSellPrice) - unrealizedPnL;
          totalHoldingWorth += holdingValue;
          console.log(`[calculateHoldingAndBookedPnL] ${data.scriptName} SHORT: remainingQty=${remainingQty}, avgSell=₹${avgSellPrice.toFixed(2)}, currentPrice=₹${currentPrice.toFixed(2)}, unrealizedPnL=₹${unrealizedPnL.toFixed(2)}, holdingValue=₹${holdingValue.toFixed(2)}`);
        }
      }
    }

    console.log(`[calculateHoldingAndBookedPnL] FINAL: totalHoldingWorth=₹${totalHoldingWorth.toFixed(2)}, totalBookedPnl=₹${totalBookedPnl.toFixed(2)}`);

    return {
      holdingWorth: Math.max(0, totalHoldingWorth),
      bookedPnl: totalBookedPnl
    };
  } catch (err) {
    console.error(`[calculateHoldingAndBookedPnL] Error for user ${userId}:`, err.message);
    return { holdingWorth: 0, bookedPnl: 0 };
  }
}

/**
 * Calculates and persists daily NSE-EQ loan interest for every eligible user.
 *
 * OLD Interest formula (per day):
 *   loanAmount = maxLimit × (1 – marginPer / 100)
 *   dailyInterest = loanAmount × (annualInterestPer / 365 / 100)
 *
 * NEW Interest formula (when nseeqinterestLinkedwithLedger = 1):
 *   availableMargin = maxLimit × (marginPer / 100)
 *   interestableAmount = MAX(0, holdingWorth - availableMargin + bookedPnL)
 *   dailyInterest = interestableAmount × (annualInterestPer / 365 / 100)
 *
 * Where:
 *   holdingWorth = sum of (netQty × currentPrice) for all open positions
 *   bookedPnL = realized P&L for the day (positive = loss, negative = profit)
 *   marginPer = the margin utilisation % stored in marketAccess.margin.marginPer
 *   maxLimit = marketAccess.margin.maximumLimit
 *
 * Rules:
 *  - Only processes users who have NSE-EQ market enabled (isSelected: true)
 *  - Only if maximumLimit > 0
 *  - Skips if today's record already exists (idempotent)
 * 
 * @param {string} forDate - Optional date in YYYY-MM-DD format. If not provided, uses today.
 * @param {ObjectId} forValanId - Optional valan ID to use for calculations. If not provided, uses current active valan.
 */
exports.chargeNseEqDailyInterest = async (forDate = null, forValanId = null) => {
  const today = forDate || moment().format('YYYY-MM-DD');
  console.log('--------------------------------------------------');
  console.log(`[NSE-EQ Interest Cron] Started for date: ${today}`);

  let processed = 0;
  let skipped = 0;
  let errors = 0;

  try {
    // Get valan to use for calculations
    let currentValan;
    if (forValanId) {
      currentValan = await WeekValanModel.findById(forValanId).lean();
      if (!currentValan) {
        console.log(`[NSE-EQ Interest Cron] Specified valan ${forValanId} not found. Exiting.`);
        return { processed: 0, skipped: 0, errors: 0 };
      }
      console.log(`[NSE-EQ Interest Cron] Using specified valan: ${currentValan.label}`);
    } else {
      currentValan = await WeekValanModel.findOne({ status: true }).lean();
      if (!currentValan) {
        console.log('[NSE-EQ Interest Cron] No active valan found. Exiting.');
        return { processed: 0, skipped: 0, errors: 0 };
      }
    }

    // 1. Fetch all non-deleted users who have NSE-EQ market access with a positive maximumLimit
    const users = await UserModel.find({
      isDeleted: false,
      marketAccess: {
        $elemMatch: {
          marketId: NSE_EQ_MARKET_ID,
          isSelected: true,
          'margin.maximumLimit': { $gt: 0 }
        }
      }
    })
      .select('_id parentIds marketAccess basicDetails accountDetails')
      .lean();

    if (!users || users.length === 0) {
      console.log('[NSE-EQ Interest Cron] No eligible users found. Exiting.');
      return { processed: 0, skipped: 0, errors: 0 };
    }

    console.log(`[NSE-EQ Interest Cron] Found ${users.length} eligible users.`);

    for (const user of users) {
      try {
        // 1. Skip if user has no parents (top-level users like Super Admin don't pay interest)
        if (!user.parentIds || user.parentIds.length === 0) {
          skipped++;
          continue;
        }

        // 2. Find the NSE-EQ market config for this user
        const nseEqMarket = (user.marketAccess || []).find(
          (m) => m.marketId === NSE_EQ_MARKET_ID && m.isSelected
        );
        if (!nseEqMarket) {
          skipped++;
          continue;
        }

        const totalMargin = Number(nseEqMarket.margin?.totalMargin) || 0;
        if (totalMargin <= 0) {
          skipped++;
          continue;
        }

        const marginPer = Math.min(
          Math.max(Number(nseEqMarket.margin?.marginPer) || 0, 0),
          100
        );

        const annualInterestPer =
          Number(user.basicDetails?.nseEqAnnualInterest) || 0;

        // If annual interest rate is 0 or less, skip
        if (annualInterestPer <= 0) {
          skipped++;
          continue;
        }

        // Skip if record already exists for today (idempotent)
        const existing = await NseEqInterestModel.findOne({
          userId: user._id,
          date: today
        }).lean();
        if (existing) {
          skipped++;
          continue;
        }

        // Check if new ledger-based logic should be used
        const isLinkedWithLedger = Number(user.accountDetails?.nseeqinterestLinkedwithLedger) === 1;

        let interestAmount = 0;
        let interestableAmount = 0;
        let holdingWorth = 0;
        let bookedPnl = 0;

        if (isLinkedWithLedger) {
          // NEW LOGIC: Calculate based on actual loan usage with unrealized P&L
          console.log(`[NSE-EQ Interest Cron] User ${user._id}: Using NEW LOGIC (Ledger-based)`);
          const result = await calculateHoldingAndBookedPnL(user._id, currentValan._id, today);
          holdingWorth = result.holdingWorth;
          bookedPnl = result.bookedPnl;

          const availableMargin = totalMargin * (marginPer / 100);
          
          // Interestable amount = MAX(0, holdingWorth - availableMargin + bookedPnL)
          interestableAmount = Math.max(0, holdingWorth - availableMargin + bookedPnl);

          console.log(`[NSE-EQ Interest Cron] User ${user._id}: holdingWorth=₹${holdingWorth.toFixed(2)}, availableMargin=₹${availableMargin.toFixed(2)}, bookedPnl=₹${bookedPnl.toFixed(2)}, interestableAmount=₹${interestableAmount.toFixed(2)}`);

          // If no loan is being used, skip
          if (interestableAmount <= 0.01) {
            console.log(`[NSE-EQ Interest Cron] User ${user._id} skipped: interestableAmount too low (${interestableAmount})`);
            skipped++;
            continue;
          }

          // Daily interest = interestableAmount × (annualInterestPer / 365 / 100)
          interestAmount = interestableAmount * (annualInterestPer / 365 / 100);
          console.log(`[NSE-EQ Interest Cron] User ${user._id}: interestAmount=₹${interestAmount.toFixed(2)}`);
        } else {
          // OLD LOGIC: Flat interest on loan amount
          const loanAmount = totalMargin * (1 - marginPer / 100);

          // If fully margined (marginPer=100) or loanAmount ≤ 0, no interest
          if (loanAmount <= 0.01) {
            skipped++;
            continue;
          }

          // Daily interest = loanAmount × (annualInterestPer / 365 / 100)
          interestAmount = loanAmount * (annualInterestPer / 365 / 100);
        }

        // Persist
        await NseEqInterestModel.create({
          userId: user._id,
          parentIds: user.parentIds || [],
          annualInterestPer: Number(annualInterestPer.toFixed(2)),
          maxLimit: Number(totalMargin.toFixed(2)),
          marginPer: Number(marginPer.toFixed(2)),
          interestAmount: Number(interestAmount.toFixed(2)),
          date: today,
          isLinkedWithLedger: isLinkedWithLedger ? 1 : 0,
          bookedPnl: Number(bookedPnl.toFixed(2)),
          holdingWorth: Number(holdingWorth.toFixed(2)),
          interestableAmount: Number(interestableAmount.toFixed(2))
        });

        processed++;
      } catch (userErr) {
        console.error(
          `[NSE-EQ Interest Cron] Error for user ${user._id}:`,
          userErr.message
        );
        errors++;
      }
    }
  } catch (err) {
    console.error('[NSE-EQ Interest Cron] Fatal error:', err);
    errors++;
  }

  console.log(
    `[NSE-EQ Interest Cron] Done. processed=${processed}, skipped=${skipped}, errors=${errors}`
  );
  console.log('--------------------------------------------------');
  return { processed, skipped, errors };
};

/**
 * Calculate and save interest for Saturday and Sunday (weekend) before a valan starts.
 * This should be called when a new valan becomes active.
 * 
 * Logic:
 * - Saturday = valan start date - 2 days
 * - Sunday = valan start date - 1 day
 * - Check if a new valan exists for the weekend dates
 * - If new valan exists, use it; otherwise use the current valan
 * 
 * @param {ObjectId} valanId - The valan ID that just became active
 */
exports.calculateWeekendInterest = async (valanId) => {
  console.log('--------------------------------------------------');
  console.log(`[NSE-EQ Weekend Interest] Starting weekend interest calculation for valan: ${valanId}`);
  
  try {
    const valan = await WeekValanModel.findById(valanId).lean();
    if (!valan) {
      console.log(`[NSE-EQ Weekend Interest] Valan ${valanId} not found. Exiting.`);
      return { processed: 0, skipped: 0, errors: 0 };
    }

    const valanStartDate = moment(valan.startDate);
    const saturday = valanStartDate.clone().subtract(2, 'days');
    const sunday = valanStartDate.clone().subtract(1, 'days');

    console.log(`[NSE-EQ Weekend Interest] Valan starts on: ${valanStartDate.format('YYYY-MM-DD')} (${valanStartDate.format('dddd')})`);
    console.log(`[NSE-EQ Weekend Interest] Saturday: ${saturday.format('YYYY-MM-DD')}`);
    console.log(`[NSE-EQ Weekend Interest] Sunday: ${sunday.format('YYYY-MM-DD')}`);

    let totalProcessed = 0;
    let totalSkipped = 0;
    let totalErrors = 0;

    // Process Saturday
    console.log(`[NSE-EQ Weekend Interest] Processing Saturday...`);
    // Check if there's a valan that covers Saturday
    const saturdayValan = await WeekValanModel.findOne({
      startDate: { $lte: saturday.toDate() },
      endDate: { $gte: saturday.toDate() }
    }).lean();
    
    const saturdayValanId = saturdayValan ? saturdayValan._id : valanId;
    console.log(`[NSE-EQ Weekend Interest] Using valan for Saturday: ${saturdayValan ? saturdayValan.label : valan.label}`);
    
    const satResult = await exports.chargeNseEqDailyInterest(
      saturday.format('YYYY-MM-DD'),
      saturdayValanId
    );
    totalProcessed += satResult.processed;
    totalSkipped += satResult.skipped;
    totalErrors += satResult.errors;

    // Process Sunday
    console.log(`[NSE-EQ Weekend Interest] Processing Sunday...`);
    // Check if there's a valan that covers Sunday
    const sundayValan = await WeekValanModel.findOne({
      startDate: { $lte: sunday.toDate() },
      endDate: { $gte: sunday.toDate() }
    }).lean();
    
    const sundayValanId = sundayValan ? sundayValan._id : valanId;
    console.log(`[NSE-EQ Weekend Interest] Using valan for Sunday: ${sundayValan ? sundayValan.label : valan.label}`);
    
    const sunResult = await exports.chargeNseEqDailyInterest(
      sunday.format('YYYY-MM-DD'),
      sundayValanId
    );
    totalProcessed += sunResult.processed;
    totalSkipped += sunResult.skipped;
    totalErrors += sunResult.errors;

    console.log(`[NSE-EQ Weekend Interest] Weekend calculation complete. Total: processed=${totalProcessed}, skipped=${totalSkipped}, errors=${totalErrors}`);
    console.log('--------------------------------------------------');
    
    return { processed: totalProcessed, skipped: totalSkipped, errors: totalErrors };
  } catch (err) {
    console.error('[NSE-EQ Weekend Interest] Fatal error:', err);
    console.log('--------------------------------------------------');
    return { processed: 0, skipped: 0, errors: 1 };
  }
};
