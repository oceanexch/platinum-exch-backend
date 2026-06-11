const userTypeModel = require('../models/UserTypeModel');
const userModel = require('../models/UserModel');
const onlineHistoryModel = require('../models/OnlineHistoryModel');
const mongoose = require('mongoose');
// const { getClientMargin } = require("./StockService");
// const { hgetall } = require("./RedisService");
const { saveLog } = require('./LogService');
const notificationSetting = require('../models/NotificationModel');
const { generateAccessToken, generateRefreshToken } = require('./TokenService');
// const CashLedger = require("../models/CashLedger"); // adjust path if needed
// const { saveCashLedger } = require("../services/ProfitLossService");
// adjust path if needed
const QuantitySettingModel = require('../models/QuantitySettingModel');

const { MarketType } = require('../models/MarketTypeModel'); // adjust path
const { storeRefreshTokenInRedis, hgetall } = require('./RedisService');
exports.getUserTypes = async (level) => {
  try {
    const match = level == 1 ? { $eq: 2 } : { $gt: level };
    return await userTypeModel.find({ level: match }).lean();
  } catch (error) {
    console.error('Error fetching data:', error);
    throw error;
  }
};

// UserService.js
exports.getMarquee = async () => {
  const currentTime = Date.now();

  try {
    const headlines = await notificationSetting.aggregate([
      {
        $match: {
          type: 'Headline',
          startDate: { $lte: currentTime },
          endDate: { $gte: currentTime }
        }
      },
      {
        $project: {
          message: 1,
          _id: 0
        }
      },
      { $sort: { createdAt: -1 } }
    ]);

    return headlines.map((h) => h.message || '');
  } catch (err) {
    console.error('getMarqueeHeadlines error:', err);
    throw err; // return to controller
  }
};

exports.getAllUserTypes = async (level) => {
  try {
    return await userTypeModel.find({ level: { $gt: level } }).lean();
  } catch (error) {
    console.error('Error fetching data:', error);
    throw error;
  }
};

exports.getUserTypeById = async (id) => {
  try {
    return await userTypeModel.findOne({ _id: id }).lean();
  } catch (error) {
    console.error('Error fetching data:', error);
    throw error;
  }
};

/**
 * Resolves a usertype identifier to its object with ObjectId and metadata
 * @param {string} userTypeIdentifier - Can be ObjectId, name (e.g., "CUSTOMER"), label, or "demo"
 * @returns {Promise<{id: ObjectId, isDemo: boolean, name: string, level: number}|null>}
 */
exports.resolveUserTypeId = async (userTypeIdentifier) => {
  try {
    const mongoose = require('mongoose');
    let isDemo = false;
    let identifier = userTypeIdentifier;

    // Special case: if "demo", we return a generic demo flag without a specific type ID
    if (userTypeIdentifier && typeof userTypeIdentifier === 'string' && userTypeIdentifier.toLowerCase() === 'demo') {
      return {
        id: null,
        isDemo: true,
        name: 'DEMO',
        label: 'Demo',
        level: null
      };
    }

    let userType;
    // If it's already a valid ObjectId
    if (mongoose.isValidObjectId(identifier)) {
      userType = await userTypeModel.findOne({ _id: identifier }).select('_id name level label').lean();
    } else if (identifier) {
      // Otherwise, try to find by name or label (case-insensitive)
      userType = await userTypeModel
        .findOne({
          $or: [{ name: { $regex: new RegExp(`^${identifier}$`, 'i') } }, { label: { $regex: new RegExp(`^${identifier}$`, 'i') } }]
        })
        .select('_id name level label')
        .lean();
    }

    if (!userType) return null;

    return {
      id: userType._id,
      isDemo: isDemo,
      name: userType.name,
      label: userType.label,
      level: userType.level
    };
  } catch (error) {
    console.error('Error resolving usertype:', error);
    return null;
  }
};
exports.getActiveUserCount = async () => {
  // 1️⃣ find all user types with level 7
  const types = await userTypeModel.find({ level: 7, isActive: true }).select('_id');

  if (!types.length) {
    return {
      total: 0,
      totalPermanent: 0,
      totalDemo: 0,
      activeDemo: 0
    };
  }

  const accountTypeIds = types.map((t) => t._id);

  // 2️⃣ aggregate stats from User collection
  const result = await userModel.aggregate([
    {
      $match: {
        accountType: { $in: accountTypeIds },
        isDeleted: false
      }
    },
    {
      $group: {
        _id: null,
        total: { $sum: 1 },

        totalPermanent: {
          $sum: {
            $cond: [{ $eq: ['$demoid', false] }, 1, 0]
          }
        },

        totalDemo: {
          $sum: {
            $cond: [{ $eq: ['$demoid', true] }, 1, 0]
          }
        },

        activeDemo: {
          $sum: {
            $cond: [
              {
                $and: [{ $eq: ['$demoid', true] }, { $eq: ['$status', true] }]
              },
              1,
              0
            ]
          }
        }
      }
    },
    { $project: { _id: 0 } }
  ]);

  return (
    result[0] || {
      total: 0,
      totalPermanent: 0,
      totalDemo: 0,
      activeDemo: 0
    }
  );
};
exports.ensureDemoIdentityIsUnique = async ({ email, contactNumber, accountCode, accountName }) => {
  if (accountName && accountName.length > 11) {
    throw new Error('Account name cannot be longer than 11 characters');
  }

  const query = {
    $or: [
      email ? { email: email.toLowerCase() } : null,
      contactNumber ? { contactNumber } : null,
      accountCode ? { accountCode } : null,
      accountName ? { accountName } : null
    ].filter(Boolean)
  };

  const existingUser = await userModel.findOne(query).select('_id email contactNumber accountCode accountName');

  if (!existingUser) return;

  if (email && existingUser.email === email.toLowerCase()) {
    throw new Error('Email is already registered');
  }

  if (contactNumber && existingUser.contactNumber === contactNumber) {
    throw new Error('Contact number is already registered');
  }

  if (accountCode && existingUser.accountCode === accountCode) {
    throw new Error('Account code is already registered');
  }

  if (accountName && existingUser.accountName === accountName) {
    throw new Error('Account name is already registered');
  }
};

exports.addDemoUser = async (body) => {
  try {
    // sanitizeDemoUserBody now fills parentIds based on userType level=1
    const sanitizedBody = await sanitizeDemoUserBody(body);

    // save user
    const data = await exports.saveUser(sanitizedBody);

    // create opening cash ledger
    const { saveCashLedger } = require('../services/ProfitLossService');
    await saveCashLedger({
      userId: data._id,
      transactionType: 'RECEIPT',
      remarks: 'Demo account opening balance (Point In)',
      date: new Date(),
      amount: 10000,
      createdBy: data._id
    });

    // create quantity settings for this demo user for all markets
    // (reuses market list from MarketType)
    await exports.createQtySettingsForUser(data._id);

    // tokens
    const acesstoken = await generateAccessToken(data);
    const refreshtoken = await generateRefreshToken(data);

    // store refresh token in redis
    storeRefreshTokenInRedis(data._id, refreshtoken);

    return { user: data, acesstoken, refreshtoken };
  } catch (error) {
    console.error('Error adding demo user:', error);
    throw error;
  }
};
async function sanitizeDemoUserBody(body) {
  // 🔹 1. Fetch CUSTOMER user type
  const customerType = await userTypeModel.findOne({ name: 'CUSTOMER' }).select('_id').lean();

  if (!customerType) {
    throw new Error('CUSTOMER user type not found');
  }

  // 🔹 2. Fetch ALL markets
  const markets = await MarketType.find({}).select('id name').lean();

  // 🔹 3. Build marketAccess using `id` (NOT _id)
  const marketAccess = markets.map((market) => ({
    marketId: market.id, // ✅ STRING id (as requested)
    marketName: market.name,
    isSelected: false, // demo default
    brokerage: {}, // schema defaults apply
    margin: {
      totalMargin: 0,
      totalLotWise: 5,
      maximumLimit: 10,
      lotOrAmount: 'lot'
    },
    other: {}
  }));

  const country = body.country?.trim() || '';
  // 🔹 4. Populate parentIds from users who have userType level = 1
  let parentIds = [];
  try {
    const getLevel = await userTypeModel.findOne({ level: 1 }).lean();
    if (getLevel) {
      // find users whose accountType equals that userType._id
      const parents = await userModel.find({ accountType: getLevel._id }).select('_id').lean();
      parentIds = parents.map((p) => p._id);
    }
  } catch (err) {
    // don't throw — parentIds is best-effort; log for debugging
    console.error('Error populating parentIds for demo user:', err);
  }
  let createdBy = null;

  try {
    // Super Admin / Master userType (adjust level if needed)
    const superAdminType = await userTypeModel.findOne({ level: 1 }).lean();

    if (superAdminType) {
      // console.log("Super Admin Type found:", superAdminType);

      const superAdmin = await userModel
        .findOne({
          accountType: new mongoose.Types.ObjectId(superAdminType._id)
        })
        .select('_id accountCode accountName accountType')
        .lean();

      // console.log("Super Admin found:", superAdmin);
      if (superAdmin) {
        createdBy = {
          userId: superAdmin._id,
          level: superAdminType.level,
          label: superAdminType.name || 'Master',
          accountCode: superAdmin.accountCode,
          accountName: superAdmin.accountName
        };
      }
    }
  } catch (err) {
    console.error('Error setting createdBy for demo user:', err);
  }

  return {
    // 🔹 UI fields
    accountName: body.name?.trim(),
    email: body.email?.trim().toLowerCase(),
    contactNumber: body.contactNumber?.trim(),
    password: body.password,

    // 🔹 FORCED account type
    accountType: customerType._id,

    // 🔹 system generated
    accountCode: body.accountCode,

    // 🔒 demo flag
    demoid: true,

    // 🔹 safe defaults
    partnership: [],
    parentIds, // <-- populated from level=1 users (best-effort)
    createdBy,
    country,

    basicDetails: {
      ledgerView: 1,
      viewOnlyAccess: 0,
      limitSLDisabled: 1,
      modificationAccess: 1,
      onlyPositionSquareOff: 0,
      manualTradeAllowed: 1,
      masterCount: 0,
      customerCount: 0,
      brokerageRefreshAllowed: 0,
      brokerCount: 0,
      summaryPostFix: '',
      remark: 'Demo User',
      brokerPartnership: []
    },
    // 🔹 ATTACHED MARKETS (IMPORTANT PART)
    marketAccess,
    accountDetails: body.accountDetails || {},

    status: true,
    isBlocked: false,
    firstPass: true,
    loginAttempts: 0,
    ledger: 0
  };
}

exports.createQtySettingsForUser = async function (userId) {
  try {
    const markets = await MarketType.find({}).select('id name').lean();
    if (!markets || markets.length === 0) return;

    const bulk = markets.map((m) => ({
      clientId: userId,
      marketId: m.id,
      marketName: m.name,
      scriptId: '999',
      scriptName: 'All',
      qtySetting: 'Lot',
      perStrikePosition: 0,
      isRange: false,
      startRange: 0,
      endRange: 0,
      minOrder: 0.1,
      maxOrder: 10,
      positionLimit: 1000,
      buySellVariation: 0,
      variationStartTime: "",
      variationEndTime: "",
      createdBy: userId
    }));

    // Use your quantity settings model/collection. If your model name is different,
    // replace QuantitySettingModel with the correct model variable.
    await QuantitySettingModel.insertMany(bulk, { ordered: false });
  } catch (err) {
    // best-effort: log and continue
    console.error('Error creating quantity settings for demo user:', err);
  }
};

exports.saveUser = async (userDetails) => {
  try {
    if (Array.isArray(userDetails.marketAccess)) {
      userDetails.marketAccess = userDetails.marketAccess.map((market) => {
        if (market.other) {
          market.other.shortSellAllowed =
            market.other.shortSellAllowed === '' || market.other.shortSellAllowed === null || market.other.shortSellAllowed === undefined
              ? false
              : Boolean(market.other.shortSellAllowed);
          market.other.limitOrderAllowed =
            market.other.limitOrderAllowed === '' || market.other.limitOrderAllowed === null || market.other.limitOrderAllowed === undefined
              ? false
              : Boolean(market.other.limitOrderAllowed);
        }
        return market;
      });
    }
    const user = new userModel(userDetails);
    return await user.save();
  } catch (error) {
    console.error('Error fetching data:', error);
    throw error;
  }
};

exports.getUserById = async (id) => {
  try {
    return await userModel
      .findOne({ _id: id, isDeleted: false })
      // .select({ password: 0, "basicDetails.transactionPassword": 0 })
      .populate('accountType', 'label level')
      .lean();
  } catch (error) {
    console.error('Error fetching data:', error);
    throw error;
  }
};

// Helper function for brokers to get only their mapped clients
const getBrokerClientsForGetUsers = async (brokerId, isDemo, filterMode) => {
  try {
    const brokerObjectId = new mongoose.Types.ObjectId(brokerId);
    const brokerIdStr = brokerId.toString();

    // Get the customer type (level 7)
    const userType = await userTypeModel.findOne({ level: 7 }).lean();
    if (!userType) {
      throw new Error('Customer type (level 7) not found');
    }

    // Build match filter for clients with this broker in brokerPartnership
    const matchFilter = {
      accountType: userType._id,
      'basicDetails.brokerPartnership': { $exists: true, $ne: [] },
      isDeleted: false
    };

    // Apply demo filter
    if (isDemo !== null) {
      matchFilter.demoid = isDemo ? true : { $ne: true };
    }

    // Apply filterMode for broker's clients:
    // "MY" = only clients created directly by this broker (createdBy.userId)
    // "all" = all clients who have this broker in their partnership (no parentIds filter)
    if (filterMode === 'MY') {
      matchFilter['createdBy.userId'] = brokerId;
    }
    // For "all" mode, we don't add parentIds filter because brokers
    // should see ALL clients who have them in brokerPartnership,
    // regardless of hierarchy position

    // Aggregate to filter by broker partnership
    const clients = await userModel.aggregate([
      {
        $match: matchFilter
      },
      {
        $addFields: {
          // Add a field to track original broker count before unwind
          originalBrokerCount: { $size: '$basicDetails.brokerPartnership' }
        }
      },
      {
        $unwind: '$basicDetails.brokerPartnership'
      },
      {
        $addFields: {
          'basicDetails.brokerPartnership.brokerObjectId': {
            $cond: {
              if: { $eq: [{ $type: '$basicDetails.brokerPartnership.broker' }, 'string'] },
              then: { $toObjectId: '$basicDetails.brokerPartnership.broker' },
              else: '$basicDetails.brokerPartnership.broker'
            }
          }
        }
      },
      {
        $match: {
          $or: [
            { 'basicDetails.brokerPartnership.brokerObjectId': brokerObjectId },
            { 'basicDetails.brokerPartnership.broker': brokerIdStr },
            { 'basicDetails.brokerPartnership.broker': brokerObjectId }
          ]
        }
      },
      {
        $lookup: {
          from: 'usertypes',
          localField: 'accountType',
          foreignField: '_id',
          as: 'accountType'
        }
      },
      {
        $unwind: '$accountType'
      },
      {
        $project: {
          'basicDetails.transactionPassword': 0
        }
      },
      {
        $addFields: {
          brokerCount: '$originalBrokerCount'
        }
      },
      {
        $sort: { accountName: 1 }
      }
    ]);

    // Get client IDs for sub-user counts
    const clientIds = clients.map(client => client._id.toString());
    const subUsersCountMap = clientIds.length > 0 ? await getLevelWiseCount(clientIds) : {};

    return {
      userType,
      users: clients.map((client) => {
        const subUsersCount = subUsersCountMap[client._id.toString()] || [];
        return {
          ...client,
          subUsersCount
        };
      })
    };
  } catch (error) {
    console.error('Error in getBrokerClientsForGetUsers:', error);
    throw error;
  }
};

// exports.getUsers = async (userId, accountTypeId, level = '', isDemo = false, filterMode = 'all') => {
//   try {
//     let userType = null;
//     if (accountTypeId) {
//       userType = await userTypeModel.findOne({ _id: accountTypeId }).lean();

//       if (!userType) {
//         throw new Error('User type not found');
//       }
//     }

//     // Use isDemo to filter specifically for demo or non-demo users
//     const matchFilter = {
//       isDeleted: false
//     };

//     // Apply user filter: "all" = all downline (parentIds), "MY" = only created by me (createdBy.userId)
//     if (filterMode === 'MY') {
//       matchFilter['createdBy.userId'] = userId;
//     } else {
//       matchFilter.parentIds = userId;
//     }

//     if (isDemo !== null) {
//       matchFilter.demoid = isDemo ? true : { $ne: true };
//     }

//     if (accountTypeId) {
//       matchFilter.accountType = accountTypeId;
//     }

//     const users = await userModel
//       .find(matchFilter)
//       .select({ 'basicDetails.transactionPassword': 0 })
//       .populate('accountType', 'label level')
//       .lean();
//     const userIds = users.map((user) => user._id.toString());

//     const subUsersCountMap = await getLevelWiseCount(userIds);
//     // Admin listing: use direct-parent count for clients (level 7) so "Client Count" = only directly created clients
//     let directCountMap = null;
//     if (userType && userType.level === 2) {
//       directCountMap = await getDirectLevelWiseCount(userIds);
//     }

//     return {
//       userType,
//       users: users.map((user) => {
//         let subUsersCount = subUsersCountMap[user._id.toString()] || [];
//         if (userType && userType.level === 2 && directCountMap) {
//           const directCounts = directCountMap[user._id.toString()] || [];
//           const directClient = directCounts.find((c) => c.level === 7);
//           if (directClient) {
//             subUsersCount = subUsersCount.filter((c) => c.level !== 7);
//             subUsersCount.push(directClient);
//           }
//         }
//         return {
//           ...user,
//           subUsersCount
//         };
//       })
//     };
//     // return {
//     //   userType,
//     //   users: users.map((user) => ({
//     //     ...user,
//     //     subUsersCount: subUsersCountMap[user._id.toString()] || [],
//     //   })),
//     // };
//   } catch (error) {
//     console.error('Error fetching data:', error);
//     throw error;
//   }
// };
exports.getUsers = async (userId, accountTypeId, level = '', isDemo = false, filterMode = 'all', dateFilter = {}) => {
  try {
    // Fetch requester's level from userId
    const requester = await userModel.findById(userId).populate('accountType', 'level').select('accountType').lean();
    const requesterLevel = requester?.accountType?.level;

    let userType = null;
    if (accountTypeId) {
      userType = await userTypeModel.findOne({ _id: accountTypeId }).lean();

      if (!userType) {
        throw new Error('User type not found');
      }
    }

    // Special handling for broker (level 6) requesting clients (level 7)
    // They should only see clients who have them in brokerPartnership
    if (requesterLevel === 6 && userType && userType.level === 7) {
      // Use the broker-specific query to get only their mapped clients
      return await getBrokerClientsForGetUsers(userId, isDemo, filterMode);
    }

    // Use isDemo to filter specifically for demo or non-demo users
    const matchFilter = {
      isDeleted: false
    };

    // Apply user filter: "all" = all downline (parentIds), "MY" = only created by me (createdBy.userId)
    if (filterMode === 'MY') {
      matchFilter['createdBy.userId'] = userId;
    } else {
      matchFilter.parentIds = userId;
    }

    // Join date range filter (inclusive: after = start of day, before = end of day)
    const { joinAfter, joinBefore } = dateFilter;
    if (joinAfter || joinBefore) {
      matchFilter.createdAt = {};
      if (joinAfter) matchFilter.createdAt.$gte = new Date(joinAfter + 'T00:00:00.000Z');
      if (joinBefore) matchFilter.createdAt.$lte = new Date(joinBefore + 'T23:59:59.999Z');
    }



    if (isDemo !== null) {
      matchFilter.demoid = isDemo ? true : { $ne: true };
    }

    if (accountTypeId) {
      matchFilter.accountType = accountTypeId;
    }

    const users = await userModel
      .find(matchFilter)
      .select({ 'basicDetails.transactionPassword': 0 })
      .populate('accountType', 'label level')
      .lean();
    const userIds = users.map((user) => user._id.toString());

    const subUsersCountMap = await getLevelWiseCount(userIds);
    
    // Admin listing: use direct-parent count for clients (level 7) so "Client Count" = only directly created clients
    let directCountMap = null;
    if (userType && userType.level === 2) {
      directCountMap = await getDirectLevelWiseCount(userIds);
    }

    // Broker listing: get broker client details based on brokerPartnership
    let brokerClientDetailsMap = null;
    if (userType && userType.level === 6) {
      brokerClientDetailsMap = await getBrokerClientCountMap(userIds);
    }

    // Fetch customer type once for reuse
    const customerType = await userTypeModel.findOne({ level: 7 }).select('_id label').lean();

    // Batch-fetch createdBy user details (level + accountType label) for all users
    const creatorIds = [...new Set(
      users.map(u => u.createdBy?.userId).filter(id => id && mongoose.isValidObjectId(id))
    )];
    const creatorDocs = creatorIds.length
      ? await userModel
          .find({ _id: { $in: creatorIds } })
          .select('_id accountType')
          .populate('accountType', 'label level')
          .lean()
      : [];
    const creatorMap = {};
    creatorDocs.forEach(c => {
      creatorMap[c._id.toString()] = {
        level: c.accountType?.level ?? null,
        label: c.accountType?.label ?? null
      };
    });

    return {
      userType,
      users: users.map((user) => {
        let subUsersCount = subUsersCountMap[user._id.toString()] || [];
        let brokerClients = null;

        // Admin listing: replace client count with direct count
        if (userType && userType.level === 2 && directCountMap) {
          const directCounts = directCountMap[user._id.toString()] || [];
          const directClient = directCounts.find((c) => c.level === 7);
          if (directClient) {
            subUsersCount = subUsersCount.filter((c) => c.level !== 7);
            subUsersCount.push(directClient);
          }
        }

        // Broker listing: add broker client count and detailed client information
        if (userType && userType.level === 6 && brokerClientDetailsMap && customerType) {
          const brokerClientDetails = brokerClientDetailsMap[user._id.toString()];
          if (brokerClientDetails && brokerClientDetails.users && brokerClientDetails.users.length > 0) {
            const brokerClientCount = brokerClientDetails.users.length;

            // Store the detailed client information (brokerCount is already included in each user)
            brokerClients = brokerClientDetails;

            // Check if client count already exists in subUsersCount
            const existingClientCount = subUsersCount.find((c) => c.level === 7);
            if (existingClientCount) {
              // Update existing count
              existingClientCount.count = brokerClientCount;
            } else {
              // Add new client count entry
              subUsersCount.push({
                level: 7,
                label: customerType.label,
                count: brokerClientCount,
                accountTypeId: customerType._id
              });
            }
          }
        }

        const creatorId = user.createdBy?.userId?.toString();
        const createdByInfo = creatorId && creatorMap[creatorId]
          ? creatorMap[creatorId]
          : { level: user.createdBy?.level ?? null, label: user.createdBy?.label ?? null };

        return {
          ...user,
          createdBy: { ...user.createdBy, level: createdByInfo.level, label: createdByInfo.label },
          subUsersCount,
          ...(brokerClients && { brokerClients })
        };
      })
    };
  } catch (error) {
    console.error('Error fetching data:', error);
    throw error;
  }
};

exports.getDirectDownlineUsers = async (userId, accountTypeId, level = '', isDemo = false) => {
  try {
    let userType = null;
    if (accountTypeId) {
      userType = await userTypeModel.findOne({ _id: accountTypeId }).lean();

      if (!userType) {
        throw new Error('User type not found');
      }
    }

    // Use isDemo to filter specifically for demo or non-demo users
    const matchFilter = {
      'createdBy.userId': mongoose.isValidObjectId(userId) ? new mongoose.Types.ObjectId(userId) : userId,
      isDeleted: false
    };

    if (isDemo !== null) {
      matchFilter.demoid = isDemo ? true : { $ne: true };
    }

    if (accountTypeId) {
      matchFilter.accountType = accountTypeId;
    }

    const users = await userModel.find(matchFilter).populate('accountType', 'label level').lean();
    const userIds = users.map((user) => user._id.toString());

    const subUsersCountMap = await getLevelWiseCount(userIds);
    // Admin listing: use direct-parent count for clients (level 7) so "Client Count" = only directly created clients
    let directCountMap = null;
    if (userType && userType.level === 2) {
      directCountMap = await getDirectLevelWiseCount(userIds);
    }

    return {
      userType,
      users: users.map((user) => {
        let subUsersCount = subUsersCountMap[user._id.toString()] || [];
        if (userType && userType.level === 2 && directCountMap) {
          const directCounts = directCountMap[user._id.toString()] || [];
          const directClient = directCounts.find((c) => c.level === 7);
          if (directClient) {
            subUsersCount = subUsersCount.filter((c) => c.level !== 7);
            subUsersCount.push(directClient);
          }
        }
        return {
          ...user,
          subUsersCount
        };
      })
    };
    // return {
    //   userType,
    //   users: users.map((user) => ({
    //     ...user,
    //     subUsersCount: subUsersCountMap[user._id.toString()] || [],
    //   })),
    // };
  } catch (error) {
    console.error('Error fetching data:', error);
    throw error;
  }
};
// Helper function to get broker client details based on brokerPartnership (same structure as getDirectDownlineUsers)
const getBrokerClientCountMap = async (brokerIds) => {
  try {
    // Convert all broker IDs to ObjectIds for matching
    const objectIds = brokerIds.map((id) => {
      if (typeof id === 'string') {
        return new mongoose.Types.ObjectId(id);
      }
      return id;
    });
    
    // First, get the customer type ID (level 7) - this will be our userType
    const userType = await userTypeModel.findOne({ level: 7 }).lean();
    if (!userType) {
      console.error('Customer type (level 7) not found');
      return {};
    }
    
    // Find all clients (level 7) that have brokerPartnership entries
    const clients = await userModel.aggregate([
      {
        $match: {
          accountType: userType._id,
          'basicDetails.brokerPartnership': { $exists: true, $ne: [] },
          isDeleted: false,
          demoid: { $ne: true } // Exclude demo users like in getDownlineUsers
        }
      },
      // Add a field to store the original broker count before unwinding
      {
        $addFields: {
          originalBrokerCount: { $size: '$basicDetails.brokerPartnership' }
        }
      },
      {
        $unwind: '$basicDetails.brokerPartnership'
      },
      {
        $addFields: {
          // Convert broker field to ObjectId if it's a string
          'basicDetails.brokerPartnership.brokerObjectId': {
            $cond: {
              if: { $eq: [{ $type: '$basicDetails.brokerPartnership.broker' }, 'string'] },
              then: { $toObjectId: '$basicDetails.brokerPartnership.broker' },
              else: '$basicDetails.brokerPartnership.broker'
            }
          }
        }
      },
      {
        $match: {
          'basicDetails.brokerPartnership.brokerObjectId': { $in: objectIds }
        }
      },
      {
        $lookup: {
          from: 'usertypes',
          localField: 'accountType',
          foreignField: '_id',
          as: 'accountType'
        }
      },
      {
        $unwind: '$accountType'
      },
      {
        $project: {
          _id: 1,
          accountName: 1,
          accountCode: 1,
          marketAccess: 1,
          brokerId: '$basicDetails.brokerPartnership.brokerObjectId',
          partnership: '$basicDetails.brokerPartnership.partnership',
          originalBrokerCount: 1,
          accountType: {
            _id: '$accountType._id',
            label: '$accountType.label',
            level: '$accountType.level'
          }
        }
      },
      {
        $sort: { accountName: 1 }
      }
    ]);

    // Group clients by broker ID and create detailed map (same structure as getDirectDownlineUsers)
    const brokerClientDetailsMap = {};
    
    // Track unique clients to avoid duplicates
    const processedClients = new Set();
    
    for (const client of clients) {
      const brokerId = client.brokerId ? client.brokerId.toString() : 'null';
      const clientId = client._id.toString();
      
      if (!brokerClientDetailsMap[brokerId]) {
        brokerClientDetailsMap[brokerId] = {
          userType,
          users: []
        };
      }
      
      // Only add each client once per broker (avoid duplicates from multiple markets)
      if (!processedClients.has(`${brokerId}-${clientId}`)) {
        processedClients.add(`${brokerId}-${clientId}`);
        
        brokerClientDetailsMap[brokerId].users.push({
          _id: client._id,
          accountName: client.accountName,
          accountCode: client.accountCode,
          marketAccess: client.marketAccess,
          accountType: client.accountType,
          partnership: client.partnership,
          loginTime: client.loginTime,
          brokerCount: client.originalBrokerCount || 0, // Use the count from before unwind
          subUsersCount: [] // Will be populated below if needed
        });
      }
    }

    // Get sub-user counts for all clients
    const allClientIds = [...new Set(clients.map(client => client._id.toString()))];
    const subUsersCountMap = allClientIds.length > 0 ? await getLevelWiseCount(allClientIds) : {};
    
    // Admin listing: use direct-parent count for clients (level 7) so "Client Count" = only directly created clients
    let directCountMap = null;
    if (userType && userType.level === 7) {
      directCountMap = await getDirectLevelWiseCount(allClientIds);
    }

    // Populate subUsersCount for each client in each broker's list
    for (const brokerId in brokerClientDetailsMap) {
      brokerClientDetailsMap[brokerId].users = brokerClientDetailsMap[brokerId].users.map((client) => {
        let subUsersCount = subUsersCountMap[client._id.toString()] || [];
        
        // Apply direct count logic if needed (similar to getDirectDownlineUsers)
        if (userType && userType.level === 7 && directCountMap) {
          const directCounts = directCountMap[client._id.toString()] || [];
          subUsersCount = directCounts.length > 0 ? directCounts : subUsersCount;
        }
        
        return {
          ...client,
          subUsersCount
        };
      });
    }

    return brokerClientDetailsMap;
  } catch (error) {
    console.error('Error in getBrokerClientCountMap:', error);
    throw error;
  }
};
const getLevelWiseCount = async (userIds) => {
  try {
    const objectIds = userIds.map((id) => (mongoose.isValidObjectId(id) ? new mongoose.Types.ObjectId(id) : id));
    // To be safe, match both ObjectIds and the original strings if they are different
    const matchIds = Array.from(new Set([...objectIds, ...userIds]));

    const usersCount = await userModel.aggregate([
      {
        $match: {
          'createdBy.userId': { $in: matchIds },
          isDeleted: false
        }
      },
      {
        $lookup: {
          from: 'usertypes',
          localField: 'accountType',
          foreignField: '_id',
          as: 'account_type'
        }
      },
      {
        $unwind: '$account_type'
      },
      {
        $group: {
          _id: { userId: '$createdBy.userId', level: '$account_type.level' },
          label: { $first: '$account_type.label' },
          accountTypeId: { $first: '$account_type._id' },
          count: { $sum: 1 }
        }
      },
      {
        $project: {
          _id: 0,
          userId: '$_id.userId',
          level: '$_id.level',
          accountTypeId: 1,
          label: 1,
          count: 1
        }
      }
    ]);

    const subUsersCountMap = usersCount.reduce((map, { userId, level, label, count, accountTypeId }) => {
      const key = userId ? userId.toString() : 'null';
      if (!map[key]) map[key] = [];
      map[key].push({ level, label, count, accountTypeId });
      return map;
    }, {});

    return subUsersCountMap;
  } catch (error) {
    console.error('Error fetching data:', error);
    throw error;
  }
};

exports.getLevelWiseCount = getLevelWiseCount;
const getDirectLevelWiseCount = async (userIds) => {
  try {
    const objectIds = userIds.map((id) => (typeof id === 'string' ? new mongoose.Types.ObjectId(id) : id));
    const usersCount = await userModel.aggregate([
      {
        $match: {
          $expr: { $in: [{ $arrayElemAt: ['$parentIds', -1] }, objectIds] },
          isDeleted: false
        }
      },
      {
        $lookup: {
          from: 'usertypes',
          localField: 'accountType',
          foreignField: '_id',
          as: 'account_type'
        }
      },
      {
        $unwind: '$account_type'
      },
      {
        $group: {
          _id: {
            userId: { $arrayElemAt: ['$parentIds', -1] },
            level: '$account_type.level'
          },
          label: { $first: '$account_type.label' },
          accountTypeId: { $first: '$account_type._id' },
          count: { $sum: 1 }
        }
      },
      {
        $project: {
          _id: 0,
          userId: '$_id.userId',
          level: '$_id.level',
          accountTypeId: 1,
          label: 1,
          count: 1
        }
      }
    ]);

    const subUsersCountMap = usersCount.reduce((map, { userId, level, label, count, accountTypeId }) => {
      const key = userId && userId.toString ? userId.toString() : String(userId);
      if (!map[key]) map[key] = [];
      map[key].push({ level, label, count, accountTypeId });
      return map;
    }, {});

    return subUsersCountMap;
  } catch (error) {
    console.error('Error in getDirectLevelWiseCount:', error);
    throw error;
  }
};

exports.getBannedUsersList = async (userId, { page = 1, limit = 10, search, market, script, client, broker, master }) => {
  // console.log("getBannedUsersList called with:", { userId, page, limit, search, market, script, client, broker, master });
  try {
    // Ensure IDs are ObjectIds
    // userId might already be an object or string, safe to cast
    const requiredParents = [new mongoose.Types.ObjectId(userId)];

    // Add explicit hierarchy filters if provided, casting to ObjectId
    if (master) requiredParents.push(new mongoose.Types.ObjectId(master));
    if (broker) requiredParents.push(new mongoose.Types.ObjectId(broker));

    const query = {
      parentIds: { $all: requiredParents },
      isDeleted: false
    };

    // If a specific client is requested, filter by _id (casted to ObjectId)
    if (client) {
      query._id = new mongoose.Types.ObjectId(client);
    }

    // Exclude demo users
    query.demoid = { $ne: true };

    const elemMatchMatch = {};

    // Initial loose filtering at DB level
    if (market) {
      elemMatchMatch['marketId'] = market;
    }

    // Ensure blockScript is not empty (check for size > 0)
    elemMatchMatch['other.blockScript'] = { $not: { $size: 0 } };

    query.marketAccess = { $elemMatch: elemMatchMatch };

    // Search filter (name or code)
    if (search) {
      query.$or = [{ accountName: { $regex: search, $options: 'i' } }, { accountCode: { $regex: search, $options: 'i' } }];
    }

    // Fetch ALL potential users matching broader criteria (no skip/limit yet)
    // We paginate in memory after filtering invalid scripts to ensure accurate total count of *effectively* banned users
    const allMatchingUsers = await userModel
      .find(query)
      .select(
        'accountName accountCode marketAccess.marketName marketAccess.marketId marketAccess.other.blockScript marketAccess.other.isTransferred'
      )
      .populate({
        path: 'marketAccess.other.blockScript.bannedBy',
        select: 'accountName accountCode'
      })
      .lean();

    // Process and filter in memory
    const validUsers = allMatchingUsers
      .map((user) => {
        const markets = (user.marketAccess || [])
          .filter((m) => m.other && m.other.blockScript && m.other.blockScript.length > 0)
          .map((m) => {
            // Strictly apply market filter
            if (market && m.marketId != market) return null;

            let validScripts = [];

            m.other.blockScript.forEach((s) => {
              // Handle String (legacy)
              if (typeof s === 'string') {
                if (String(s).trim() !== '') {
                  if (!script || s.toLowerCase().includes(script.toLowerCase())) {
                    validScripts.push({ scriptName: s, bannedBy: null });
                  }
                }
              }
              // Handle Object (new schema)
              else if (s && typeof s === 'object') {
                if (s.scriptName) {
                  if (!script || s.scriptName.toLowerCase().includes(script.toLowerCase())) {
                    validScripts.push({
                      scriptName: s.scriptName,
                      bannedBy: s.bannedBy ? { accountName: s.bannedBy.accountName, accountCode: s.bannedBy.accountCode } : null
                    });
                  }
                }
              }
            });

            if (validScripts.length === 0) return null;

            return {
              marketName: m.marketName,
              marketId: m.marketId,
              bannedScripts: validScripts,
              isTransferred: m.other?.isTransferred || false
            };
          })
          .filter(Boolean); // Remove nulls

        if (markets.length === 0) return null;

        return {
          _id: user._id,
          accountName: user.accountName,
          accountCode: user.accountCode,
          markets: markets
        };
      })
      .filter(Boolean); // Only keep users with at least one valid banned script

    // Apply Pagination on the filtered list
    const total = validUsers.length;
    const startIndex = (page - 1) * limit;
    const endIndex = startIndex + parseInt(limit);
    const paginatedData = validUsers.slice(startIndex, endIndex);

    return {
      data: paginatedData,
      pagination: {
        total,
        page: parseInt(page),
        limit: parseInt(limit),
        totalPages: Math.ceil(total / limit)
      }
    };
  } catch (error) {
    console.error('Error in getBannedUsersList:', error);
    throw error;
  }
};

exports.getDownlineCount = async (userId, filterLevel) => {
  try {
    return await userModel.aggregate([
      {
        $match: {
          'createdBy.userId': userId,
          isDeleted: false
        }
      },
      {
        $lookup: {
          from: 'usertypes',
          localField: 'accountType',
          foreignField: '_id',
          as: 'account_type'
        }
      },
      {
        $unwind: '$account_type'
      },
      {
        $project: {
          levelGroup: {
            $cond: {
              if: {
                $and: [{ $gte: ['$account_type.level', filterLevel] }, { $lte: ['$account_type.level', 5] }]
              },
              then: 'Master',
              else: {
                $cond: {
                  if: { $eq: ['$account_type.level', 7] },
                  then: 'Customer',
                  else: 'Broker'
                }
              }
            }
          }
        }
      },
      {
        $group: {
          _id: '$levelGroup',
          count: { $sum: 1 }
        }
      }
    ]);
  } catch (error) {
    console.error('Error fetching data:', error);
    throw error;
  }
};

exports.getUserMargins = async (matchCondition) => {
  try {
    return await userModel.aggregate([
      {
        $match: matchCondition
      },
      {
        $unwind: '$marketAccess'
      },
      {
        $project: {
          accountName: 1,
          accountCode: 1,
          marketName: '$marketAccess.marketName',
          totalLotWise: '$marketAccess.margin.totalLotWise',
          totalMargin: '$marketAccess.margin.totalMargin'
        }
      },
      {
        $group: {
          _id: '$accountCode',
          name: { $first: '$accountName' },
          totalMargins: {
            $push: {
              marketName: '$marketName',
              totalLotWise: '$totalLotWise',
              totalMargin: '$totalMargin'
            }
          }
        }
      }
    ]);
  } catch (error) {
    console.error('Error fetching data:', error);
    throw error;
  }
};

exports.getUser = async (match, select) => {
  try {
    return await userModel.findOne(match).populate('accountType', 'level').select(select).lean();
  } catch (error) {
    console.error('Error fetching data:', error);
    throw error;
  }
};

exports.getDownlineLevelUsers = async (userId, level, filterMode = 'all') => {
  try {
    const getLevel = await userTypeModel.findOne({ level }).lean();
    if (!getLevel) {
      return [];
    }

    // Apply user filter: "all" = all downline (parentIds), "MY" = only created by me (createdBy.userId)
    const filter = { accountType: getLevel._id };
    if (filterMode === 'MY') {
      filter['createdBy.userId'] = userId;
    } else {
      filter.parentIds = userId;
    }

    const users = await userModel
      .find(filter)
      .select({ accountName: 1, accountCode: 1, accountType: 1, loginIP: 1, lastLogin: 1, createdAt: 1, marketAccess: 1, createdBy: 1, status: 1, 'basicDetails.onlyPositionSquareOff': 1 })
      .lean();

    // Batch-fetch createdBy user details (name + accountCode)
    const creatorIds = [...new Set(
      users.map(u => u.createdBy?.userId).filter(id => id && mongoose.isValidObjectId(id))
    )];
    const creatorDocs = creatorIds.length
      ? await userModel
          .find({ _id: { $in: creatorIds } })
          .select('_id accountName accountCode')
          .lean()
      : [];
    const creatorMap = {};
    creatorDocs.forEach(c => {
      creatorMap[c._id.toString()] = {
        accountName: c.accountName,
        accountCode: c.accountCode
      };
    });

    return users.map((user) => {
      const creatorId = user.createdBy?.userId?.toString();
      const createdByInfo = creatorId && creatorMap[creatorId]
        ? creatorMap[creatorId]
        : { accountName: null, accountCode: null };

      return {
        ...user,
        createdBy: {
          ...user.createdBy,
          accountName: createdByInfo.accountName,
          accountCode: createdByInfo.accountCode
        }
      };
    });
  } catch (error) {
    console.error('Error fetching data:', error);
    throw error;
  }
};

exports.getDownlineUsers = async (ownUserId, ownAccountType, level, type, search, isDemo = false, filterMode = 'all') => {
  try {
    let query = { isDeleted: false };
    
    // Apply user filter: "all" = all downline (parentIds), "MY" = only created by me (createdBy.userId)
    if (filterMode === 'MY') {
      query['createdBy.userId'] = ownUserId;
    } else {
      query.parentIds = ownUserId;
    }
    
    query.demoid = isDemo ? true : { $ne: true };
    if (level) {
      //if level is provided get downline users based on level
      const getLevel = await userTypeModel.findOne({ level }).lean();
      if (getLevel) {
        query.accountType = getLevel._id;
      }
    } else {
      //if level is not provided get downline users based on type user or master
      if (type == 'Client') {
        const getLevel = await userTypeModel.findOne({ level: 7 }).lean();
        query.accountType = getLevel._id;
      } else if (type == 'Master') {
        const getLevel = await userTypeModel.find({ level: { $gt: ownAccountType.level, $lt: 6 } }).lean();
        query.accountType = { $in: getLevel.map((lvl) => lvl._id) };
      } else if (type == 'Broker') {
        const getLevel = await userTypeModel.findOne({ level: 6 }).lean();
        query.accountType = getLevel._id;
      }
    }
    if (search) {
      query.$or = [{ accountName: { $regex: `^${search}`, $options: 'i' } }, { accountCode: { $regex: `^${search}`, $options: 'i' } }];
    }
    return await userModel
      .find(query)
      .select({ accountName: 1, accountCode: 1, marketAccess: 1 })
      .populate('accountType', 'label name level -_id')
      .lean();
  } catch (error) {
    console.error('Error fetching data:', error);
    throw error;
  }
};



exports.checkPartnership = async (userId, index, compareValue) => {
  try {
    return await userModel
      .find({
        'createdBy.userId': userId,
        $expr: {
          $lt: [{ $arrayElemAt: ['$partnership', index] }, compareValue]
        }
      })
      .select({ partnership: 1 })
      .lean()
      .countDocuments();
  } catch (error) {
    console.error('Error fetching data:', error);
    throw error;
  }
};

exports.getMarketWiseSum = async (userId, exceptUserId = '') => {
  try {
    let exceptMatch = {};
    if (exceptUserId) {
      exceptMatch = { _id: { $ne: new mongoose.Types.ObjectId(exceptUserId) } };
    }
    const result = await userModel.aggregate([
      { $match: { 'createdBy.userId': userId, ...exceptMatch } },
      { $unwind: '$marketAccess' },
      {
        $group: {
          _id: '$marketAccess.marketId',
          marketName: { $first: '$marketAccess.marketName' },
          totalMarginSum: {
            $sum: {
              $toDouble: '$marketAccess.margin.totalMargin'
            }
          },
          totalLotWiseSum: {
            $sum: {
              $toDouble: '$marketAccess.margin.totalLotWise'
            }
          }
        }
      },
      {
        $project: {
          _id: 0,
          marketId: '$_id',
          marketName: 1,
          totalMarginSum: 1,
          totalLotWiseSum: 1
        }
      }
    ]);

    return result;
  } catch (error) {
    console.error('Error in getMarketWiseSums:', error);
    throw error;
  }
};

exports.updateUser = async (userDetails, userId, ip, edit_by) => {
  try {
    const oldDetails = await userModel.findOne({ _id: userId }).lean();

    // Handle bannedBy logic in blockScript
    if (userDetails.marketAccess && oldDetails) {
      userDetails.marketAccess = userDetails.marketAccess.map((newMarket) => {
        if (newMarket.other && newMarket.other.blockScript) {
          const oldMarket = oldDetails.marketAccess.find((m) => m.marketId == newMarket.marketId);

          newMarket.other.blockScript = newMarket.other.blockScript.map((script) => {
            // Handle if script is just a string (from frontend) or object
            const scriptName = typeof script === 'string' ? script : script.scriptName;
            const scriptId = typeof script === 'object' ? script.scriptId : undefined;

            if (!scriptName) return script; // fallback

            let bannedBy = edit_by; // Default to current editor

            // Check if this script was already banned
            if (oldMarket && oldMarket.other && oldMarket.other.blockScript) {
              const existingBlock = oldMarket.other.blockScript.find((b) => {
                const bName = typeof b === 'string' ? b : b.scriptName;
                return bName === scriptName;
              });

              if (existingBlock) {
                // If it was already blocked, prefer the original banner
                if (typeof existingBlock === 'object' && existingBlock.bannedBy) {
                  bannedBy = existingBlock.bannedBy;
                } else {
                  // If legacy (no bannedBy), we assign the current editor as they are "re-affirming" the ban
                  bannedBy = edit_by;
                }
              }
            }

            return {
              scriptName,
              scriptId,
              bannedBy
            };
          });
        }
        return newMarket;
      });
    }
    // Sanitize BSON Long objects (e.g. { low, high, unsigned }) that MongoDB may
    // return for large Number fields. Mongoose cannot cast them back to Number,
    // so we convert them to plain JS numbers here before the update.
    const bsonLongToNumber = (val) => {
      if (val && typeof val === 'object' && 'low' in val && 'high' in val) {
        // Reconstruct the 64-bit integer: high * 2^32 + (low treated as unsigned)
        const lo = val.low >>> 0; // unsigned 32-bit
        return val.high * 4294967296 + lo;
      }
      return val;
    };

    if (userDetails.marketAccess) {
      userDetails.marketAccess = userDetails.marketAccess.map((market) => {
        if (market.margin) {
          if (market.margin.totalMargin !== undefined) {
            market.margin.totalMargin = bsonLongToNumber(market.margin.totalMargin);
          }
          if (market.margin.maximumLimit !== undefined) {
            market.margin.maximumLimit = bsonLongToNumber(market.margin.maximumLimit);
          }
          if (market.margin.totalLotWise !== undefined) {
            market.margin.totalLotWise = bsonLongToNumber(market.margin.totalLotWise);
          }
        }
        if (market.other) {
          if (market.other.shortSellAllowed === '' || market.other.shortSellAllowed === null || market.other.shortSellAllowed === undefined) {
            market.other.shortSellAllowed = false;
          } else {
            market.other.shortSellAllowed = Boolean(market.other.shortSellAllowed);
          }
          if (market.other.limitOrderAllowed === '' || market.other.limitOrderAllowed === null || market.other.limitOrderAllowed === undefined) {
            market.other.limitOrderAllowed = false;
          } else {
            market.other.limitOrderAllowed = Boolean(market.other.limitOrderAllowed);
          }
        }
        return market;
      });
    }

    const resp = await userModel.findOneAndUpdate({ _id: userId }, userDetails, { new: true }); //.populate("accountType", "label level");
    insertUserEditLog(oldDetails, resp, ip, edit_by);
    return resp; // await userModel.updateOne({ _id: userId }, userDetails);
  } catch (error) {
    console.error('Error updating data:', error);
    throw error;
  }
};

const insertUserEditLog = async (oldDetails, newDetails, ip, edit_by) => {
  const oldMarkets = {};
  for (const element of oldDetails.marketAccess) {
    oldMarkets[element.marketName] = element;
  }
  const newMarkets = {};
  for (const element of newDetails.marketAccess) {
    newMarkets[element.marketName] = element;
  }
  //console.log(oldMarkets)
  const log = {
    clientId: oldDetails._id,
    parentIds: oldDetails.parentIds,
    accountType: oldDetails.accountType,
    createdAt: oldDetails.createdAt,
    basic: [
      {
        log: 'Old',
        alertper: oldDetails.accountDetails.alertPercent,
        m2mLimit: oldDetails.accountDetails.m2mLoss_NSE_MCX_NOPT,
        m2mLinkedLedger: oldDetails.accountDetails.m2mLinkedWithLedger,
        broker: oldDetails.basicDetails.brokerPartnership.map((m) => `${m.broker.accountName} (${m.partnership}%)`),
        p: oldDetails.partnership[oldDetails.partnership.length - 1],
        hl: oldDetails.accountDetails.orderBetweenHighLow,
        autoSquare: oldDetails.accountDetails.weeklyAutoSquare,
        iautoSquare: oldDetails.accountDetails.intraDayAutoSquare,
        squareOff: oldDetails.accountDetails.onlyPositionSquareOff,
        uplineSquareOff: oldDetails.accountDetails.m2m_square_off,
        m2mNSE_EQ: oldDetails.accountDetails.m2mLoss_NSEEQ,
        applyNSE_EQ: oldDetails.accountDetails.applyAutoSquare_NSEEQ,
        nseFirstSell: '',
        nseUnmatched: '',
        nseScriptL: '',
        mcxFirstSell: '',
        mcxUnmatched: '',
        mcxScriptL: '',
        nseMargin:
          (oldMarkets['NSE-FO']?.margin?.totalMargin || oldMarkets['NSE-FO']?.margin?.totalLotWise || oldMarkets['NSE']?.margin?.totalMargin || oldMarkets['NSE']?.margin?.totalLotWise || 0) +
          ' - in ' +
          (oldMarkets['NSE-FO']?.margin?.lotOrAmount || oldMarkets['NSE']?.margin?.lotOrAmount || 'amount'),
        mcxMargin:
          (oldMarkets['MCX']?.margin?.totalMargin || oldMarkets['MCX']?.margin?.totalLotWise || 0) +
          ' - in ' +
          (oldMarkets['MCX']?.margin?.lotOrAmount || 'amount'),
        noptMargin:
          (oldMarkets['NOPT']?.margin?.totalMargin || oldMarkets['NOPT']?.margin?.totalLotWise || 0) +
          ' - in ' +
          (oldMarkets['NOPT']?.margin?.lotOrAmount || 'amount'),
        forexMargin:
          (oldMarkets['FOREX']?.margin?.totalMargin || oldMarkets['FOREX']?.margin?.totalLotWise || 0) +
          ' - in ' +
          (oldMarkets['FOREX']?.margin?.lotOrAmount || 'amount'),
        comexMargin:
          (oldMarkets['COMEX']?.margin?.totalMargin || oldMarkets['COMEX']?.margin?.totalLotWise || 0) +
          ' - in ' +
          (oldMarkets['COMEX']?.margin?.lotOrAmount || 'amount'),
        nseEqMargin:
          (oldMarkets['NSE-EQ']?.margin?.totalMargin || oldMarkets['NSE-EQ']?.margin?.totalLotWise || 0) +
          ' - in ' +
          (oldMarkets['NSE-EQ']?.margin?.lotOrAmount || 'amount')
      },
      {
        log: 'Edit',
        alertper: newDetails.accountDetails.alertPercent,
        m2mLimit: newDetails.accountDetails.m2mLoss_NSE_MCX_NOPT,
        m2mLinkedLedger: newDetails.accountDetails.m2mLinkedWithLedger,
        broker: newDetails.basicDetails.brokerPartnership.map((m) => `${m.broker.accountName} (${m.partnership})%`),
        p: newDetails.partnership[newDetails.partnership.length - 1],
        hl: newDetails.accountDetails.orderBetweenHighLow,
        autoSquare: newDetails.accountDetails.weeklyAutoSquare,
        iautoSquare: newDetails.accountDetails.intraDayAutoSquare,
        squareOff: newDetails.accountDetails.onlyPositionSquareOff,
        uplineSquareOff: newDetails.accountDetails.m2m_square_off,
        m2mNSE_EQ: newDetails.accountDetails.m2mLoss_NSEEQ,
        applyNSE_EQ: newDetails.accountDetails.applyAutoSquare_NSEEQ,
        nseFirstSell: '',
        nseUnmatched: '',
        nseScriptL: '',
        mcxFirstSell: '',
        mcxUnmatched: '',
        mcxScriptL: '',
        nseMargin:
          (newMarkets['NSE-FO']?.margin?.totalMargin || newMarkets['NSE-FO']?.margin?.totalLotWise || newMarkets['NSE']?.margin?.totalMargin || newMarkets['NSE']?.margin?.totalLotWise || 0) +
          ' - in ' +
          (newMarkets['NSE-FO']?.margin?.lotOrAmount || newMarkets['NSE']?.margin?.lotOrAmount || 'amount'),
        mcxMargin:
          (newMarkets['MCX']?.margin?.totalMargin || newMarkets['MCX']?.margin?.totalLotWise || 0) +
          ' - in ' +
          (newMarkets['MCX']?.margin?.lotOrAmount || 'amount'),
        noptMargin:
          (newMarkets['NOPT']?.margin?.totalMargin || newMarkets['NOPT']?.margin?.totalLotWise || 0) +
          ' - in ' +
          (newMarkets['NOPT']?.margin?.lotOrAmount || 'amount'),
        forexMargin:
          (newMarkets['FOREX']?.margin?.totalMargin || newMarkets['FOREX']?.margin?.totalLotWise || 0) +
          ' - in ' +
          (newMarkets['FOREX']?.margin?.lotOrAmount || 'amount'),
        comexMargin:
          (newMarkets['COMEX']?.margin?.totalMargin || newMarkets['COMEX']?.margin?.totalLotWise || 0) +
          ' - in ' +
          (newMarkets['COMEX']?.margin?.lotOrAmount || 'amount'),
        nseEqMargin:
          (newMarkets['NSE-EQ']?.margin?.totalMargin || newMarkets['NSE-EQ']?.margin?.totalLotWise || 0) +
          ' - in ' +
          (newMarkets['NSE-EQ']?.margin?.lotOrAmount || 'amount')
      }
    ],
    brokerage: [],
    market: [
      {
        log: 'Old',
        market: Object.keys(oldMarkets)
      },
      {
        log: 'Edit',
        market: Object.keys(newMarkets)
      }
    ],
    qty: [],
    ip,
    time: new Date().getTime(),
    edit_by
  };

  for (const market of oldDetails.marketAccess) {
    if (market.brokerage.scriptWiseBrokerage[0]?.script) {
      for (script of market.brokerage.scriptWiseBrokerage) {
        log.brokerage.push({
          log: 'Old',
          market: market.marketName,
          commType: 'Script Wise',
          commPer: market.marketName == 'MCX' ? market.brokerage.type : 'percent',
          script: script.script,
          uDelComm: script.deliveryCommission,
          uIntraComm: script.intradayCommission,
          b1DelComm:
            market.brokerage.brokerCommission?.[0]?.scriptWiseBrokerage?.find((f) => f.script == script.script)?.deliveryCommission || 0,
          b1IntraComm:
            market.brokerage.brokerCommission?.[0]?.scriptWiseBrokerage?.find((f) => f.script == script.script)?.intradayCommission || 0,
          b2DelComm:
            market.brokerage.brokerCommission?.[1]?.scriptWiseBrokerage?.find((f) => f.script == script.script)?.deliveryCommission || 0,
          b2IntraComm:
            market.brokerage.brokerCommission?.[1]?.scriptWiseBrokerage?.find((f) => f.script == script.script)?.intradayCommission || 0,
          b3DelComm:
            market.brokerage.brokerCommission?.[2]?.scriptWiseBrokerage?.find((f) => f.script == script.script)?.deliveryCommission || 0,
          b3IntraComm:
            market.brokerage.brokerCommission?.[2]?.scriptWiseBrokerage?.find((f) => f.script == script.script)?.intradayCommission || 0
        });
      }
    } else {
      log.brokerage.push({
        log: 'Old',
        market: market.marketName,
        commType: 'Same for all',
        commPer: market.marketName == 'MCX' ? market.brokerage.type : 'percent',
        script: '',
        uDelComm: market.brokerage.deliveryCommission,
        uIntraComm: market.brokerage.intradayCommission,
        b1DelComm: market.brokerage.brokerCommission?.[0]?.deliveryCommission,
        b1IntraComm: market.brokerage.brokerCommission?.[0]?.intradayCommission,
        b2DelComm: market.brokerage.brokerCommission?.[1]?.deliveryCommission,
        b2IntraComm: market.brokerage.brokerCommission?.[1]?.intradayCommission,
        b3DelComm: market.brokerage.brokerCommission?.[2]?.deliveryCommission,
        b3IntraComm: market.brokerage.brokerCommission?.[2]?.intradayCommission
      });
    }
  }

  for (const market of newDetails.marketAccess) {
    if (market.brokerage.scriptWiseBrokerage[0]?.script) {
      for (script of market.brokerage.scriptWiseBrokerage) {
        log.brokerage.push({
          log: 'Edit',
          market: market.marketName,
          commType: 'Script Wise',
          commPer: market.marketName == 'MCX' ? market.brokerage.type : 'percent',
          script: script.script,
          uDelComm: script.deliveryCommission,
          uIntraComm: script.intradayCommission,
          b1DelComm:
            market.brokerage.brokerCommission?.[0]?.scriptWiseBrokerage?.find((f) => f.script == script.script)?.deliveryCommission || 0,
          b1IntraComm:
            market.brokerage.brokerCommission?.[0]?.scriptWiseBrokerage?.find((f) => f.script == script.script)?.intradayCommission || 0,
          b2DelComm:
            market.brokerage.brokerCommission?.[1]?.scriptWiseBrokerage?.find((f) => f.script == script.script)?.deliveryCommission || 0,
          b2IntraComm:
            market.brokerage.brokerCommission?.[1]?.scriptWiseBrokerage?.find((f) => f.script == script.script)?.intradayCommission || 0,
          b3DelComm:
            market.brokerage.brokerCommission?.[2]?.scriptWiseBrokerage?.find((f) => f.script == script.script)?.deliveryCommission || 0,
          b3IntraComm:
            market.brokerage.brokerCommission?.[2]?.scriptWiseBrokerage?.find((f) => f.script == script.script)?.intradayCommission || 0
        });
      }
    } else {
      log.brokerage.push({
        log: 'Edit',
        market: market.marketName,
        commType: 'Same for all',
        commPer: market.marketName == 'MCX' ? market.brokerage.type : 'percent',
        script: '',
        uDelComm: market.brokerage.deliveryCommission,
        uIntraComm: market.brokerage.intradayCommission,
        b1DelComm: market.brokerage.brokerCommission?.[0]?.deliveryCommission,
        b1IntraComm: market.brokerage.brokerCommission?.[0]?.intradayCommission,
        b2DelComm: market.brokerage.brokerCommission?.[1]?.deliveryCommission,
        b2IntraComm: market.brokerage.brokerCommission?.[1]?.intradayCommission,
        b3DelComm: market.brokerage.brokerCommission?.[2]?.deliveryCommission,
        b3IntraComm: market.brokerage.brokerCommission?.[2]?.intradayCommission
      });
    }
  }
  await saveLog('userEdit', log);
};

exports.updateManyUser = async (match, userDetails) => {
  try {
    return await userModel.updateMany(match, userDetails);
  } catch (error) {
    console.error('Error updating data:', error);
    throw error;
  }
};

exports.getMarginLimits = async (userId, marketIds, client, broker, master, isDemo = false, userid = null, clientType = null, userLevel = null, isDetail = false) => {
  try {
    const userIdObj = new mongoose.Types.ObjectId(userId);
    const userIdStr = userId.toString();


    const matchFilter = {
      isDeleted: { $ne: true },
      demoid: isDemo ? true : { $ne: true }
    };

    if (master && mongoose.Types.ObjectId.isValid(master) && isDetail) {
      // Drill-down: fetch direct children of master first, then filter pipeline to their _ids.
      const masterObj = new mongoose.Types.ObjectId(master);
      const masterStr = master.toString();
      const directChildren = await userModel.find({
        $or: [
          { 'createdBy.userId': masterStr },
          { 'createdBy.userId': masterObj }
        ],
        isDeleted: { $ne: true }
      }).select('_id').lean();

      if (!directChildren.length) return [];

      matchFilter['_id'] = { $in: directChildren.map(c => c._id) };
    } else if (userid && mongoose.Types.ObjectId.isValid(userid)) {
      // specific user in downline
      matchFilter.parentIds = userIdObj;
      matchFilter._id = new mongoose.Types.ObjectId(userid);
    } else if (clientType === 'ALL') {
      // full downline
      matchFilter['$or'] = [{ parentIds: userIdObj }, { parentIds: userIdStr }];
    } else {
      // MY (default) — direct children only, created by me
      matchFilter['$or'] = [
        { 'createdBy.userId': userIdStr },
        { 'createdBy.userId': userIdObj }
      ];

      const ids = [];
      if (client && mongoose.Types.ObjectId.isValid(client)) ids.push(new mongoose.Types.ObjectId(client));
      if (master && mongoose.Types.ObjectId.isValid(master)) ids.push(new mongoose.Types.ObjectId(master));
      if (ids.length > 0) matchFilter['_id'] = { $in: ids };

      if (broker && mongoose.Types.ObjectId.isValid(broker)) {
        const bObj = new mongoose.Types.ObjectId(broker);
        matchFilter['$or'] = [
          { 'basicDetails.brokerPartnership.broker._id': bObj },
          { 'basicDetails.brokerPartnership.broker._id': broker },
          { 'basicDetails.brokerPartnership.broker': bObj },
          { 'basicDetails.brokerPartnership.broker': broker }
        ];
      }
    }

    // Single aggregation on User model only.
    // total  = user's own marketAccess.margin.totalLotWise (lot) or maximumLimit (amount)
    // used   = sum of direct children's same field (createdBy.userId = this user's _id)
    const pipeline = [
      { $match: matchFilter },
      { $unwind: '$marketAccess' },
      { $match: { 'marketAccess.marketId': { $in: marketIds }, 'marketAccess.isSelected': true } },
      {
        // For each user+market doc, sum direct children's allocated margins for THIS market only.
        // mktId passed into let so the sub-pipeline filters to the exact market — avoids type-mismatch
        // in post-lookup $filter (string vs int marketId comparison would silently return 0).
        $lookup: {
          from: 'users',
          let: {
            uid:    { $toString: '$_id' },
            uidObj: '$_id',
            mktId:  { $toString: '$marketAccess.marketId' }
          },
          pipeline: [
            {
              // Direct children: createdBy.userId == this user's _id (string or ObjectId)
              $match: {
                $expr: {
                  $or: [
                    { $eq: ['$createdBy.userId', '$$uid'] },
                    { $eq: [{ $toString: '$createdBy.userId' }, '$$uid'] }
                  ]
                },
                isDeleted: { $ne: true }
              }
            },
            { $unwind: '$marketAccess' },
            {
              $match: {
                $expr: { $eq: [{ $toString: '$marketAccess.marketId' }, '$$mktId'] }
              }
            },
            {
              $group: {
                _id: null,
                // level-7 children have totalLotWise=null, their cap is in maximumLimit
                // non-level-7 children have totalLotWise set; fall through $ifNull skips maximumLimit
                usedLotWise:  { $sum: { $toDouble: { $ifNull: ['$marketAccess.margin.totalLotWise', '$marketAccess.margin.maximumLimit'] } } },
                usedMaxLimit: { $sum: { $toDouble: { $ifNull: ['$marketAccess.margin.totalMargin',  '$marketAccess.margin.maximumLimit'] } } }
              }
            }
          ],
          as: 'childrenMargins'
        }
      },
      {
        $group: {
          _id: { userId: '$_id', marketId: '$marketAccess.marketId' },
          accountName: { $first: '$accountName' },
          accountCode: { $first: '$accountCode' },
          status:      { $first: '$status' },
          createdBy:   { $first: '$createdBy.userId' },
          marketName:  { $first: '$marketAccess.marketName' },
          lotOrAmount: { $first: '$marketAccess.margin.lotOrAmount' },
          totalLotWise:    { $first: { $toDouble: '$marketAccess.margin.totalLotWise' } },
          totalMarginVal:  { $first: { $toDouble: '$marketAccess.margin.totalMargin' } },
          maximumLimitVal: { $first: { $toDouble: '$marketAccess.margin.maximumLimit' } },
          usedLotWise:     { $first: { $ifNull: [{ $arrayElemAt: ['$childrenMargins.usedLotWise', 0] }, 0] } },
          usedMaxLimit:    { $first: { $ifNull: [{ $arrayElemAt: ['$childrenMargins.usedMaxLimit', 0] }, 0] } }
        }
      },
      {
        $group: {
          _id: '$_id.userId',
          accountName: { $first: '$accountName' },
          accountCode: { $first: '$accountCode' },
          status:      { $first: '$status' },
          createdBy:   { $first: '$createdBy' },
          markets: {
            $push: {
              marketId:    '$_id.marketId',
              marketName:  '$marketName',
              lotOrAmount: '$lotOrAmount',
              totalLotWise:    '$totalLotWise',
              totalMarginVal:  '$totalMarginVal',
              maximumLimitVal: '$maximumLimitVal',
              usedLotWise:     '$usedLotWise',
              usedMaxLimit:    '$usedMaxLimit'
            }
          }
        }
      },
      {
        $project: {
          _id: '$_id',
          userId: '$_id',
          accountName: 1,
          accountCode: 1,
          status: 1,
          createdBy: 1,
          markets: 1
        }
      }
    ];

    const rawResults = await userModel.aggregate(pipeline);

    // Batch-fetch account level for all returned users
    const allUserIds = rawResults.map(u => u._id);
    const userLevelDocs = await userModel.find({ _id: { $in: allUserIds } })
      .populate('accountType', 'level')
      .select('accountType')
      .lean();
    const levelMap = {};
    for (const u of userLevelDocs) {
      levelMap[u._id.toString()] = u.accountType?.level || 0;
    }

    // For level-7 (client) users: compute used from open positions × live price
    const clientUsedMap = {};
    const level7Ids = rawResults.filter(u => levelMap[u._id.toString()] === 7).map(u => u._id);
    if (level7Ids.length > 0) {
      const UserPosition = require('../models/UserPositionModel');
      const { getAllStocksHash } = require('./RedisService');
      const { getActiveWeekValan } = require('./StockService');

      const [currentValan, priceMap] = await Promise.all([getActiveWeekValan(), getAllStocksHash()]);

      const positions = await UserPosition.find({
        userId: { $in: level7Ids },
        marketId: { $in: marketIds },
        valanId: new mongoose.Types.ObjectId(currentValan._id)
      }).lean();

      for (const pos of positions) {
        const uid = pos.userId.toString();
        const mid = pos.marketId;
        if (!clientUsedMap[uid]) clientUsedMap[uid] = {};
        if (!clientUsedMap[uid][mid]) clientUsedMap[uid][mid] = { usedLots: 0, usedAmount: 0 };

        const netLot   = Math.abs((pos.buyLot      || 0) - (pos.sellLot      || 0));
        const netQty   = (pos.buyQuantity || 0) - (pos.sellQuantity || 0);
        const absNetQty = Math.abs(netQty);

        // Live price from Redis; fallback to avg buy/sell price from position record
        const live = priceMap.get(pos.scriptId) || priceMap.get((pos.scriptId || '').toUpperCase());
        let livePrice = 0;
        if (live) {
          livePrice = Number(live.Ltp || live.SellPrice || live.BuyPrice || 0);
        } else {
          livePrice = netQty >= 0
            ? (pos.buyQuantity  > 0 ? (pos.buyPrice  || 0) / pos.buyQuantity  : 0)
            : (pos.sellQuantity > 0 ? (pos.sellPrice || 0) / pos.sellQuantity : 0);
        }

        clientUsedMap[uid][mid].usedLots   += netLot;
        clientUsedMap[uid][mid].usedAmount += absNetQty * livePrice;
      }
    }

    // Format response
    const results = rawResults.map((user) => {
      const userStatus = user.status !== false;
      const isClient   = levelMap[user._id.toString()] === 7;

      const markets = user.markets.map((market) => {
        const isAmount = market.lotOrAmount === 'amount';

        if (!userStatus) {
          return {
            marketId: market.marketId,
            marketName: market.marketName,
            lotOrAmount: market.lotOrAmount,
            totalAllowed: 0,
            totalUsed: 0,
            totalRemaining: 0
          };
        }

        // level 7: cap is always maximumLimit (their personal lot/qty/amount cap)
        // upline:  cap is totalMargin (amount) or totalLotWise (lot) — what was given to them
        const totalAllowed = isClient
          ? (market.maximumLimitVal || 0)
          : (isAmount ? (market.totalMarginVal || 0) : (market.totalLotWise || 0));

        // totalUsed: clients = open positions × live price; uplines = distributed to children
        let totalUsed;
        if (isClient) {
          const cu = clientUsedMap[user._id.toString()]?.[market.marketId] || { usedLots: 0, usedAmount: 0 };
          totalUsed = isAmount ? cu.usedAmount : cu.usedLots;
        } else {
          totalUsed = isAmount ? (market.usedMaxLimit || 0) : (market.usedLotWise || 0);
        }

        const totalRemaining = totalAllowed - totalUsed;

        return {
          marketId: market.marketId,
          marketName: market.marketName,
          lotOrAmount: market.lotOrAmount,
          totalAllowed,
          totalUsed,
          totalRemaining
        };
      });

      return {
        _id: user._id,
        userId: user.userId,
        accountName: user.accountName,
        accountCode: user.accountCode,
        level: levelMap[user._id.toString()] || null,
        createdBy: user.createdBy,
        status: userStatus,
        markets
      };
    });

    if (results.length === 0) {
      const selfUser = await userModel
        .findById(userId)
        .select({ accountCode: 1, accountName: 1, marketAccess: 1, accountType: 1, status: 1 })
        .populate('accountType', 'level')
        .lean();

      if (!selfUser) return [];

      const selfLevel = selfUser.accountType?.level || 0;
      const selfIsClient = selfLevel === 7;
      const selfStatus = selfUser.status !== false;

      const selfMarkets = (selfUser.marketAccess || [])
        .filter(m => marketIds.includes(m.marketId) && m.isSelected)
        .map(market => {
          const isAmount = market.margin?.lotOrAmount === 'amount';
          const totalAllowed = selfIsClient
            ? (Number(market.margin?.maximumLimit) || 0)
            : (isAmount ? (Number(market.margin?.totalMargin) || 0) : (Number(market.margin?.totalLotWise) || 0));

          return {
            marketId: market.marketId,
            marketName: market.marketName,
            lotOrAmount: market.margin?.lotOrAmount,
            totalAllowed: selfStatus ? totalAllowed : 0,
            totalUsed: 0,
            totalRemaining: selfStatus ? totalAllowed : 0
          };
        });

      return [{
        _id: selfUser._id,
        userId: selfUser._id,
        accountName: selfUser.accountName,
        accountCode: selfUser.accountCode,
        level: selfLevel,
        createdBy: null,
        status: selfStatus,
        markets: selfMarkets
      }];
    }

    return results;
  } catch (error) {
    console.error('Error in getMarginLimits:', error);
    throw error;
  }
};

const getClientMargins = async (clientIds, marketIds) => {
  try {
    const { getClientMargin } = require('./StockService');
    const clientList = await userModel
      .find({ _id: { $in: clientIds } })
      .select({ accountCode: 1, accountName: 1, marketAccess: 1, createdBy: 1, status: 1 })
      .lean();

    const getClientStocks = await getClientMargin(clientIds, marketIds);

    const clientStocks = getClientStocks.map((client) => {
      const clientId = client._id.toString();
      const getCurrentClient = clientList.find((c) => c._id.toString() == clientId);
      const marketAccess = getCurrentClient?.marketAccess || [];

      // Group markets by marketId to avoid duplicates
      const marketMap = new Map();

      client.markets.forEach((mkt) => {
        const marketId = mkt.marketId;
        const marketConfig = marketAccess.find((m) => m.marketId == marketId);
        const lotOrAmount = marketConfig?.margin?.lotOrAmount || '';
        const lotWise = lotOrAmount == 'lot' ? mkt.lot : 0;
        const margin = lotOrAmount == 'amount' ? mkt.margin : 0;

        if (marketMap.has(marketId)) {
          // Add to existing market entry
          const existing = marketMap.get(marketId);
          existing.totalLotWiseSum += +lotWise;
          existing.totalMarginSum += +margin;
        } else {
          // Create new market entry
          marketMap.set(marketId, {
            lotOrAmount,
            marketId,
            marketName: marketConfig?.marketName || '',
            totalLotWiseSum: +lotWise,
            totalMarginSum: +margin
          });
        }
      });

      // Convert map to array and calculate totals
      const markets = Array.from(marketMap.values());
      const totalLotWiseSum = markets.reduce((sum, m) => sum + m.totalLotWiseSum, 0);
      const totalMarginSum = markets.reduce((sum, m) => sum + m.totalMarginSum, 0);

      return {
        accountName: getCurrentClient?.accountName || '',
        accountCode: getCurrentClient?.accountCode || '',
        userId: clientId,
        createdBy: getCurrentClient?.createdBy || clientId,
        status: getCurrentClient?.status !== false,
        markets,
        totalLotWiseSum,
        totalMarginSum
      };
    });

    return clientStocks;
  } catch (error) {
    console.error('Error updating data:', error);
    throw error;
  }
};

exports.getDirectUsers = async (userId, isDemo = false) => {
  try {
    const match = { 'createdBy.userId': userId, isDeleted: false };
    if (!isDemo) {
      match.demoid = { $ne: true };
    }
    return await userModel
      .find(match)
      .populate('accountType', 'label level')
      .select({ accountCode: 1, accountName: 1, accountType: 1 })
      .lean();
  } catch (error) {
    console.error('Error fetching data:', error);
    throw error;
  }
};

exports.getClientTree = async (clientId, parentId) => {
  try {
    const parentParents = await userModel.findOne({ _id: parentId, isDeleted: false }).select('parentIds').lean();
    const clientList = await userModel
      .find({ _id: clientId, parentIds: parentId, isDeleted: false })
      .populate({ path: 'accountType' })
      .populate({
        path: 'parentIds',
        match: { _id: { $nin: [parentId, ...parentParents.parentIds] }, isDeleted: false },
        populate: { path: 'accountType' }
      })
      .lean();

    return clientList;
  } catch (error) {
    console.error('Error updating data:', error);
    throw error;
  }
};
exports.getOnlineUsers = async (parentId, filterMode = 'all') => {
  try {
    const allStatuses = await hgetall('onlineStatus');

    // gather online id strings
    const onlineUserIds = Object.entries(allStatuses || {})
      .filter(([_, s]) => String(s).trim().toLowerCase() === 'online')
      .map(([id]) => String(id));

    if (!onlineUserIds.length) return [];

    // build safe ObjectId array for Mongo query (only once)
    const safeIdsForQuery = onlineUserIds
      .map((id) => {
        if (mongoose.isValidObjectId(id)) return new mongoose.Types.ObjectId(id);
        return null;
      })
      .filter(Boolean); // only valid ObjectIds remain

    // If no valid ObjectIds, nothing to query
    if (!safeIdsForQuery.length) return [];

    // Apply user filter: "all" = all downline (parentIds), "MY" = only created by me (createdBy.userId)
    const queryFilter = {
      _id: { $in: safeIdsForQuery },
      isDeleted: false
    };
    
    if (filterMode === 'MY') {
      queryFilter['createdBy.userId'] = parentId;
    } else {
      queryFilter.parentIds = { $in: [parentId] };
    }

    const users = await userModel
      .find(queryFilter)
      .populate({ path: 'accountType', select: 'level label' })
      .select({
        accountCode: 1,
        accountName: 1,
        loginIP: 1,
        lastLogin: 1,
        _id: 1
      })
      .lean()
      .exec();

    if (!users.length) return [];

    // lazy-require balance service (avoids circular dependency)
    const balanceService = require('./Balanceservice');

    // pass plain string ids to balanceService (it will convert safely)
    const ids = users.map((u) => String(u._id));
    const balances = await balanceService.computeCombinedBalances(ids);
    const balMap = new Map(balances.map((b) => [String(b.userId), b]));
    const clientList = users.map((u) => {
      const idStr = String(u._id);
      const b = balMap.get(idStr) || { cash: 0, jv: 0, ledger: 0, balance: 0 };
      return {
        accountCode: u.accountCode,
        accountName: u.accountName,
        _id: u._id,
        balance: b.cash,
        breakdown: { cash: b.cash, jv: b.jv, ledger: b.ledger },
        accountType: u.accountType || null,
        loginIP: u.loginIP
      };
    });

    return clientList;
  } catch (error) {
    console.error('Error updating data:', error);
    throw error;
  }
};

exports.getOnlineUserIds = async () => {
  try {
    const allStatuses = await hgetall('onlineStatus');

    const onlineUserIds = Object.entries(allStatuses || {})
      .filter(([_, s]) => String(s).trim().toLowerCase() === 'online')
      .map(([id]) => id);

    return onlineUserIds ?? [];
  } catch (error) {
    console.error('Error updating data:', error);
    throw error;
  }
};

exports.getLastSeen = async (userId, isOnline) => {
  if (isOnline) {
    return 'Online';
  }
  const lastOffline = await onlineHistoryModel.findOne({ userId, type: 'offline' }).sort({ time: -1 }).select('time').lean();
  if (lastOffline) {
    return lastOffline.time;
  }
  // Fallback to user's lastLogin or createdAt if no history exists
  const user = await userModel.findById(userId).select('lastLogin createdAt').lean();
  return user ? user.lastLogin || user.createdAt : null;
};
exports.getOnlineHistory = async (parentId, userId, page = 1, limit = 10) => {
  try {
    const user = await userModel
      .findOne({ _id: userId, parentIds: parentId })
      .populate({ path: 'accountType', select: 'level label' })
      .select({
        accountCode: 1,
        accountName: 1,
        loginIP: 1,
        lastLogin: 1,
        _id: 0
      })
      .lean();
    if (!user) {
      return {};
    }

    page = parseInt(page) || 1;
    limit = parseInt(limit) || 10;
    const skip = (page - 1) * limit;

    const totalDocs = await onlineHistoryModel.countDocuments({ userId: userId });

    const history = await onlineHistoryModel
      .find({ userId: userId })
      .select({
        type: 1,
        time: 1,
        ip: 1,
        _id: 0
      })
      .sort({ time: -1 })
      .skip(skip)
      .limit(limit)
      .lean();

    return {
      user,
      history,
      pagination: {
        total: totalDocs,
        page,
        limit,
        totalPages: Math.ceil(totalDocs / limit)
      }
    };
  } catch (error) {
    console.error('Error updating data:', error);
    throw error;
  }
};

exports.getUserLevelMargins = async (clientId, marketIds) => {
  try {
    const clientList = await userModel
      .findOne({ _id: { $in: clientId } })
      .select({ accountCode: 1, accountName: 1, marketAccess: 1, createdBy: 1 })
      .lean();
    const { getClientMargin } = require('./StockService');

    const effectiveMarketIds = Array.isArray(marketIds) && marketIds.length > 0
      ? marketIds
      : (clientList.marketAccess || []).map(m => m.marketId);

    const getCurrentClient = clientList.marketAccess.filter((mkt) => effectiveMarketIds.includes(mkt.marketId)) || [];

    const getClientStocks = await getClientMargin(clientId, effectiveMarketIds);
    const userStocks = getClientStocks.length > 0 ? getClientStocks[0] : null;
    let grandTotalLotWise = 0;
    let grandTotalMargin = 0;
    let grandUsedLotWise = 0;
    let grandUsedMargin = 0;

    const clientMargins = getCurrentClient.map((mkt) => {
      const lotOrAmount = mkt.margin.lotOrAmount;

      const { usedLotWiseSum, usedMarginSum } = userStocks?.markets.reduce(
        (acc, mk) => {
          if (mk.marketId == mkt.marketId) {
            const lotWise = lotOrAmount == 'lot' ? Number(mk.lot) || 0 : 0;
            const margin = lotOrAmount == 'amount' ? Number(mk.margin) || 0 : 0;

            acc.usedLotWiseSum += lotWise;
            acc.usedMarginSum += margin;
          }

          return acc;
        },
        { usedLotWiseSum: 0, usedMarginSum: 0 }
      ) || { usedLotWiseSum: 0, usedMarginSum: 0 };

      const totalLotWise = Number(mkt.margin.totalLotWise) || 0;
      const totalMargin = Number(mkt.margin.totalMargin) || 0;

      grandTotalLotWise += totalLotWise;
      grandTotalMargin += totalMargin;
      grandUsedLotWise += usedLotWiseSum;
      grandUsedMargin += usedMarginSum;

      return {
        lotOrAmount: mkt.margin.lotOrAmount,
        marketId: mkt.marketId,
        marketName: mkt.marketName,
        usedLotWiseSum,
        usedMarginSum,
        totalLotWiseSum: totalLotWise,
        totalMarginSum: totalMargin
      };
    });

    return {
      accountName: clientList.accountName,
      accountCode: clientList.accountCode,
      clientMargins,
      grandTotalLotWise,
      grandTotalMargin,
      grandUsedLotWise,
      grandUsedMargin
    };
  } catch (error) {
    console.error('Error updating data:', error);
    return [];
  }
};

exports.getUserCounts = async (userId) => {
  try {
    return await userModel.aggregate([
      {
        $match: {
          parentIds: userId,
          isDeleted: false
        }
      },
      {
        $group: {
          _id: '$accountType',
          totalUsers: { $sum: 1 }
        }
      },
      {
        $lookup: {
          from: 'usertypes', // the collection name that stores account types
          localField: '_id',
          foreignField: '_id',
          as: 'accountTypeInfo'
        }
      },
      {
        $unwind: '$accountTypeInfo'
      },
      {
        $project: {
          _id: 0,
          label: '$accountTypeInfo.label',
          level: '$accountTypeInfo.level',
          count: '$totalUsers'
        }
      },
      {
        $sort: { level: 1 } // Sort by level in ascending order
      }
    ]);
  } catch (error) {
    console.error('Error fetching data:', error);
    throw error;
  }
};

exports.getMarketAccess = async (userId) => {
  try {
    return await userModel.aggregate([
      {
        $match: {
          _id: new mongoose.Types.ObjectId(userId)
        }
      },
      {
        $project: {
          _id: 0,
          marketAccess: 1
        }
      }
    ]);
  } catch (error) {
    console.error('Error fetching data:', error);
    throw error;
  }
};
// compute + emit to all online users

exports.getUsersByLevel = async (userId, level) => {
  return await userModel.aggregate([
    {
      $match: {
        parentIds: userId,
        isDeleted: false
      }
    },
    {
      $lookup: {
        from: 'usertypes',
        localField: 'accountType',
        foreignField: '_id',
        as: 'accountType'
      }
    },
    { $unwind: '$accountType' },
    {
      $match: {
        'accountType.level': Number(level)
      }
    },
    {
      $project: {
        accountName: 1,
        accountCode: 1,
        loginIP: 1,
        lastLogin: 1,
        isOnline: 1,
        'accountType.label': 1,
        'accountType.level': 1
      }
    },
    { $sort: { lastLogin: -1 } }
  ]);
};

exports.getDemoUsers = async (userId) => {
  try {
    const matchFilter = { demoid: true, isDeleted: false };

    const users = await userModel.find(matchFilter).populate('accountType', 'label level').lean();

    const userIds = users.map((user) => user._id.toString());
    const subUsersCountMap = await getLevelWiseCount(userIds);

    return {
      users: users.map((user) => ({
        ...user,
        subUsersCount: subUsersCountMap[user._id.toString()] || []
      }))
    };
  } catch (error) {
    console.error('Error fetching demo users:', error);
    throw error;
  }
};

exports.getMarginManagementData = async (userId, marketIds, userLevel) => {
  try {
    const sortingKeys = ['INDEX', 'NSE', 'MCX', 'NOPT'];
    const { getSingleStockData } = require('./RedisService');
    const { getActiveWeekValan } = require('./StockService');
    const UserPosition = require('../models/UserPositionModel');

    // 1. Fetch "Me" (The User)
    const user = await userModel.findById(userId).select('accountName accountCode accountType marketAccess createdBy').lean();

    if (!user) {
      throw new Error('User not found');
    }

    // 2. Get active valan for filtering current positions
    const activeValan = await getActiveWeekValan();
    if (!activeValan) {
      throw new Error('Active valan not found');
    }

    // 3. Fetch user's open positions for the active valan
    const userPositions = await UserPosition.find({
      userId: new mongoose.Types.ObjectId(userId),
      valanId: activeValan._id
    }).lean();

    // 4. Calculate actual usage from open positions per market
    const actualUsageMap = {}; // mktId -> { lots, amount }
    
    for (const position of userPositions) {
      const mktId = String(position.marketId);
      if (!actualUsageMap[mktId]) {
        actualUsageMap[mktId] = { lots: 0, amount: 0 };
      }

      // Calculate net lots (buy - sell)
      const netLots = Math.abs(position.buyLot - position.sellLot);
      actualUsageMap[mktId].lots += netLots;

      // Calculate net quantity for amount calculation
      const netQty = Math.abs(position.buyQuantity - position.sellQuantity);
      
      if (netQty > 0) {
        // Get live price from Redis
        try {
          const stockData = await getSingleStockData(position.scriptId);
          if (stockData) {
            const parsed = typeof stockData === 'string' ? JSON.parse(stockData) : stockData;
            const livePrice = parsed.ltp || parsed.last_price || 0;
            actualUsageMap[mktId].amount += netQty * livePrice;
          }
        } catch (err) {
          console.error(`Error fetching price for ${position.scriptId}:`, err);
        }
      }
    }

    // 5. Fetch Direct Children to calculate usage (How much I allocated to them)
    // userLevel passed from controller (auth token) — reliable. Fallback: check if user has no children (leaf node).
    const isClient = userLevel === 7;

    let children = [];
    const userIdObj = mongoose.Types.ObjectId.isValid(userId) ? new mongoose.Types.ObjectId(userId) : null;
    const childQuery = {
      $or: [
        { 'createdBy.userId': userId },
        ...(userIdObj ? [{ 'createdBy.userId': userIdObj }] : [])
      ],
      isDeleted: false
    };
    children = await userModel.find(childQuery).select('marketAccess').lean();

    // Build childrenUsageMap: sum of margins allocated to direct children (for uplines)
    const childrenUsageMap = {};
    if (!isClient) {
      for (const child of children) {
        for (const mkt of (child.marketAccess || [])) {
          const mktId = String(mkt.marketId);
          if (!childrenUsageMap[mktId]) childrenUsageMap[mktId] = { lots: 0, amount: 0 };
          childrenUsageMap[mktId].lots += mkt.margin?.totalLotWise || 0;
          childrenUsageMap[mktId].amount += mkt.margin?.maximumLimit || 0;
        }
      }
    }

    // 6. Initialize totals
    const grandTotal = {
      totalLotWiseSum: 0,
      totalMarginSum: 0,
      usedLotWiseSum: 0,
      usedMarginSum: 0
    };

    const marketMap = {};
    // Initialize market map
    marketIds.forEach((id) => {
      id = String(id);
      marketMap[id] = {
        marketId: id,
        marketName: '',
        totalMarginSum: 0,
        totalLotWiseSum: 0,
        usedMarginSum: 0,
        usedLotWiseSum: 0
      };
    });

    const fillMarketName = (id, name) => {
      if (marketMap[id] && !marketMap[id].marketName && name) {
        marketMap[id].marketName = name;
      }
    };

    // 7. Calculate "Me" Margins (My Limits) and "My Usage" (Based on actual positions)
    const myMarkets = user.marketAccess || [];
    const processedMarkets = [];

    marketIds.forEach((mktId) => {
      mktId = String(mktId);
      const existing = myMarkets.find((m) => String(m.marketId) === mktId);

      let totalMargin = 0;
      let totalLot = 0;
      let mName = '';
      let lotOrAmount = '';
      let maximumLimit = 0;

      if (existing) {
        mName = existing.marketName;
        fillMarketName(mktId, mName);
        totalMargin = existing.margin?.totalMargin || 0;
        totalLot = existing.margin?.totalLotWise || 0;
        lotOrAmount = existing.margin?.lotOrAmount || 'lot';
        maximumLimit = existing.margin?.maximumLimit || 0;
      }

      // Calculate used margin based on lotOrAmount setting
      // Client (lvl 7): used = own open positions
      // Upline: used = sum of margins allocated to direct children
      let usedMargin = 0;
      let usedLot = 0;

      const usageSource = isClient ? actualUsageMap : childrenUsageMap;
      const actualUsage = usageSource[mktId] || { lots: 0, amount: 0 };

      if (lotOrAmount === 'lot') {
        usedLot = actualUsage.lots;
      } else if (lotOrAmount === 'amount') {
        usedMargin = actualUsage.amount;
      } else if (lotOrAmount === 'qty') {
        usedLot = actualUsage.lots;
      }

      // Update Grand Totals - use maximumLimit as total
      grandTotal.totalMarginSum += maximumLimit;
      grandTotal.totalLotWiseSum += totalLot;
      grandTotal.usedMarginSum += usedMargin;
      grandTotal.usedLotWiseSum += usedLot;

      // Update Market Map
      if (marketMap[mktId]) {
        marketMap[mktId].totalMarginSum += maximumLimit;
        marketMap[mktId].totalLotWiseSum += totalLot;
        marketMap[mktId].usedMarginSum += usedMargin;
        marketMap[mktId].usedLotWiseSum += usedLot;
      }

      const marketEntry = {
        marketId: mktId,
        marketName: mName || marketMap[mktId].marketName || '',
        lotOrAmount: lotOrAmount
      };

      if (lotOrAmount === 'amount') {
        marketEntry.totalMarginSum = maximumLimit;
        marketEntry.usedMarginSum = usedMargin;
      } else {
        // lot or qty
        marketEntry.totalLotWiseSum = totalLot;
        marketEntry.usedLotWiseSum = usedLot;
      }

      processedMarkets.push(marketEntry);
    });

    // Ensure names are filled in processedMarkets if found later
    processedMarkets.forEach((pm) => {
      if (!pm.marketName && marketMap[pm.marketId].marketName) {
        pm.marketName = marketMap[pm.marketId].marketName;
      }
    });

    // Sort Markets (Columns for the user row)
    processedMarkets.sort((a, b) => {
      const idxA = sortingKeys.indexOf(a.marketName);
      const idxB = sortingKeys.indexOf(b.marketName);
      if (idxA === -1 && idxB === -1) return 0;
      if (idxA === -1) return 1;
      if (idxB === -1) return -1;
      return idxA - idxB;
    });

    // Construct the "User Limit" object (Me)
    const myUserFormatted = {
      _id: user._id,
      userId: user._id, // Add userId alias if frontend uses it
      accountName: user.accountName,
      accountCode: user.accountCode,
      accountType: user.accountType,
      markets: processedMarkets,
      totalMarginSum: grandTotal.totalMarginSum, // My Total (sum of maximumLimits)
      totalLotWiseSum: grandTotal.totalLotWiseSum, // My Total
      myDownline: {
        // Usage info based on actual positions
        totalMarginWise: grandTotal.usedMarginSum,
        totalLotWise: grandTotal.usedLotWiseSum
      }
    };

    // Sort Market Totals (Bottom Summary)
    const marketTotalsArray = Object.values(marketMap).sort((a, b) => {
      const idxA = sortingKeys.indexOf(a.marketName);
      const idxB = sortingKeys.indexOf(b.marketName);
      if (idxA === -1 && idxB === -1) return 0;
      if (idxA === -1) return 1;
      if (idxB === -1) return -1;
      return idxA - idxB;
    });

    return {
      usersLimit: [myUserFormatted], // Return ME as the single item in the list
      grandTotal,
      marketTotals: marketTotalsArray
    };
  } catch (error) {
    console.error('Error in getMarginManagementData:', error);
    throw error;
  }
};

/**
 * Completely delete a user and all associated data
 * @param {String} userId - ID of the user to delete
 * @returns {Object} - Results of the operation
 */
// exports.deleteUserCompletely = async (userId) => {
//   const session = await mongoose.startSession();
//   session.startTransaction();
//   try {
//     const uId = new mongoose.Types.ObjectId(userId);

//     // 1. Check if user exists
//     const user = await userModel.findById(uId).session(session);
//     if (!user) {
//       throw new Error('User not found');
//     }

//     // 2. Safeguard: Prevent deletion if user has any downline
//     // This is crucial to prevent orphaned clients/masters
//     const downlineExists = await userModel.exists({ 'createdBy.userId': userId }).session(session);
//     if (downlineExists) {
//       throw new Error('Cannot delete user because they have an active downline. Please delete or reassigned their downline first.');
//     }

//     // 3. Import all relevant models for data wiping
//     const StockTransaction = require('../models/StockTransactionModel');
//     const UserPosition = require('../models/UserPositionModel');
//     const UserQuantity = require('../models/UserQuantityModel');
//     const UserScript = require('../models/UserScriptModel');
//     const Ledger = require('../models/LedgerModel');
//     const CashLedger = require('../models/CashLedgerModel');
//     const JVLedger = require('../models/JVLedgerModel');
//     const QuantitySetting = require('../models/QuantitySettingModel');
//     const LotSetting = require('../models/LotSettingModel');
//     const ProfitLossReport = require('../models/ProfitLossReport');
//     const OnlineHistory = require('../models/OnlineHistoryModel');
//     const PageHistory = require('../models/PageHistoryModel');
//     const Notification = require('../models/NotificationModel');
//     const AlertSetting = require('../models/AlertSettingModel');
//     const DepositWithdraw = require('../models/DepositWithdrawModel');
//     const Log = require('../models/LogModel');
//     const BrokerageRefresh = require('../models/BrokerageRefreshModel');
//     const LimitDisable = require('../models/LimitDisableModel');
//     const LinkedAccount = require('../models/LinkedAccountModel');
//     const Squareoff = require('../models/SquareoffModel');
//     const TeleChatUser = require('../models/TeleChatUserModel');
//     const ChatMessage = require('../models/ChatMessageModel');

//     // 4. Perform bulk deletions across all associated collections
//     await Promise.all([
//       StockTransaction.deleteMany({ userId: uId }).session(session),
//       UserPosition.deleteMany({ userId: uId }).session(session),
//       UserQuantity.deleteMany({ userId: uId }).session(session),
//       UserScript.deleteMany({ createdBy: uId }).session(session),
//       Ledger.deleteMany({ userId: uId }).session(session),
//       CashLedger.deleteMany({ userId: uId }).session(session),
//       JVLedger.deleteMany({ $or: [{ debitAccount: uId }, { creditAccount: uId }] }).session(session),
//       QuantitySetting.deleteMany({ clientId: uId }).session(session),
//       LotSetting.deleteMany({ createdBy: uId }).session(session),
//       ProfitLossReport.deleteMany({ userId: uId }).session(session),
//       OnlineHistory.deleteMany({ userId: uId }).session(session),
//       PageHistory.deleteMany({ userId: uId }).session(session),
//       Notification.deleteMany({
//         $or: [{ selectedUser: userId.toString() }, { createdBy: uId }, { readBy: uId }, { parentIds: uId }]
//       }).session(session),
//       AlertSetting.deleteMany({ userId: uId }).session(session),
//       DepositWithdraw.deleteMany({ userId: uId }).session(session),
//       BrokerageRefresh.deleteMany({ $or: [{ userId: uId }, { createdBy: uId }] }).session(session),
//       LimitDisable.deleteMany({ createdBy: uId }).session(session),
//       LinkedAccount.deleteMany({ $or: [{ userId: uId }, { parentId: uId }] }).session(session),
//       Squareoff.deleteMany({ userId: uId }).session(session),
//       TeleChatUser.deleteMany({ userId: uId }).session(session),
//       ChatMessage.deleteMany({ $or: [{ from: uId }, { to: uId }] }).session(session),
//       // Aggregate Log Wipe
//       Log.deleteMany({
//         $or: [
//           { 'tradeLog.userId': uId },
//           { 'cashLedgerLog.userId': uId },
//           { 'depositLedgerLog.userId': uId },
//           { 'rejectionLog.clientId': uId },
//           { 'userEditLog.clientId': uId },
//           { 'userEditLog.edit_by': uId },
//           { 'loginLog.clientId': uId }
//         ]
//       }).session(session),
//       // The final act: Delete the user itself
//       userModel.deleteOne({ _id: uId }).session(session)
//     ]);

//     await session.commitTransaction();
//     session.endSession();
//     return { success: true, message: 'User and all associated trading/ledger data have been permanently removed.' };
//   } catch (error) {
//     await session.abortTransaction();
//     session.endSession();
//     console.error('Critical: deleteUserCompletely error -', error);
//     throw error;
//   }
// };
exports.deleteUserCompletely = async (userId) => {
  try {
    const uId = new mongoose.Types.ObjectId(userId);

    const user = await userModel.findById(uId);
    if (!user) {
      throw new Error('User not found');
    }

    const downlineExists = await userModel.exists({ 'createdBy.userId': userId });
    if (downlineExists) {
      throw new Error('Cannot delete user because they have an active downline.');
    }

    const StockTransaction = require('../models/StockTransactionModel');
    const UserPosition = require('../models/UserPositionModel');
    const UserQuantity = require('../models/UserQuantityModel');
    const UserScript = require('../models/UserScriptModel');
    const Ledger = require('../models/LedgerModel');
    const CashLedger = require('../models/CashLedgerModel');
    const JVLedger = require('../models/JVLedgerModel');
    const QuantitySetting = require('../models/QuantitySettingModel');
    const LotSetting = require('../models/LotSettingModel');
    const ProfitLossReport = require('../models/ProfitLossReport');
    const OnlineHistory = require('../models/OnlineHistoryModel');
    const PageHistory = require('../models/PageHistoryModel');
    const Notification = require('../models/NotificationModel');
    const AlertSetting = require('../models/AlertSettingModel');
    const DepositWithdraw = require('../models/DepositWithdrawModel');
    const Log = require('../models/LogModel');
    const BrokerageRefresh = require('../models/BrokerageRefreshModel');
    const LimitDisable = require('../models/LimitDisableModel');
    const LinkedAccount = require('../models/LinkedAccountModel');
    const Squareoff = require('../models/SquareoffModel');
    const TeleChatUser = require('../models/TeleChatUserModel');
    const ChatMessage = require('../models/ChatMessageModel');

    const steps = [
      () => StockTransaction.deleteMany({ userId: uId }),
      () => UserPosition.deleteMany({ userId: uId }),
      () => UserQuantity.deleteMany({ userId: uId }),
      () => UserScript.deleteMany({ createdBy: uId }),
      () => Ledger.deleteMany({ userId: uId }),
      () => CashLedger.deleteMany({ userId: uId }),
      () => JVLedger.deleteMany({ $or: [{ debitAccount: uId }, { creditAccount: uId }] }),
      () => QuantitySetting.deleteMany({ clientId: uId }),
      // () => LotSetting.deleteMany({ createdBy: uId }), // LotSettings managed via refreshLotSettings
      () => ProfitLossReport.deleteMany({ userId: uId }),
      () => OnlineHistory.deleteMany({ userId: uId }),
      () => PageHistory.deleteMany({ userId: uId }),
      () =>
        Notification.deleteMany({
          $or: [
            { selectedUser: userId.toString() },
            { createdBy: uId },
            { readBy: uId },
            { parentIds: uId }
          ]
        }),
      () => AlertSetting.deleteMany({ userId: uId }),
      () => DepositWithdraw.deleteMany({ userId: uId }),
      () => BrokerageRefresh.deleteMany({ $or: [{ userId: uId }, { createdBy: uId }] }),
      () => LimitDisable.deleteMany({ createdBy: uId }),
      () => LinkedAccount.deleteMany({ $or: [{ userId: uId }, { parentId: uId }] }),
      () => Squareoff.deleteMany({ userId: uId }),
      () => TeleChatUser.deleteMany({ userId: uId }),
      () => ChatMessage.deleteMany({ $or: [{ from: uId }, { to: uId }] }),
      () =>
        Log.deleteMany({
          $or: [
            { 'tradeLog.userId': uId },
            { 'cashLedgerLog.userId': uId },
            { 'depositLedgerLog.userId': uId },
            { 'rejectionLog.clientId': uId },
            { 'userEditLog.clientId': uId },
            { 'userEditLog.edit_by': uId },
            { 'loginLog.clientId': uId }
          ]
        }),
      () => userModel.deleteOne({ _id: uId })
    ];

    for (let i = 0; i < steps.length; i++) {
      try {
        await steps[i]();
      } catch (err) {
        console.error(`Deletion failed at step ${i}`, err);
        throw new Error(`Deletion failed midway. Stopped at step ${i}`);
      }
    }

    return {
      success: true,
      message: 'User and all associated data removed (non-transactional)'
    };
  } catch (error) {
    console.error('Critical: deleteUserCompletely error -', error);
    throw error;
  }
};
exports.getDeletedUsers = async (requesterId, { page = 1, limit = 10, search = '' }) => {
  try {
    const skip = (page - 1) * limit;
    let query = { isDeleted: true, parentIds: requesterId };
    if (search) {
      query.$or = [{ accountName: { $regex: search, $options: 'i' } }, { accountCode: { $regex: search, $options: 'i' } }];
    }
    const total = await userModel.countDocuments(query);
    const users = await userModel.find(query).populate('accountType', 'label level').skip(skip).limit(limit).sort({ deletedAt: -1 }).lean();

    return { users, total, page: Number(page), limit: Number(limit), totalPages: Math.ceil(total / limit) };
  } catch (error) {
    console.error('getDeletedUsers service error:', error);
    throw error;
  }
};

/**
 * Validates the transaction password based on user level.
 * Level 1 (Super Admin) uses login password.
 * Others use their configured transactionPassword.
 */
exports.validateTransactionPassword = async (userId, passwordToValidate) => {
  try {
    const user = await userModel
      .findById(userId)
      .populate('accountType', 'level')
      .select('password transactionPassword accountType basicDetails')
      .lean();
    // console.log("User : ", user);

    if (!user) return false;
    // console.log("Transaction pass : ", passwordToValidate);
    // Logic: Super Admin (level 1) uses login password, others use basicDetails.transactionPassword
    const effectiveTransactionPassword =
      user.accountType && user.accountType.level === 1 ? user.password : user.basicDetails.transactionPassword;

    if (!effectiveTransactionPassword) return false;
    // console.log("Effective Transaction pass : ", effectiveTransactionPassword);
    // console.log("Pass check :", String(passwordToValidate).trim() === String(effectiveTransactionPassword).trim())
    return String(passwordToValidate).trim() === String(effectiveTransactionPassword).trim();
  } catch (error) {
    console.error('Error in validateTransactionPassword Service:', error);
    return false;
  }
};
/**
 * Get specific market settings for a user by account code
 * @param {string} accountCode
 * @param {string} marketId
 * @param {string} settingsName (Brokerage, Margin, Other)
 */
exports.getMarketSettingsByAccountCode = async (accountCode, marketId, settingsName) => {
  try {
    const user = await userModel.findOne({ accountCode, isDeleted: false }).lean();
    if (!user) {
      return { success: false, message: 'User not found' };
    }

    const market = (user.marketAccess || []).find((m) => String(m.marketId) === String(marketId));
    if (!market) {
      return { success: false, message: 'Market settings not found for this user' };
    }

    const key = settingsName.toLowerCase();
    let data;

    if (key === 'brokerage') data = market.brokerage;
    else if (key === 'margin') data = market.margin;
    else if (key === 'other') data = market.other;
    else return { success: false, message: 'Invalid settings name. Must be Brokerage, Margin, or Other' };

    return { success: true, data };
  } catch (error) {
    console.error('getMarketSettingsByAccountCode error:', error);
    throw error;
  }
};

/**
 * Get broker's mapped clients - shows customers assigned to a specific broker
 * @param {string} brokerId - The broker's user ID
 * @param {string} search - Optional search term for client name/code
 * @param {boolean} isDemo - Filter for demo/non-demo clients
 * @returns {Object} Object with userType and users array (same structure as getDirectDownlineUsers)
 */
exports.getBrokerClients = async (brokerId, search = '', isDemo = false) => {
  try {
    // Convert brokerId to ObjectId for matching
    const brokerObjectId = new mongoose.Types.ObjectId(brokerId);
    const brokerIdStr = brokerId.toString();

    // Get the customer type ID (level 7) - this will be our userType
    const userType = await userTypeModel.findOne({ level: 7 }).lean();
    if (!userType) {
      throw new Error('Customer type (level 7) not found');
    }

    // Build the query to find clients with this broker in their brokerPartnership
    const matchFilter = {
      accountType: userType._id,
      'basicDetails.brokerPartnership': { $exists: true, $ne: [] },
      isDeleted: false
    };

    // Apply demo filter
    if (isDemo !== null) {
      matchFilter.demoid = isDemo ? true : { $ne: true };
    }

    // Apply search filter if provided
    if (search && search.trim()) {
      matchFilter.$or = [
        { accountName: { $regex: search.trim(), $options: 'i' } },
        { accountCode: { $regex: search.trim(), $options: 'i' } }
      ];
    }

    // Find all clients and filter by broker partnership
    const clients = await userModel.aggregate([
      {
        $match: matchFilter
      },
      {
        $unwind: '$basicDetails.brokerPartnership'
      },
      {
        $addFields: {
          // Convert broker field to ObjectId if it's a string for comparison
          'basicDetails.brokerPartnership.brokerObjectId': {
            $cond: {
              if: { $eq: [{ $type: '$basicDetails.brokerPartnership.broker' }, 'string'] },
              then: { $toObjectId: '$basicDetails.brokerPartnership.broker' },
              else: '$basicDetails.brokerPartnership.broker'
            }
          }
        }
      },
      {
        $match: {
          $or: [
            { 'basicDetails.brokerPartnership.brokerObjectId': brokerObjectId },
            { 'basicDetails.brokerPartnership.broker': brokerIdStr },
            { 'basicDetails.brokerPartnership.broker': brokerObjectId }
          ]
        }
      },
      {
        $lookup: {
          from: 'usertypes',
          localField: 'accountType',
          foreignField: '_id',
          as: 'accountType'
        }
      },
      {
        $unwind: '$accountType'
      },
      {
        $project: {
          _id: 1,
          accountName: 1,
          accountCode: 1,
          marketAccess: 1,
          partnership: '$basicDetails.brokerPartnership.partnership',
          accountType: {
            _id: '$accountType._id',
            label: '$accountType.label',
            level: '$accountType.level'
          }
        }
      },
      {
        $sort: { accountName: 1 }
      }
    ]);

    // Get client IDs for additional data
    const clientIds = clients.map(client => client._id.toString());

    // Get sub-user counts for each client (if they have any downline)
    const subUsersCountMap = clientIds.length > 0 ? await getLevelWiseCount(clientIds) : {};

    // Admin listing: use direct-parent count for clients (level 7) so "Client Count" = only directly created clients
    let directCountMap = null;
    if (userType && userType.level === 7) {
      // For customers (level 7), we might want to show their direct downline if any
      directCountMap = await getDirectLevelWiseCount(clientIds);
    }

    // Return the same structure as getDirectDownlineUsers
    return {
      userType,
      users: clients.map((client) => {
        let subUsersCount = subUsersCountMap[client._id.toString()] || [];
        
        // Apply direct count logic if needed (similar to getDirectDownlineUsers)
        if (userType && userType.level === 7 && directCountMap) {
          const directCounts = directCountMap[client._id.toString()] || [];
          // For customers, we might not need this logic, but keeping it consistent
          subUsersCount = directCounts.length > 0 ? directCounts : subUsersCount;
        }
        
        return {
          ...client,
          subUsersCount
        };
      })
    };

  } catch (error) {
    console.error('Error in getBrokerClients:', error);
    throw error;
  }
};

/**
 * Get detailed broker client information for multiple brokers
 * @param {Array} brokerIds - Array of broker user IDs
 * @returns {Object} Map of brokerId -> client details array
 */
exports.getBrokerClientDetails = async (brokerIds) => {
  try {
    // Convert all broker IDs to ObjectIds for matching
    const objectIds = brokerIds.map((id) => {
      if (typeof id === 'string') {
        return new mongoose.Types.ObjectId(id);
      }
      return id;
    });
    
    // First, get the customer type ID (level 7)
    const customerType = await userTypeModel.findOne({ level: 7 }).select('_id label name').lean();
    if (!customerType) {
      console.error('Customer type (level 7) not found');
      return {};
    }
    
    // Find all clients (level 7) that have brokerPartnership entries
    const clients = await userModel.aggregate([
      {
        $match: {
          accountType: customerType._id,
          'basicDetails.brokerPartnership': { $exists: true, $ne: [] },
          isDeleted: false,
          demoid: { $ne: true } // Exclude demo users like in getDownlineUsers
        }
      },
      {
        $unwind: '$basicDetails.brokerPartnership'
      },
      {
        $addFields: {
          // Convert broker field to ObjectId if it's a string
          'basicDetails.brokerPartnership.brokerObjectId': {
            $cond: {
              if: { $eq: [{ $type: '$basicDetails.brokerPartnership.broker' }, 'string'] },
              then: { $toObjectId: '$basicDetails.brokerPartnership.broker' },
              else: '$basicDetails.brokerPartnership.broker'
            }
          }
        }
      },
      {
        $match: {
          'basicDetails.brokerPartnership.brokerObjectId': { $in: objectIds }
        }
      },
      {
        $lookup: {
          from: 'usertypes',
          localField: 'accountType',
          foreignField: '_id',
          as: 'accountType'
        }
      },
      {
        $unwind: '$accountType'
      },
      {
        $project: {
          _id: 1,
          accountName: 1,
          accountCode: 1,
          marketAccess: 1,
          brokerId: '$basicDetails.brokerPartnership.brokerObjectId',
          partnership: '$basicDetails.brokerPartnership.partnership',
          accountType: {
            label: '$accountType.label',
            name: '$accountType.name',
            level: '$accountType.level',
            _id: '$accountType._id'
          }
        }
      },
      {
        $sort: { accountName: 1 }
      }
    ]);

    // Group clients by broker ID
    const brokerClientDetailsMap = {};
    
    for (const client of clients) {
      const brokerId = client.brokerId ? client.brokerId.toString() : 'null';
      
      if (!brokerClientDetailsMap[brokerId]) {
        brokerClientDetailsMap[brokerId] = [];
      }
      
      brokerClientDetailsMap[brokerId].push({
        _id: client._id,
        accountName: client.accountName,
        accountCode: client.accountCode,
        marketAccess: client.marketAccess,
        accountType: client.accountType,
        partnership: client.partnership
      });
    }

    return brokerClientDetailsMap;
  } catch (error) {
    console.error('Error in getBrokerClientDetails:', error);
    throw error;
  }
};
