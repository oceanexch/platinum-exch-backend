const mongoose = require("mongoose");
const { Schema } = mongoose;

/* =========================
   🔧 HELPERS
========================= */

// Round numbers
const roundToDecimalPlaces = (value, places = 4) => {
  if (value == null) return value;
  return Number(parseFloat(value).toFixed(places));
};

// Conditional validator
const conditionalMinZeroValidator = (fieldName) => ({
  validator: function (value) {
    if (value == null) return true;

    // ✅ Allow negative only for marketId = "3"
    if (this.marketId === "3") return true;

    // ❌ Otherwise enforce >= 0
    return value >= 0;
  },
  message: () => `${fieldName} must be >= 0 for marketId other than 3`,
});

// Reusable number field with conditional validation
const numberField = (fieldName, required = true) => ({
  type: Number,
  required,
  set: (value) => roundToDecimalPlaces(value, 4),
  validate: conditionalMinZeroValidator(fieldName),
});

// Simple number field (no validation)
const simpleNumberField = (required = true) => ({
  type: Number,
  required,
  set: (value) => roundToDecimalPlaces(value, 4),
});

/* =========================
   📦 SCHEMA
========================= */

const stockTransactionSchema = new Schema(
  {
    userId: {
      type: Schema.Types.ObjectId,
      ref: "User",
      required: true,
    },

    valanId: {
      type: Schema.Types.ObjectId,
      ref: "weekvalan",
      required: true,
    },

    marketId: {
      type: String,
      required: true,
    },

    marketName: {
      type: String,
      required: true,
    },

    scriptId: {
      type: String,
      required: true,
    },

    scriptName: {
      type: String,
      required: true,
    },

    label: {
      type: String,
      required: true,
    },

    expiry: {
      type: String,
      required: true,
    },

    lot: {
      ...simpleNumberField(),
      min: 0,
    },

    quantityType: {
      intraday: {
        type: Number,
        required: true,
        min: 0,
      },
      delivery: {
        type: Number,
        required: true,
        min: 0,
      },
    },

    quantity: {
      type: Number,
      required: true,
      min: 1,
    },

    /* =========================
       💰 PRICE / BROKERAGE (CONDITIONAL)
    ========================= */

    orderPrice: numberField("orderPrice"),
    totalOrderPrice: numberField("totalOrderPrice"),
    orderBrokerage: numberField("orderBrokerage"),
    netBrokerage: numberField("netBrokerage"),
    brokerTotalBrokerage: numberField("brokerTotalBrokerage"),

    brokeragePercentageType: {
      intraday: numberField("brokeragePercentageType.intraday"),
      delivery: numberField("brokeragePercentageType.delivery"),
    },

    brokeragePercentage: numberField("brokeragePercentage"),
    brokerTotalPercentage: numberField("brokerTotalPercentage"),

    /* =========================
       📉 P&L (ALWAYS ALLOW NEGATIVE)
    ========================= */

    netPrice: simpleNumberField(),
    totalNetPrice: simpleNumberField(),
    m2mPrice: simpleNumberField(),

    deletedPrice: {
      ...simpleNumberField(false),
    },

    /* =========================
       🧾 OTHER
    ========================= */

    otherBrokerage: {
      type: Schema.Types.Mixed,
      required: true,
    },

    type: {
      type: String,
      enum: ["NRM", "CF", "BF", "AUTO_SQ", "FW"],
      required: true,
    },

    transactionType: {
      type: String,
      enum: ["BUY", "SELL"],
      required: true,
    },

    transactionStatus: {
      type: String,
      enum: ["PENDING", "COMPLETED", "REJECTED", "DELETED"],
      required: true,
    },

    orderType: {
      type: String,
      enum: [
        "Market",
        "Limit",
        "MARKET",
        "LIMIT",
        "Exit Position (Market)",
        "Manual",
        "M2M Loss",
      ],
      required: true,
    },

    tradePosition: {
      type: String,
      enum: ["UP", "DOWN", "NRM"],
      default: "NRM",
    },

    ip: {
      type: String,
      default: "",
    },

    userAgent: {
      type: String,
      default: "",
    },

    message: {
      type: String,
      required: true,
    },

    shortmsg: {
      type: String,
      default: "",
    },

    isExitPosition: {
      type: Boolean,
      default: false,
    },

    parentIds: [{ type: Schema.Types.ObjectId, ref: "User" }],
    myParent: { type: Schema.Types.ObjectId, ref: "User" },
    brokerIds: [{ type: Schema.Types.ObjectId, ref: "User" }],

    partnership: [{ type: Number, default: 0 }],
    minPercentageWiseBrokerage: [{ type: Number, default: 0 }],
    minLotWiseBrokerage: [{ type: Number, default: 0 }],

    isEdited: {
      type: Boolean,
      default: false,
    },

    createdBy: { type: Schema.Types.ObjectId, ref: "User" },
    deletedBy: { type: Schema.Types.ObjectId, ref: "User" },

    prevStatus: {
      type: String,
      enum: ["PENDING", "COMPLETED", "REJECTED", "DELETED"],
    },

    brockersBrokerage: [
      {
        brokerId: { type: Schema.Types.ObjectId, ref: "User" },
        rate: { type: Number },
      },
    ],

    /* =========================
       📦 DELIVERY COMMISSION DETAILS (NSE-EQ)
    ========================= */
    delDetails: {
      delApplied: {
        type: Boolean,
        default: false,
      },
      appliedQty: {
        type: Number,
        default: 0,
      },
      delBrokerage: {
        type: Number,
        default: 0,
      },
      delBrokerBrokerage: [
        {
          brokerId: { type: Schema.Types.ObjectId, ref: "User" },
          amount: { type: Number, default: 0 },
        },
      ],
      appliedAt: {
        type: Date,
        default: null,
      },
    },
  },
  { timestamps: true }
);

/* =========================
   ⚡ INDEXES (IMPORTANT)
========================= */

stockTransactionSchema.index({
  userId: 1,
  scriptId: 1,
  valanId: 1,
  transactionStatus: 1,
});

stockTransactionSchema.index({
  parentIds: 1,
  valanId: 1,
  transactionStatus: 1,
});

stockTransactionSchema.index({
  marketId: 1,
  transactionStatus: 1,
});

stockTransactionSchema.index({ createdAt: -1 });

/* =========================
   🚀 MODEL
========================= */

module.exports = mongoose.model(
  "StockTransaction",
  stockTransactionSchema
);