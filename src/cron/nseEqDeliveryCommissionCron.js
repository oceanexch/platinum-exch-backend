const mongoose = require('mongoose');
const moment = require('moment');
const UserModel = require('../models/UserModel');
const StockTransactionModel = require('../models/StockTransactionModel');
const WeekValanModel = require('../models/WeekValanModel');

// NSE-EQ market ID
const NSE_EQ_MARKET_ID = '12';

/**
 * Apply delivery commission to NSE-EQ positions held overnight.
 * 
 * Logic:
 * 1. Find all users with NSE-EQ market access
 * 2. For each user, get all completed transactions for the day
 * 3. Use FIFO matching to determine which BUY transactions have remaining open positions
 * 4. Apply delivery commission ONCE on remaining qty at original orderPrice
 * 5. Update transaction with delDetails and adjust brokerage
 * 6. Update broker's brokerage proportionally
 * 
 * Rules:
 * - Only applies to transactions that don't already have delApplied = true
 * - Handles both long (BUY) and short (SELL) positions
 * - Uses original transaction price, not market value
 * - Applies only once per transaction, no matter how many days held
 * 
 * @param {string} forDate - Optional date in YYYY-MM-DD format. If not provided, uses today.
 */
exports.applyNseEqDeliveryCommission = async (forDate = null) => {
  const today = forDate || moment().format('YYYY-MM-DD');
  console.log('--------------------------------------------------');
  console.log(`[NSE-EQ Delivery Commission Cron] Started for date: ${today}`);

  let processed = 0;
  let skipped = 0;
  let errors = 0;
  let totalDelBrokerage = 0;

  try {
    // Get current active valan
    const currentValan = await WeekValanModel.findOne({ status: true }).lean();
    if (!currentValan) {
      console.log('[NSE-EQ Delivery Commission Cron] No active valan found. Exiting.');
      return { processed: 0, skipped: 0, errors: 0 };
    }

    console.log(`[NSE-EQ Delivery Commission Cron] Using valan: ${currentValan.label}`);

    // Find all users with NSE-EQ market access
    const users = await UserModel.find({
      isDeleted: false,
      marketAccess: {
        $elemMatch: {
          marketId: NSE_EQ_MARKET_ID,
          isSelected: true,
        },
      },
    })
      .select('_id accountName accountCode marketAccess basicDetails')
      .lean();

    if (!users || users.length === 0) {
      console.log('[NSE-EQ Delivery Commission Cron] No eligible users found. Exiting.');
      return { processed: 0, skipped: 0, errors: 0 };
    }

    console.log(`[NSE-EQ Delivery Commission Cron] Found ${users.length} eligible users.`);

    const startOfDay = moment(today).startOf('day').toDate();
    const endOfDay = moment(today).endOf('day').toDate();

    for (const user of users) {
      try {
        console.log(`\n[NSE-EQ Delivery Commission] Processing user: ${user.accountName} (${user._id})`);

        // Get NSE-EQ market config
        const nseEqMarket = (user.marketAccess || []).find(
          (m) => m.marketId === NSE_EQ_MARKET_ID && m.isSelected
        );

        if (!nseEqMarket) {
          console.log(`[NSE-EQ Delivery Commission] User ${user._id}: No NSE-EQ market access`);
          skipped++;
          continue;
        }

        const deliveryCommission = parseFloat(nseEqMarket.brokerage?.deliveryCommission || 0);
        const intradayCommission = parseFloat(nseEqMarket.brokerage?.intradayCommission || 0);
        const brokerageType = nseEqMarket.brokerage?.type || 'percent';

        // Delivery commission to apply = delivery - intraday (the difference)
        const delCommissionToApply = deliveryCommission - intradayCommission;

        if (delCommissionToApply <= 0) {
          console.log(`[NSE-EQ Delivery Commission] User ${user._id}: Delivery commission difference is ${delCommissionToApply} (del: ${deliveryCommission}, intraday: ${intradayCommission}), skipping`);
          skipped++;
          continue;
        }

        console.log(`[NSE-EQ Delivery Commission] User ${user._id}: Delivery commission to apply = ${delCommissionToApply}${brokerageType === 'percent' ? '%' : ' per lot'} (del: ${deliveryCommission} - intraday: ${intradayCommission})`);

        // Get all completed transactions for today
        const transactions = await StockTransactionModel.find({
          userId: user._id,
          valanId: currentValan._id,
          marketId: NSE_EQ_MARKET_ID,
          transactionStatus: 'COMPLETED',
          createdAt: { $gte: startOfDay, $lte: endOfDay },
        })
          .sort({ createdAt: 1 }) // FIFO order
          .lean();

        if (transactions.length === 0) {
          console.log(`[NSE-EQ Delivery Commission] User ${user._id}: No transactions today`);
          skipped++;
          continue;
        }

        console.log(`[NSE-EQ Delivery Commission] User ${user._id}: Found ${transactions.length} transactions`);

        // Group by script for FIFO matching
        const scriptMap = new Map();

        for (const txn of transactions) {
          const scriptId = txn.scriptId.toString();
          if (!scriptMap.has(scriptId)) {
            scriptMap.set(scriptId, {
              scriptName: txn.scriptName,
              buys: [],
              sells: [],
            });
          }

          const script = scriptMap.get(scriptId);
          if (txn.transactionType === 'BUY') {
            script.buys.push({
              ...txn,
              remainingQty: txn.quantity,
            });
          } else if (txn.transactionType === 'SELL') {
            script.sells.push({
              ...txn,
              remainingQty: txn.quantity,
            });
          }
        }

        console.log(`[NSE-EQ Delivery Commission] User ${user._id}: Processing ${scriptMap.size} scripts`);

        // Process each script with FIFO matching
        const bulkUpdates = [];

        for (const [scriptId, data] of scriptMap) {
          console.log(`\n[NSE-EQ Delivery Commission] Script: ${data.scriptName}`);
          console.log(`  - BUYs: ${data.buys.length}, SELLs: ${data.sells.length}`);

          // FIFO matching: Match sells against buys
          let buyIndex = 0;
          let sellIndex = 0;

          while (buyIndex < data.buys.length && sellIndex < data.sells.length) {
            const buy = data.buys[buyIndex];
            const sell = data.sells[sellIndex];

            const matchQty = Math.min(buy.remainingQty, sell.remainingQty);

            buy.remainingQty -= matchQty;
            sell.remainingQty -= matchQty;

            console.log(`  - Matched ${matchQty} qty: BUY[${buyIndex}] vs SELL[${sellIndex}]`);

            if (buy.remainingQty === 0) buyIndex++;
            if (sell.remainingQty === 0) sellIndex++;
          }

          // Apply delivery commission to remaining BUY positions (long positions)
          for (const buy of data.buys) {
            if (buy.remainingQty > 0 && !buy.delDetails?.delApplied) {
              const result = await applyDeliveryCommissionToTransaction(
                buy,
                buy.remainingQty,
                delCommissionToApply,
                brokerageType,
                nseEqMarket,
                user
              );

              if (result) {
                bulkUpdates.push(result);
                totalDelBrokerage += result.updateOne.update.$set['delDetails.delBrokerage'];
                console.log(`  ✓ Applied delivery commission to BUY txn ${buy._id}: ${buy.remainingQty} qty, ₹${result.updateOne.update.$set['delDetails.delBrokerage'].toFixed(2)}`);
              }
            }
          }

          // Apply delivery commission to remaining SELL positions (short positions)
          for (const sell of data.sells) {
            if (sell.remainingQty > 0 && !sell.delDetails?.delApplied) {
              const result = await applyDeliveryCommissionToTransaction(
                sell,
                sell.remainingQty,
                delCommissionToApply,
                brokerageType,
                nseEqMarket,
                user
              );

              if (result) {
                bulkUpdates.push(result);
                totalDelBrokerage += result.updateOne.update.$set['delDetails.delBrokerage'];
                console.log(`  ✓ Applied delivery commission to SELL txn ${sell._id}: ${sell.remainingQty} qty, ₹${result.updateOne.update.$set['delDetails.delBrokerage'].toFixed(2)}`);
              }
            }
          }
        }

        // Execute bulk updates for this user
        if (bulkUpdates.length > 0) {
          await StockTransactionModel.bulkWrite(bulkUpdates);
          processed += bulkUpdates.length;
          console.log(`[NSE-EQ Delivery Commission] User ${user._id}: Updated ${bulkUpdates.length} transactions`);
        } else {
          console.log(`[NSE-EQ Delivery Commission] User ${user._id}: No updates needed`);
          skipped++;
        }
      } catch (userErr) {
        console.error(`[NSE-EQ Delivery Commission] Error for user ${user._id}:`, userErr.message);
        errors++;
      }
    }
  } catch (err) {
    console.error('[NSE-EQ Delivery Commission Cron] Fatal error:', err);
    errors++;
  }

  console.log(`\n[NSE-EQ Delivery Commission Cron] Done.`);
  console.log(`  - Processed: ${processed} transactions`);
  console.log(`  - Skipped: ${skipped} users`);
  console.log(`  - Errors: ${errors}`);
  console.log(`  - Total Delivery Brokerage Applied: ₹${totalDelBrokerage.toFixed(2)}`);
  console.log('--------------------------------------------------');

  return { processed, skipped, errors, totalDelBrokerage };
};

/**
 * Apply delivery commission to a single transaction
 * @param {Object} transaction - The transaction object
 * @param {Number} remainingQty - Remaining open quantity
 * @param {Number} deliveryCommission - Delivery commission rate
 * @param {String} brokerageType - 'percent' or 'lot'
 * @param {Object} nseEqMarket - Market config
 * @param {Object} user - User object
 * @returns {Object} Bulk update operation object
 */
async function applyDeliveryCommissionToTransaction(
  transaction,
  remainingQty,
  deliveryCommission,
  brokerageType,
  nseEqMarket,
  user
) {
  try {
    // Check for script-wise brokerage
    const scriptWiseBrokerage = nseEqMarket.brokerage?.scriptWiseBrokerage || [];
    const normalizedScriptName = transaction.scriptName.toUpperCase().trim();
    
    let scriptDeliveryCommission = deliveryCommission;
    let scriptIntradayCommission = parseFloat(nseEqMarket.brokerage?.intradayCommission || 0);
    
    const scriptConfig = scriptWiseBrokerage.find(
      (s) => s.script && s.script.toUpperCase().trim() === normalizedScriptName
    );
    
    if (scriptConfig) {
      const scriptDel = parseFloat(scriptConfig.deliveryCommission || 0);
      const scriptIntra = parseFloat(scriptConfig.intradayCommission || 0);
      scriptDeliveryCommission = scriptDel - scriptIntra; // Calculate difference for script-wise too
      console.log(`    - Using script-wise delivery commission for ${transaction.scriptName}: del=${scriptDel}, intraday=${scriptIntra}, difference=${scriptDeliveryCommission}`);
    }

    // If the difference is <= 0, skip this transaction
    if (scriptDeliveryCommission <= 0) {
      console.log(`    - Skipping ${transaction.scriptName}: delivery commission difference is ${scriptDeliveryCommission}`);
      return null;
    }

    // Calculate delivery brokerage on original orderPrice
    let delBrokerage = 0;
    let delBrokeragePerQty = 0;

    if (brokerageType === 'lot') {
      // Lot-based brokerage
      const lotFactor = transaction.quantity > 0 ? transaction.lot / transaction.quantity : 0;
      delBrokerage = remainingQty * scriptDeliveryCommission * lotFactor;
      delBrokeragePerQty = scriptDeliveryCommission * lotFactor;
    } else {
      // Percentage-based brokerage
      delBrokerage = (remainingQty * transaction.orderPrice * scriptDeliveryCommission) / 100;
      delBrokeragePerQty = (transaction.orderPrice * scriptDeliveryCommission) / 100;
    }

    // Calculate broker's share of delivery brokerage
    const delBrokerBrokerage = [];
    const brokerPartnership = user.basicDetails?.brokerPartnership || [];

    for (const bp of brokerPartnership) {
      if (bp.broker && bp.partnership > 0) {
        // Handle both populated and non-populated broker references
        const brokerId = bp.broker._id ? bp.broker._id : bp.broker;
        const brokerShare = (delBrokerage * bp.partnership) / 100;
        delBrokerBrokerage.push({
          brokerId: brokerId,
          amount: Number(brokerShare.toFixed(4)),
        });
      }
    }

    // Update transaction brokerage fields
    const currentNetBrokerage = transaction.netBrokerage || 0;
    const currentOrderBrokerage = transaction.orderBrokerage || 0;
    const currentBrokerTotalBrokerage = transaction.brokerTotalBrokerage || 0;

    const newNetBrokerage = currentNetBrokerage + delBrokerage;
    const newOrderBrokerage = transaction.quantity > 0 ? newNetBrokerage / transaction.quantity : currentOrderBrokerage;

    // Recalculate netPrice and totalNetPrice
    let newNetPrice = transaction.netPrice || transaction.orderPrice;
    let newTotalNetPrice = transaction.totalNetPrice || 0;

    if (transaction.transactionType === 'BUY') {
      newNetPrice = transaction.orderPrice + newOrderBrokerage;
      newTotalNetPrice = newNetPrice * transaction.quantity;
    } else {
      newNetPrice = transaction.orderPrice - newOrderBrokerage;
      newTotalNetPrice = newNetPrice * transaction.quantity;
    }

    // Calculate new broker total brokerage
    const totalDelBrokerBrokerage = delBrokerBrokerage.reduce((sum, b) => sum + b.amount, 0);
    const newBrokerTotalBrokerage = currentBrokerTotalBrokerage + totalDelBrokerBrokerage;

    // Update brockersBrokerage array
    const updatedBrockersBrokerage = [...(transaction.brockersBrokerage || [])];
    for (const delBroker of delBrokerBrokerage) {
      const delBrokerIdStr = delBroker.brokerId ? delBroker.brokerId.toString() : null;
      if (!delBrokerIdStr) continue;
      
      const existingBroker = updatedBrockersBrokerage.find(
        (b) => b.brokerId && b.brokerId.toString() === delBrokerIdStr
      );
      if (existingBroker) {
        existingBroker.rate = Number((existingBroker.rate + delBroker.amount).toFixed(4));
      } else {
        updatedBrockersBrokerage.push({
          brokerId: delBroker.brokerId,
          rate: delBroker.amount,
        });
      }
    }

    // Recalculate m2mPrice
    let newM2mPrice = 0;
    if (transaction.transactionType === 'BUY') {
      newM2mPrice = newTotalNetPrice - newBrokerTotalBrokerage;
    } else {
      newM2mPrice = newTotalNetPrice + newBrokerTotalBrokerage;
    }

    // Calculate new brokerage percentage
    const newBrokeragePercentage =
      transaction.orderPrice && Number.isFinite(transaction.orderPrice) && transaction.orderPrice > 0
        ? Number(((newOrderBrokerage * 100) / transaction.orderPrice).toFixed(4))
        : 0;

    return {
      updateOne: {
        filter: { _id: transaction._id },
        update: {
          $set: {
            'delDetails.delApplied': true,
            'delDetails.appliedQty': remainingQty,
            'delDetails.delBrokerage': Number(delBrokerage.toFixed(4)),
            'delDetails.delBrokerBrokerage': delBrokerBrokerage,
            'delDetails.appliedAt': new Date(),
            netBrokerage: Number(newNetBrokerage.toFixed(4)),
            orderBrokerage: Number(newOrderBrokerage.toFixed(4)),
            netPrice: Number(newNetPrice.toFixed(4)),
            totalNetPrice: Number(newTotalNetPrice.toFixed(4)),
            brokerTotalBrokerage: Number(newBrokerTotalBrokerage.toFixed(4)),
            brockersBrokerage: updatedBrockersBrokerage,
            m2mPrice: Number(newM2mPrice.toFixed(4)),
            brokeragePercentage: newBrokeragePercentage,
          },
        },
      },
    };
  } catch (err) {
    console.error(`[applyDeliveryCommissionToTransaction] Error for txn ${transaction._id}:`, err.message);
    return null;
  }
}
