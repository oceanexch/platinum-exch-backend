const mongoose = require("mongoose");
const { Schema } = mongoose;

const deletedLineTradeHistorySchema = new Schema(
  {
    reportContextKey: { type: String, required: true, index: true },
    userId: { type: Schema.Types.ObjectId, ref: "User", required: true },
    firstTradeId: { type: Schema.Types.ObjectId, required: true },
    secondTradeId: { type: Schema.Types.ObjectId, required: true },
    label: { type: String, default: "-" },
    rate: { type: Number, default: null },
    buy: { type: Number, default: null },
    profit: { type: Number, default: null },
    accountName: { type: String, default: "" },
    accountCode: { type: String, default: "" },
    // Report context (from reportContextKey or stored for display)
    buyRateFrom: { type: Number, default: null },
    buyRateTo: { type: Number, default: null },
    sellRateFrom: { type: Number, default: null },
    sellRateTo: { type: Number, default: null },
    minute: { type: Number, default: null },
    // First / second trade details for deleted popup
    firstOrderPrice: { type: Number, default: null },
    firstQty: { type: Number, default: null },
    firstCreatedAt: { type: Date, default: null },
    firstType: { type: String, default: "" },
    secondOrderPrice: { type: Number, default: null },
    secondQty: { type: Number, default: null },
    secondCreatedAt: { type: Date, default: null },
    secondType: { type: String, default: "" },
  },
  { timestamps: true }
);

deletedLineTradeHistorySchema.index({ reportContextKey: 1, firstTradeId: 1, secondTradeId: 1 }, { unique: true });

const DeletedLineTradeHistory = mongoose.model("DeletedLineTradeHistory", deletedLineTradeHistorySchema);
module.exports = DeletedLineTradeHistory;
