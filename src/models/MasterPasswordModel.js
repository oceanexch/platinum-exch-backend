const mongoose = require('mongoose');
const Schema = mongoose.Schema;

const MasterPasswordSchema = new Schema(
  {
    userId: {
      type: Schema.Types.ObjectId,
      ref: 'User',
      required: true,
      unique: true
    },
    password: {
      type: String,
      required: true
    }
  },
  { timestamps: true }
);

module.exports = mongoose.model('MasterPassword', MasterPasswordSchema);
