const mongoose = require('mongoose');

const MonthlyFinalBillSchema = new mongoose.Schema(
  {
    // User identification
    userId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
      required: true,
      index: true
    },
    createdBy: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
      required: true,
      index: true
    },
    
    // Period identification (YYYY-MM format)
    month: {
      type: String,
      required: true,
      index: true
    },
    marketId: {
      type: String,
      required: true,
      index: true
    },
    
    // User metadata
    accountCode: String,
    accountName: String,
    level: {
      type: Number,
      required: true
    },
    partnership: {
      type: [Number],
      default: []
    },
    
    // Self financial data (ONLY this user's own cash/JV)
    selfCash: {
      type: Number,
      default: 0
    },
    selfJV: {
      type: Number,
      default: 0
    },
    
    // Aggregated M2M (sum of weekly bills + previous month)
    totalM2M: {
      type: Number,
      default: 0
    },
    
    // Opening balance from previous month
    openingBalance: {
      type: Number,
      default: 0
    },
    
    // NEW: Cumulative closing balance (openingBalance + totalM2M + selfCash + selfJV)
    closingBalance: {
      type: Number,
      default: 0
    },
    
    // Partnership breakdown - stores M2M distribution by partner
    partnershipBreakdown: [{
      userId: {
        type: mongoose.Schema.Types.ObjectId,
        ref: 'User'
      },
      partnership: Number,
      amount: Number
    }],
    
    // Brokerage data
    gross: {
      type: Number,
      default: 0
    },
    brokerage: {
      type: Number,
      default: 0
    },
    brokerBrokerage: {
      type: Number,
      default: 0
    },
    selfBrokerage: {
      type: Number,
      default: 0
    },
    summedOtherBrokerage: {
      type: mongoose.Schema.Types.Mixed,
      default: []
    },
    
    // Calculated shares
    selfNetPrice: {
      type: Number,
      default: 0
    },
    uplineNetPrice: {
      type: Number,
      default: 0
    },
    downlineNetPrice: {
      type: Number,
      default: 0
    },
    brokerNetPrice: {
      type: Number,
      default: 0
    },
    
    // NSE EQ specific
    interestAmount: {
      type: Number,
      default: 0
    },
    
    // Limits
    m2mProfitLimit: Number,
    m2mLossLimit: Number,
    
    // Additional fields
    bill: {
      type: Number,
      default: 0
    },
    myShare: {
      type: Number,
      default: 0
    },
    uplineShare: {
      type: Number,
      default: 0
    },
    
    // Valans included in this monthly bill
    valanIds: [{
      type: mongoose.Schema.Types.ObjectId,
      ref: 'WeekValan'
    }]
  },
  {
    timestamps: true,
    collection: 'monthlyfinalbills'
  }
);

// Compound indexes for efficient queries
MonthlyFinalBillSchema.index({ userId: 1, month: 1, marketId: 1 }, { unique: true });
MonthlyFinalBillSchema.index({ createdBy: 1, month: 1, marketId: 1 });
MonthlyFinalBillSchema.index({ month: 1, level: 1 });

module.exports = mongoose.model('MonthlyFinalBill', MonthlyFinalBillSchema);