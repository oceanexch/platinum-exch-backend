const mongoose = require('mongoose');

const bhavcopySchema = new mongoose.Schema({
  InstrumentIdentifier: { type: String, required: true, unique: true },
  label: { type: String },
  marketId: { type: String, required: true },
  marketName: { type: String, required: true },
  scriptId: { type: String },
  symbol: { type: String },
  scriptName: { type: String },
  expiry: { type: String },
  date: { type: String },
  closingPrice: { type: Number, required: true },
}, { timestamps: true });

module.exports = mongoose.model('Bhavcopy', bhavcopySchema);
