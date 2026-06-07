/**
 * Broker Helper Utilities
 * Functions to handle broker-specific logic like market access inheritance
 */

const UserModel = require('../models/UserModel');

/**
 * Get market access for a user, with broker inheritance logic
 * If user is a broker (level 6) with no marketAccess, inherits from direct parent
 * 
 * @param {string|ObjectId} userId - User ID to check
 * @returns {Promise<Array>} - marketAccess array
 */
exports.getMarketAccessForUser = async (userId) => {
  try {
    const user = await UserModel.findById(userId)
      .select('marketAccess accountType parentIds')
      .populate('accountType', 'level')
      .lean();

    if (!user) {
      return [];
    }

    let marketAccess = user.marketAccess || [];

    // If user is a broker (level 6) and has no marketAccess, inherit from direct parent
    if (user.accountType?.level === 6 && marketAccess.length === 0) {
      if (user.parentIds && user.parentIds.length > 0) {
        // Get direct parent (first in parentIds array is the immediate parent)
        const directParentId = user.parentIds[0];
        const parentUser = await UserModel.findById(directParentId)
          .select('marketAccess')
          .lean();

        if (parentUser && parentUser.marketAccess) {
          // console.log(`[BROKER HELPER] Broker ${userId} (level 6) has no marketAccess, inheriting from parent ${directParentId}`);
          marketAccess = parentUser.marketAccess;
        }
      }
    }

    return marketAccess;
  } catch (error) {
    console.error('[BROKER HELPER] Error getting market access:', error);
    return [];
  }
};

/**
 * Get user info with broker market access inheritance
 * 
 * @param {string|ObjectId} userId - User ID to check
 * @param {Object} selectFields - Fields to select (default: marketAccess, accountType, parentIds)
 * @returns {Promise<Object>} - User object with marketAccess
 */
exports.getUserWithMarketAccess = async (userId, selectFields = null) => {
  try {
    const fields = selectFields || { marketAccess: 1, accountType: 1, parentIds: 1 };
    
    const user = await UserModel.findById(userId)
      .select(fields)
      .populate('accountType', 'level')
      .lean();

    if (!user) {
      return null;
    }

    let marketAccess = user.marketAccess || [];

    // If user is a broker (level 6) and has no marketAccess, inherit from direct parent
    if (user.accountType?.level === 6 && marketAccess.length === 0) {
      if (user.parentIds && user.parentIds.length > 0) {
        const directParentId = user.parentIds[0];
        const parentUser = await UserModel.findById(directParentId)
          .select('marketAccess')
          .lean();

        if (parentUser && parentUser.marketAccess) {
          // console.log(`[BROKER HELPER] Broker ${userId} (level 6) has no marketAccess, inheriting from parent ${directParentId}`);
          marketAccess = parentUser.marketAccess;
          user.marketAccess = marketAccess;
        }
      }
    }

    return user;
  } catch (error) {
    console.error('[BROKER HELPER] Error getting user with market access:', error);
    return null;
  }
};

/**
 * Check if user is a broker (level 6)
 * 
 * @param {Object} user - User object with accountType populated
 * @returns {boolean} - True if broker
 */
exports.isBroker = (user) => {
  return user?.accountType?.level === 6;
};

/**
 * Get market IDs from marketAccess array
 * 
 * @param {Array} marketAccess - marketAccess array
 * @returns {Array<string>} - Array of market IDs
 */
exports.getMarketIds = (marketAccess) => {
  if (!marketAccess || !Array.isArray(marketAccess)) {
    return [];
  }
  return [...new Set(marketAccess.map(m => String(m.marketId)))];
};
