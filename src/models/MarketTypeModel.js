const mongoose = require('mongoose');
const Schema = mongoose.Schema;

// Expiry Schema
const expirySchema = new Schema({
  script_expiry_id: { type: String, required: true },
  script_id: { type: String, required: true },
  expiry_date: { type: String, required: true },
  tradeEndDate: { type: String }, // Add tradeEndDate field
  script_expiry_type: { type: String, default: '' },
  script_data_key: { type: String, default: '' },
  script_lot_qty: { type: Number, default: null },
  expiry_date_orginal: { type: String, default: "NA", required: true },
  symbol: { type: String },
});

const scriptSchema = new Schema({
  script_name: { type: String, required: true },
  script_id: { type: String, required: true },
  id: { type: String },
  market_type_id: { type: String, required: true },
  selected: { type: Boolean, default: false },

  // Metadata / Real-time fields
  symbol: { type: String },
  last_price: { type: Number, default: 0 },
  closing_price: { type: Number, default: 0 },
  open: { type: Number, default: 0 },
  high: { type: Number, default: 0 },
  low: { type: Number, default: 0 },
  lot_size: { type: Number, default: 1 },
  tick_size: { type: Number, default: 0.05 },
  strike: { type: Number, default: 0 },
  instrument_type: { type: String },
  option_type: { type: String },
  exchange: { type: String },
  dacimal: { type: Boolean, default: true },
  // Last week's closing prices (array of values only)
  lastWeekClosing: [{ type: Number }],

  // Last week's closing price (single value, 2 decimal places)
  lastWeekClosing: { type: Number, default: 0 },

  expiry: [expirySchema],
}, { timestamps: true });

// MarketType Schema with Reference to Scripts
const marketTypeSchema = new Schema({
  market_type_name: { type: String, required: true },
  name: { type: String, required: true },
  market_type_id: { type: String, required: true },
  id: { type: String, required: true },
  selected: { type: Boolean, default: false },
  order: { type: String, required: true },
  scripts: [{ type: Schema.Types.ObjectId, ref: 'Script' }],
}, { timestamps: true });

// Index on the market_type_id in the MarketType schema
marketTypeSchema.index({ market_type_id: 1 });

// Index on script_id in the Script schema
scriptSchema.index({ script_id: 1 });

// Index on expiry_date in the Script schema
scriptSchema.index({ "expiry.expiry_date": 1 });

// Create the models
const MarketType = mongoose.model('MarketType', marketTypeSchema);
const Script = mongoose.model('Script', scriptSchema);

module.exports = { MarketType, Script };