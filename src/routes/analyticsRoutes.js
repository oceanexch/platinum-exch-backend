const express = require('express');
const router = express.Router();
const AnalyticsController = require('../controllers/AnalyticsController');
const  authenticateJWT = require('../middlewares/authenticateJWT');

// All routes require authentication
router.use(authenticateJWT);

// Configuration routes
router.get('/config', AnalyticsController.getConfig);
router.get('/tracked-clients', AnalyticsController.getTrackedClients);

// Cron management routes
router.post('/cron/start', AnalyticsController.startCron);
router.post('/cron/stop', AnalyticsController.stopCron);
router.post('/cron/restart', AnalyticsController.restartCron);
router.get('/cron/status', AnalyticsController.getCronStatus);

// Manual capture routes
router.post('/capture/manual', AnalyticsController.manualCapture);
router.post('/capture/user/:userId', AnalyticsController.captureUserAnalytics);

// Data retrieval routes
router.get('/data/:userId', AnalyticsController.getUserAnalytics);
router.get('/summary/:userId', AnalyticsController.getAnalyticsSummary);

module.exports = router;
