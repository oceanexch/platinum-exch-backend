const mongoose = require('mongoose');
const Schema = mongoose.Schema;

/**
 * AppVersion Schema
 * Stores mobile application version information and download links
 */
const AppVersionSchema = new Schema(
  {
    version: {
      type: String,
      required: true,
      trim: true,
      unique: true,
      validate: {
        validator: function(v) {
          // Validates semantic versioning format (e.g., 1.0.0, 2.1.3)
          return /^\d+\.\d+\.\d+$/.test(v);
        },
        message: props => `${props.value} is not a valid version format! Use semantic versioning (e.g., 1.0.0)`
      }
    },
    fileName: {
      type: String,
      required: true,
      trim: true
    },
    platform: {
      type: String,
      enum: ['android', 'ios', 'both'],
      default: 'both',
      lowercase: true,
      required: true
    },
    isActive: {
      type: Boolean,
      default: true
    },
    isMandatory: {
      type: Boolean,
      default: false
    },
    releaseNotes: {
      type: String,
      default: '',
      trim: true
    },
    minSupportedVersion: {
      type: String,
      trim: true,
      validate: {
        validator: function(v) {
          if (!v) return true; // Optional field
          return /^\d+\.\d+\.\d+$/.test(v);
        },
        message: props => `${props.value} is not a valid version format!`
      }
    },
    fileSize: {
      type: String,
      trim: true
    },
    buildNumber: {
      type: Number
    },
    createdBy: {
      type: Schema.Types.ObjectId,
      ref: 'User',
      required: true
    },
    updatedBy: {
      type: Schema.Types.ObjectId,
      ref: 'User'
    },
    ip: {
      type: String
    },
    parentIds: [
      {
        type: Schema.Types.ObjectId,
        ref: 'User'
      }
    ]
  },
  {
    timestamps: true
  }
);

// Indexes for faster queries
AppVersionSchema.index({ version: 1, platform: 1 });
AppVersionSchema.index({ isActive: 1, platform: 1 });
AppVersionSchema.index({ createdAt: -1 });
AppVersionSchema.index({ createdBy: 1 });

const AppVersionModel = mongoose.model('AppVersion', AppVersionSchema);

module.exports = AppVersionModel;
