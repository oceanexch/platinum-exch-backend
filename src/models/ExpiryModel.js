const mongoose = require("mongoose");
const { nanoid } = require('nanoid');

const expirySchema = new mongoose.Schema(
  {
    marketId: { type: String, required: true },
    marketName: { type: String, required: true },
    scriptId: { type: String, required: true },
    scriptName: { type: String, required: true },
    tradeStartDate: { type: String, required: true },
    tradeEndDate: { type: String, required: true },
    expiryDate: { type: String, required: true },
    actualExpiry: { type: String },
    ip: { type: String },
    scriptExpiryId: {
      type: String,
      unique: true,
      default: () => nanoid(10)
    },
    createdBy: { type: mongoose.Schema.Types.ObjectId, ref: "User" },
  },
  { timestamps: true }
);

expirySchema.index({ marketId: 1, scriptId: 1, expiryDate: 1 }, { unique: true });
const expirySetting = mongoose.model("expiries", expirySchema);

module.exports = expirySetting;
