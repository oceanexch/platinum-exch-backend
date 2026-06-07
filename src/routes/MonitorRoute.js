'use strict';
const express = require('express');
const router  = express.Router();
const authenticateJWT = require('../middlewares/authenticateJWT');
const {
  addMonitor,
  removeMonitor,
  listMonitored,
  whoAdded
} = require('../controllers/MonitorController');

// All routes require authentication
router.use(authenticateJWT);

// Add a user to the watch list
router.post('/add', addMonitor);

// Remove a user from the watch list
router.delete('/remove/:monitoredUserId', removeMonitor);

// List all users I am currently monitoring
router.get('/list', listMonitored);

// See all watchers of a specific user
router.get('/who-added/:monitoredUserId', whoAdded);

module.exports = router;
