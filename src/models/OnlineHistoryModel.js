const mongoose = require("mongoose");

const onineHistorySchema = new mongoose.Schema(
  {
    userId: { type: mongoose.Schema.Types.ObjectId, required: true, ref: "User" },
    type: { type: String, required: true, enum: ['online', 'offline'] },
    time: { type: Date, index: true, expires: 86400 },
    ip: { type: String }
  }
);

module.exports = mongoose.model("OnlineHistory", onineHistorySchema);
