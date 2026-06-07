const mongoose = require('mongoose');

const marketClosePriceSchema = new mongoose.Schema(
  {
    scriptName: { type: String, required: true },
    expiry: { type: String },
    symbol: { type: String },
    marketId: { type: String, required: true },
    buyRate: { type: Number, default: 0 },
    sellRate: { type: Number, default: 0 },
    ltp: { type: Number, default: 0 },
    high: { type: Number, default: 0 },
    low: { type: Number, default: 0 },
    open: { type: Number, default: 0 },
    // TTL index: automatically delete after 30 days
    createdAt: { type: Date, default: Date.now, expires: '30d' },
  },
  { timestamps: true }
);

// Optional: compound index for faster queries by market and name
marketClosePriceSchema.index({ marketId: 1, scriptName: 1 });

// Compound unique index to prevent duplicate entries for same symbol on same day
marketClosePriceSchema.index(
  { symbol: 1, marketId: 1, expiry: 1, createdAt: 1 },
  { 
    unique: true,
    partialFilterExpression: { symbol: { $exists: true, $ne: null } }
  }
);

module.exports = mongoose.model('MarketClosePrice', marketClosePriceSchema);
