const multer = require("multer");
const path = require('path')
const storage = multer.diskStorage({
  destination: path.join(__dirname, "..", "..", "uploads", "tmp"),
  filename: (req, file, cb) =>
    cb(null, Date.now() + "-" + file.originalname)
});

const upload = multer({
  storage,
  limits: { fileSize: 50 * 1024 * 1024 },
  fileFilter(req, file, cb) {
    const ext = path.extname(file.originalname).toLowerCase();

    const allowedExts = [
      ".jpg", ".jpeg", ".png", ".gif", ".webp",
      ".mp4", ".mov", ".avi", ".mkv",
      ".pdf",
      ".xls", ".xlsx"
    ];

    const allowedMimeTypes = [
      "application/pdf",
      "application/vnd.ms-excel",
      "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
    ];

    if (
      file.mimetype.startsWith("image/") ||
      file.mimetype.startsWith("video/") ||
      allowedMimeTypes.includes(file.mimetype)
    ) {
      if (!allowedExts.includes(ext)) {
        return cb(new Error("Invalid file extension"));
      }
      cb(null, true);
    } else {
      cb(new Error("Only image, video, PDF, or Excel files are allowed"));
    }
  }
  // fileFilter(req, file, cb) {
  //   const ext = path.extname(file.originalname).toLowerCase();
  //   if (!allowedExts.includes(ext)) {
  //     return cb(new Error("Invalid file extension"));
  //   }
  //   if (file.mimetype.startsWith("image/") || file.mimetype.startsWith("video/") || allowedMimeTypes.includes(file.mimetype))
  //     cb(null, true);
  //   else cb(new Error("Only image/video allowed"));
  // }
});

module.exports = upload;
