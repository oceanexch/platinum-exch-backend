const mongoose = require("mongoose");
const { Schema } = mongoose;

const brokerageRefreshSchema = new Schema(
  {
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
    marketId: {
      type: String,
      required: true,
    },
    marketName: {
      type: String,
      required: true,
      trim: true,
    },
    ip: {
      type: String,
      trim: true,
    },
    createdBy: {
      type: Schema.Types.ObjectId,
      ref: "User",
      required: true,
    },
  },
  {
    timestamps: true,
  }
);

brokerageRefreshSchema.index({ createdAt: 1 }, { expireAfterSeconds: 10368000 }); // 4 months

module.exports = mongoose.model("BrokerageRefresh", brokerageRefreshSchema);
