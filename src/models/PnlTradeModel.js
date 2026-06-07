const mongoose = require("mongoose");
const { Schema } = mongoose;

const pnlTradeSchema = new Schema(
  {
    userId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      required: true,
    },
    price: {
      type: Number,
      required: true,
    },
    profit_loss: {
      type: Number,
      required: true,
    },
    timestamp: {
      type: Date,
      default: Date.now,
    },
  },
  { timestamps: true }
);

// Indexes for performance
pnlTradeSchema.index({ userId: 1, timestamp: -1 });

const PnlTrade = mongoose.model("PnlTrade", pnlTradeSchema);

module.exports = PnlTrade;
