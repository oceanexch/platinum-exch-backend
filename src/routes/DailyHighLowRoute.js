const express = require('express');
const router = express.Router();
const DailyHighLowController = require('../controllers/DailyHighLowController');
const authenticateJWT = require('../middlewares/authenticateJWT');

// Get today's high/low for a specific script
router.get('/today/:scriptId', authenticateJWT, DailyHighLowController.getTodayHighLow);

// Get historical high/low for a specific script
router.get('/historical/:scriptId', authenticateJWT, DailyHighLowController.getHistoricalHighLow);

// Get daily high/low records with filters and pagination
router.get('/records', authenticateJWT, DailyHighLowController.getDailyHighLowRecords);

// Get daily high/low statistics
router.get('/stats', authenticateJWT, DailyHighLowController.getDailyHighLowStats);

module.exports = router;