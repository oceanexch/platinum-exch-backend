const mongoose = require("mongoose");
const { Schema } = mongoose;

const ledgerSchema = new Schema(
  {
    parentIds: [
      {
        type: Schema.Types.ObjectId,
        ref: "User",
      },
    ],
    brokerIds: [
      {
        type: Schema.Types.ObjectId,
        ref: "User",
      },
    ],
    label: {
      type: String,
      required: true,
    },
    valanId: {
      type: Schema.Types.ObjectId,
      ref: "weekvalan",
      required: true,
    },
    valanName: {
      type: String,
      required: true,
    },
    userId: {
      type: Schema.Types.ObjectId,
      ref: "User",
      required: true,
    },
    scriptId: {
      type: String,
      required: true,
      trim: true,
    },
    scriptName: {
      type: String,
      required: true,
      trim: true,
    },
    marketId: {
      type: String,
      required: true,
    },
    marketName: {
      type: String,
      required: true,
      trim: true,
    },
    amount: {
      type: Number,
      required: true,
    },
    uplineAmount: {
      type: Number,
      required: true,
    },
    downlineAmount: {
      type: Number,
      required: true,
    },
    transactionType: {
      type: String,
      required: true,
      trim: true,
      enum: ["BILL"],
    },
    level: {
      type: Number,
      required: true,
    },
    otherBrokerShare: {
      type: Schema.Types.Mixed,
      required: true,
    },
  },
  {
    timestamps: true,
  }
);

module.exports = mongoose.model("Ledger", ledgerSchema);
