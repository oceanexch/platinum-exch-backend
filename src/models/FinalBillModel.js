const mongoose = require('mongoose');

const FinalBillSchema = new mongoose.Schema(
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
    
    // Period identification
    valanId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'WeekValan',
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
    
    // Aggregated M2M (includes self + all downline)
    totalM2M: {
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
    // Per-broker brokerage breakdown (summed from StockTransaction.brockersBrokerage)
    brockersBrokerage: [{
      brokerId: {
        type: mongoose.Schema.Types.ObjectId,
        ref: 'User'
      },
      rate: { type: Number }
    }],
    
    // Calculated shares (from summary report)
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
    
    // NSE EQ specific (marketId="12")
    interestAmount: {
      type: Number,
      default: 0
    },
    
    // Limits (for reference)
    m2mProfitLimit: Number,
    m2mLossLimit: Number,
    
    // Additional fields for compatibility
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
    }
  },
  {
    timestamps: true,
    collection: 'finalbills'
  }
);

// Compound indexes for efficient queries
FinalBillSchema.index({ userId: 1, valanId: 1, marketId: 1 }, { unique: true });
FinalBillSchema.index({ createdBy: 1, valanId: 1, marketId: 1 });
FinalBillSchema.index({ valanId: 1, level: 1 });

module.exports = mongoose.model('FinalBill', FinalBillSchema);
