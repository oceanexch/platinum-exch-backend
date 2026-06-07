const { 
  captureUserAnalytics, 
  captureMultipleUsersAnalytics, 
  getUserAnalytics, 
  getAnalyticsSummary 
} = require('../services/AnalyticsService');
const config = require('../config/config');
const mongoose = require('mongoose');

/**
 * Get analytics configuration
 */
const getConfig = async (req, res) => {
  try {
    const analyticsConfig = {
      enabled: config.analytics?.enabled || false,
      intervalMinutes: config.analytics?.intervalMinutes || 1,
      trackedClientsCount: config.analytics?.trackedClients?.length || 0
    };

    res.json({
      status: true,
      data: analyticsConfig
    });
  } catch (error) {
    console.error('Error fetching analytics config:', error);
    res.status(500).json({ 
      status: false, 
      message: 'Failed to fetch analytics configuration',
      error: error.message 
    });
  }
};

/**
 * Get tracked clients list
 */
const getTrackedClients = async (req, res) => {
  try {
    const trackedClients = config.analytics?.trackedClients || [];

    res.json({
      status: true,
      data: {
        clients: trackedClients,
        count: trackedClients.length
      }
    });
  } catch (error) {
    console.error('Error fetching tracked clients:', error);
    res.status(500).json({ 
      status: false, 
      message: 'Failed to fetch tracked clients',
      error: error.message 
    });
  }
};

/**
 * Start analytics cron job
 */
const startCron = async (req, res) => {
  try {
    // Import cron functions
    const { startCron: startAnalyticsCron } = require('../cron/analyticsCaptureCron');
    
    const result = startAnalyticsCron();
    
    if (result) {
      res.json({
        status: true,
        message: 'Analytics cron job started successfully'
      });
    } else {
      res.status(500).json({
        status: false,
        message: 'Failed to start analytics cron job'
      });
    }
  } catch (error) {
    console.error('Error starting cron:', error);
    res.status(500).json({ 
      status: false, 
      message: 'Failed to start cron job',
      error: error.message 
    });
  }
};

/**
 * Stop analytics cron job
 */
const stopCron = async (req, res) => {
  try {
    const { stopCron: stopAnalyticsCron } = require('../cron/analyticsCaptureCron');
    
    const result = stopAnalyticsCron();
    
    if (result) {
      res.json({
        status: true,
        message: 'Analytics cron job stopped successfully'
      });
    } else {
      res.status(500).json({
        status: false,
        message: 'Failed to stop analytics cron job'
      });
    }
  } catch (error) {
    console.error('Error stopping cron:', error);
    res.status(500).json({ 
      status: false, 
      message: 'Failed to stop cron job',
      error: error.message 
    });
  }
};

/**
 * Restart analytics cron job
 */
const restartCron = async (req, res) => {
  try {
    const { restartCron: restartAnalyticsCron } = require('../cron/analyticsCaptureCron');
    
    const result = restartAnalyticsCron();
    
    if (result) {
      res.json({
        status: true,
        message: 'Analytics cron job restarted successfully'
      });
    } else {
      res.status(500).json({
        status: false,
        message: 'Failed to restart analytics cron job'
      });
    }
  } catch (error) {
    console.error('Error restarting cron:', error);
    res.status(500).json({ 
      status: false, 
      message: 'Failed to restart cron job',
      error: error.message 
    });
  }
};

/**
 * Get cron job status
 */
const getCronStatus = async (req, res) => {
  try {
    const { getCronStatus: getAnalyticsCronStatus } = require('../cron/analyticsCaptureCron');
    
    const status = getAnalyticsCronStatus();
    
    res.json({
      status: true,
      data: status
    });
  } catch (error) {
    console.error('Error fetching cron status:', error);
    res.status(500).json({ 
      status: false, 
      message: 'Failed to fetch cron status',
      error: error.message 
    });
  }
};

/**
 * Manual capture for all tracked clients
 */
const manualCapture = async (req, res) => {
  try {
    const trackedClients = config.analytics?.trackedClients || [];
    
    if (trackedClients.length === 0) {
      return res.status(400).json({
        status: false,
        message: 'No tracked clients configured'
      });
    }

    const result = await captureMultipleUsersAnalytics(trackedClients);

    res.json({
      status: true,
      message: 'Manual capture completed',
      data: result
    });
  } catch (error) {
    console.error('Error in manual capture:', error);
    res.status(500).json({ 
      status: false, 
      message: 'Manual capture failed',
      error: error.message 
    });
  }
};

/**
 * Capture analytics for a specific user
 */
const captureUserAnalyticsController = async (req, res) => {
  try {
    const { userId } = req.params;

    if (!mongoose.Types.ObjectId.isValid(userId)) {
      return res.status(400).json({
        status: false,
        message: 'Invalid user ID format'
      });
    }

    const result = await captureUserAnalytics(userId);

    res.json({
      status: true,
      message: 'User analytics captured successfully',
      data: result
    });
  } catch (error) {
    console.error('Error capturing user analytics:', error);
    res.status(500).json({ 
      status: false, 
      message: 'Failed to capture user analytics',
      error: error.message 
    });
  }
};

/**
 * Get analytics data for a user
 * GET /api/analytics/data/:userId
 * Query params: limit, page, scriptId, marketId, startDate, endDate
 */
const getUserAnalyticsController = async (req, res) => {
  try {
    const { userId } = req.params;
    const { 
      limit = 50, 
      page = 1, 
      scriptId, 
      marketId, 
      startDate, 
      endDate 
    } = req.query;

    // Validate userId
    if (!mongoose.Types.ObjectId.isValid(userId)) {
      return res.status(400).json({
        status: false,
        message: 'Invalid user ID format'
      });
    }

    // Build options object
    const options = {
      limit: parseInt(limit),
      startTime: startDate ? new Date(startDate) : null,
      endTime: endDate ? new Date(endDate) : null
    };

    if (scriptId) options.scriptId = scriptId;
    if (marketId) options.marketId = marketId;

    // Calculate skip for pagination
    const skip = (parseInt(page) - 1) * parseInt(limit);

    // Get analytics data
    const data = await getUserAnalytics(userId, options);

    // Apply pagination manually since the service doesn't handle it
    const paginatedData = data.slice(skip, skip + parseInt(limit));

    res.json({
      status: true,
      data: paginatedData,
      pagination: {
        total: data.length,
        page: parseInt(page),
        limit: parseInt(limit),
        pages: Math.ceil(data.length / parseInt(limit))
      }
    });
  } catch (error) {
    console.error('Error fetching user analytics:', error);
    res.status(500).json({ 
      status: false, 
      message: 'Failed to fetch user analytics',
      error: error.message 
    });
  }
};

/**
 * Get analytics summary for a user
 * GET /api/analytics/summary/:userId
 * Query params: scriptId, marketId, startDate, endDate
 */
const getAnalyticsSummaryController = async (req, res) => {
  try {
    const { userId } = req.params;
    const { scriptId, marketId, startDate, endDate } = req.query;

    // Validate userId
    if (!mongoose.Types.ObjectId.isValid(userId)) {
      return res.status(400).json({
        status: false,
        message: 'Invalid user ID format'
      });
    }

    // Build options object
    const options = {
      startTime: startDate ? new Date(startDate) : null,
      endTime: endDate ? new Date(endDate) : null
    };

    if (scriptId) options.scriptId = scriptId;
    if (marketId) options.marketId = marketId;

    // Get analytics summary
    const summary = await getAnalyticsSummary(userId, options);

    if (!summary) {
      return res.json({
        status: true,
        data: {
          avgTotalPnl: 0,
          maxTotalPnl: 0,
          minTotalPnl: 0,
          avgM2m: 0,
          maxM2m: 0,
          minM2m: 0,
          totalBrokerage: 0,
          snapshotCount: 0,
          firstSnapshot: null,
          lastSnapshot: null
        }
      });
    }

    res.json({
      status: true,
      data: summary
    });
  } catch (error) {
    console.error('Error fetching analytics summary:', error);
    res.status(500).json({ 
      status: false, 
      message: 'Failed to fetch analytics summary',
      error: error.message 
    });
  }
};

module.exports = {
  getConfig,
  getTrackedClients,
  startCron,
  stopCron,
  restartCron,
  getCronStatus,
  manualCapture,
  captureUserAnalytics: captureUserAnalyticsController,
  getUserAnalytics: getUserAnalyticsController,
  getAnalyticsSummary: getAnalyticsSummaryController
};