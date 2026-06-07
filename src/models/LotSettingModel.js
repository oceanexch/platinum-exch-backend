const mongoose = require("mongoose");

const lotSettingSchema = new mongoose.Schema(
  {
    marketId: { type: String, required: true },
    marketName: { type: String, required: true },
    scriptName: { type: String, required: true },
    quantity: { type: Number, required: true },
    createdBy: { type: mongoose.Schema.Types.ObjectId, required: true, ref: "User" },
  },
  { timestamps: true }
);

lotSettingSchema.index({ marketId: 1, scriptName: 1 }, { unique: true });

// Create model from the schema
const lotSetting = mongoose.model("LotSetting", lotSettingSchema);

module.exports = lotSetting;
