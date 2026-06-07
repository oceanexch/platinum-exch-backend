const mongoose = require("mongoose");

const pageHistorySchema = new mongoose.Schema({
    userId: {
        type: mongoose.Schema.Types.ObjectId,
        required: true,
        index: true,
        ref: "User"
    },

    page: {
        type: String,
        required: true
    },

    time: {
        type: Date,
        default: Date.now
    },

    ip: String
});

pageHistorySchema.index(
    { time: 1 },
    { expireAfterSeconds: 86400 } // TTL: 24 hours
);

module.exports = mongoose.model("PageHistory", pageHistorySchema);
