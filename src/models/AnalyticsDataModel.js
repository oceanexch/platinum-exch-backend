const mongoose = require('mongoose');

const analyticsDataSchema = new mongoose.Schema({
  userId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User',
    required: true
  },
  valanId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'WeekValan'
  },
  scriptId: {
    type: String,
    required: true
  },
  scriptName: String,
  marketId: String,
  marketName: String,
  
  // Quantities
  buyQuantity: {
    type: Number,
    default: 0
  },
  sellQuantity: {
    type: Number,
    default: 0
  },
  remainingQty: {
    type: Number,
    default: 0
  },
  
  // Lots
  buyLot: {
    type: Number,
    default: 0
  },
  sellLot: {
    type: Number,
    default: 0
  },
  remainingLot: {
    type: Number,
    default: 0
  },
  
  // Prices
  buyNetAveragePrice: {
    type: Number,
    default: 0
  },
  sellNetAveragePrice: {
    type: Number,
    default: 0
  },
  livePrice: {
    type: Number,
    default: 0
  },
  
  // P&L calculations
  totalPnl: {
    type: Number,
    default: 0
  },
  m2m: {
    type: Number,
    default: 0
  },
  gross: {
    type: Number,
    default: 0
  },
  
  // Brokerage
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
  
  // Net prices
  selfNetPrice: {
    type: Number,
    default: 0
  },
  brokerNetPrice: {
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
  
  // Shares
  myShare: {
    type: Number,
    default: 0
  },
  uplineShare: {
    type: Number,
    default: 0
  },
  downlineShare: {
    type: Number,
    default: 0
  },
  
  // User details
  userDetails: {
    accountCode: String,
    accountName: String,
    demoid: Boolean
  },
  
  // Metadata
  captureSource: {
    type: String,
    default: 'getUserPositionReport'
  },
  captureLevel: {
    type: Number
  },
  
  snapshotTime: {
    type: Date,
    default: Date.now
  }
}, {
  timestamps: true
});

// Indexes for better query performance
analyticsDataSchema.index({ userId: 1, snapshotTime: -1 });
analyticsDataSchema.index({ valanId: 1, userId: 1 });
analyticsDataSchema.index({ scriptId: 1, userId: 1 });
analyticsDataSchema.index({ snapshotTime: -1 });

module.exports = mongoose.model('AnalyticsData', analyticsDataSchema);