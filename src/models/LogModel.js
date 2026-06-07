const mongoose = require("mongoose");
const Schema = mongoose.Schema;

// Ledger Log
const ledgerLogSchema = new Schema(
  {
    userId: { type: mongoose.Schema.Types.ObjectId, ref: "User" },
    createdBy: { type: mongoose.Schema.Types.ObjectId, ref: "User" },
    old_amount: { type: Number },
    new_amount: { type: Number },
    old_remark: { type: String },
    new_remark: { type: String },
    logType: { type: String },
    ip: { type: String },
    edit_time: { type: Number },
    add_time: { type: Number },
  }
);

// Trade Log
const tradeLogSchema = new Schema(
  {
    action: { type: String },
    userId: { type: mongoose.Schema.Types.ObjectId, ref: "User" },
    parentIds: [{ type: Schema.Types.ObjectId, ref: "User" }],
    marketId: { type: String },
    scriptId: { type: String },
    symbol: { type: String },
    order_type: { type: String },
    txn_type: { type: String },
    lot: { type: Number },
    qty: { type: Number },
    order_price: { type: Number },
    message: { type: String },
    created_by: { type: String },
    ip: { type: String },
    time: { type: Number },
  }
);

// Rejection Log 
const rejectionLogSchema = new Schema(
  {
    action: { type: String },
    clientId: { type: mongoose.Schema.Types.ObjectId, ref: "User" },
    parentIds: [{ type: Schema.Types.ObjectId, ref: "User" }],
    marketId: { type: String },
    scriptId: { type: String },
    symbol: { type: String },
    order_type: { type: String },
    txn_type: { type: String },
    lot: { type: Number },
    qty: { type: Number },
    order_price: { type: Number },
    message: { type: String },
    ip: { type: String },
    time: { type: Number },
  }
);

// User Edit Log
const userEditLogSchema = new Schema(
  {
    clientId: { type: mongoose.Schema.Types.ObjectId, ref: "User" },
    parentIds: [{ type: Schema.Types.ObjectId, ref: "User" }],
    accountType: { type: Schema.Types.ObjectId, ref: "UserType" },
    basic: [{ type: Object }],
    brokerage: [{ type: Object }],
    market: [{ type: Object }],
    qty: [{ type: Object }],
    ip: { type: String },
    time: { type: Number },
    edit_by: { type: mongoose.Schema.Types.ObjectId, ref: "User" }
  }
);

// Login Log
const loginLogSchema = new Schema(
  {
    clientId: { type: mongoose.Schema.Types.ObjectId, ref: "User" },
    loginDevice: { type: String },
    deviceType: { type: String },
    version: { type: String },
    userAgent: { type: String },
    ip: { type: String },
    time: { type: Number },
  }
);

// Quantity Setting Log
const quantitySettingLogSchema = new Schema(
  {
    clientId: { type: mongoose.Schema.Types.ObjectId, ref: "User" },
    parentIds: [{ type: Schema.Types.ObjectId, ref: "User" }],
    marketId: { type: String },
    marketName: { type: String },
    scriptId: { type: String },
    scriptName: { type: String },
    qtySetting: { type: String },
    old_value: { type: Object },
    new_value: { type: Object },
    ip: { type: String },
    time: { type: Number },
    edit_by: { type: mongoose.Schema.Types.ObjectId, ref: "User" }
  }
);

// Define the main Log Schema
const logsSchema = new Schema(
  {
    type: {
      type: String,
      required: true,
      enum: ['trade', 'cashLedger', 'depositLedger', 'rejection', 'userEdit', 'login', 'quantitySetting']
    },
    tradeLog: tradeLogSchema,
    cashLedgerLog: ledgerLogSchema,
    depositLedgerLog: ledgerLogSchema,
    rejectionLog: rejectionLogSchema,
    userEditLog: userEditLogSchema,
    loginLog: loginLogSchema,
    quantitySettingLog: quantitySettingLogSchema,
  },
  { timestamps: true }
);


const Log = mongoose.model("Logs", logsSchema);
module.exports = Log;
