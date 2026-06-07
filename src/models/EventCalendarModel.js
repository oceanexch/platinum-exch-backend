const mongoose = require("mongoose");
const { Schema } = mongoose;

const eventCalendarSchema = new Schema(
  {
    symbol: { type: String, required: true, uppercase: true, trim: true },
    companyName: { type: String, default: "" },
    purpose: { type: String, default: "" },
    details: { type: String, default: "" },
    eventDate: { type: Date, required: true },
  },
  { timestamps: true }
);

eventCalendarSchema.index({ symbol: 1, eventDate: 1 });
eventCalendarSchema.index({ eventDate: 1 });

module.exports = mongoose.model("EventCalendar", eventCalendarSchema);
