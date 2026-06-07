const mongoose = require("mongoose");
const Schema = mongoose.Schema;

const weekvalanSchema = new Schema(
  {
    keyidentifier: {
      type: String,
      required: true,
      unique: true,
    },
    label: {
      type: String,
      required: true,
    },
    startDate: {
      type: Date,
      required: true,
    },
    endDate: {
      type: Date,
      required: true,
    },
    status: {
      type: Boolean,
      default: true,
      required: true,
    },
    billStatus: {
      type: Boolean,
      default: false,
      required: true,
    },
    segment: {
      type: Array,
      required: true,
    },
  },
  {
    timestamps: true,
  }
);

const weekvalan = mongoose.model("weekvalan", weekvalanSchema);

module.exports = weekvalan;
