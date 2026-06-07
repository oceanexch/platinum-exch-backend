const moment = require('moment');
const userModel = require('../models/UserModel');
const M2MService = require('../services/M2MService');

exports.resetWeeklyLimitOverrides = async () => {
  try {
    const thisWeekMonday = moment().startOf('isoWeek').toDate();

    // Find users whose snapshot is for the week that just ended (this week or earlier)
    // AND who have weeklyLimitAutoReset enabled (or not set, defaults to true)
    const usersWithSnapshot = await userModel
      .find({ 
        'weeklyLimitSnapshot.weekStart': { $ne: null, $lte: thisWeekMonday },
        $or: [
          { 'accountDetails.weeklyLimitAutoReset': true },
          { 'accountDetails.weeklyLimitAutoReset': { $exists: false } } // Handle old documents without the flag
        ]
      })
      .select('_id accountCode accountDetails marketAccess weeklyLimitSnapshot')
      .lean();

    if (!usersWithSnapshot.length) {
      console.log('[weeklyLimitReset] No users with pending limit snapshots (or all have auto-reset disabled).');
      return;
    }

    console.log(`[weeklyLimitReset] Restoring limits for ${usersWithSnapshot.length} user(s).`);

    const bulkOps = usersWithSnapshot.map(user => {
      const snap = user.weeklyLimitSnapshot;
      const marketAccess = (user.marketAccess || []).map(m => {
        const saved = (snap.marketMargins || []).find(s => s.marketId === m.marketId);
        if (!saved) return m;
        return {
          ...m,
          margin: {
            ...m.margin,
            lotOrAmount: saved.lotOrAmount,
            totalLotWise: saved.totalLotWise,
            totalMargin: saved.totalMargin,
            maximumLimit: saved.maximumLimit
          }
        };
      });

      console.log(`[weeklyLimitReset] Resetting user: ${user.accountCode}`);

      return {
        updateOne: {
          filter: { _id: user._id },
          update: {
            $set: {
              'accountDetails.m2mLoss_NSE_MCX_NOPT': snap.m2mLoss_NSE_MCX_NOPT ?? user.accountDetails?.m2mLoss_NSE_MCX_NOPT,
              'accountDetails.m2mProfit_NSE_MCX_NOPT': snap.m2mProfit_NSE_MCX_NOPT ?? user.accountDetails?.m2mProfit_NSE_MCX_NOPT,
              'accountDetails.m2mLoss_FOREX_COMEX': snap.m2mLoss_FOREX_COMEX ?? user.accountDetails?.m2mLoss_FOREX_COMEX,
              'accountDetails.m2mProfit_FOREX_COMEX': snap.m2mProfit_FOREX_COMEX ?? user.accountDetails?.m2mProfit_FOREX_COMEX,
              'accountDetails.m2mLoss_NSEEQ': snap.m2mLoss_NSEEQ ?? user.accountDetails?.m2mLoss_NSEEQ,
              'accountDetails.m2mProfit_NSEEQ': snap.m2mProfit_NSEEQ ?? user.accountDetails?.m2mProfit_NSEEQ,
              marketAccess,
              'weeklyLimitSnapshot.weekStart': null,
              'weeklyLimitSnapshot.marketMargins': []
            }
          }
        }
      };
    });

    await userModel.bulkWrite(bulkOps);

    // Refresh M2M cache so restored limits take effect immediately on Monday
    await M2MService.refreshM2MUserCache().catch(err =>
      console.error('[weeklyLimitReset] M2M cache refresh failed:', err)
    );

    console.log(`[weeklyLimitReset] Done. Restored ${usersWithSnapshot.length} user(s).`);
  } catch (err) {
    console.error('[weeklyLimitReset] Failed:', err);
    throw err;
  }
};
