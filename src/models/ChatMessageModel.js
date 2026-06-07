const mongoose = require("mongoose");
const Schema = mongoose.Schema;

// const ChatMessageSchema = new Schema(
//   {
//     conversationId: { type: String, required: true, index: true },
//     from: { type: Schema.Types.ObjectId, ref: "User", required: true, index: true },
//     to: { type: Schema.Types.ObjectId, ref: "User", required: true, index: true },
//     body: { type: String, required: true, trim: true },
//     readAt: { type: Date, default: null },
//   },
//   { timestamps: true }
// );
const ChatMessageSchema = new Schema(
  {
    conversationId: { type: String, required: true, index: true },
    from: { type: Schema.Types.ObjectId, ref: "User", required: true, index: true },
    to: { type: Schema.Types.ObjectId, ref: "User", required: true, index: true },

    type: {
      type: String,
      enum: ["text", "image", "video", "pdf", "excel"],
      default: "text"
    },

    body: { type: String, trim: true },

    media: {
      url: String,
      fileName: String,
      mimeType: String,
      size: Number,
      width: Number,
      height: Number,
      duration: Number
    },

    tempId: { type: String, index: true },   // ✅ ADD THIS LINE

    readAt: { type: Date, default: null },
  },
  { timestamps: true }
);


ChatMessageSchema.index({ conversationId: 1, createdAt: -1 });
ChatMessageSchema.index({ to: 1, readAt: 1 });

const ChatMessage = mongoose.model("ChatMessage", ChatMessageSchema);
module.exports = ChatMessage;
