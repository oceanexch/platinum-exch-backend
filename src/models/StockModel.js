const mongoose = require('mongoose');

const stockSchema = new mongoose.Schema({
  InstrumentIdentifier: { type: String, required: true },
  Exchange: { type: String, required: true },
  High: { type: Number, required: true },
  Low: { type: Number, required: true },
  BuyPrice: { type: Number, required: true },
  SellPrice: { type: Number, required: true },
  LastTradePrice: { type: Number, required: true },
  PriceChange: { type: Number, required: true },
  PriceChangePercentage: { type: Number, required: true },
  ServerTime: { type: Number, required: true },
  ServerTime2: { type: String, required: true },
  Close: { type: Number, required: true },
  Open: { type: Number, required: true },
}, { timestamps: true });

const Stock = mongoose.model('Stock', stockSchema);

module.exports = Stock;
