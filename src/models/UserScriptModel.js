const mongoose = require("mongoose");

const userScriptSchema = new mongoose.Schema(
  {
    marketId: {
      type: String,
      required: true,
      ref: "Market",
    },
    marketName: {
      type: String,
      required: true,
    },
    scriptId: {
      type: String,
      required: true,
      ref: "Script",
    },
    scriptName: {
      type: String,
      required: true,
    },

    symbol: {
      type: String,
    },
    label: {
      type: String,
      required: true,
    },
    expiryId: {
      type: String,
      required: true,
    },
    expiryDate: {
      type: String,
      required: true,
    },
    keyIdentifier: {
      type: String,
      required: true,
    },
    strike: {
      type: Number,
      default: 0,
    },
    cepe: {
      type: String,
      default: "",
    },
    createdBy: {
      type: mongoose.Schema.Types.ObjectId,
      required: true,
      ref: "User",
    },
  },
  { timestamps: true }
);

// Indexes for faster queries
userScriptSchema.index({ createdBy: 1 });
userScriptSchema.index({ marketId: 1 });
userScriptSchema.index({ createdBy: 1, keyIdentifier: 1 }, { unique: true });
userScriptSchema.index({ createdBy: 1, scriptId: 1, label: 1 });
userScriptSchema.index({ createdBy: 1, marketId: 1 });
userScriptSchema.index({ label: 1 });

// Create model from the schema
const UserScript = mongoose.model("UserScript", userScriptSchema);

module.exports = UserScript;
