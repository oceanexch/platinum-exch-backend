const express = require('express');
const router = express.Router();
const {
  createVersion,
  getAllVersions,
  getVersionById,
  getLatest,
  checkUpdate,
  updateVersion,
  deleteVersion,
  downloadApk
} = require('../controllers/AppVersionController');
const {
  uploadChunk
} = require('../controllers/ChunkUploadController');
const authenticateJWT = require('../middlewares/authenticateJWT');
const apkUpload = require('../middlewares/apkUpload');
const chunkUpload = require('../middlewares/chunkUpload');

// Public routes (no authentication required)
router.get('/latest', getLatest);
router.get('/check-update', checkUpdate);
router.get('/download/:id', downloadApk);

// Chunked upload route (authentication required)
router.post('/upload', authenticateJWT, chunkUpload.single('apkFile'), uploadChunk);

// Protected routes (authentication required)
router.post('/', authenticateJWT, createVersion);
router.get('/', authenticateJWT, getAllVersions);
router.get('/:id', authenticateJWT, getVersionById);
router.put('/:id', authenticateJWT, updateVersion);
router.delete('/:id', authenticateJWT, deleteVersion);

module.exports = router;
