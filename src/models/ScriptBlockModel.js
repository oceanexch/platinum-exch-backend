const mongoose = require("mongoose");

const scriptBlockSchema = new mongoose.Schema(
  {
    clientId: { type: mongoose.Schema.Types.ObjectId, required: true, ref: "User" },
    marketId: { type: mongoose.Schema.Types.ObjectId, required: true, ref: "MarketType" },
    scriptId: { type: mongoose.Schema.Types.ObjectId, required: true, ref: "Script" },
    blockedBy: { type: mongoose.Schema.Types.ObjectId, required: true, ref: "User" }
  },
  { timestamps: true }
);

// Create model from the schema
const scriptBlock = mongoose.model("ScriptBlock", scriptBlockSchema);

module.exports = scriptBlock;
