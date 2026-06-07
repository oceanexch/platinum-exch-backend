const mongoose = require('mongoose');
const Schema = mongoose.Schema;

// Permission Schema
const permissionSchema = new Schema({
    page: {
        type: String,
        required: true,
        trim: true,
    },
    actions: {
        type: [String],
        enum: ['read', 'write', 'delete', 'update'], // Actions that can be performed on the page
        default: ['read'], // Default actions
        required: true,
    },
}, {
    timestamps: true,
});

const Permission = mongoose.model('Permission', permissionSchema);

module.exports = Permission;