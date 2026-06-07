const mongoose = require("mongoose");

const holidaySchema = new mongoose.Schema(
  {
    marketId: { type: String, required: true },
    marketName: { type: String, required: true },
    holiday: { type: String, required: true },
    session1: { type: Boolean, default: false, },
    session2: { type: Boolean, default: false },
    startDate: { type: Number, required: true },
    endDate: { type: Number, required: true },
    ip: { type: String },
    date: { type: String },
    createdBy: { type: mongoose.Schema.Types.ObjectId, required: true, ref: "User" },
  },
  { timestamps: true }
);

// Create model from the schema
const holidaySetting = mongoose.model("Holiday", holidaySchema);

module.exports = holidaySetting;
