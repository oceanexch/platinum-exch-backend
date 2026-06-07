const mongoose = require('mongoose');
const Schema = mongoose.Schema;

// UserType Schema (for roles or types of users with page-based permissions)
const userTypeSchema = new Schema({
    label: {
        type: String,
        required: true,
        unique: true,
        trim: true,
        minlength: 3,
    },
    name: {
        type: String,
        required: true,
        unique: true,
        trim: true,
        minlength: 3,
    },
    description: {
        type: String,
        required: true,
        minlength: 10,
    },
    level: {
        type: Number,
        required: true,
        min: 1, // Ensures that roles with higher priority have lower level numbers (e.g., admin = level 1)
        default: 5,
    },
    permissions: [{
        type: Schema.Types.ObjectId,
        ref: 'Permission',  // Reference to the Permission model
        //required: true,
    }],
    isActive: {
        type: Boolean,
        default: true,
    },
}, {
    timestamps: true,
});

// Create a model for UserType
const UserType = mongoose.model('UserType', userTypeSchema);

module.exports = UserType;
