const mongoose = require("mongoose");

const scriptStalenessSchema = new mongoose.Schema(
    {
        scriptId: {
            type: String,
            required: true,
            unique: true,
        },
        scriptName: {
            type: String,
            required: true,
        },
        timeoutSeconds: {
            type: Number,
            required: true,
            default: 30,
        },
        isEnabled: {
            type: Boolean,
            default: true,
        },
        createdBy: {
            type: mongoose.Schema.Types.ObjectId,
            ref: "User",
        },
    },
    { timestamps: true }
);

module.exports = mongoose.model("ScriptFroze", scriptStalenessSchema);
