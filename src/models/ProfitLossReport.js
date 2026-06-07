const mongoose = require("mongoose");
const { Schema } = mongoose;

const profitLossSchema = new Schema(
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
    partnership: [
      {
        type: Number,
        required: true,
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
    bill: {
      type: Number,
      required: true,
    },
    m2m: {
      type: Number,
      required: true,
    },
    gross: {
      type: Number,
      required: true,
    },
    brokerage: {
      type: Number,
      required: true,
    },
    brokerBrokerage: {
      type: Number,
      required: true,
    },
    uplineBrokerage: [
      {
        type: Number,
      },
    ],
    uplineM2M: [
      {
        type: Number,
      },
    ],
    otherBrokerShare: {
      type: Schema.Types.Mixed,
    }
  },
  {
    timestamps: true,
  }
);

module.exports = mongoose.model("ProfitLossReport", profitLossSchema);
