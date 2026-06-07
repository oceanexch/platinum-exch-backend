const mongoose = require('mongoose');
const Schema = mongoose.Schema;

/**
 * NseEqInterestModel – stores one record per user per day for NSE-EQ loan interest.
 *
 * Formula (Old Logic):
 *   dailyRate  = nseEqAnnualInterest / 365
 *   interest   = (maxLimit * marginPer / 100) * (dailyRate / 100)
 *
 * Formula (New Logic - when isLinkedWithLedger = true):
 *   availableMargin = maxLimit * (marginPer / 100)
 *   interestableAmount = MAX(0, holdingWorth - availableMargin + bookedPnl)
 *   interest = interestableAmount * (annualInterestPer / 365 / 100)
 *
 * Fields:
 *   userId        – the client / user this interest applies to
 *   parentIds     – hierarchy chain (mirrors StockTransaction.parentIds)
 *   annualInterestPer  – the annual interest % configured on this user's basicDetails
 *   maxLimit      – NSE-EQ market's maximumLimit for this user (rupees)
 *   marginPer     – margin utilisation % at the time of calculation
 *                   ( = usedMargin / maxLimit * 100 )
 *   interestAmount – computed daily interest in ₹
 *   date          – calendar date the interest was charged (YYYY-MM-DD string for easy grouping)
 *   isLinkedWithLedger – whether new ledger-based calculation was used (0 or 1)
 *   bookedPnl     – realized P&L for the day (positive = loss, negative = profit)
 *   holdingWorth  – market value of open positions
 *   interestableAmount – calculated loan amount used (only for new logic)
 *   createdAt / updatedAt – automatic timestamps
 */
const NseEqInterestSchema = new Schema(
  {
    userId: {
      type: Schema.Types.ObjectId,
      ref: 'User',
      required: true,
      index: true
    },
    parentIds: [{ type: Schema.Types.ObjectId, ref: 'User' }],
    annualInterestPer: { type: Number, required: true },
    maxLimit: { type: Number, required: true },
    marginPer: { type: Number, required: true },  // % of maxLimit currently used
    interestAmount: { type: Number, required: true },
    date: { type: String, required: true },         // 'YYYY-MM-DD'
    isLinkedWithLedger: { type: Number, default: 0 }, // 1 = new logic, 0 = old logic
    bookedPnl: { type: Number, default: 0 },        // Realized P&L (positive = loss, negative = profit)
    holdingWorth: { type: Number, default: 0 },     // Market value of open positions
    interestableAmount: { type: Number, default: 0 } // Calculated loan amount (new logic only)
  },
  { timestamps: true }
);

// Compound index so we can quickly check / prevent duplicate entries per user per day
NseEqInterestSchema.index({ userId: 1, date: 1 }, { unique: true });

const NseEqInterestModel = mongoose.model('NseEqInterest', NseEqInterestSchema);
module.exports = NseEqInterestModel;
