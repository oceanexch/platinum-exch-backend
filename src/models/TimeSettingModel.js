const mongoose = require("mongoose");

const timeSettingSchema = new mongoose.Schema(
  {
    marketId: { type: String, required: true },
    marketName: { type: String, required: true },
    scriptName: { type: String, default: 'All' },
    marketStartTime: { type: String, required: true },
    marketEndTime: { type: String, required: true },
    tradeStartTime: { type: String, required: true },
    tradeEndTime: { type: String, required: true },
    createdBy: { type: mongoose.Schema.Types.ObjectId, required: true, ref: "User" },
  },
  { timestamps: true }
);

// Create model from the schema
const timeSetting = mongoose.model("TimeSetting", timeSettingSchema);

module.exports = timeSetting;
