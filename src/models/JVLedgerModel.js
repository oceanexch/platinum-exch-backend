const mongoose = require("mongoose");
const { Schema } = mongoose;

const JVLedgerSchema = new Schema(
  {
    debitAccount: { type: Schema.Types.ObjectId, ref: "User", required: true },
    creditAccount: { type: Schema.Types.ObjectId, ref: "User", required: true },
    transactionType: { type: String, required: true, trim: true, enum: ["DEBIT", "CREDIT"] },
    date: { type: Date, required: true },
    amount: { type: Number, required: true },
    remarks: { type: String, required: true },
    createdBy: { type: Schema.Types.ObjectId, ref: "User", required: true },
    preLedger: { type: Number },
    ledger: { type: Number }
  },
  {
    timestamps: true,
  }
);

module.exports = mongoose.model("JVLedger", JVLedgerSchema);
