const mongoose = require("mongoose");

const alertSettingSchema = new mongoose.Schema(
  {
    userId: { type: mongoose.Schema.Types.ObjectId, required: true, ref: "User" },
    tradeSound: { type: Boolean, default: false, },
    autoSquareOffAlert: { type: Boolean, default: false },
    autoSquareOffAlertSound: { type: Boolean, default: false },
    tradeClearAlert: { type: Boolean, default: false }
  },
  { timestamps: true }
);

// Create model from the schema
const alertSetting = mongoose.model("AlertSetting", alertSettingSchema);

module.exports = alertSetting;
