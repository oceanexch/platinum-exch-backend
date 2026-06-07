const multer = require("multer");
const path = require('path');
const fs = require('fs');

// Ensure the temp chunks directory exists
const chunksDir = path.join(__dirname, "..", "..", "uploads", "chunks");
if (!fs.existsSync(chunksDir)) {
  fs.mkdirSync(chunksDir, { recursive: true });
}

const storage = multer.diskStorage({
  destination: chunksDir,
  filename: (req, file, cb) => {
    // At this point, req.body might not be fully parsed yet
    // We'll rename the file after upload in the controller
    const tempName = `temp-${Date.now()}-${Math.random().toString(36).substring(7)}`;
    cb(null, tempName);
  }
});

const upload = multer({
  storage,
  limits: { fileSize: 10 * 1024 * 1024 }, // 10MB per chunk
});

module.exports = upload;
