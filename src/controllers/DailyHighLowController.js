const DailyHighLow = require('../models/DailyHighLowModel');
const DailyHighLowService = require('../services/DailyHighLowService');

class DailyHighLowController {
  
  /**
   * Get current high/low for a script (all periods)
   */
  static async getTodayHighLow(req, res) {
    try {
      const { scriptId } = req.params;
      
      if (!scriptId) {
        return res.status(400).json({
          success: false,
          message: 'Script ID is required'
        });
      }

      const result = await DailyHighLowService.getHighLow(scriptId);
      
      res.json({
        success: true,
        data: result
      });
    } catch (error) {
      console.error('Error getting high/low:', error);
      res.status(500).json({
        success: false,
        message: 'Internal server error'
      });
    }
  }

  /**
   * Get historical high/low for a script
   */
  static async getHistoricalHighLow(req, res) {
    try {
      const { scriptId } = req.params;
      const { period = 'DAILY', limit = 10 } = req.query;
      
      if (!scriptId) {
        return res.status(400).json({
          success: false,
          message: 'Script ID is required'
        });
      }

      const records = await DailyHighLowService.getHistoricalHighLow(
        scriptId, 
        period.toUpperCase(), 
        parseInt(limit)
      );
      
      res.json({
        success: true,
        data: records
      });
    } catch (error) {
      console.error('Error getting historical high/low:', error);
      res.status(500).json({
        success: false,
        message: 'Internal server error'
      });
    }
  }

  /**
   * Get daily high/low records with pagination
   */
 static async getDailyHighLowRecords(req, res) {
    try {
      const { 
        scriptId, 
        type, 
        period = 'DAILY',
        page = 1, 
        limit = 50,
        startDate,
        endDate 
      } = req.query;

      const query = {};
      const countQuery = {};
      
      if (scriptId) {
        query.scriptName = scriptId;
        countQuery.scriptName = scriptId;
      }
      
      // Handle type filter - support 'ALL' to get both HIGH and LOW
      if (type && type.toUpperCase() !== 'ALL') {
        if (['HIGH', 'LOW'].includes(type.toUpperCase())) {
          query.type = type.toUpperCase();
          countQuery.type = type.toUpperCase();
        }
      } else if (type && type.toUpperCase() === 'ALL') {
        countQuery.type = { $in: ['HIGH', 'LOW'] };
      }
      
      // Handle period filter - support 'ALL' to get all periods
      if (period && period.toUpperCase() !== 'ALL') {
        if (['DAILY', 'WEEKLY', 'MONTHLY'].includes(period.toUpperCase())) {
          query.period = period.toUpperCase();
          countQuery.period = period.toUpperCase();
        }
      } else if (period && period.toUpperCase() === 'ALL') {
        countQuery.period = { $in: ['DAILY', 'WEEKLY', 'MONTHLY'] };
      }

      // Date range filter
      if (startDate || endDate) {
        const moment = require('moment');
        query.timestamp = {};
        countQuery.timestamp = {};
        if (startDate) {
          query.timestamp.$gte = moment(startDate).startOf('day').toDate();
          countQuery.timestamp.$gte = moment(startDate).startOf('day').toDate();
        }
        if (endDate) {
          query.timestamp.$lte = moment(endDate).endOf('day').toDate();
          countQuery.timestamp.$lte = moment(endDate).endOf('day').toDate();
        }
      }

      const skip = (parseInt(page) - 1) * parseInt(limit);
      
      // Get period counts based on filters
      const getPeriodCounts = async () => {
        const countQueryForPeriods = { ...countQuery };
        const counts = {};
        
        // If type is ALL, get counts for both HIGH and LOW
        const typesToCount = (type && type.toUpperCase() === 'ALL') ? ['HIGH', 'LOW'] : [type?.toUpperCase() || 'HIGH'];
        
        // If period is ALL, get counts for each period
        const periodsToCount = (period && period.toUpperCase() === 'ALL') ? ['DAILY', 'WEEKLY', 'MONTHLY'] : [period?.toUpperCase() || 'DAILY'];
        
        for (const t of typesToCount) {
          counts[t] = {};
          for (const p of periodsToCount) {
            const tempQuery = { ...countQueryForPeriods };
            tempQuery.type = t;
            tempQuery.period = p;
            counts[t][`${p.toLowerCase()}_count`] = await DailyHighLow.countDocuments(tempQuery);
          }
        }
        
        return counts;
      };
      
      const [records, total, periodCounts] = await Promise.all([
        DailyHighLow.find(query)
          .sort({ timestamp: -1 })
          .skip(skip)
          .limit(parseInt(limit))
          .lean(),
        DailyHighLow.countDocuments(query),
        getPeriodCounts()
      ]);

      res.json({
        success: true,
        data: {
          records,
          counts: periodCounts,
          pagination: {
            page: parseInt(page),
            limit: parseInt(limit),
            total,
            pages: Math.ceil(total / parseInt(limit))
          }
        }
      });
    } catch (error) {
      console.error('Error getting daily high/low records:', error);
      res.status(500).json({
        success: false,
        message: 'Internal server error'
      });
    }
  }

  /**
   * Get daily high/low statistics
   */
  static async getDailyHighLowStats(req, res) {
    try {
      const today = new Date();
      today.setHours(0, 0, 0, 0);
      const tomorrow = new Date(today);
      tomorrow.setDate(tomorrow.getDate() + 1);

      const [todayStats, totalStats, recentRecords] = await Promise.all([
        DailyHighLow.aggregate([
          {
            $match: {
              timestamp: { $gte: today, $lt: tomorrow }
            }
          },
          {
            $group: {
              _id: { type: '$type', period: '$period' },
              count: { $sum: 1 },
              uniqueScripts: { $addToSet: '$scriptId' }
            }
          },
          {
            $project: {
              type: '$_id.type',
              period: '$_id.period',
              count: 1,
              uniqueScripts: { $size: '$uniqueScripts' }
            }
          }
        ]),
        DailyHighLow.aggregate([
          {
            $group: {
              _id: { type: '$type', period: '$period' },
              count: { $sum: 1 },
              uniqueScripts: { $addToSet: '$scriptId' }
            }
          },
          {
            $project: {
              type: '$_id.type',
              period: '$_id.period',
              count: 1,
              uniqueScripts: { $size: '$uniqueScripts' }
            }
          }
        ]),
        // Get recent 10 records for debugging
        DailyHighLow.find({})
          .sort({ timestamp: -1 })
          .limit(10)
          .lean()
      ]);

      res.json({
        success: true,
        data: {
          today: todayStats,
          total: totalStats,
          recentRecords: recentRecords
        }
      });
    } catch (error) {
      console.error('Error getting daily high/low stats:', error);
      res.status(500).json({
        success: false,
        message: 'Internal server error'
      });
    }
  }
}

module.exports = DailyHighLowController;