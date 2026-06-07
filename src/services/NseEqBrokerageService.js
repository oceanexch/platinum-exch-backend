const mongoose = require('mongoose');
const moment = require('moment');
const StockTransactionModel = require('../models/StockTransactionModel');
const { MARKET_IDS } = require('../config/marketConstants');

/**
 * NSE-EQ Brokerage Service
 * 
 * This service calculates how much quantity has DEL (delivery commission) applied
 * and how much should use intraday rates when squaring off positions.
 * 
 * Logic:
 * - Uses FIFO matching similar to nseEqDeliveryCommissionCron.js
 * - Determines which BUY/SELL transactions have DEL applied
 * - When squaring off, matches against DEL positions first, then intraday
 * - For DEL positions: use full delivery rate
 * - For intraday positions: use intraday rate
 */

/**
 * Get DEL applicable quantity for a user's script position
 * Uses FIFO matching to determine which quantity has DEL applied
 * 
 * @param {ObjectId} userId - User ID
 * @param {ObjectId} valanId - Current valan ID
 * @param {ObjectId} scriptId - Script ID
 * @param {Number} quantity - Quantity being traded
 * @param {String} transactionType - 'BUY' or 'SELL' (the current transaction type)
 * @returns {Object} { delQty, intradayQty, delTransactions }
 */
exports.getDelApplicableQty = async (userId, valanId, scriptId, quantity, transactionType) => {
  try {
    // For square-off, we need to check opposite type transactions
    // If we're SELLING, check BUY transactions (and vice versa)
    const oppositeType = transactionType === 'BUY' ? 'SELL' : 'BUY';
    
    // Get all completed opposite transactions for this user/script in current valan
    const transactions = await StockTransactionModel.find({
      userId,
      valanId,
      scriptId,
      marketId: MARKET_IDS.NSE_EQ,
      transactionStatus: 'COMPLETED',
      transactionType: oppositeType,
    })
      .sort({ createdAt: 1 }) // FIFO order
      .lean();

    if (transactions.length === 0) {
      return { delQty: 0, intradayQty: quantity, delTransactions: [] };
    }

    // Calculate remaining quantity for each transaction using FIFO
    const openPositions = [];
    
    for (const txn of transactions) {
      const remainingQty = await getRemainingQtyForTransaction(txn, userId, valanId, scriptId);
      
      if (remainingQty > 0) {
        openPositions.push({
          ...txn,
          remainingQty,
          hasDelApplied: !!(txn.delDetails && txn.delDetails.delApplied),
        });
      }
    }

    // Match against positions with DEL first (FIFO)
    let delQty = 0;
    let intradayQty = 0;
    let remainingToMatch = quantity;
    const matchedDelTransactions = [];

    // First pass: Match DEL positions
    for (const pos of openPositions) {
      if (remainingToMatch <= 0) break;
      if (!pos.hasDelApplied) continue;

      const matchQty = Math.min(pos.remainingQty, remainingToMatch);
      delQty += matchQty;
      remainingToMatch -= matchQty;

      matchedDelTransactions.push({
        transactionId: pos._id,
        matchedQty: matchQty,
        orderPrice: pos.orderPrice,
        hasDelApplied: true,
      });
    }

    // Second pass: Match intraday positions
    for (const pos of openPositions) {
      if (remainingToMatch <= 0) break;
      if (pos.hasDelApplied) continue;

      const matchQty = Math.min(pos.remainingQty, remainingToMatch);
      intradayQty += matchQty;
      remainingToMatch -= matchQty;

      matchedDelTransactions.push({
        transactionId: pos._id,
        matchedQty: matchQty,
        orderPrice: pos.orderPrice,
        hasDelApplied: false,
      });
    }

    // Any remaining quantity is new intraday
    intradayQty += remainingToMatch;

    return {
      delQty,
      intradayQty,
      delTransactions: matchedDelTransactions,
    };
  } catch (error) {
    console.error('[NseEqBrokerageService] Error in getDelApplicableQty:', error);
    return { delQty: 0, intradayQty: quantity, delTransactions: [] };
  }
};

/**
 * Calculate remaining quantity for a transaction after matching with opposite transactions
 * Uses FIFO matching logic
 * 
 * @param {Object} transaction - The transaction to check
 * @param {ObjectId} userId - User ID
 * @param {ObjectId} valanId - Valan ID
 * @param {ObjectId} scriptId - Script ID
 * @returns {Number} Remaining open quantity
 */
async function getRemainingQtyForTransaction(transaction, userId, valanId, scriptId) {
  try {
    // Get all opposite transactions that came AFTER this transaction
    const oppositeType = transaction.transactionType === 'BUY' ? 'SELL' : 'BUY';
    
    const oppositeTransactions = await StockTransactionModel.find({
      userId,
      valanId,
      scriptId,
      marketId: MARKET_IDS.NSE_EQ,
      transactionStatus: 'COMPLETED',
      transactionType: oppositeType,
      createdAt: { $gte: transaction.createdAt },
    })
      .sort({ createdAt: 1 })
      .lean();

    // Get all same-type transactions that came BEFORE this transaction
    const sameTypeTransactions = await StockTransactionModel.find({
      userId,
      valanId,
      scriptId,
      marketId: MARKET_IDS.NSE_EQ,
      transactionStatus: 'COMPLETED',
      transactionType: transaction.transactionType,
      createdAt: { $lt: transaction.createdAt },
    })
      .sort({ createdAt: 1 })
      .lean();

    // Calculate how much of the earlier transactions are still open
    let earlierOpenQty = 0;
    for (const earlier of sameTypeTransactions) {
      earlierOpenQty += earlier.quantity;
    }

    // Match opposite transactions against earlier + current transaction
    let totalAvailableQty = earlierOpenQty + transaction.quantity;
    let matchedQty = 0;

    for (const opposite of oppositeTransactions) {
      if (totalAvailableQty <= 0) break;

      const matchQty = Math.min(opposite.quantity, totalAvailableQty);
      totalAvailableQty -= matchQty;

      // If we've consumed all earlier qty, start consuming current transaction
      if (matchQty > earlierOpenQty) {
        matchedQty += (matchQty - earlierOpenQty);
        earlierOpenQty = 0;
      } else {
        earlierOpenQty -= matchQty;
      }
    }

    return Math.max(0, transaction.quantity - matchedQty);
  } catch (error) {
    console.error('[NseEqBrokerageService] Error in getRemainingQtyForTransaction:', error);
    return 0;
  }
}

/**
 * Calculate brokerage split between DEL and intraday rates
 * 
 * @param {Number} delQty - Quantity with DEL applied
 * @param {Number} intradayQty - Quantity for intraday
 * @param {Number} price - Transaction price
 * @param {Number} deliveryRate - Delivery commission rate
 * @param {Number} intradayRate - Intraday commission rate
 * @param {String} brokerageType - 'percent' or 'lot'
 * @param {Number} lot - Lot size (for lot-based brokerage)
 * @returns {Object} { totalBrokerage, delBrokerage, intradayBrokerage }
 */
exports.calculateNseEqBrokerage = (delQty, intradayQty, price, deliveryRate, intradayRate, brokerageType, lot = 0) => {
  let delBrokerage = 0;
  let intradayBrokerage = 0;

  if (brokerageType === 'lot') {
    const totalQty = delQty + intradayQty;
    const lotFactor = totalQty > 0 ? lot / totalQty : 0;
    
    delBrokerage = delQty * deliveryRate * lotFactor;
    intradayBrokerage = intradayQty * intradayRate * lotFactor;
  } else {
    // Percentage-based
    delBrokerage = (delQty * price * deliveryRate) / 100;
    intradayBrokerage = (intradayQty * price * intradayRate) / 100;
  }

  return {
    totalBrokerage: delBrokerage + intradayBrokerage,
    delBrokerage,
    intradayBrokerage,
  };
};

/**
 * Check if a market is NSE-EQ
 * 
 * @param {String} marketId - Market ID
 * @returns {Boolean}
 */
exports.isNseEq = (marketId) => {
  return marketId === MARKET_IDS.NSE_EQ;
};


/**
 * Calculate brokerage split between DEL and intraday rates for NSE-EQ
 * 
 * @param {Number} delQty - Quantity with DEL applied
 * @param {Number} intradayQty - Quantity for intraday
 * @param {Number} price - Transaction price
 * @param {Number} deliveryRate - Delivery commission rate (full rate, not difference)
 * @param {Number} intradayRate - Intraday commission rate
 * @param {String} brokerageType - 'percent' or 'lot'
 * @param {Number} lot - Lot size (for lot-based brokerage)
 * @param {Number} totalQty - Total quantity (delQty + intradayQty)
 * @returns {Object} { totalBrokerage, delBrokerage, intradayBrokerage, orderBrokerage }
 */
exports.calculateNseEqBrokerage = (delQty, intradayQty, price, deliveryRate, intradayRate, brokerageType, lot, totalQty) => {
  let delBrokerage = 0;
  let intradayBrokerage = 0;

  if (brokerageType === 'lot') {
    const lotFactor = totalQty > 0 ? lot / totalQty : 0;
    
    // For DEL qty: use full delivery rate
    delBrokerage = delQty * deliveryRate * lotFactor;
    // For intraday qty: use intraday rate
    intradayBrokerage = intradayQty * intradayRate * lotFactor;
  } else {
    // Percentage-based
    // For DEL qty: use full delivery rate
    delBrokerage = (delQty * price * deliveryRate) / 100;
    // For intraday qty: use intraday rate
    intradayBrokerage = (intradayQty * price * intradayRate) / 100;
  }

  const totalBrokerage = delBrokerage + intradayBrokerage;
  const orderBrokerage = totalQty > 0 ? totalBrokerage / totalQty : 0;

  return {
    totalBrokerage,
    delBrokerage,
    intradayBrokerage,
    orderBrokerage,
  };
};

/**
 * Check if a market is NSE-EQ
 * 
 * @param {String} marketId - Market ID
 * @returns {Boolean}
 */
exports.isNseEq = (marketId) => {
  return marketId === MARKET_IDS.NSE_EQ || marketId === '12';
};

module.exports = exports;
