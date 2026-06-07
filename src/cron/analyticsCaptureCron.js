// Load environment variables first
require('dotenv').config();

const cron = require('node-cron');
const { captureMultipleUsersAnalytics } = require('../services/AnalyticsService');
const config = require('../config/config');

/**
 * Analytics Capture Cron Job
 * Captures profit/loss data every minute for specified clients
 */

let cronJob = null;
let isRunning = false;

/**
 * Get the list of client IDs to track from config
 */
const getTrackedClients = () => {
  try {
    const clients = config.analytics?.trackedClients || [];
    return Array.isArray(clients) ? clients : [];
  } catch (error) {
    console.error('[AnalyticsCron] Error fetching tracked clients:', error);
    return [];
  }
};

/**
 * Check if cron is enabled
 */
const isCronEnabled = () => {
  try {
    return config.analytics?.enabled || false;
  } catch (error) {
    console.error('[AnalyticsCron] Error checking cron status:', error);
    return false;
  }
};

/**
 * Get cron interval in minutes
 */
const getCronInterval = () => {
  try {
    return config.analytics?.intervalMinutes || 1; // Default: 1 minute
  } catch (error) {
    console.error('[AnalyticsCron] Error fetching cron interval:', error);
    return 1;
  }
};

/**
 * Execute analytics capture
 */
const executeCapture = async () => {
  if (isRunning) {
   // console.log(('[AnalyticsCron] Previous capture still running, skipping...');
    return;
  }

  try {
    isRunning = true;
    const startTime = Date.now();

    // Check if cron is enabled
    const enabled = isCronEnabled();
    if (!enabled) {
     // console.log(('[AnalyticsCron] Cron is disabled in config, skipping capture');
      return;
    }

    // Get tracked clients from config
    const trackedClients = getTrackedClients();

    if (trackedClients.length === 0) {
     // console.log(('[AnalyticsCron] No clients configured to track, skipping capture');
      return;
    }

   // console.log((`[AnalyticsCron] Starting capture for ${trackedClients.length} clients...`);

    // Capture analytics for tracked clients
    const result = await captureMultipleUsersAnalytics(trackedClients);

    const duration = Date.now() - startTime;

   // console.log((
     
  } catch (error) {
    console.error('[AnalyticsCron] Error during capture execution:', error);
  } finally {
    isRunning = false;
  }
};

/**
 * Start the cron job
 */
const startCron = () => {
  try {
    if (cronJob) {
     // console.log(('[AnalyticsCron] Cron job already running, stopping first...');
      stopCron();
    }

    const intervalMinutes = getCronInterval();
    const cronExpression = `*/${intervalMinutes} * * * *`; // Every N minutes

    cronJob = cron.schedule(cronExpression, executeCapture, {
      scheduled: true,
      timezone: 'Asia/Kolkata'
    });

   // console.log((`[AnalyticsCron] Started with interval: ${intervalMinutes} minute(s)`);
   // console.log((`[AnalyticsCron] Cron expression: ${cronExpression}`);
   // console.log((`[AnalyticsCron] Tracking ${getTrackedClients().length} clients`);

    return true;
  } catch (error) {
    console.error('[AnalyticsCron] Error starting cron:', error);
    return false;
  }
};

/**
 * Stop the cron job
 */
const stopCron = () => {
  try {
    if (cronJob) {
      cronJob.stop();
      cronJob = null;
     // console.log(('[AnalyticsCron] Stopped');
    }
    return true;
  } catch (error) {
    console.error('[AnalyticsCron] Error stopping cron:', error);
    return false;
  }
};

/**
 * Restart the cron job (useful when config changes)
 */
const restartCron = () => {
  try {
    stopCron();
    startCron();
   // console.log(('[AnalyticsCron] Restarted successfully');
    return true;
  } catch (error) {
    console.error('[AnalyticsCron] Error restarting cron:', error);
    return false;
  }
};

/**
 * Get cron status
 */
const getCronStatus = () => {
  try {
    const enabled = isCronEnabled();
    const trackedClients = getTrackedClients();
    const intervalMinutes = getCronInterval();

    return {
      enabled,
      isRunning,
      intervalMinutes,
      trackedClientsCount: trackedClients.length,
      trackedClients,
      cronActive: cronJob !== null,
      configSource: 'static (config.js)'
    };
  } catch (error) {
    console.error('[AnalyticsCron] Error getting cron status:', error);
    return {
      enabled: false,
      isRunning: false,
      error: error.message
    };
  }
};

module.exports = {
  startCron,
  stopCron,
  restartCron,
  executeCapture,
  getCronStatus,
  getTrackedClients,
  getCronInterval,
  isCronEnabled
};

// If this file is run directly (not imported as a module)
if (require.main === module) {
 // console.log(('[AnalyticsCron] Running in standalone mode...');
  
  // Connect to database first
  const connectDB = require('../config/database');
  
  connectDB()
    .then(() => {
     // console.log(('[AnalyticsCron] Database connected successfully');
      
      // Check if cron is enabled
      if (!isCronEnabled()) {
        console.error('[AnalyticsCron] ERROR: Analytics cron is disabled in config');
       // console.log(('[AnalyticsCron] Set ANALYTICS_ENABLED=true in .env or config.js');
        process.exit(1);
      }
      
      const trackedClients = getTrackedClients();
      if (trackedClients.length === 0) {
        console.error('[AnalyticsCron] ERROR: No clients configured to track');
       // console.log(('[AnalyticsCron] Add client IDs to config.analytics.trackedClients in config.js');
        process.exit(1);
      }
      
     // console.log((`[AnalyticsCron] Configuration:`);
     // console.log((`  - Enabled: ${isCronEnabled()}`);
     // console.log((`  - Interval: ${getCronInterval()} minute(s)`);
     // console.log((`  - Tracked Clients: ${trackedClients.length}`);
     // console.log((`  - Client IDs: ${trackedClients.join(', ')}`);
      
      // Start the cron job
      startCron();
      
     // console.log(('[AnalyticsCron] Cron job started successfully');
     // console.log(('[AnalyticsCron] Press Ctrl+C to stop');
      
      // Execute once immediately for testing
     // console.log(('[AnalyticsCron] Executing initial capture...');
      executeCapture().then(() => {
       // console.log(('[AnalyticsCron] Initial capture completed');
      });
    })
    .catch((error) => {
      console.error('[AnalyticsCron] Database connection failed:', error);
      process.exit(1);
    });
  
  // Handle graceful shutdown
  process.on('SIGINT', () => {
   // console.log(('\n[AnalyticsCron] Received SIGINT, shutting down gracefully...');
    stopCron();
    process.exit(0);
  });
  
  process.on('SIGTERM', () => {
   // console.log(('\n[AnalyticsCron] Received SIGTERM, shutting down gracefully...');
    stopCron();
    process.exit(0);
  });
}
