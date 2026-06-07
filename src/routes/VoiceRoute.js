const express = require('express');
const router = express.Router();
const authenticateJWT = require('../middlewares/authenticateJWT');
const { saveRecording, getLearnedContext, updateLearnedContext, getRecordings } = require('../controllers/VoiceController');

/**
 * Endpoints for Voice Assistant Auto-Learning
 */
router.get('/context', authenticateJWT, getLearnedContext);
router.post('/learn', authenticateJWT, updateLearnedContext);

/**
 * Endpoint for voice recording upload and listing
 */
router.post('/record', authenticateJWT, saveRecording);
router.get('/recordings', authenticateJWT, getRecordings);

module.exports = router;
