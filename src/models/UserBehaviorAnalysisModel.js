const mongoose = require("mongoose");
const { Schema } = mongoose;

const behaviorSchema = new Schema(
  {
    type: { type: String, required: true },
    label: { type: String, required: true },
    tradeCount: { type: Number, default: 0 },
    successRate: { type: Number, default: 0 },
    profitAmount: { type: Number, default: 0 },
    lossAmount: { type: Number, default: 0 },
    netPnl: { type: Number, default: 0 },
    confidence: { type: Number, default: 0 },
  },
  { _id: false }
);

const userBehaviorAnalysisSchema = new Schema(
  {
    userId: { type: Schema.Types.ObjectId, ref: "User", required: true },
    valanId: { type: Schema.Types.ObjectId, ref: "weekvalan", default: null },
    periodStart: { type: Date, required: true },
    periodEnd: { type: Date, required: true },
    computedAt: { type: Date, default: Date.now },
    behaviors: { type: [behaviorSchema], default: [] },
    totalTrades: { type: Number, default: 0 },
    totalProfit: { type: Number, default: 0 },
    totalLoss: { type: Number, default: 0 },
  },
  { timestamps: true }
);

userBehaviorAnalysisSchema.index({ userId: 1, valanId: 1 }, { unique: true });
userBehaviorAnalysisSchema.index({ valanId: 1 });
userBehaviorAnalysisSchema.index({ userId: 1, periodStart: -1 });

module.exports = mongoose.model("UserBehaviorAnalysis", userBehaviorAnalysisSchema);
