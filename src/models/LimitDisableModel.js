const mongoose = require("mongoose");

const limitDisableSchema = new mongoose.Schema(
  {
    marketId: { type: String, required: true },
    marketName: { type: String, required: true },
    date: { type: String, required: true },
    onlySquareOff: { type: String, required: true },
    ip: { type: String },
    createdBy: { type: mongoose.Schema.Types.ObjectId, required: true, ref: "User" },
  },
  { timestamps: true }
);

// Create model from the schema
const limitDisableSetting = mongoose.model("LimitDisable", limitDisableSchema);

module.exports = limitDisableSetting;
