const mongoose = require("mongoose");

const notificationSchema = new mongoose.Schema(
  {
    type: { type: String, enum: ["Notification", "Headline"], required: true },
    userType: { type: String, enum: ["User Wise", "User Type Wise", ""] },
    selectedUser: { type: String },
    selectedUserType: { type: mongoose.Schema.Types.ObjectId, ref: "UserType" },
    startDate: { type: Number, required: true },
    endDate: { type: Number, required: true },
    title: { type: String },
    message: { type: String, required: true },
    ip: { type: String },
    createdBy: { type: mongoose.Schema.Types.ObjectId, ref: "User" },
    isParentShow: { type: Boolean, default: false },
    readBy: [{ type: mongoose.Schema.Types.ObjectId, ref: "User" }],
    parentIds: [{ type: mongoose.Schema.Types.ObjectId, ref: "User" }]
  },
  { timestamps: true }
);

// Create model from the schema
const notificationSetting = mongoose.model("Notification", notificationSchema);

module.exports = notificationSetting;
  