const multer = require("multer");
const path = require('path');
const fs = require('fs');

// Ensure the apk directory exists
const apkDir = path.join(__dirname, "..", "..", "uploads", "apk");
if (!fs.existsSync(apkDir)) {
  fs.mkdirSync(apkDir, { recursive: true });
}

const storage = multer.diskStorage({
  destination: apkDir,
  filename: (req, file, cb) => {
    // Generate filename: version-timestamp.apk
    const version = req.body.version || 'unknown';
    const timestamp = Date.now();
    const sanitizedVersion = version.replace(/\./g, '_');
    cb(null, `app-v${sanitizedVersion}-${timestamp}.apk`);
  }
});

const upload = multer({
  storage,
  limits: { fileSize: 200 * 1024 * 1024 }, // 200MB limit for APK files
  fileFilter(req, file, cb) {
    const ext = path.extname(file.originalname).toLowerCase();
    const allowedExts = [".apk"];
    
    if (!allowedExts.includes(ext)) {
      return cb(new Error("Only APK files are allowed"));
    }
    
    cb(null, true);
  }
});

module.exports = upload;
