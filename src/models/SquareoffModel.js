const mongoose = require("mongoose");
const { Schema } = mongoose;

const squareoffSchema = new Schema(
  {
    label: {
      type: String,
      required: true,
    },
    valanId: {
      type: Schema.Types.ObjectId,
      ref: "weekvalan",
      required: true,
    },
    userId: {
      type: Schema.Types.ObjectId,
      ref: "User",
      required: true,
    },
    positionId: {
      type: Schema.Types.ObjectId,
      ref: "UserPosition",
      required: false, // Optional for ALERT types that might not be script-specific
    },
    alertPercent: {
      type: Number,
      required: true,
      default: 0
    },
    m2m: {
      type: Number,
      required: true,
    },
    ledgerAmount: {
      type: Number,
      required: true,
    },
    type: {
      type: String,
      required: true,
      enum: ["LOSS", "ALERT", "PROFIT"],
    },
    maxLoss: {
      type: Number,
      required: true,
      default: 0
    },
    squaredOff: {
      type: Boolean,
      default: false,
    },
    parentIds: [{ type: Schema.Types.ObjectId, ref: "User" }],
  },
  {
    timestamps: true,
  }
);

module.exports = mongoose.model("Squareoff", squareoffSchema);
