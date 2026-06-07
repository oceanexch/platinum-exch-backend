const AnalyticsDataModel = require('../models/AnalyticsDataModel');
const { getScriptWiseReport, getActiveWeekValan, getProfitLossWithLivePrices } = require('./StockService');
const { getMultipleStockData } = require('./RedisService');
const UserModel = require('../models/UserModel');
const mongoose = require('mongoose');
const moment = require('moment');

/**
 * Capture analytics data for multiple users using getProfitLossWithLivePrices
 * @param {Array} userIds - Array of user IDs to capture analytics for
 * @returns {Object} - Result with success/failure counts
 */
const captureMultipleUsersAnalytics = async (userIds) => {
  const results = {
    total: userIds.length,
    successful: 0,
    failed: 0,
    errors: []
  };

  // console.log(`[AnalyticsService] Starting P&L capture with live prices for ${userIds.length} users`);

  for (const userId of userIds) {
    try {
      await captureUserPositionAnalytics(userId);
      results.successful++;
      // console.log(`[AnalyticsService] ✓ Captured analytics for user: ${userId}`);
    } catch (error) {
      results.failed++;
      results.errors.push({ userId, error: error.message });
      console.error(`[AnalyticsService] ✗ Failed to capture analytics for user ${userId}:`, error.message);
    }
  }

  // console.log(`[AnalyticsService] Capture completed - Success: ${results.successful}, Failed: ${results.failed}`);
  return results;
};

/**
 * Capture user position analytics using getProfitLossWithLivePrices for accurate M2M
 * @param {string} userId - User ID to capture analytics for
 */
const captureUserPositionAnalytics = async (userId) => {
  try {
    // console.log(`[AnalyticsService] Capturing position data for user: ${userId}`);

    // Validate user exists
    const user = await UserModel.findById(userId)
      .select('demoid accountType accountCode accountName partnership')
      .populate('accountType', 'level')
      .lean();
    
    if (!user) {
      throw new Error(`User ${userId} not found`);
    }

    const isRequesterDemo = user.demoid === true;
    const level = user.accountType?.level || 7;

    // Get active valan
    const activeValan = await getActiveWeekValan();
    if (!activeValan) {
      throw new Error('No active valan found');
    }

    // Build match filter similar to getUserPositionReport
    const matchFilter = {
      transactionStatus: 'COMPLETED',
      valanId: activeValan._id
    };

    // Set user filter based on level
    const userIdObj = new mongoose.Types.ObjectId(userId);
    const userIdStr = userId.toString();
    
    if (level == 7) {
      // Client login - only sees their own
      matchFilter.userId = userIdObj;
    } else {
      // Admin / Master / Broker login - see downline
      matchFilter.$or = [
        { parentIds: userIdObj },
        { parentIds: userIdStr },
        { brokerIds: userIdObj },
        { brokerIds: userIdStr },
        { userId: userIdObj },
        { userId: userIdStr }
      ];
    }

    // console.log(`[AnalyticsService] Fetching P&L with live prices for user ${userId} with level ${level}`);

    // Use getProfitLossWithLivePrices for accurate M2M calculations with live prices
    const { data: profitLossData, enriched: scriptLevelData } = await getProfitLossWithLivePrices(
      matchFilter, 
      level, 
      userId,
      { isRequesterDemo }
    );

    if (!scriptLevelData || scriptLevelData.length === 0) {
      // console.log(`[AnalyticsService] No position data found for user: ${userId}`);
      return;
    }

    // console.log(`[AnalyticsService] Found ${scriptLevelData.length} script-level position(s) for user: ${userId}`);

    // Save each script-level position as analytics data
    let savedCount = 0;
    const snapshotTime = new Date();
    
    for (const script of scriptLevelData) {
      try {
        // Extract user info from the script data
        const scriptUserId = script.userId || script._id?.userId;
        const scriptUserIdStr = scriptUserId ? scriptUserId.toString() : null;
        
        // Find matching user data from profitLossData for additional details
        const userData = profitLossData.find(u => u.userId.toString() === scriptUserIdStr);
        
        const analyticsRecord = {
          userId: scriptUserId ? new mongoose.Types.ObjectId(scriptUserId) : userIdObj,
          valanId: activeValan._id,
          snapshotTime,
          
          // Position data from script
          scriptId: script.scriptId || script._id?.scriptId,
          scriptName: script.scriptName,
          marketId: script.marketId,
          marketName: script.marketName,
          
          // Quantities
          buyQuantity: Number(script.buyQuantity || 0),
          sellQuantity: Number(script.sellQuantity || 0),
          remainingQty: Number(script.remainingQty || 0),
          
          // Lots
          buyLot: Number(script.buyLot || 0),
          sellLot: Number(script.sellLot || 0),
          remainingLot: Number(script.remainingLot || 0),
          
          // Prices (with live price integration)
          buyNetAveragePrice: Number(script.buyNetAveragePrice || 0),
          sellNetAveragePrice: Number(script.sellNetAveragePrice || 0),
          livePrice: Number(script.livePrice || script.orderPrice || 0),
          
          // P&L calculations (accurate with live prices)
          totalPnl: Number(script.m2m || 0),
          m2m: Number(script.m2m || 0),
          gross: Number(script.gross || 0),
          
          // Brokerage
          brokerage: Number(script.brokerage || 0),
          brokerBrokerage: Number(script.brokerBrokerage || 0),
          selfBrokerage: Number(script.selfBrokerage || 0),
          
          // Net prices (hierarchy distribution)
          selfNetPrice: Number(script.selfNetPrice || 0),
          brokerNetPrice: Number(script.brokerNetPrice || 0),
          uplineNetPrice: Number(script.uplineNetPrice || 0),
          downlineNetPrice: Number(script.downlineNetPrice || 0),
          
          // Shares (partnership percentages)
          myShare: Number(script.myShare || 0),
          uplineShare: Number(script.uplineShare || 0),
          downlineShare: Number(script.downlineShare || 0),
          
          // User details
          userDetails: {
            accountCode: script.accountCode || user.accountCode,
            accountName: script.accountName || user.accountName,
            demoid: isRequesterDemo
          },
          
          // Additional metadata
          captureSource: 'getProfitLossWithLivePrices',
          captureLevel: level
        };

        // Save to database
        await AnalyticsDataModel.create(analyticsRecord);
        savedCount++;
        
        // console.log(`[AnalyticsService] Saved analytics record for ${script.scriptName || script.scriptId}`);
      } catch (saveError) {
        console.error(`[AnalyticsService] Error saving position record for ${script.scriptId}:`, saveError.message);
      }
    }

    // console.log(`[AnalyticsService] Successfully saved ${savedCount} analytics records for user: ${userId}`);
    
  } catch (error) {
    console.error(`[AnalyticsService] Error capturing position analytics for user ${userId}:`, error);
    throw error;
  }
};

/**
 * Capture and save analytics data for a specific user (legacy function)
 */
const captureUserAnalytics = async (userId, options = {}) => {
  try {
    const { valanId, marketId, scriptId } = options;

    // Get active valan if not provided
    let activeValanId = valanId;
    if (!activeValanId) {
      const activeValan = await getActiveWeekValan();
      activeValanId = activeValan._id;
    }

    // Get user details
    const user = await UserModel.findById(userId)
      .select('accountCode accountName accountType parentIds')
      .lean();

    if (!user) {
      console.warn(`[AnalyticsService] User ${userId} not found`);
      return { success: false, message: 'User not found' };
    }

    const userLevel = user.accountType?.level || 7;

    // Build match filter
    const matchFilter = {
      userId: new mongoose.Types.ObjectId(userId),
      valanId: activeValanId,
      transactionStatus: 'COMPLETED'
    };

    if (marketId) {
      matchFilter.marketId = marketId;
    }

    if (scriptId) {
      matchFilter.scriptId = scriptId;
    }

    // Fetch script-wise report data
    const reportData = await getScriptWiseReport(matchFilter, userLevel, userId);

    if (!reportData || reportData.length === 0) {
      // console.log(`[AnalyticsService] No data found for user ${userId}`);
      return { success: true, message: 'No positions to capture', count: 0 };
    }

    // Prepare analytics documents
    const snapshotTime = new Date();
    const analyticsDocuments = reportData.map((item) => ({
      userId: new mongoose.Types.ObjectId(userId),
      valanId: activeValanId,
      marketId: item.marketId || marketId,
      scriptId: item.scriptId,
      scriptName: item.scriptName,
      label: item.label,
      
      // Position Data
      buyQuantity: item.buyQuantity || 0,
      sellQuantity: item.sellQuantity || 0,
      netQuantity: item.netQuantity || 0,
      buyLot: item.buyLot || 0,
      sellLot: item.sellLot || 0,
      
      // Price Data
      buyAvgPrice: item.buyAvgPrice || 0,
      sellAvgPrice: item.sellAvgPrice || 0,
      livePrice: item.livePrice || 0,
      
      // P&L Data
      realizedPnl: item.realizedPnl || 0,
      unrealizedPnl: item.unrealizedPnl || 0,
      totalPnl: item.totalPnl || 0,
      m2m: item.m2m || 0,
      
      // Brokerage Data
      brokerage: item.brokerage || 0,
      brokerBrokerage: item.brokerBrokerage || 0,
      netBrokerage: item.netBrokerage || 0,
      
      // Gross & Bill
      gross: item.gross || 0,
      bill: item.bill || 0,
      
      // Metadata
      snapshotTime,
      accountCode: user.accountCode,
      accountName: user.accountName,
      parentIds: user.parentIds || [],
      period: 'minute'
    }));

    // Bulk insert analytics data
    const result = await AnalyticsDataModel.insertMany(analyticsDocuments, { ordered: false });

    // console.log(`[AnalyticsService] Captured ${result.length} analytics records for user ${userId}`);

    return {
      success: true,
      count: result.length,
      userId,
      snapshotTime
    };
  } catch (error) {
    console.error(`[AnalyticsService] Error capturing analytics for user ${userId}:`, error);
    return {
      success: false,
      error: error.message,
      userId
    };
  }
};

/**
 * Get analytics data for a user within a time range
 */
const getUserAnalytics = async (userId, options = {}) => {
  try {
    const { startTime, endTime, scriptId, marketId, valanId, limit = 100 } = options;

    const query = {
      userId: new mongoose.Types.ObjectId(userId)
    };

    if (valanId) {
      query.valanId = new mongoose.Types.ObjectId(valanId);
    }

    if (scriptId) {
      query.scriptId = scriptId;
    }

    if (marketId) {
      query.marketId = marketId;
    }

    if (startTime || endTime) {
      query.snapshotTime = {};
      if (startTime) query.snapshotTime.$gte = new Date(startTime);
      if (endTime) query.snapshotTime.$lte = new Date(endTime);
    }

    const data = await AnalyticsDataModel.find(query)
      .sort({ snapshotTime: -1 })
      .limit(limit)
      .lean();

    return data;
  } catch (error) {
    console.error('[AnalyticsService] Error fetching user analytics:', error);
    throw error;
  }
};

/**
 * Get aggregated analytics summary
 */
const getAnalyticsSummary = async (userId, options = {}) => {
  try {
    const { startTime, endTime, scriptId, marketId, valanId } = options;

    const matchStage = {
      userId: new mongoose.Types.ObjectId(userId)
    };

    if (valanId) {
      matchStage.valanId = new mongoose.Types.ObjectId(valanId);
    }

    if (scriptId) {
      matchStage.scriptId = scriptId;
    }

    if (marketId) {
      matchStage.marketId = marketId;
    }

    if (startTime || endTime) {
      matchStage.snapshotTime = {};
      if (startTime) matchStage.snapshotTime.$gte = new Date(startTime);
      if (endTime) matchStage.snapshotTime.$lte = new Date(endTime);
    }

    const summary = await AnalyticsDataModel.aggregate([
      { $match: matchStage },
      {
        $group: {
          _id: null,
          avgTotalPnl: { $avg: '$totalPnl' },
          maxTotalPnl: { $max: '$totalPnl' },
          minTotalPnl: { $min: '$totalPnl' },
          avgM2m: { $avg: '$m2m' },
          maxM2m: { $max: '$m2m' },
          minM2m: { $min: '$m2m' },
          totalBrokerage: { $sum: '$brokerage' },
          snapshotCount: { $sum: 1 },
          firstSnapshot: { $min: '$snapshotTime' },
          lastSnapshot: { $max: '$snapshotTime' }
        }
      }
    ]);

    return summary[0] || null;
  } catch (error) {
    console.error('[AnalyticsService] Error fetching analytics summary:', error);
    throw error;
  }
};

module.exports = {
  captureUserAnalytics,
  captureMultipleUsersAnalytics,
  captureUserPositionAnalytics,
  getUserAnalytics,
  getAnalyticsSummary
};