const express = require("express");
const router = express.Router();
const authenticateJWT = require("../middlewares/authenticateJWT");
const {
  getChatTargets,
  getChatThreads,
  getMessages,
  sendMessage,
  sendMediaMessage,
  markRead,
} = require("../controllers/ChatController");
const upload = require("../middlewares/chatUpload");

router.get("/targets", authenticateJWT, getChatTargets);
router.get("/threads", authenticateJWT, getChatThreads);
router.get("/messages/:partnerId", authenticateJWT, getMessages);
router.post("/send", authenticateJWT, sendMessage);
router.post("/send-media", authenticateJWT,upload.single("file"), sendMediaMessage);
router.post("/read", authenticateJWT, markRead);

module.exports = router;
