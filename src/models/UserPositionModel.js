const mongoose = require("mongoose");
const { Schema } = mongoose;

const roundToDecimalPlaces = (value, places = 4) => {
  return Math.round(value * Math.pow(10, places)) / Math.pow(10, places);
};

const userPositionSchema = new Schema(
  {
    userId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      required: true,
    },
    valanId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "weekvalan",
      required: true,
    },
    marketId: {
      type: String,
      required: true,
    },
    marketName: {
      type: String,
      required: true,
    },
    scriptId: {
      type: String,
      required: true,
    },
    scriptName: {
      type: String,
      required: true,
    },
    label: {
      type: String,
      required: true,
    },
    buyLot: {
      type: Number,
      required: true,
      min: 0,
      set: (value) => roundToDecimalPlaces(value, 4),
    },
    sellLot: {
      type: Number,
      required: true,
      min: 0,
      set: (value) => roundToDecimalPlaces(value, 4),
    },
    buyQuantity: {
      type: Number,
      required: true,
      min: 1,
    },
    sellQuantity: {
      type: Number,
      required: true,
      min: 1,
    },
    buyPrice: {
      type: Number,
      required: true,
      min: 0,
      set: (value) => roundToDecimalPlaces(value, 4),
    },
    sellPrice: {
      type: Number,
      required: true,
      min: 0,
      set: (value) => roundToDecimalPlaces(value, 4),
    },
    parentIds: [{ type: Schema.Types.ObjectId, ref: "User" }],
  },
  { timestamps: true }
);

// Key Indexes for Optimized Querying
userPositionSchema.index({ userId: 1, marketId: 1, valanId: 1 });
userPositionSchema.index({ userId: 1 });
userPositionSchema.index({ scriptId: 1 });
userPositionSchema.index({ valanId: 1 });

const UserPosition = mongoose.model("UserPosition", userPositionSchema);

module.exports = UserPosition;
