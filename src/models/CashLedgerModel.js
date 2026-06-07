const mongoose = require("mongoose");
const { Schema } = mongoose;

const cashLedgerSchema = new Schema(
  {
    userId: { type: Schema.Types.ObjectId, ref: "User", required: true },
    createdBy: { type: Schema.Types.ObjectId, ref: "User", required: true },
    amount: { type: Number, required: true },
    transactionType: { type: String, required: true, trim: true, enum: ["RECEIPT", "PAYMENT"] },
    date: { type: Date, required: true },
    remarks: { type: String, required: true },
    preLedger: { type: Number },
    ledger: { type: Number }
  },
  {
    timestamps: true,
  }
);

// Covered index for computeCashBalances aggregate (userId $in → transactionType → amount)
cashLedgerSchema.index({ userId: 1, transactionType: 1, amount: 1 });

module.exports = mongoose.model('CashLedger', cashLedgerSchema, 'CashLedgers');
