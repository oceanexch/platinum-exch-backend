const mongoose = require("mongoose");

const quantitySettingSchema = new mongoose.Schema(
  {
    clientId: { type: mongoose.Schema.Types.ObjectId, ref: "User", required: true },
    marketId: { type: String, required: true, ref: "Market" },
    marketName: { type: String, required: true },
    scriptId: { type: String, required: true, ref: "Script" },
    scriptName: { type: String, required: true },
    qtySetting: { type: String, enum: ["Qty", "Lot", "Value"], required: true },
    perStrikePosition: { type: Number, default: 0 },
    isRange: { type: Boolean, default: false },
    startRange: { type: Number, default: 0 },
    endRange: { type: Number, default: 0 },
    minOrder: { type: Number, default: 0 },
    maxOrder: { type: Number, default: 0 },
    maxAmount: { type: Number, default: 0 },
    positionLimit: { type: Number, default: 0 },
    buySellVariation: { type: Number, default: 0 },
    variationStartTime: { type: String, default: "" },
    variationEndTime: { type: String, default: "" },
    createdBy: { type: mongoose.Schema.Types.ObjectId, required: true, ref: "User" },
  },
  { timestamps: true }
);

// Create model from the schema
const quantitySetting = mongoose.model("QuantitySetting", quantitySettingSchema);

module.exports = quantitySetting;
