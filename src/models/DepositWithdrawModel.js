const mongoose = require("mongoose");
const { Schema } = mongoose;

const depositWithdrawSchema = new Schema(
  {
    userId: {
      type: Schema.Types.ObjectId,
      ref: "User",
      required: true,
    },
    createdBy: {
      type: Schema.Types.ObjectId,
      ref: "User",
      required: true,
    },
    amount: {
      type: Number,
      required: true,
    },
    transactionType: {
      type: String,
      required: true,
      trim: true,
      enum: ["DEPOSIT", "WITHDRAW"],
    },
    date: {
      type: Date,
      required: true,
    },
    remarks: {
      type: String,
      required: true,
    },
  },
  {
    timestamps: true,
  }
);

module.exports = mongoose.model("DepositWithdraw", depositWithdrawSchema);
