'use strict';
const mongoose = require('mongoose');
const Schema = mongoose.Schema;

/**
 * UserMonitor — tracks which users are under surveillance.
 *
 * When a watcher (addedBy) performs an action that triggers a monitored
 * user event, the MonitorService looks up this table and sends a Telegram
 * alert to the watcher's telegramChatId.
 */
const UserMonitorSchema = new Schema(
  {
    /** The user being watched */
    monitoredUserId: {
      type: Schema.Types.ObjectId,
      ref: 'User',
      required: true,
      index: true
    },

    /** Who added this user to the watch list (level 1–5 only) */
    addedBy: {
      type: Schema.Types.ObjectId,
      ref: 'User',
      required: true
    },

    /** Whether this monitoring entry is still active */
    isActive: {
      type: Boolean,
      default: true,
      index: true
    }
  },
  { timestamps: true }
);

// Compound index for fast lookup: "who is watching userId?"
UserMonitorSchema.index({ monitoredUserId: 1, isActive: 1 });

// Prevent duplicate watch entries for the same (watcher, target) pair
UserMonitorSchema.index({ monitoredUserId: 1, addedBy: 1 }, { unique: true });

module.exports = mongoose.model('UserMonitor', UserMonitorSchema);
