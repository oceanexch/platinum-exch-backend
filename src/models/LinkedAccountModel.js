// const mongoose = require("mongoose");
// const Schema = mongoose.Schema;

// const LinkedAccountSchema = new Schema(
//   {
//     groupId: {
//       type: Schema.Types.ObjectId,
//       required: true,
//       index: true,
//     },
//     userId: {
//       type: Schema.Types.ObjectId,
//       ref: "User",
//       required: true,
//       index: true,
//     },
//   },
//   { timestamps: true }
// );

// // One user per group
// LinkedAccountSchema.index({ groupId: 1, userId: 1 }, { unique: true });

// module.exports = mongoose.model("LinkedAccount", LinkedAccountSchema);
const mongoose = require('mongoose');
const Schema = mongoose.Schema;

const LinkedAccountSchema = new Schema(
  {
    groupId: {
      type: Schema.Types.ObjectId,
      index: true,
      // Making it optional for backward compatibility or future removal
      required: false
    },
    parentId: {
      type: Schema.Types.ObjectId,
      ref: 'User',
      required: true,
      index: true
    },
    userId: {
      type: Schema.Types.ObjectId,
      ref: 'User',
      required: true,
      index: true
    },
    ipAddress: {
      type: String,
      default: ""
    }
  },
  { timestamps: true }
);

// Unique link: A parent can link a specific child only once
LinkedAccountSchema.index({ parentId: 1, userId: 1 }, { unique: true });

module.exports = mongoose.model('LinkedAccount', LinkedAccountSchema);
