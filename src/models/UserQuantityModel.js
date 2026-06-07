const mongoose = require("mongoose");
const { Schema } = mongoose;

const userQtySchema = new Schema(
  {
    userId: {
      type: Schema.Types.ObjectId,
      ref: "User",
      required: true,
    },
    scriptId: {
      type: String,
      required: true,
      trim: true,
    },
    scriptName: {
      type: String,
      required: true,
      trim: true,
    },
    marketId: {
      type: String,
      required: true,
    },
    marketName: {
      type: String,
      required: true,
      trim: true,
    },
    previous: {
      date: {
        type: Date,
        required: true,
      },
      buyQty: {
        type: Number,
        required: true,
      },
      sellQty: {
        type: Number,
        required: true,
      },
      isSettled: {
        type: Boolean,
        required: true,
      },
      currentBuyQty: {
        type: Number,
        required: true,
      },
      currentSellQty: {
        type: Number,
        required: true,
      },
    },
    current: {
      date: {
        type: Date,
        required: true,
      },
      buyQty: {
        type: Number,
        required: true,
      },
      sellQty: {
        type: Number,
        required: true,
      },
    },
  },
  {
    timestamps: true,
  }
);

module.exports = mongoose.model("UserQuantity", userQtySchema);
