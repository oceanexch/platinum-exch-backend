const mongoose = require('mongoose');

const VoiceContextSchema = new mongoose.Schema({
  userId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, unique: true },
  
  // Track how many times each script has been successfully traded
  scriptFrequency: { type: Map, of: Number, default: {} },
  
  // Track how many times each client has been successfully targeted (for admins)
  clientFrequency: { type: Map, of: Number, default: {} },
  
  // Learned phonetic synonyms (e.g., 'vipro' -> 'wipro')
  synonymMap: { type: Map, of: String, default: {} },
  
  // Cache for last searched/viewed script context
  lastSearchedScript: { type: mongoose.Schema.Types.Mixed, default: null },
  
  updatedAt: { type: Date, default: Date.now }
});

module.exports = mongoose.model('VoiceContext', VoiceContextSchema);
