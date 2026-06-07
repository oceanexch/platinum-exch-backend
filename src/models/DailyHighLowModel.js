const mongoose = require('mongoose');

const dailyHighLowSchema = new mongoose.Schema({
  scriptId: {
    type: String,
    required: true,
    index: true
  },
  marketId: {
    type: String,
    required: true
  },
  scriptName: {
    type: String,
    required: true
  },
  marketName:{
     type: String,
    required: true
  },
  expiry: {
    type: String,
    default: null
  },
  price: {
    type: Number,
    required: true
  },
  ltp: {
    type: Number,
    default: 0
  },
  bid: {
    type: Number,
    default: 0
  },
  ask: {
    type: Number,
    default: 0
  },
  type: {
    type: String,
    enum: ['HIGH', 'LOW'],
    required: true
  },
  period: {
    type: String,
    enum: ['DAILY', 'WEEKLY', 'MONTHLY'],
    required: true,
    default: 'DAILY'
  },
  periodKey: {
    type: String,
    required: true,
    index: true
  },
  timestamp: {
    type: Date,
    default: Date.now
  }
}, {
  timestamps: true
});

// Compound indexes for efficient queries
dailyHighLowSchema.index({ scriptId: 1, period: 1, type: 1, timestamp: -1 });
dailyHighLowSchema.index({ scriptId: 1, periodKey: 1, type: 1 });
dailyHighLowSchema.index({ timestamp: 1 }, { expireAfterSeconds: 5184000 }); // 60 days TTL

module.exports = mongoose.model('DailyHighLow', dailyHighLowSchema);