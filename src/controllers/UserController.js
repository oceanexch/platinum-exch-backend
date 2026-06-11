const {
  getUserTypes,
  getAllUserTypes,
  saveUser,
  getUsers,
  getUserById,
  getUserTypeById,
  getDownlineCount,
  getUserMargins,
  getDownlineUsers,
  checkPartnership,
  getMarketWiseSum,
  updateUser,
  updateManyUser,
  getMarginLimits,
  getDirectUsers,
  getClientTree,
  getDownlineLevelUsers,
  getOnlineUsers,
  getOnlineHistory,
  getUserLevelMargins,
  getUserCounts,
  getMarquee,
  addDemoUser,
  ensureDemoIdentityIsUnique,
  getActiveUserCount,
  getDemoUsers,
  resolveUserTypeId,
  getMarginManagementData,
  getMarketAccess,
  getLastSeen,
  getDirectDownlineUsers,
  getBannedUsersList,
  deleteUserCompletely,
  validateTransactionPassword,
  getMarketSettingsByAccountCode,
  createQtySettingsForUser,
  getBrokerClients
} = require('../services/UserService');
const MarginService = require('../services/MarginService');
const BalanceService = require('../services/Balanceservice');
const { hgetall } = require('../services/RedisService');
const UserType = require('../models/UserTypeModel');
const userModel = require('../models/UserModel');
const PageHistory = require('../models/PageHistoryModel');
const mongoose = require('mongoose');
const jwt = require("jsonwebtoken");
const M2MService = require("../services/M2MService");
const moment = require('moment');
const LinkedAccount = require('../models/LinkedAccountModel');
const UserMonitor = require('../models/UserMonitorModel');
const { validatepassword } = require('../services/AuthService');
const { getEffectiveUserId, getLoginUserId, getUserContext, getAuditContext, isDemoUser } = require('../utils/contextHelpers');
const { MAX_LOT_VALUE, ACCOUNT_CODE_LENGTH } = require('../config/config');

// Account code must be numeric and at most ACCOUNT_CODE_LENGTH digits.
const isValidAccountCode = (code) => new RegExp(`^\\d{1,${ACCOUNT_CODE_LENGTH}}$`).test(String(code));
exports.getUserTypes = async (req, res) => {
  try {
    const {
      accountType: { level }
    } = req.user;
    const data = await getUserTypes(level);
    res.status(200).json({ status: true, data });
  } catch (error) {
    console.log(error);
    res.status(500).json({ status: 'false' });
  }
};

exports.getAllUserTypes = async (req, res) => {
  try {
    const {
      accountType: { level }
    } = req.user;
    const data = await getAllUserTypes(level);
    res.status(200).json({ status: true, data });
  } catch (error) {
    console.log(error);
    res.status(500).json({ status: 'false' });
  }
};
exports.forceLogoutUser = async (req, res) => {
  try {
    const { userId, minutes } = req.body;

    if (!userId) {
      return res.status(400).json({ message: 'userId is required' });
    }

    const mins = Number(minutes) === 0 ? 0 : Number(minutes) || 0;
    if (mins < 0) {
      return res.status(400).json({ message: 'Minutes cannot be less than 0' });
    }
    await userModel.updateOne(
      { _id: userId },
      {
        $set: {
          forceLogout: true,
          forceLogoutMinutes: mins,
          forceLogoutBy: getLoginUserId(req),
          forceLogoutStartedAt: Date.now()
        }
      }
    );

    res.json({
      message: 'User logged out successfully',
      type: mins > 0 ? 'temporary' : 'permanent',
      minutes: mins
    });
  } catch (err) {
    console.error('forceLogoutUser error', err);
    res.status(500).json({ message: err.message });
  }
};

exports.getMarquee = async (req, res) => {
  try {
    const data = await getMarquee();
    res.status(200).json({ status: true, data });
  } catch (err) {
    console.error('error fetching marquee');
  }
};
exports.checkavialability = async (req, res) => {
  try {
    const { email, contactNumber, accountCode, accountName } = req.body;

    // 🔹 basic guard
    if (!email && !contactNumber && !accountCode && !accountName) {
      return res.status(400).json({
        status: false,
        message: 'Email, contact number, account code, or account name is required'
      });
    }

    // 🔹 reuse service logic
    await ensureDemoIdentityIsUnique({
      email,
      contactNumber,
      accountCode,
      accountName
    });

    // ✅ available
    return res.status(200).json({
      status: true,
      available: true,
      message: 'Available'
    });
  } catch (error) {
    // ❌ already exists
    if (
      error.message === 'Email is already registered' ||
      error.message === 'Contact number is already registered' ||
      error.message === 'Account code is already registered' ||
      error.message === 'Account name is already registered' ||
      error.message === 'Account name cannot be longer than 11 characters'
    ) {
      return res.status(400).json({
        status: true,
        available: false,
        message: error.message
      });
    }

    return res.status(500).json({
      status: false,
      message: 'Unable to check availability'
    });
  }
};
exports.brokerClient = async (req, res) => {
  try {
    const brokerId = getEffectiveUserId(req);
    const { search, isDemo } = req.query;
    
    // Convert isDemo query parameter to boolean
    const isDemoFilter = isDemo === 'true' ? true : isDemo === 'false' ? false : null;
    
    const data = await getBrokerClients(brokerId, search, isDemoFilter);
    res.status(200).json({ status: true, data });
  } catch (error) {
    console.error('Error in brokerClient controller:', error);
    res.status(500).json({ 
      status: false, 
      message: error.message || 'Internal server error' 
    });
  }
};

exports.createDemoUser = async (req, res) => {
  try {
    const { name, email, password, confirmPassword, contactNumber, country } = req.body;

    // 🔹 basic validation
    if (!name || !email || !password || !confirmPassword || !contactNumber || !country) {
      return res.status(400).json({
        status: false,
        message: 'Missing required fields'
      });
    }

    if (password !== confirmPassword) {
      return res.status(400).json({
        status: false,
        message: 'Passwords do not match'
      });
    }

    if (password.length < 6) {
      return res.status(400).json({
        status: false,
        message: 'Password must be at least 6 characters long'
      });
    }

    await ensureDemoIdentityIsUnique({
      email,
      contactNumber,
      accountName: name
    });

    // 🔹 generate account code
    const accountCode = Math.floor(100000 + Math.random() * 900000).toString();

    // 🔹 save
    const demoUser = await addDemoUser({
      ...req.body,
      accountCode
    });
    res.status(200).json({
      status: true,
      message: 'Demo user created successfully',
      data: {
        userId: demoUser.user._id,
        accountCode,
        accountId: demoUser.user._id,
        accountName: demoUser.user.accountName,
        basicDetails: demoUser.user.basicDetails,
        label: 'Customer',
        level: 7,
        accessToken: demoUser.acesstoken,
        refreshToken: demoUser.refreshtoken
      }
    });
  } catch (error) {
    console.error('Create demo user error:', error.message);
    res.status(500).json({
      status: false,
      message: error.message || 'Internal Server Error'
    });
  }
};
exports.getActiveusercounts = async (req, res) => {
  try {
    const data = await getActiveUserCount();

    return res.status(200).json({
      status: true,
      data
    });
  } catch (err) {
    console.error('getLevel7UsersSummary error:', err);

    return res.status(500).json({
      status: false,
      message: 'Unable to fetch level 7 user summary'
    });
  }
};

exports.createUser = async (req, res) => {
  try {
    const accountCode = Math.floor(100000 + Math.random() * 900000);
    const userId = getEffectiveUserId(req);
    const { transactionPassword } = req.user;
    // console.log('Req.body from create user : ', req.body);

    const { accountName, accountCode: reqAccountCode, isDemo, demoid } = req.body;
    if (!accountName) {
      return res.status(400).json({ status: false, message: 'Account Name is required' });
    }

    if (accountName.length > 11) {
      return res.status(400).json({ status: false, message: 'Account Name cannot be longer than 11 characters' });
    }
    const existingUser = await userModel.findOne({
      $or: [{ accountName: accountName }, { accountCode: reqAccountCode }]
    });
    if (existingUser) {
      return res.status(400).json({ status: false, message: 'Account Name or Account Code already exists' });
    }

    // if (
    //   !req.body.transactionPassword ||
    //   typeof req.body.transactionPassword !== "string" ||
    //   !req.body.transactionPassword.trim()
    // ) {
    //   return res.status(400).json({
    //     status: false,
    //     message: "Transaction password (your login password) is required",
    //   });
    // }
    // const isValid = await validatepassword(
    //   userId,
    //   req.body.transactionPassword.trim()
    // );
    // if (!isValid) {
    //   return res.status(401).json({
    //     status: false,
    //     message: "Wrong transaction password",
    //   });
    // }

    const getUser = await getUserById(userId);
    if (!getUser) {
      return res.status(403).json({ status: false, message: 'Invalid User' });
    }

    const myLevel = +getUser.accountType.level;
    const filterLevel = myLevel + 1;

    const brokerPartnership =
      req.body?.basicDetails?.brokerPartnership.reduce((acc, item) => {
        return (acc += item.partnership);
      }, 0) || 0;

    // if (brokerPartnership > getUser.partnership[myLevel - 1]) {
    //   return res
    //     .status(403)
    //     .json({ status: false, message: "Broker Partnership exceed" });
    // }

    if (req.body.password && req.body.password.length < 6) {
      return res.status(400).json({
        status: false,
        message: 'Password must be at least 6 characters long'
      });
    }

    if (myLevel == 2) {
      const checkCounts = await getDownlineCount(userId, filterLevel);
      const { masterCount, customerCount } = checkCounts.reduce(
        (acc, doc) => {
          if (doc._id == 'Master') {
            acc.masterCount = doc.count;
          }

          if (doc._id == 'Customer') {
            acc.customerCount = doc.count;
          }

          return acc;
        },
        { masterCount: 0, customerCount: 0 }
      );

      if (masterCount >= getUser.basicDetails.masterCount) {
        return res.status(403).json({ status: false, message: 'Master count limit exceed' });
      }

      if (customerCount >= getUser.basicDetails.customerCount) {
        return res.status(403).json({ status: false, message: 'Customer count limit exceed' });
      }
    }

    // Resolve accountType (can be ID or name like "CUSTOMER")
    const resolvedType = await resolveUserTypeId(req.body.accountType);
    if (!resolvedType) {
      return res.status(403).json({ status: false, message: 'Invalid User Type' });
    }
    const resolvedAccountTypeId = resolvedType.id;

    const getUserType = await getUserTypeById(resolvedAccountTypeId);
    if (!getUserType) {
      return res.status(403).json({ status: false, message: 'Invalid User Type' });
    }

    const createdLevel = +getUserType.level;

    // 🔗 CREATION LIMITS for levels 2-5 (check direct downline allocation + direct users)
    if (myLevel >= 2 && myLevel <= 5) {
      const directUsers = await getDirectUsers(userId); // Get all direct children

      let allocatedMasters = 0;
      let allocatedCustomers = 0;
      let directMasterCount = 0;
      let directCustomerCount = 0;

      // Sum allocated limits + count direct users by type
      for (const directUser of directUsers) {
        // Add allocated limits from each direct child
        allocatedMasters += +(directUser.basicDetails?.masterCount || 0);
        allocatedCustomers += +(directUser.basicDetails?.customerCount || 0);

        // Count direct users by their level
        const directUserLevel = directUser.accountType?.level || 0;
        if (directUserLevel === 5) {
          directMasterCount++;
        } else if (directUserLevel === 7) {
          directCustomerCount++;
        }
      }

      // Calculate used limits
      const usedMasters = allocatedMasters + directMasterCount;
      const usedCustomers = allocatedCustomers + directCustomerCount;

      // Get creator's max limits
      const maxMasters = +(getUser.basicDetails?.masterCount || 0);
      const maxCustomers = +(getUser.basicDetails?.customerCount || 0);

      // Calculate remaining limits
      const remainingMasters = maxMasters - usedMasters;
      const remainingCustomers = maxCustomers - usedCustomers;

      // Check if creating new user with limits exceeds remaining
      const newUserAllocatedMasters = createdLevel === 5 ? 1 + (+(req.body.basicDetails?.masterCount || 0)) : 0;
      const newUserAllocatedCustomers = createdLevel === 7 ? 1 + (+(req.body.basicDetails?.customerCount || 0)) : 0;

      if (newUserAllocatedMasters > remainingMasters || newUserAllocatedCustomers > remainingCustomers) {
        return res.status(403).json({
          status: false,
          message: 'Cannot create more users. Limit used.',
          details: {
            remaining: { masters: remainingMasters, customers: remainingCustomers },
            requesting: { masters: newUserAllocatedMasters, customers: newUserAllocatedCustomers }
          }
        });
      }
    }

    // Partnership floor validation - skip for level 6 & 7 (have their own validations)
    if (myLevel !== 1 && createdLevel !== 6 && createdLevel !== 7) {
      const myDownlineShare = getUser.partnership?.[myLevel - 1];
      if (myDownlineShare != null) {
        const partnershipFloor = 100 - myDownlineShare;
        if ((+(req.body.partnership) || 0) < partnershipFloor) {
          return res.status(403).json({
            status: false,
            message: `Minimum partnership you can give is ${partnershipFloor}%`
          });
        }
      }
    }

    const myMarginLimits = getUser.marketAccess;
    const myDistributedMarginLimits = await getMarketWiseSum(userId);
    const editUserMarginLimit = req.body.marketAccess;

    // Validation using MarginService and direct checks
    for (const ifEditExists of editUserMarginLimit) {
      const myConfig = myMarginLimits.find((m) => m.marketId == ifEditExists.marketId);
      if (!myConfig) {
        return res.status(400).json({ status: false, message: `Parent does not have access to ${ifEditExists.marketName}` });
      }

      // Lot cap: when type is 'lot', totalLotWise cannot exceed MAX_LOT_VALUE (configurable)
      if (ifEditExists.margin?.lotOrAmount === 'lot' && (+ifEditExists.margin?.totalLotWise || 0) > MAX_LOT_VALUE) {
        return res.status(400).json({
          status: false,
          message: `Total lot for ${ifEditExists.marketName} cannot exceed ${MAX_LOT_VALUE}`
        });
      }

      // Skip margin/lot allocation check if requester is level 1
      if (myLevel !== 1) {
        const allocationCheck = await MarginService.checkParentCanAllocateMargin(
          userId,
          ifEditExists.marketId,
          +ifEditExists.margin.totalLotWise || 0,
          +ifEditExists.margin.totalMargin || 0,
          ifEditExists.margin.lotOrAmount || 'amount',
          null, // excludeUserId (none for create)
          ifEditExists.marketName
        );

        if (!allocationCheck.canAllocate) {
          return res.status(400).json({
            status: false,
            message: allocationCheck.message,
            details: allocationCheck.details
          });
        }

        // Check that the child's maximumLimit does not exceed parent's maximumLimit
        if (+ifEditExists.margin.maximumLimit > +myConfig.margin.maximumLimit) {
          return res.status(400).json({
            status: false,
            message: `Maximum limit for ${ifEditExists.marketName} cannot exceed parent's maximum limit (${myConfig.margin.maximumLimit})`
          });
        }

        // Check that the child's totalLotWise/totalMargin does not exceed parent's totalLotWise/totalMargin
        const childTotal = ifEditExists.margin.lotOrAmount === 'lot'
          ? +ifEditExists.margin.totalLotWise || 0
          : +ifEditExists.margin.totalMargin || 0;
        const parentTotal = ifEditExists.margin.lotOrAmount === 'lot'
          ? +myConfig.margin.totalLotWise || 0
          : +myConfig.margin.totalMargin || 0;
        if (childTotal > parentTotal) {
          return res.status(400).json({
            status: false,
            message: `Total ${ifEditExists.margin.lotOrAmount === 'lot' ? 'lot' : 'amount'} for ${ifEditExists.marketName} cannot exceed parent's total (${parentTotal})`
          });
        }
      } // end if (myLevel !== 1)

      // For level 7 (client/customer) only:
      // Their totalLotWise/totalMargin cannot exceed parent's maximumLimit.
      // (e.g. admin has totalLots=100, max=10 → each client gets at most 10 lots)
      // For higher-level users (master, sub-admin, broker), totalLotWise is bounded
      // by parent's available pool (checked above via checkParentCanAllocateMargin),
      // not by the per-client maximumLimit.

      if (createdLevel == 7) {
        if (myLevel !== 1) {
          const requestedValue =
            ifEditExists.margin.lotOrAmount === 'lot'
              ? +ifEditExists.margin.totalLotWise || 0
              : +ifEditExists.margin.totalMargin || 0;
          if (requestedValue > (+myConfig.margin.maximumLimit || 0)) {
            return res.status(400).json({
              status: false,
              message: `Total ${ifEditExists.margin.lotOrAmount === 'lot' ? 'lot' : 'amount'} limit for ${ifEditExists.marketName} cannot exceed parent's maximum limit (${myConfig.margin.maximumLimit})`
            });
          }
        }
      }

      // Brokerage Validation for User creation (all levels)
      if (ifEditExists.brokerage) {
        const pBrokerage = myConfig.brokerage || {};
        const { deliveryCommission, intradayCommission, type: bType, minLotWiseBrokerage, minPercentageWiseBrokerage } = ifEditExists.brokerage;

        const valOf = (v) => (v === "" || v === null || v === undefined) ? -1 : +v;

        // 1. Determine Parent Requirement (pReq) based on child's type
        const pReqLot = Math.max(
          valOf(pBrokerage.minLotWiseBrokerage),
          (pBrokerage.type === 'lot' ? valOf(pBrokerage.deliveryCommission) : -1),
          (pBrokerage.type === 'lot' ? valOf(pBrokerage.intradayCommission) : -1),
          0
        );
        const pReqPerc = Math.max(
          valOf(pBrokerage.minPercentageWiseBrokerage),
          (pBrokerage.type === 'percent' ? valOf(pBrokerage.deliveryCommission) : -1),
          (pBrokerage.type === 'percent' ? valOf(pBrokerage.intradayCommission) : -1),
          0
        );

        let pReq = (bType === 'lot') ? pReqLot : pReqPerc;

        // Logical Fallback: ONLY if parent has NO requirement in our type, use other type as floor
        if (pReq === 0) {
          pReq = (bType === 'lot') ? pReqPerc : pReqLot;
        }

        // 2. CHILD Basic Validation (Min or Commissions)
        const currentMin = bType === 'lot' ? valOf(minLotWiseBrokerage) : valOf(minPercentageWiseBrokerage);
        const cDel = valOf(deliveryCommission);
        const cIntra = valOf(intradayCommission);

        let validationPassed = true;
        let errorMsg = `${ifEditExists.marketName} requirement is ${pReq}.`;

        if (currentMin !== -1) {
          if (currentMin < pReq) {
            validationPassed = false;
            errorMsg += ` Your Min Brokerage (${currentMin}) is below this.`;
          }
        } else if (cDel !== -1 || cIntra !== -1) {
          if ((cDel !== -1 && cDel < pReq) || (cIntra !== -1 && cIntra < pReq) || Math.max(cDel, cIntra) < pReq) {
            validationPassed = false;
            errorMsg += ` One or more of your rates (Del/Intra) are below this.`;
          }
        } else if (pReq > 0) {
          validationPassed = false;
          errorMsg += ` Please set either Min Brokerage or Delivery/Intraday rates.`;
        }

        if (!validationPassed) {
          return res.status(400).json({ status: false, message: errorMsg });
        }

        // 3. Sub-Broker General Distribution
        const effectiveDelS = Math.max(cDel, currentMin, 0);
        const effectiveIntraS = Math.max(cIntra, currentMin, 0);
        const remainingDelivS = Math.max(0, effectiveDelS - pReq);
        const remainingIntraS = Math.max(0, effectiveIntraS - pReq);

        const brokerCommissions = ifEditExists.brokerage.brokerCommission || [];
        const { totalDelS, totalIntS } = brokerCommissions.reduce((acc, item) => {
          acc.totalDelS += +(item.deliveryCommission || 0);
          acc.totalIntS += +(item.intradayCommission || 0);
          return acc;
        }, { totalDelS: 0, totalIntS: 0 });

        if (+remainingDelivS.toFixed(6) < +totalDelS.toFixed(6) || +remainingIntraS.toFixed(6) < +totalIntS.toFixed(6)) {
          const typeLabel = bType == 'lot' ? 'per lot ' : '';
          return res.status(400).json({
            status: false,
            message: `Over-distribution for ${ifEditExists.marketName}. Upline share is ${pReq} ${typeLabel}. Available: ${remainingDelivS.toFixed(6)}. Sub-brokers total: ${totalDelS.toFixed(6)}.`
          });
        }

        // 4. Script-wise Validation
        const childScripts = ifEditExists.brokerage.scriptWiseBrokerage || [];

        // Dependecy Check: Sub-brokers can only have scripts defined in main brokerage
        for (const bkr of brokerCommissions) {
          for (const bScript of (bkr.scriptWiseBrokerage || [])) {
            if (!childScripts.some(s => s.script === bScript.script)) {
              return res.status(400).json({ status: false, message: `Script ${bScript.script} cannot be distributed to sub-brokers as it is not defined in your script-wise brokerage list.` });
            }
          }
        }

        for (const sItem of childScripts) {
          const { script: sName } = sItem;
          const sDelVal = valOf(sItem.deliveryCommission);
          const sIntVal = valOf(sItem.intradayCommission);
          const sLotVal = valOf(sItem.lot);
          const sPctVal = valOf(sItem.percentage);
          const sMinVal = (bType === 'lot') ? sLotVal : sPctVal;

          const pScript = (pBrokerage.scriptWiseBrokerage || []).find(s => s.script === sName);
          let pSReqLot = pScript ? Math.max(valOf(pScript.lot), valOf(pScript.deliveryCommission), valOf(pScript.intradayCommission), pReq) : pReq;
          let pSReqPerc = pScript ? Math.max(valOf(pScript.percentage), valOf(pScript.deliveryCommission), valOf(pScript.intradayCommission), pReq) : pReq;

          let pSReq = (bType === 'lot') ? pSReqLot : pSReqPerc;
          if (pSReq === 0) pSReq = (bType === 'lot') ? pSReqPerc : pSReqLot;

          // Combined Validation: At least one rate (Min, Del, or Intra) must meet the requirement
          const cMaxRate = Math.max(sMinVal, sDelVal, sIntVal);

          if (cMaxRate < pSReq) {
            const rateToPrint = cMaxRate === -1 ? 0 : cMaxRate;
            return res.status(400).json({
              status: false,
              message: `${ifEditExists.marketName} script ${sName} rate (${rateToPrint}) is below requirement (${pSReq}).`
            });
          }

          // Check Script Distribution Limit
          const sEffDel = Math.max(sDelVal, sMinVal, 0);
          const sEffInt = Math.max(sIntVal, sMinVal, 0);
          const sRemDel = Math.max(0, sEffDel - pSReq);
          const sRemInt = Math.max(0, sEffInt - pSReq);

          let sUsedDel = 0;
          let sUsedInt = 0;
          for (const bkr of brokerCommissions) {
            const bScript = (bkr.scriptWiseBrokerage || []).find(s => s.script === sName);
            if (bScript) {
              sUsedDel += +(bScript.deliveryCommission || 0);
              sUsedInt += +(bScript.intradayCommission || 0);
            }
          }

          if (+sRemDel.toFixed(6) < +sUsedDel.toFixed(6) || +sRemInt.toFixed(6) < +sUsedInt.toFixed(6)) {
            return res.status(400).json({ status: false, message: `${ifEditExists.marketName} script ${sName} over-distributed. Available: ${sRemDel.toFixed(6)}. Sub-brokers total: ${sUsedDel.toFixed(6)}.` });
          }
        }
      }

      // NSE-EQ maximumLimit distribution check:
      // Sum of all existing children's maximumLimit + new user's maximumLimit must not exceed parent's maximumLimit
      if (ifEditExists.marketId === '12' && myLevel !== 1) {
        const newMaxLimit = Number(ifEditExists.margin?.maximumLimit) || 0;
        if (newMaxLimit > 0) {
          const existingChildrenMaxLimit = await userModel.aggregate([
            { $match: { 'createdBy.userId': mongoose.Types.ObjectId.isValid(userId) ? new mongoose.Types.ObjectId(userId) : userId, isDeleted: { $ne: true } } },
            { $unwind: '$marketAccess' },
            { $match: { 'marketAccess.marketId': '12' } },
            { $group: { _id: null, totalMaxLimit: { $sum: { $toDouble: '$marketAccess.margin.maximumLimit' } } } }
          ]);
          const totalExisting = (existingChildrenMaxLimit[0]?.totalMaxLimit) || 0;
          const parentNseEqPool = myConfig.margin.totalMargin || 0;
          if (totalExisting + newMaxLimit > parentNseEqPool) {
            return res.status(400).json({
              status: false,
              message: `NSE-EQ total distributed limit for all sub-users (${totalExisting + newMaxLimit}) would exceed your pool limit (${parentNseEqPool}). Available: ${Math.max(0, parentNseEqPool - totalExisting)}`
            });
          }
        }
      }
    }

    // NSE-EQ Annual Interest Rate validation:
    // Only if NSE-EQ market is selected for this user
    const hasNseEqAccess = req.body.marketAccess?.some(m => m.marketId === '12' && m.isSelected);
    const newInterestRate = Number(req.body.basicDetails?.nseEqAnnualInterest);
    if (hasNseEqAccess && !isNaN(newInterestRate)) {
      const parentInterestRate = Number(getUser.basicDetails?.nseEqAnnualInterest) || 12;
      if (newInterestRate < parentInterestRate) {
        return res.status(400).json({
          status: false,
          message: `NSE-EQ annual interest rate (${newInterestRate}%) cannot be less than your own rate (${parentInterestRate}%).`
        });
      }
    }

    const {
      accountName: creatorAccountName,
      accountCode: code,
      accountType: { level, label },
      partnership: userPartnership,
      parentIds: userParentIds
    } = getUser;

    const createdBy = { userId, level, label, accountCode: code, accountName: creatorAccountName };

    const levelDiff = createdLevel != 7 ? createdLevel - level : createdLevel - 1 - level;
    const creatorPartnership = req.body.partnership;
    //const downlinePartnership = userPartnership[level - 1] - creatorPartnership;
    const downlinePartnership = 100 - creatorPartnership;
    const getParentPartnership = userPartnership.slice(0, level - 1).reduce((acc, item) => acc + item, 0);
    // if (getParentPartnership > creatorPartnership) {
    //   return res.status(403).json({
    //     status: false,
    //     message: "Min partnership would be " + getParentPartnership,
    //   });
    // }

    let partnership = [...userPartnership, ...new Array(levelDiff).fill(0)];
    if (createdLevel != 7) {
      // Downline gets the remainder (100 - creatorPartnership)
      partnership[createdLevel - 1] = downlinePartnership;
      // Creator's net share = their committed % minus what goes to their upline minus broker
      const createdP = creatorPartnership - getParentPartnership - brokerPartnership;
      partnership[level - 1] = createdP;
      // Broker share always stored at index 5 (even for intermediate levels)
      partnership[5] = brokerPartnership;
    }
    if (createdLevel == 7) {
      // Creator's net share = their committed % minus upline share minus broker
      partnership[level - 1] = creatorPartnership - getParentPartnership - brokerPartnership;
      partnership[5] = brokerPartnership;
    }

    let parentIds = [...userParentIds, userId];

    req.body.basicDetails.ledgerView = getUser.basicDetails.ledgerView ? req.body.basicDetails.ledgerView : getUser.basicDetails.ledgerView;
    req.body.basicDetails.viewOnlyAccess = getUser.basicDetails.viewOnlyAccess
      ? getUser.basicDetails.viewOnlyAccess
      : req.body.basicDetails.viewOnlyAccess;
    req.body.basicDetails.limitSLDisabled = getUser.basicDetails.limitSLDisabled
      ? getUser.basicDetails.limitSLDisabled
      : req.body.basicDetails.limitSLDisabled;
    req.body.basicDetails.modificationAccess = getUser.basicDetails.modificationAccess
      ? req.body.basicDetails.modificationAccess
      : getUser.basicDetails.modificationAccess;
    req.body.basicDetails.manualTradeAllowed = getUser.basicDetails.manualTradeAllowed
      ? req.body.basicDetails.manualTradeAllowed
      : getUser.basicDetails.manualTradeAllowed;
    req.body.basicDetails.brokerageRefreshAllowed = getUser.basicDetails.brokerageRefreshAllowed
      ? req.body.basicDetails.brokerageRefreshAllowed
      : getUser.basicDetails.brokerageRefreshAllowed;

    if (getUser.accountType.level == 1) {
      req.body.basicDetails.manualAccountCode = req.body.basicDetails.manualAccountCode ?? false;
    }

    let manualAccountCodeValue = getUser.basicDetails.manualAccountCode ? reqAccountCode : accountCode;

    // If manualAccountCode was intended but not provided or empty, fallback to generated one
    if (getUser.basicDetails.manualAccountCode && (!manualAccountCodeValue || String(manualAccountCodeValue).trim() === '')) {
      manualAccountCodeValue = accountCode;
    }

    // Account code must be numeric and at most ACCOUNT_CODE_LENGTH digits
    if (!isValidAccountCode(manualAccountCodeValue)) {
      return res.status(400).json({ status: false, message: `Account Code must be numeric and at most ${ACCOUNT_CODE_LENGTH} digits` });
    }

    const createPayload = {
      ...req.body,
      accountCode: manualAccountCodeValue,
      partnership,
      createdBy,
      parentIds,
      demoid: isDemo === true || isDemo === 'true' || demoid === true || demoid === 'true' || getUser.demoid === true
    };
    if (
      req.body.basicDetails &&
      req.body.basicDetails.transactionPassword !== undefined &&
      req.body.basicDetails.transactionPassword !== null
    ) {
      createPayload.basicDetails = {
        ...createPayload.basicDetails,
        transactionPassword:
          typeof req.body.basicDetails.transactionPassword === 'string'
            ? req.body.basicDetails.transactionPassword.trim()
            : String(req.body.basicDetails.transactionPassword)
      };
    }

    const newUser = await saveUser(createPayload);

    if (createPayload.demoid) {
      await createQtySettingsForUser(newUser._id);
    }
    // Refresh M2M Cache in background
    M2MService.refreshM2MUserCache().catch(err => console.error("M2M Cache Refresh Error (Create):", err));

    res.status(200).json({
      status: true,
      message: `User Created Successfully, user Id: ${manualAccountCodeValue}`
    });
  } catch (error) {
    console.log(error);
    res.status(500).json({ status: 'false' });
  }
};

exports.getUsers = async (req, res) => {
  try {
    const userId = getEffectiveUserId(req);
    const {
      accountType: { level }
    } = req.user;
    const { accountType } = req.params;
    const { user, joinAfter, joinBefore } = req.query; // Get user filter parameter

    // Resolve accountType (can be ID or name like "CUSTOMER")
    const resolved = await resolveUserTypeId(accountType);

    if (!resolved) {
      return res.status(400).json({
        status: false,
        message: 'Invalid account type'
      });
    }

    const requesterIsDemo = isDemoUser(req);
    // If requester is a demo user, show only their demo downline (demoid: true).
    // Otherwise use the resolved type's isDemo flag to separate live vs demo users.
    const demoFilter = requesterIsDemo ? true : resolved.isDemo;

    // Determine filter mode: "all" = all downline, "MY" = only created by me, default = all downline
    const filterMode = user && user.toUpperCase() === 'MY' ? 'MY' : 'all';

    const data = await getUsers(userId, resolved.id, level, demoFilter, filterMode, { joinAfter, joinBefore });
    res.status(200).json({ status: true, data });
  } catch (error) {
    console.log(error);
    res.status(500).json({ status: 'false' });
  }
};

exports.getDemoUsers = async (req, res) => {
  try {
    const userId = getEffectiveUserId(req);
    const data = await getDemoUsers(userId);
    res.status(200).json({ status: true, data });
  } catch (error) {
    console.log(error);
    res.status(500).json({ status: 'false' });
  }
};

exports.getUserById = async (req, res) => {
  try {
    const { id } = req.params;
    const data = await getUserById(id);
    res.status(200).json({ status: true, data });
  } catch (error) {
    console.log(error);
    res.status(500).json({ status: 'false' });
  }
};

exports.getMarketSettings = async (req, res) => {
  try {
    const { accountCode, marketId, settingsName } = req.query;

    if (!accountCode || !marketId || !settingsName) {
      return res.status(400).json({
        status: false,
        message: 'accountCode, marketId, and settingsName are required'
      });
    }

    const result = await getMarketSettingsByAccountCode(accountCode, marketId, settingsName);

    if (!result.success) {
      return res.status(404).json({
        status: false,
        message: result.message
      });
    }

    res.status(200).json({
      status: true,
      data: result.data
    });
  } catch (error) {
    console.error('getMarketSettings controller error:', error);
    res.status(500).json({
      status: false,
      message: 'Internal server error'
    });
  }
};

exports.getUserMargins = async (req, res) => {
  try {
    const userId = getEffectiveUserId(req);
    const data = await getUserMargins({ parentIds: userId });
    res.status(200).json({ status: true, data });
  } catch (error) {
    console.log(error);
    res.status(500).json({ status: 'false' });
  }
};

exports.getDownlineLevelUsers = async (req, res) => {
  try {
    const effectiveUserId = getEffectiveUserId(req);
    const { level } = req.params;
    const { id, user } = req.query;

    const Id = id && id != '' ? id : effectiveUserId;
    
    // Determine filter mode: "all" = all downline, "MY" = only created by me, default = all downline
    const filterMode = user && user.toUpperCase() === 'MY' ? 'MY' : 'all';
    
    const data = await getDownlineLevelUsers(Id, level, filterMode);
    res.status(200).json({ status: true, data });
  } catch (error) {
    console.log(error);
    res.status(500).json({ status: 'false' });
  }
};

exports.getDownlineUsers = async (req, res) => {
  try {
    const effectiveUserId = getEffectiveUserId(req);
    const { accountType } = req.user;
    const { level, type, search, user } = req.query;
    
    // Determine filter mode: "all" = all downline, "MY" = only created by me, default = all downline
    const filterMode = user && user.toUpperCase() === 'MY' ? 'MY' : 'all';
    
    const data = await getDownlineUsers(effectiveUserId, accountType, level, type, search, isDemoUser(req), filterMode);
    res.status(200).json({ status: true, data });
  } catch (error) {
    console.log(error);
    res.status(500).json({ status: 'false' });
  }
};

exports.editUser = async (req, res) => {
  try {
    const { id: edituserId, userId, transactionPassword } = req.params;
    const editor = req.user;
    // console.log("Edit user body :",req.body);
    // edituserId = userId;
    // if (
    //   !req.body.transactionPassword ||
    //   typeof req.body.transactionPassword !== "string" ||
    //   !req.body.transactionPassword.trim()
    // ) {
    //   return res.status(400).json({
    //     status: false,
    //     message: "Transaction password is required",
    //   });
    // }
    // const isValid = await validateTransactionPassword(
    //   editor.userId,
    //   req.body.transactionPassword.trim()
    // );
    // // console.log("Is valid : ", isValid);
    // if (!isValid) {
    //   // console.log("If triggered ........");
    //   return res.status(401).json({
    //     status: false,
    //     message: "Wrong transaction password",
    //   });
    // }

    const { accountName, accountCode } = req.body;
    if (accountName) {
      if (accountName.length > 11) {
        return res.status(400).json({ status: false, message: 'Account Name cannot be longer than 11 characters' });
      }

      const existingUser = await userModel.findOne({
        accountName
      });
      if (existingUser && existingUser._id.toString() !== edituserId.toString()) {
        return res.status(400).json({ status: false, message: 'Account Name already exists' });
      }
    }

    const getEditedUser = await getUserById(edituserId);
    if (!getEditedUser) {
      return res.status(403).json({ status: false, message: 'Invalid User' });
    }

    // Determine the ACTUAL parent (creator) of the user being edited
    // If SuperAdmin is editing, them being req.user shouldn't wipe intermediate levels.
    // We use getEditedUser.createdBy.userId or the last ID in parentIds.
    let actualParentId = getEditedUser.createdBy?.userId;
    if (!actualParentId && getEditedUser.parentIds.length > 0) {
      actualParentId = getEditedUser.parentIds[getEditedUser.parentIds.length - 1];
    }

    // Fallback to params if creator ID missing
    if (!actualParentId) actualParentId = userId;

    const getUser = await getUserById(actualParentId);
    if (!getUser) {
      return res.status(403).json({ status: false, message: 'Invalid Parent User' });
    }

    const editedLevel = +getEditedUser.accountType.level;
    const editedPartnership = getEditedUser.partnership;

    const {
      accountType: { level },
      partnership: userPartnership
    } = getUser;

    const levelDiff = editedLevel != 7 ? editedLevel - level : editedLevel - 1 - level;

    const creatorPartnership = req.body.partnership;

    const brokerPartnership =
      req.body?.basicDetails?.brokerPartnership.reduce((acc, item) => {
        return (acc += item.partnership);
      }, 0) || 0;

    if (brokerPartnership > userPartnership[level - 1]) {
      return res.status(403).json({ status: false, message: 'Broker Partnership exceed' });
    }

    if (+level !== 1 && editedLevel !== 6 && editedLevel !== 7) {
      const creatorDownlineShare = getUser.partnership?.[level - 1];
      if (creatorDownlineShare != null) {
        const partnershipFloor = 100 - creatorDownlineShare;
        if (creatorPartnership < partnershipFloor) {
          return res.status(403).json({
            status: false,
            message: `Minimum partnership you can give is ${partnershipFloor}%`
          });
        }
      }
    }

    //const downlinePartnership = userPartnership[level - 1] - creatorPartnership;
    const downlinePartnership = 100 - creatorPartnership;
    const getParentPartnership = userPartnership.slice(0, level - 1).reduce((acc, item) => acc + item, 0);
    // if (getParentPartnership > creatorPartnership) {
    //   return res.status(403).json({
    //     status: false,
    //     message: "Min partnership would be " + getParentPartnership,
    //   });
    // }

    let partnership = [...userPartnership, ...new Array(levelDiff).fill(0)];

    if (editedLevel != 7) {
      // Downline gets the remainder (100 - creatorPartnership)
      partnership[editedLevel - 1] = downlinePartnership;
      // Creator's net share = their committed % minus what goes to their upline minus broker
      const createdP = creatorPartnership - getParentPartnership - brokerPartnership;
      partnership[level - 1] = createdP;
      // Broker share always stored at index 5 (even for intermediate levels)
      partnership[5] = brokerPartnership;
    }
    if (editedLevel == 7) {
      // Creator's net share = their committed % minus upline share minus broker
      partnership[level - 1] = creatorPartnership - getParentPartnership - brokerPartnership;
      partnership[5] = brokerPartnership;
    }

    const getPartnershipDifference = downlinePartnership - editedPartnership[editedLevel - 1] || 0;

    if (getPartnershipDifference < 0) {
      const checkPartnershipUser = await checkPartnership(edituserId, editedLevel - 1, Math.abs(getPartnershipDifference));
      if (checkPartnershipUser > 0) {
        return res.status(403).json({ status: false, message: 'Partnership Limit reached' });
      }
    }

    const myMarginLimits = getUser.marketAccess;
    const editUserMarginLimit = req.body.marketAccess || [];

    let message = '';
    let errorFlag = 0;

    // Validation using MarginService and direct checks
    for (const ifEditExists of editUserMarginLimit) {
      const myConfig = myMarginLimits.find((m) => m.marketId == ifEditExists.marketId);
      if (!myConfig) {
        return res.status(400).json({ status: false, message: `Parent does not have access to ${ifEditExists.marketName}` });
      }

      // Lot cap: when type is 'lot', totalLotWise cannot exceed MAX_LOT_VALUE (configurable)
      if (ifEditExists.margin?.lotOrAmount === 'lot' && (+ifEditExists.margin?.totalLotWise || 0) > MAX_LOT_VALUE) {
        return res.status(400).json({
          status: false,
          message: `Total lot for ${ifEditExists.marketName} cannot exceed ${MAX_LOT_VALUE}`
        });
      }

      // Skip margin/lot allocation check if requester is level 1
      if (+level !== 1) {
        const allocationCheck = await MarginService.checkParentCanAllocateMargin(
          actualParentId,
          ifEditExists.marketId,
          +ifEditExists.margin?.totalLotWise || 0,
          +ifEditExists.margin?.totalMargin || 0,
          ifEditExists.margin?.lotOrAmount || 'amount',
          edituserId, // exclude current user being edited
          ifEditExists.marketName
        );

        if (!allocationCheck.canAllocate) {
          return res.status(400).json({
            status: false,
            message: allocationCheck.message,
            details: allocationCheck.details
          });
        }

        // Check that the child's maximumLimit does not exceed parent's maximumLimit
        if (+ifEditExists.margin.maximumLimit > +(myConfig.margin?.maximumLimit || 0)) {
          return res.status(400).json({
            status: false,
            message: `Maximum limit for ${ifEditExists.marketName} cannot exceed parent's maximum limit (${myConfig.margin?.maximumLimit || 0})`
          });
        }

        // Check that the child's totalLotWise/totalMargin does not exceed parent's totalLotWise/totalMargin
        const childTotal = ifEditExists.margin?.lotOrAmount === 'lot'
          ? +ifEditExists.margin?.totalLotWise || 0
          : +ifEditExists.margin?.totalMargin || 0;
        const parentTotal = ifEditExists.margin?.lotOrAmount === 'lot'
          ? +myConfig.margin?.totalLotWise || 0
          : +myConfig.margin?.totalMargin || 0;
        if (childTotal > parentTotal) {
          return res.status(400).json({
            status: false,
            message: `Total ${ifEditExists.margin?.lotOrAmount === 'lot' ? 'lot' : 'amount'} for ${ifEditExists.marketName} cannot exceed parent's total (${parentTotal})`
          });
        }
      } // end if (+level !== 1)

      // For level 7 (client/customer) only:
      // Their totalLotWise/totalMargin cannot exceed parent's maximumLimit.
      // (e.g. admin has totalLots=100, max=10 → each client gets at most 10 lots)
      // For higher-level users (master, sub-admin, broker), totalLotWise is bounded
      // by parent's available pool (checked above via checkParentCanAllocateMargin),
      // not by the per-client maximumLimit.
      if (editedLevel == 7) {
        if (+level !== 1) {
          const requestedValue =
            ifEditExists.margin?.lotOrAmount === 'lot'
              ? +ifEditExists.margin?.totalLotWise || 0
              : +ifEditExists.margin?.totalMargin || 0;
          if (requestedValue > +(myConfig.margin?.maximumLimit || 0)) {
            return res.status(400).json({
              status: false,
              message: `Total ${ifEditExists.margin?.lotOrAmount === 'lot' ? 'lot' : 'amount'} limit for ${ifEditExists.marketName} cannot exceed parent's maximum limit (${myConfig.margin?.maximumLimit || 0})`
            });
          }
        }
      }

      // Brokerage Validation (Unified Lot/Percent) for any user
      // We use a merged version of the brokerage to ensure full context even if partial update is sent
      const existingMarket = getEditedUser.marketAccess.find(m => String(m.marketId) === String(ifEditExists.marketId));
      const mergedBrokerage = {
        ...(existingMarket?.brokerage || {}),
        ...(ifEditExists.brokerage || {})
      };

      if (mergedBrokerage && Object.keys(mergedBrokerage).length > 0) {
        const pBrokerage = myConfig.brokerage || {};
        const { deliveryCommission, intradayCommission, type: bType, minLotWiseBrokerage, minPercentageWiseBrokerage } = mergedBrokerage;

        const valOf = (v) => (v === "" || v === null || v === undefined) ? -1 : +v;

        // 1. Determine Parent Requirement (parentSharedReq) based on child's type
        const pReqLot = Math.max(
          valOf(pBrokerage.minLotWiseBrokerage),
          (pBrokerage.type === 'lot' ? valOf(pBrokerage.deliveryCommission) : -1),
          (pBrokerage.type === 'lot' ? valOf(pBrokerage.intradayCommission) : -1),
          0
        );
        const pReqPerc = Math.max(
          valOf(pBrokerage.minPercentageWiseBrokerage),
          (pBrokerage.type === 'percent' ? valOf(pBrokerage.deliveryCommission) : -1),
          (pBrokerage.type === 'percent' ? valOf(pBrokerage.intradayCommission) : -1),
          0
        );

        let parentSharedReq = (bType === 'lot') ? pReqLot : pReqPerc;

        // Logical Fallback: ONLY if parent has NO requirement in our type, use other type as floor
        if (parentSharedReq === 0) {
          parentSharedReq = (bType === 'lot') ? pReqPerc : pReqLot;
        }

        // 2. CHILD Basic Validation (Min or Commissions)
        const currentMin = bType === 'lot' ? valOf(minLotWiseBrokerage) : valOf(minPercentageWiseBrokerage);
        const cDel = valOf(deliveryCommission);
        const cIntra = valOf(intradayCommission);

        let validationPassed = true;
        let errorMsg = `${ifEditExists.marketName} requirement is ${parentSharedReq}.`;

        if (currentMin !== -1) {
          if (currentMin < parentSharedReq) {
            validationPassed = false;
            errorMsg += ` Your Min Brokerage (${currentMin}) is below this.`;
          }
        } else if (cDel !== -1 || cIntra !== -1) {
          if ((cDel !== -1 && cDel < parentSharedReq) || (cIntra !== -1 && cIntra < parentSharedReq) || Math.max(cDel, cIntra) < parentSharedReq) {
            validationPassed = false;
            errorMsg += ` One or more of your rates (Del/Intra) are below this.`;
          }
        } else if (parentSharedReq > 0) {
          validationPassed = false;
          errorMsg += ` Please set either Min Brokerage or Delivery/Intraday rates.`;
        }

        if (!validationPassed) {
          return res.status(400).json({ status: false, message: errorMsg });
        }

        // 3. Sub-Broker General Distribution
        const effectiveDel = Math.max(cDel, currentMin, 0);
        const effectiveIntra = Math.max(cIntra, currentMin, 0);
        const remainingIntra = Math.max(0, effectiveIntra - parentSharedReq);
        const remainingDeliv = Math.max(0, effectiveDel - parentSharedReq);

        const brokerCommissions = mergedBrokerage.brokerCommission || [];
        const { totalDel, totalInt } = brokerCommissions.reduce((acc, bkr) => {
          acc.totalInt += +(bkr.intradayCommission || 0);
          acc.totalDel += +(bkr.deliveryCommission || 0);
          return acc;
        }, { totalDel: 0, totalInt: 0 });

        if (+remainingIntra.toFixed(6) < +totalInt.toFixed(6) || +remainingDeliv.toFixed(6) < +totalDel.toFixed(6)) {
          const typeLabel = bType == 'lot' ? 'per lot ' : '';
          return res.status(400).json({
            status: false,
            message: `Over-distribution for ${ifEditExists.marketName}. Upline share is ${parentSharedReq} ${typeLabel}. Available: ${remainingDeliv.toFixed(6)}. Sub-brokers total: ${totalDel.toFixed(6)}.`
          });
        }

        // 4. Script-wise Validation
        const childScripts = mergedBrokerage.scriptWiseBrokerage || [];

        // Dependency Check: Sub-brokers can only have scripts defined in main brokerage
        for (const bkr of brokerCommissions) {
          for (const bScript of (bkr.scriptWiseBrokerage || [])) {
            if (!childScripts.some(s => s.script === bScript.script)) {
              return res.status(400).json({ status: false, message: `Script ${bScript.script} cannot be distributed to sub-brokers as it is not defined in your script-wise brokerage list.` });
            }
          }
        }

        for (const sItem of childScripts) {
          const { script: sName } = sItem;
          const sDelVal = valOf(sItem.deliveryCommission);
          const sIntVal = valOf(sItem.intradayCommission);
          const sLotVal = valOf(sItem.lot);
          const sPctVal = valOf(sItem.percentage);
          const sMinVal = (bType === 'lot') ? sLotVal : sPctVal;

          const pScript = (pBrokerage.scriptWiseBrokerage || []).find(s => s.script === sName);
          let pSReqLot = pScript ? Math.max(valOf(pScript.lot), valOf(pScript.deliveryCommission), valOf(pScript.intradayCommission), parentSharedReq) : parentSharedReq;
          let pSReqPerc = pScript ? Math.max(valOf(pScript.percentage), valOf(pScript.deliveryCommission), valOf(pScript.intradayCommission), parentSharedReq) : parentSharedReq;

          let pSReq = (bType === 'lot') ? pSReqLot : pSReqPerc;
          if (pSReq === 0) pSReq = (bType === 'lot') ? pSReqPerc : pSReqLot;

          // Combined Validation: At least one rate (Min, Del, or Intra) must meet the requirement
          const cMaxRate = Math.max(sMinVal, sDelVal, sIntVal);

          if (cMaxRate < pSReq) {
            const rateToPrint = cMaxRate === -1 ? 0 : cMaxRate;
            return res.status(400).json({
              status: false,
              message: `${ifEditExists.marketName} script ${sName} rate (${rateToPrint}) is below requirement (${pSReq}).`
            });
          }

          // Check Script Distribution Limit
          const sEffDel = Math.max(sDelVal, sMinVal, 0);
          const sEffInt = Math.max(sIntVal, sMinVal, 0);
          const sRemDel = Math.max(0, sEffDel - pSReq);
          const sRemInt = Math.max(0, sEffInt - pSReq);

          let sUsedIntra = 0;
          let sUsedDeliv = 0;
          for (const bkr of brokerCommissions) {
            const scp = (bkr.scriptWiseBrokerage || []).find(s => s.script == sName);
            if (scp) {
              sUsedIntra += +(scp.intradayCommission || 0);
              sUsedDeliv += +(scp.deliveryCommission || 0);
            }
          }

          if (+sRemInt.toFixed(6) < +sUsedIntra.toFixed(6) || +sRemDel.toFixed(6) < +sUsedDeliv.toFixed(6)) {
            return res.status(400).json({
              status: false,
              message: `${ifEditExists.marketName} script ${sName} over-distributed. Available: ${sRemDel.toFixed(6)}. Sub-brokers total: ${sUsedDeliv.toFixed(6)}.`
            });
          }
        }
      }

      // NSE-EQ maximumLimit distribution check for edit:
      // Sum of all existing children's maximumLimit (excluding the current user being edited) + updated maximumLimit must not exceed parent's maximumLimit
      if (ifEditExists.marketId === '12' && +level !== 1) {
        const newMaxLimit = Number(ifEditExists.margin?.maximumLimit) || 0;
        if (newMaxLimit > 0) {
          const existingChildrenMaxLimit = await userModel.aggregate([
            {
              $match: {
                'createdBy.userId': mongoose.Types.ObjectId.isValid(actualParentId) ? new mongoose.Types.ObjectId(actualParentId) : actualParentId,
                _id: { $ne: new mongoose.Types.ObjectId(edituserId) },
                isDeleted: { $ne: true }
              }
            },
            { $unwind: '$marketAccess' },
            { $match: { 'marketAccess.marketId': '12' } },
            { $group: { _id: null, totalMaxLimit: { $sum: { $toDouble: '$marketAccess.margin.maximumLimit' } } } }
          ]);
          const totalExisting = (existingChildrenMaxLimit[0]?.totalMaxLimit) || 0;
          const parentNseEqPool = myConfig.margin.totalMargin || 0;
          if (totalExisting + newMaxLimit > parentNseEqPool) {
            return res.status(400).json({
              status: false,
              message: `NSE-EQ total distributed limit for all sub-users (${totalExisting + newMaxLimit}) would exceed parent's pool limit (${parentNseEqPool}). Available: ${Math.max(0, parentNseEqPool - totalExisting)}`
            });
          }
        }
      }
    }

    // NSE-EQ Annual Interest Rate validation:
    // Only if NSE-EQ market is selected for this user
    const hasNseEqUpdate = req.body.marketAccess?.some(m => m.marketId === '12' && m.isSelected);
    const editedInterestRate = Number(req.body.basicDetails?.nseEqAnnualInterest);
    if (hasNseEqUpdate && !isNaN(editedInterestRate)) {
      const parentInterestRate = Number(getUser.basicDetails?.nseEqAnnualInterest) || 12;
      if (editedInterestRate < parentInterestRate) {
        return res.status(400).json({
          status: false,
          message: `NSE-EQ annual interest rate (${editedInterestRate}%) cannot be less than the creator's rate (${parentInterestRate}%).`
        });
      }
    }

    // Basic detail validation
    if (!getUser.basicDetails.ledgerView && getEditedUser.basicDetails.ledgerView) {
      message = 'Ledger view access not allowed';
      errorFlag = 1;
    }
    if (getUser.basicDetails.viewOnlyAccess && !getEditedUser.basicDetails.viewOnlyAccess) {
      message = 'Parent has view only access';
      errorFlag = 1;
    }
    if (getUser.basicDetails.limitSLDisabled && !getEditedUser.basicDetails.limitSLDisabled) {
      message = 'Limit / SL disabled not allowed';
      errorFlag = 1;
    }
    if (!getUser.basicDetails.modificationAccess && getEditedUser.basicDetails.modificationAccess) {
      message = 'Downlevel modification access not allowed';
      errorFlag = 1;
    }
    if (!getUser.basicDetails.manualTradeAllowed && getEditedUser.basicDetails.manualTradeAllowed) {
      message = 'Manual trade not allowed';
      errorFlag = 1;
    }
    if (!getUser.basicDetails.brokerageRefreshAllowed && getEditedUser.basicDetails.brokerageRefreshAllowed) {
      message = 'Broker refresh not allowed';
      errorFlag = 1;
    }

    if (errorFlag) {
      return res.status(403).json({ status: false, message });
    }

    const { marketAccess, basicDetails, accountDetails } = req.body;

    // Deep merge marketAccess to prevent loss of unpassed fields (like marginPer)
    // If marketAccess is provided, it serves as the definitive list (enabling removals by omission)
    const existingMarkets = getEditedUser.marketAccess || [];
    const mergedMarketAccess = marketAccess ? marketAccess.map(newM => {
      const oldM = existingMarkets.find(m => String(m.marketId) === String(newM.marketId));
      if (oldM) {
        // Use toObject() if it's a mongoose document
        const oldObj = oldM.toObject ? oldM.toObject() : oldM;
        return {
          ...oldObj,
          ...newM,
          margin: { ...(oldObj.margin || {}), ...(newM.margin || {}) },
          brokerage: { ...(oldObj.brokerage || {}), ...(newM.brokerage || {}) },
          other: { ...(oldObj.other || {}), ...(newM.other || {}) }
        };
      }
      return newM; // New market being added
    }) : existingMarkets;

    const updatePayload = {
      accountName: accountName || getEditedUser.accountName,
      marketAccess: mergedMarketAccess,
      // Merge basicDetails and accountDetails to allow partial updates without data loss
      basicDetails: {
        ...(getEditedUser.basicDetails?.toObject ? getEditedUser.basicDetails.toObject() : getEditedUser.basicDetails),
        ...basicDetails
      },
      accountDetails: {
        ...(getEditedUser.accountDetails?.toObject ? getEditedUser.accountDetails.toObject() : getEditedUser.accountDetails),
        ...accountDetails
      },
      partnership
    };

    const cleanLongValues = (obj) => {
      if (!obj || typeof obj !== 'object') return obj;
      if (obj instanceof Date || (obj.constructor && obj.constructor.name === 'ObjectId')) return obj;

      for (const [key, value] of Object.entries(obj)) {
        if (value && typeof value === 'object') {
          if ('low' in value && 'high' in value) {
            obj[key] = typeof value.toNumber === 'function' ? value.toNumber() : Number((value.high * 4294967296) + (value.low >>> 0));
          } else {
            cleanLongValues(value);
          }
        }
      }
      return obj;
    };

    cleanLongValues(updatePayload);

    if (getUser.basicDetails.manualAccountCode && accountCode) {
      // Account code must be numeric and at most ACCOUNT_CODE_LENGTH digits
      if (!isValidAccountCode(accountCode)) {
        return res.status(400).json({ status: false, message: `Account Code must be numeric and at most ${ACCOUNT_CODE_LENGTH} digits` });
      }
      updatePayload.accountCode = accountCode;
    }
    if (
      req.body.basicDetails &&
      req.body.basicDetails.transactionPassword !== undefined &&
      req.body.basicDetails.transactionPassword !== null
    ) {
      updatePayload.basicDetails = {
        ...updatePayload.basicDetails,
        transactionPassword:
          typeof req.body.basicDetails.transactionPassword === 'string'
            ? req.body.basicDetails.transactionPassword.trim()
            : String(req.body.basicDetails.transactionPassword)
      };
    }

    // Take a one-time snapshot of limit fields on the first edit within a week.
    // The cron (Saturday midnight) restores these values, then clears the snapshot.
    const thisWeekMonday = moment().startOf('isoWeek').toDate();
    const existingSnapshot = getEditedUser.weeklyLimitSnapshot;
    const snapshotAlreadyTakenThisWeek =
      existingSnapshot?.weekStart &&
      moment(existingSnapshot.weekStart).isSame(thisWeekMonday, 'day');

    if (!snapshotAlreadyTakenThisWeek) {
      const ad = getEditedUser.accountDetails || {};
      updatePayload.weeklyLimitSnapshot = {
        weekStart: thisWeekMonday,
        m2mLoss_NSE_MCX_NOPT: ad.m2mLoss_NSE_MCX_NOPT ?? 0,
        m2mProfit_NSE_MCX_NOPT: ad.m2mProfit_NSE_MCX_NOPT ?? 0,
        m2mLoss_FOREX_COMEX: ad.m2mLoss_FOREX_COMEX ?? 0,
        m2mProfit_FOREX_COMEX: ad.m2mProfit_FOREX_COMEX ?? 0,
        m2mLoss_NSEEQ: ad.m2mLoss_NSEEQ ?? 0,
        m2mProfit_NSEEQ: ad.m2mProfit_NSEEQ ?? 0,
        marketMargins: (getEditedUser.marketAccess || []).map(m => ({
          marketId: m.marketId,
          marketName: m.marketName,
          lotOrAmount: m.margin?.lotOrAmount || 'lot',
          totalLotWise: m.margin?.totalLotWise ?? 0,
          totalMargin: m.margin?.totalMargin ?? 0,
          maximumLimit: m.margin?.maximumLimit ?? 0
        }))
      };
    }

    await updateUser(updatePayload, edituserId, req.ip, getLoginUserId(req));

    const parentPartnershipDifference = -1 * getPartnershipDifference;
    await updateManyUser(
      { parentIds: edituserId },
      {
        $inc: {
          [`partnership.${level - 1}`]: parentPartnershipDifference,
          [`partnership.${editedLevel - 1}`]: getPartnershipDifference
        }
      }
    );
    if (getEditedUser.accountType.level < 6) {
      updateDownlineBasicDetails(getEditedUser.basicDetails, basicDetails, edituserId);
    }
    // Refresh M2M cache and reset any breach locks so that if limits were
    // increased, the user is immediately unblocked for trading on the next cycle.
    M2MService.refreshM2MUserCache().catch(err => console.error("M2M Cache Refresh Error (Edit):", err));
    if (typeof M2MService.resetM2MBreachState === "function") {
      M2MService.resetM2MBreachState(edituserId).catch(err => console.error("M2M Breach Reset Error (Edit):", err));
    }

    res.status(200).json({ status: true, message: 'Succesfully update user' });
  } catch (error) {
    console.log(error);
    res.status(500).json({ status: 'false' });
  }
};

const updateDownlineBasicDetails = async (oldBasicDetails, newBasicDetails, edituserId) => {
  const keys = ['ledgerView', 'viewOnlyAccess', 'limitSLDisabled', 'modificationAccess', 'manualTradeAllowed', 'brokerageRefreshAllowed'];

  const values = keys.reduce((acc, key) => {
    if (oldBasicDetails[key] !== newBasicDetails[key]) {
      acc[`basicDetails.${key}`] = newBasicDetails[key];
    }
    return acc;
  }, {});

  if (Object.keys(values).length > 0) {
    await updateManyUser({ parentIds: edituserId }, values);
  }
};

exports.getMarginManagement = async (req, res) => {
  try {
    const userId = getEffectiveUserId(req);

    // User requested to remove query params for fetching data, so we rely on DB user object.
    // However, filters like client/broker/master might still be needed?
    // "get the other details fron the user object fron db data fetch remove rhe query poarams"
    // I will assume marketIds come from DB. client/broker/master might still be filters.
    // Let's remove marketIds from query.
    let { client, broker, master } = req.query;

    let marketIds = [];
    const userAccess = await getMarketAccess(userId);
    if (userAccess && userAccess.length > 0 && userAccess[0].marketAccess) {
      marketIds = userAccess[0].marketAccess.map((m) => String(m.marketId));
    } else {
      // Fallback or empty
      marketIds = ['10', '2', '1', '3'];
    }

    const userLevel = req.user?.accountType?.level;
    const data = await getMarginManagementData(userId, marketIds, userLevel);
    res.status(200).json({ status: true, data });
  } catch (error) {
    console.log(error);
    res.status(500).json({ status: 'false' });
  }
};

exports.getMyM2MLimits = async (req, res) => {
  try {
    const userId = getEffectiveUserId(req);
    const user = await userModel
      .findById(userId)
      .select("accountName accountCode accountDetails")
      .lean();
    if (!user) return res.status(404).json({ status: false, message: "User not found" });

    const ad = user.accountDetails || {};
    res.status(200).json({
      status: true,
      data: {
        accountName: user.accountName,
        accountCode: user.accountCode,
        m2mLimits: {
          NSE_MCX_NOPT: {
            loss:   ad.m2mLoss_NSE_MCX_NOPT   || 0,
            profit: ad.m2mProfit_NSE_MCX_NOPT || 0,
          },
          FOREX_COMEX: {
            loss:   ad.m2mLoss_FOREX_COMEX   || 0,
            profit: ad.m2mProfit_FOREX_COMEX || 0,
          },
          NSEEQ: {
            loss:   ad.m2mLoss_NSEEQ   || 0,
            profit: ad.m2mProfit_NSEEQ || 0,
          },
        },
      },
    });
  } catch (error) {
    res.status(500).json({ status: false, message: error.message });
  }
};

exports.getMarginLimits = async (req, res) => {
  try {
    const userId = getEffectiveUserId(req);
    const userLevel = req.user?.accountType?.level;
    const { marketIds, client, broker, master, userid, clientType, isDetail } = req.body;
    const data = await getMarginLimits(userId, marketIds, client, broker, master, isDemoUser(req), userid, clientType, userLevel, isDetail);
    res.status(200).json({ status: true, data });
  } catch (error) {
    console.log(error);
    res.status(500).json({ status: 'false' });
  }
};

exports.getDirectUsers = async (req, res) => {
  try {
    const userId = getEffectiveUserId(req);
    const { user } = req.query;
    
    // Note: getDirectUsers already returns only users created by the current user
    // The "all" vs "MY" filter doesn't apply here as it's always direct children
    // But we keep the parameter for consistency
    const data = await getDirectUsers(userId, isDemoUser(req));
    res.status(200).json({ status: true, data });
  } catch (error) {
    console.log(error);
    res.status(500).json({ status: 'false' });
  }
};

exports.getClientTree = async (req, res) => {
  try {
    const userId = getEffectiveUserId(req);
    const { clientId } = req.body;
    const data = await getClientTree(clientId, userId);
    res.status(200).json({ status: true, data });
  } catch (error) {
    console.log(error);
    res.status(500).json({ status: 'false' });
  }
};

exports.getOnlineUsers = async (req, res) => {
  try {
    const userId = getEffectiveUserId(req);
    const { user } = req.query;
    
    // Determine filter mode: "all" = all downline, "MY" = only created by me, default = all downline
    const filterMode = user && user.toUpperCase() === 'MY' ? 'MY' : 'all';
    
    const data = await getOnlineUsers(userId, filterMode);
    res.status(200).json({ status: true, data });
  } catch (error) {
    console.log(error);
    res.status(500).json({ status: 'false' });
  }
};

exports.getUsersByLevel = async (req, res) => {
  try {
    const userId = getEffectiveUserId(req);
    const { level } = req.query;

    const users = await getUsersByLevel(new mongoose.Types.ObjectId(userId), level);

    res.status(200).json({ status: true, data: users });
  } catch (err) {
    res.status(500).json({ status: false });
  }
};

exports.getOnlineHistory = async (req, res) => {
  try {
    const parentId = getEffectiveUserId(req);
    const { userId, page, limit } = req.body;
    const data = await getOnlineHistory(parentId, userId, page, limit);
    res.status(200).json({ status: true, data });
  } catch (error) {
    console.log(error);
    res.status(500).json({ status: 'false' });
  }
};

exports.getUserLevelMargins = async (req, res) => {
  try {
    let userId = getEffectiveUserId(req);
    userId = new mongoose.Types.ObjectId(userId);
    const { marketIds } = req.body;
    const data = await getUserLevelMargins([userId], marketIds);
    res.status(200).json({ status: true, data });
  } catch (error) {
    console.log(error);
    res.status(500).json({ status: 'false' });
  }
};

exports.getUserCounts = async (req, res) => {
  try {
    let userId = getEffectiveUserId(req);
    userId = new mongoose.Types.ObjectId(userId);
    const data = await getUserCounts(userId);
    res.status(200).json({ status: true, data });
  } catch (error) {
    console.log(error);
    res.status(500).json({ status: 'false' });
  }
};

exports.getDownlineDirectUsers = async (req, res) => {
  try {
    const { accountType, userId } = req.params;

    // Resolve accountType (can be ID or name like "CUSTOMER")
    const resolved = await resolveUserTypeId(accountType);

    if (!resolved) {
      return res.status(400).json({
        status: false,
        message: 'Invalid account type'
      });
    }

    const requesterIsDemo = isDemoUser(req);
    // If requester is a demo user, restrict to their demo downline (demoid: true).
    // Otherwise use the resolved type's isDemo flag.
    const demoFilter = requesterIsDemo ? true : resolved.isDemo;
    const data = await getDirectDownlineUsers(userId, resolved.id, '', demoFilter);
    res.status(200).json({ status: true, data });
  } catch (error) {
    console.log(error);
    res.status(500).json({ status: 'false' });
  }
};
exports.getExtendedUsers = async (req, res) => {
  try {
    const { page = 1, limit = 10, search = '', userType = '', superadmin_excluded, accountcode, withparents } = req.query;
    const skip = (page - 1) * limit;

    const isSAExclude = superadmin_excluded === 'true' || superadmin_excluded === '1';
    const isWithParents = withparents === 'true' || withparents === '1';

    const userId = getEffectiveUserId(req);
    const {
      accountType: { level: requesterLevel }
    } = req.user;

    let users = [];
    let totalUsers = 0;
    let totalActiveRecords = 0;
    let aggregation = [];
    let demoCount = 0;
    const requesterIsDemo = isDemoUser(req);
    // If requester is a demo user, restrict to demo users only.
    // If requester is a normal user, hide all demo users.
    let liveUserQuery = requesterIsDemo ? { demoid: true } : { demoid: { $ne: true } };

    let commonSelect = {
      accountName: 1,
      accountCode: 1,
      lastLogin: 1,
      demoid: 1,
      accountType: 1,
      parentIds: 1,
      createdAt: 1,
      isDeleted: 1,
      loginIP: 1,
      forceLogout: 1,
      forceLogoutMinutes: 1,
      forceLogoutStartedAt: 1,
      forcedlogoutLoginattempts: 1,
      createdBy: 1,
      status : 1
    };

    if (accountcode) {
      // 1. Mode: Specific User (+ Parents)
      const targetUser = await userModel.findOne({ accountCode: accountcode }).select('_id parentIds').lean();

      if (targetUser) {
        const isAuthorized = requesterLevel === 1 || targetUser.parentIds.some((id) => String(id) === String(userId));

        if (isAuthorized) {
          const fetchIds = isWithParents ? [...targetUser.parentIds, targetUser._id] : [targetUser._id];
          users = await userModel
            .find({ _id: { $in: fetchIds } })
            .select(commonSelect)
            .populate('accountType', 'label name _id')
            .populate({ path: 'parentIds', select: 'accountName accountCode _id' })
            .lean();

          // Sort by hierarchy: Parents first (in order), then user
          const idOrder = fetchIds.map((id) => String(id));
          users.sort((a, b) => idOrder.indexOf(String(a._id)) - idOrder.indexOf(String(b._id)));

          totalUsers = users.length;
          totalActiveRecords = users.length;
          liveUserQuery = { _id: { $in: fetchIds } };
        }
      }
    } else {
      // 2. Mode: General Listing (Existing Logic)
      const saTypes = await UserType.find({ level: 1 }).select('_id').lean();
      const saIds = saTypes.map((t) => t._id);
      const saFilter = { $nin: saIds };

      // Demo requester sees only their demo downline; normal requester hides all demo users
      const demoidFilter = requesterIsDemo ? { demoid: true } : { demoid: { $ne: true } };
      const query = { ...demoidFilter };
      const aggregationMatch = { ...demoidFilter };
      const totalActiveQuery = { ...demoidFilter };

      if (isSAExclude) {
        query.accountType = saFilter;
        aggregationMatch.accountType = saFilter;
        totalActiveQuery.accountType = saFilter;
        liveUserQuery.accountType = saFilter;
      }

      if (requesterLevel > 1) {
        const userIdObj = new mongoose.Types.ObjectId(userId);
        const userIdStr = userId.toString();

        if (requesterLevel === 6) {
          // Broker: Filter by both hierarchy (parentIds) and partnership (brokerPartnership.broker)
          const brokerMatch = {
            $or: [
              { parentIds: userIdObj },
              { 'basicDetails.brokerPartnership.broker._id': userIdObj },
              { 'basicDetails.brokerPartnership.broker._id': userIdStr },
              { 'basicDetails.brokerPartnership.broker': userIdObj },
              { 'basicDetails.brokerPartnership.broker': userIdStr }
            ]
          };
          query.$and = query.$and || [];
          query.$and.push(brokerMatch);

          aggregationMatch.$and = aggregationMatch.$and || [];
          aggregationMatch.$and.push(brokerMatch);

          totalActiveQuery.$and = totalActiveQuery.$and || [];
          totalActiveQuery.$and.push(brokerMatch);

          liveUserQuery.$and = liveUserQuery.$and || [];
          liveUserQuery.$and.push(brokerMatch);
        } else {
          // Others: Strict hierarchy
          query.parentIds = userIdObj;
          aggregationMatch.parentIds = userIdObj;
          totalActiveQuery.parentIds = userIdObj;
          liveUserQuery.parentIds = userIdObj;
        }
      }

      if (search) {
        query.$or = [{ accountName: { $regex: search, $options: 'i' } }, { accountCode: { $regex: search, $options: 'i' } }];
      }

      if (userType) {
        const resolved = await resolveUserTypeId(userType);
        if (resolved) {
          if (resolved.id) {
            if (query.accountType && typeof query.accountType === 'object' && query.accountType.$nin) {
              query.accountType = { $in: [resolved.id], $nin: query.accountType.$nin };
            } else {
              query.accountType = resolved.id;
            }
          }
          // For demo requesters, always keep demoid: true (never let userType filter override it)
          if (!requesterIsDemo) {
            query.demoid = resolved.isDemo ? true : { $ne: true };
            aggregationMatch.demoid = resolved.isDemo ? true : { $ne: true };
            totalActiveQuery.demoid = resolved.isDemo ? true : { $ne: true };
          }
        }
      }

      const [foundUsers, countUsers, countTotal, roleCounts, countDemo] = await Promise.all([
        userModel
          .find(query)
          .select(commonSelect)
          .populate('accountType', 'label name _id')
          .populate({ path: 'parentIds', select: 'accountName accountCode _id' })
          .skip(Number(skip))
          .limit(Number(limit))
          .lean(),
        userModel.countDocuments(query),
        userModel.countDocuments(totalActiveQuery),
        userModel.aggregate([
          { $match: aggregationMatch },
          {
            $group: {
              _id: '$accountType',
              count: { $sum: 1 }
            }
          },
          {
            $lookup: {
              from: 'usertypes',
              localField: '_id',
              foreignField: '_id',
              as: 'typeInfo'
            }
          },
          { $unwind: '$typeInfo' },
          {
            $project: {
              _id: 1,
              count: 1,
              label: '$typeInfo.label',
              name: '$typeInfo.name',
              level: '$typeInfo.level'
            }
          },
          { $sort: { level: 1 } }
        ]),
        userModel.countDocuments({ demoid: true, ...(requesterLevel > 1 ? { parentIds: new mongoose.Types.ObjectId(userId) } : {}) })
      ]);

      users = foundUsers;
      totalUsers = countUsers;
      totalActiveRecords = countTotal;
      aggregation = roleCounts;
      demoCount = countDemo;
    }

    // Fetch online status hash once for both paths
    const onlineStatusHash = (await hgetall('onlineStatus')) || {};

    // Calculate online/offline counts from all users matching the query
    const allUserIds = await userModel.find(liveUserQuery).select('_id').lean();
    const allUserIdsStr = allUserIds.map((u) => String(u._id));
    let totalOnlineUsers = 0;
    let totalOfflineUsers = 0;

    allUserIdsStr.forEach((userId) => {
      const isOnline = String(onlineStatusHash[userId] || '').toLowerCase() === 'online';
      if (isOnline) {
        totalOnlineUsers++;
      } else {
        totalOfflineUsers++;
      }
    });

    if (!users.length) {
      return res.status(200).json({
        status: true,
        data: [],
        pagination: {
          currentPage: Number(page),
          totalPages: 0,
          totalUsers, // Changed from 0 to actual count
          totalRecords: totalActiveRecords
        },
        accountCounts: [
          ...aggregation,
          {
            _id: 'demo',
            label: 'Demo Account',
            name: 'Demo Account',
            count: demoCount,
            level: 7
          }
        ],
        usermeta: {
          totalOnlineUsers,
          totalOfflineUsers
        }
      });
    }

    const userIds = users.map((u) => u._id);
    const loginUserId = getLoginUserId(req);

    const [balances, monitorEntries] = await Promise.all([
      BalanceService.computeCashBalances(userIds),
      UserMonitor.find({ monitoredUserId: { $in: userIds }, isActive: true })
        .select('monitoredUserId addedBy')
        .lean()
    ]);
    const balanceMap = new Map(balances.map((b) => [String(b._id), b.amount]));

    // Batch-fetch watcher user info to avoid N+1
    const watcherIds = [...new Set(monitorEntries.map(e => String(e.addedBy)))];
    const watcherUsers = watcherIds.length
      ? await userModel.find({ _id: { $in: watcherIds } })
          .select('accountCode accountName accountType')
          .populate('accountType', 'label')
          .lean()
      : [];
    const watcherMap = new Map(watcherUsers.map(w => [String(w._id), w]));

    const monitorMap = new Map();
    monitorEntries.forEach(e => {
      const mid = String(e.monitoredUserId);
      if (!monitorMap.has(mid)) monitorMap.set(mid, { isMonitoredByMe: false, watchers: [] });
      const entry = monitorMap.get(mid);
      if (String(e.addedBy) === String(loginUserId)) entry.isMonitoredByMe = true;
      const w = watcherMap.get(String(e.addedBy));
      if (w) entry.watchers.push({ id: e.addedBy, accountCode: w.accountCode, accountName: w.accountName, role: w.accountType?.label || null });
    });

    // Fetch latest page for each user
    const latestPages = await PageHistory.aggregate([
      { $match: { userId: { $in: userIds } } },
      { $sort: { time: -1 } },
      {
        $group: {
          _id: '$userId',
          lastPage: { $first: '$page' },
          lastPageTime: { $first: '$time' }
        }
      }
    ]);
    const pageMap = new Map(latestPages.map((p) => [String(p._id), p]));

    // 1. Fetch Active Valan and Calculate Live M2M (Matches Summary Report Logic)
    const activeValan = await setGetValanDetails();
    const liveResults = await getProfitLossWithLivePrices({
      transactionStatus: 'COMPLETED',
      userId: { $in: userIds },
      valanId: activeValan?._id
    }, requesterLevel, userId);

    const m2mDataMap = new Map();
    if (liveResults && liveResults.data) {
      liveResults.data.forEach(r => {
        // selfNetPrice is the share-based P&L from the requester's perspective
        // r.m2m is the total house pooled M2M (net result) for that user
        m2mDataMap.set(String(r.userId), {
          selfM2m: Number(r.selfNetPrice || 0),
          totalM2m: Number(r.m2m || 0)
        });
      });
    }

    const formattedData = await Promise.all(
      users.map(async (user) => {
        const uId = String(user._id);
        const isOnline = String(onlineStatusHash[uId] || '').toLowerCase() === 'online';
        const lastSeen = await getLastSeen(user._id, isOnline);

        const userPageData = pageMap.get(uId);

        const monitorInfo = monitorMap.get(uId) || { isMonitoredByMe: false, watchers: [] };

        return {
          _id: user._id,
          name: user.accountName,
          accountCode: user.accountCode,
          lastSeen: lastSeen,
          lastPageVisited: userPageData ? userPageData.lastPage : null,
          lastPageTime: userPageData ? userPageData.lastPageTime : null,
          cashBalance: balanceMap.get(uId) || 0,
          status : user.status,
          isMonitored: monitorInfo.watchers.length > 0,
          isMonitoredByMe: monitorInfo.isMonitoredByMe,
          monitoredBy: monitorInfo.watchers,
          m2m: Number((m2mDataMap.get(uId)?.selfM2m || 0).toFixed(4)),
          totalM2m: Number((m2mDataMap.get(uId)?.totalM2m || 0).toFixed(4)),
          balance: Number((m2mDataMap.get(uId)?.selfM2m || 0).toFixed(4)),
          accountType: user.accountType ? { id: user.accountType._id, name: user.accountType.label || user.accountType.name } : null,
          parents: (user.parentIds || [])
            .filter((p) => p) // Filter out null parents (e.g. deleted users)
            .map((p) => ({
              id: p._id,
              name: p.accountName,
              accountCode: p.accountCode
            })),
          isDemo: user.demoid || false,
          isDeleted: user.isDeleted || false,
          loginIP: user.loginIP,
          forceLogout: user?.forceLogout || false,
          forceLogoutMinutes: user?.forceLogoutMinutes || 0,
          forceLogoutStartedAt: user?.forceLogoutStartedAt || null,
          forcedlogoutLoginattempts: user?.forcedlogoutLoginattempts || 0,
          createdBy: user.createdBy
            ? {
              name: user.createdBy.accountName,
              accountCode: user.createdBy.accountCode
            }
            : null
        };
      })
    );

    res.status(200).json({
      status: true,
      data: formattedData,
      pagination: {
        currentPage: Number(page),
        totalPages: Math.ceil(totalUsers / limit),
        totalUsers, // This was already correct here but verified
        totalRecords: totalActiveRecords
      },
      accountCounts: [
        ...aggregation,
        {
          _id: 'demo',
          label: 'Demo Account',
          name: 'Demo Account',
          count: demoCount,
          level: 7
        }
      ],
      usermeta: {
        totalOnlineUsers: totalOnlineUsers ?? 0,
        totalOfflineUsers: totalOfflineUsers ?? 0
      }
    });
  } catch (error) {
    console.error('getExtendedUsers error:', error);
    res.status(500).json({ status: false, message: error.message });
  }
};

exports.getUsersWithHierarchyCounts = async (req, res) => {
  try {
    const { page = 1, limit = 20, search = '', userType = '', superadmin_excluded } = req.query;
    const skip = (page - 1) * limit;

    const isSAExclude = superadmin_excluded === 'true' || superadmin_excluded === '1';
    const userId = getEffectiveUserId(req);
    const {
      accountType: { level: requesterLevel }
    } = req.user;

    const requesterIsDemoHC = isDemoUser(req);
    // Demo requester sees only their demo hierarchy; normal requester hides all demo users
    const demoidFilterHC = requesterIsDemoHC ? { demoid: true } : { demoid: { $ne: true } };
    const query = { ...demoidFilterHC };
    const totalActiveQuery = { ...demoidFilterHC };

    // Exclude Customers/Clients from the list of creators
    const customerTypes = await UserType.find({ level: 7 }).select('_id').lean();
    const customerIds = customerTypes.map((t) => t._id);
    query.accountType = { $nin: customerIds };
    totalActiveQuery.accountType = { $nin: customerIds };

    if (isSAExclude) {
      const saTypes = await UserType.find({ level: 1 }).select('_id').lean();
      const saIds = saTypes.map((t) => t._id);
      query.accountType.$nin = [...(query.accountType.$nin || []), ...saIds];
      totalActiveQuery.accountType.$nin = [...(totalActiveQuery.accountType.$nin || []), ...saIds];
    }

    if (requesterLevel > 1) {
      const parentIdMatch = new mongoose.Types.ObjectId(userId);
      query.parentIds = parentIdMatch;
      totalActiveQuery.parentIds = parentIdMatch;
    }

    if (search) {
      query.$or = [{ accountName: { $regex: search, $options: 'i' } }, { accountCode: { $regex: search, $options: 'i' } }];
    }

    if (userType) {
      const resolved = await resolveUserTypeId(userType);
      if (resolved) {
        if (query.accountType && typeof query.accountType === 'object' && query.accountType.$nin) {
          query.accountType = { $in: [resolved.id], $nin: query.accountType.$nin };
        } else {
          query.accountType = resolved.id;
        }
        query.demoid = resolved.isDemo ? true : { $ne: true };
      }
    }

    const [users, totalUsers, totalActiveRecords] = await Promise.all([
      userModel
        .find(query)
        .select({
          accountName: 1,
          accountCode: 1,
          accountType: 1,
          demoid: 1,
          _id: 1
        })
        .populate('accountType', 'label name level')
        .skip(Number(skip))
        .limit(Number(limit))
        .lean(),
      userModel.countDocuments(query),
      userModel.countDocuments(totalActiveQuery)
    ]);

    if (!users.length) {
      return res.status(200).json({
        status: true,
        data: [],
        pagination: {
          currentPage: Number(page),
          totalPages: 0,
          totalUsers: 0,
          totalRecords: totalActiveRecords
        }
      });
    }

    const userIds = users.map((u) => u._id);

    // Fetch counts of accounts created by these users
    const creationCounts = await userModel.aggregate([
      {
        $match: {
          $or: [{ 'createdBy.userId': { $in: userIds } }, { 'createdBy.userId': { $in: userIds.map((id) => String(id)) } }],
          demoid: { $ne: true }
        }
      },
      {
        $group: {
          _id: {
            creatorId: '$createdBy.userId',
            accountType: '$accountType'
          },
          count: { $sum: 1 }
        }
      },
      {
        $lookup: {
          from: 'usertypes',
          localField: '_id.accountType',
          foreignField: '_id',
          as: 'typeInfo'
        }
      },
      { $unwind: '$typeInfo' },
      {
        $project: {
          creatorId: '$_id.creatorId',
          typeLabel: '$typeInfo.label',
          typeName: '$typeInfo.name',
          typeLevel: '$typeInfo.level',
          count: 1
        }
      }
    ]);

    const creationMap = new Map();
    creationCounts.forEach((c) => {
      const cid = String(c.creatorId);
      if (!creationMap.has(cid)) creationMap.set(cid, {});
      const userCounts = creationMap.get(cid);

      let key = (c.typeName || c.typeLabel).toLowerCase().replace(/ /g, '_');
      // Map 'customer' to 'client' as requested
      if (key === 'customer') key = 'client';

      userCounts[key] = (userCounts[key] || 0) + c.count;
    });

    // Fetch broker-wise client counts
    const brokerClientCounts = await getBrokerClientCounts(userIds);

    const formattedData = users.map((user) => {
      const userId = String(user._id);
      return {
        _id: user._id,
        name: user.accountName,
        accountCode: user.accountCode,
        accountType: user.accountType
          ? {
            id: user.accountType._id,
            name: user.accountType.label || user.accountType.name,
            level: user.accountType.level
          }
          : null,
        isDemo: user.demoid || false,
        createdCounts: creationMap.get(userId) || {},
        brokerClientCounts: brokerClientCounts.get(userId) || []
      };
    });

    res.status(200).json({
      status: true,
      data: formattedData,
      pagination: {
        currentPage: Number(page),
        totalPages: Math.ceil(totalUsers / limit),
        totalUsers,
        totalRecords: totalActiveRecords
      }
    });
  } catch (error) {
    console.error('getUsersWithHierarchyCounts Error:', error);
    res.status(500).json({ status: false, message: error.message });
  }
};

/**
 * Helper function to get broker-wise client counts for given user IDs (brokers)
 * For each broker in userIds, count how many clients have them in brokerPartnership
 */
const getBrokerClientCounts = async (userIds) => {
  try {
    // Convert userIds to both ObjectId and String formats for matching
    const userIdStrings = userIds.map(id => String(id));
    const userIdObjects = userIds.map(id => {
      try {
        return mongoose.Types.ObjectId.isValid(id) ? new mongoose.Types.ObjectId(id) : id;
      } catch {
        return id;
      }
    });

    // Fetch all clients (level 7) that have any of these users as brokers
    const clients = await userModel.aggregate([
      {
        $lookup: {
          from: 'usertypes',
          localField: 'accountType',
          foreignField: '_id',
          as: 'accountTypeInfo'
        }
      },
      { $unwind: '$accountTypeInfo' },
      {
        $match: {
          'accountTypeInfo.level': 7, // Only clients/customers
          demoid: { $ne: true },
          isDeleted: { $ne: true },
          'basicDetails.brokerPartnership': { $exists: true, $ne: [] }
        }
      },
      {
        $project: {
          accountName: 1,
          accountCode: 1,
          brokerPartnership: '$basicDetails.brokerPartnership'
        }
      }
    ]);

    // Map to store client counts per broker
    const brokerCountMap = new Map();
    
    // Initialize map for all userIds
    userIds.forEach(userId => {
      const userIdStr = String(userId);
      brokerCountMap.set(userIdStr, {
        brokerId: userIdStr,
        clientCount: 0,
        clients: []
      });
    });

    // Count clients for each broker
    clients.forEach((client) => {
      const brokerPartnership = client.brokerPartnership || [];
      
      brokerPartnership.forEach((bp) => {
        if (bp.broker) {
          const brokerId = String(bp.broker._id || bp.broker);
          
          // Check if this broker is in our userIds list
          if (userIdStrings.includes(brokerId)) {
            const brokerData = brokerCountMap.get(brokerId);
            if (brokerData) {
              brokerData.clientCount++;
              brokerData.clients.push({
                _id: client._id,
                accountName: client.accountName,
                accountCode: client.accountCode
              });
            }
          }
        }
      });
    });

    // Fetch broker details
    const brokers = await userModel
      .find({ _id: { $in: userIdObjects } })
      .select('_id accountName accountCode')
      .lean();

    const brokerDetailsMap = new Map();
    brokers.forEach(broker => {
      brokerDetailsMap.set(String(broker._id), {
        _id: broker._id,
        accountName: broker.accountName,
        accountCode: broker.accountCode
      });
    });

    // Create result map with broker details
    const result = new Map();
    userIds.forEach(userId => {
      const userIdStr = String(userId);
      const brokerData = brokerCountMap.get(userIdStr);
      const brokerDetails = brokerDetailsMap.get(userIdStr);
      
      if (brokerData && brokerData.clientCount > 0) {
        result.set(userIdStr, [{
          broker: brokerDetails || {
            _id: userIdStr,
            accountName: 'Unknown',
            accountCode: ''
          },
          clientCount: brokerData.clientCount,
          clients: brokerData.clients
        }]);
      } else {
        result.set(userIdStr, []);
      }
    });

    return result;
  } catch (error) {
    console.error('getBrokerClientCounts Error:', error);
    return new Map();
  }
};
exports.getBannedScriptUsers = async (req, res) => {
  try {
    const userId = getEffectiveUserId(req);
    const { page, limit, search, market, script, client, broker, master } = req.query;

    const result = await getBannedUsersList(userId, {
      page: page || 1,
      limit: limit || 10,
      search: search || '',
      market: market || '',
      script: script || '',
      client: client || '',
      broker: broker || '',
      master: master || ''
    });

    res.status(200).json({
      status: true,
      data: result.data,
      pagination: result.pagination
    });
  } catch (error) {
    console.error('Error in getBannedScriptUsers controller:', error);
    res.status(500).json({ status: false, message: 'Internal server error' });
  }
};

const { getDeletedUsers: getDeletedUsersService } = require('../services/UserService');

const { getFilterStockTransactions, getUserPosition, getProfitLossWithLivePrices, setGetValanDetails } = require('../services/StockService');

exports.verifyUserIdWithRequester = async (req, res) => {
  try {
    const userId = getEffectiveUserId(req);
    const {
      accountType: { level: requesterLevel }
    } = req.user;

    const { id: targetUserId, password } = req.body;

    if (!targetUserId) {
      return res.status(400).json({ status: false, message: 'Target User ID is required' });
    }
    if (!password || typeof password !== 'string' || !password.trim()) {
      return res.status(400).json({ status: false, message: 'Transaction password is required' });
    }
    const isValid = await validatepassword(userId, password.trim());
    if (!isValid) {
      return res.status(401).json({ status: false, message: 'Wrong transaction password' });
    }

    // 1. Fetch target user to check permissions (exclude already deleted users)
    const targetUser = await userModel.findOne({ _id: targetUserId, isDeleted: false }).select('parentIds accountName accountCode').lean();
    if (!targetUser) {
      return res.status(404).json({ status: false, message: 'User not found or already deleted' });
    }

    // 2. Authorization: Only SuperAdmin (Level 1) or a parent in the hierarchy can delete
    const isAuthorized = requesterLevel === 1 || targetUser.parentIds.some((pid) => String(pid) === String(userId));

    if (!isAuthorized) {
      return res.status(403).json({ status: false, message: 'Permission denied. You can only verify users in your own downline.' });
    }

    res.status(200).json({
      status: true,
      message: `User ${targetUser.accountName} (${targetUser.accountCode}) is valid for action.`
    });
  } catch (error) {
    console.error('verifyUserIdWithRequester controller error:', error);
    res.status(400).json({ status: false, message: error.message });
  }
};

exports.deleteUserCompletely = async (req, res) => {
  try {
    const requesterId = getEffectiveUserId(req);
    const loginUserId = getLoginUserId(req);
    const {
      accountType: { level: requesterLevel }
    } = req.user;

    const { id: targetUserId, password } = req.body;

    if (!targetUserId) {
      return res.status(400).json({ status: false, message: 'Target User ID is required' });
    }
    if (!password || typeof password !== 'string' || !password.trim()) {
      return res.status(400).json({ status: false, message: 'Transaction password is required' });
    }
    const isValid = await validatepassword(requesterId, password.trim());
    if (!isValid) {
      return res.status(401).json({ status: false, message: 'Wrong transaction password' });
    }
    if (!targetUserId) {
      return res.status(400).json({ status: false, message: 'Target User ID is required' });
    }

    // 1. Fetch target user to check permissions (exclude already deleted users)
    const targetUser = await userModel.findOne({ _id: targetUserId, isDeleted: false }).select('parentIds accountName accountCode demoid').lean();
    if (!targetUser) {
      return res.status(404).json({ status: false, message: 'User not found or already deleted' });
    }

    // 2. Authorization: Only SuperAdmin (Level 1) or a parent in the hierarchy can delete
    const isAuthorized = requesterLevel === 1 || targetUser.parentIds.some((pid) => String(pid) === String(requesterId));

    if (!isAuthorized) {
      return res.status(403).json({ status: false, message: 'Permission denied. You can only delete users in your own downline.' });
    }

    // 3. Prevent self-deletion
    if (String(targetUserId) === String(requesterId)) {
      return res.status(400).json({ status: false, message: 'You cannot delete your own account.' });
    }

    // 4. Block deletion during weekdays (Market Days: Mon-Fri)
    const currentDay = moment().day(); // 0 = Sun, 6 = Sat
    if (currentDay >= 1 && currentDay <= 5 && !targetUser.demoid) {
      return res.status(400).json({ status: false, message: 'User deletion is only allowed on weekends (Saturday & Sunday).' });
    }

    // 5. Check if user has open positions
    const positions = await getUserPosition({ userId: targetUserId });
    if (positions && positions.length > 0) {
      // Check if there's actual remaining quantity in any position
      const hasOpenPositions = positions.some((p) => p.buyQuantity - p.sellQuantity !== 0);
      if (hasOpenPositions) {
        return res.status(400).json({ status: false, message: 'Cannot delete user with open trading positions.' });
      }
    }
    await deleteUserCompletely(targetUserId);
    // 6. Soft delete: Set isDeleted flag
    await userModel.findByIdAndUpdate(targetUserId, {
      isDeleted: true,
      deletedAt: new Date(),
      deletedBy: requesterId
    });

    res.status(200).json({
      status: true,
      message: `User ${targetUser.accountName} (${targetUser.accountCode}) has been marked as deleted successfully`
    });
  } catch (error) {
    console.error('deleteUserCompletely controller error:', error);
    res.status(400).json({ status: false, message: error.message });
  }
};

exports.getClientLedgerView = async (req, res) => {
  try {
    const requesterId = getEffectiveUserId(req);
    const { page, limit, search } = req.query;

    const result = await getDeletedUsersService(requesterId, { page, limit, search });
    res.status(200).json({ status: true, data: result });
  } catch (error) {
    console.error('getDeletedUsers controller error:', error);
    res.status(400).json({ status: false, message: error.message });
  }
};

exports.getDownlineUsersByAccountType = async (req, res) => {
  try {
    const requesterId = getEffectiveUserId(req);
    const {
      accountType: { level: requesterLevel }
    } = req.user;
    const { userId: targetUserId, startDate, endDate } = req.query;

    if (!targetUserId) {
      return res.status(400).json({ status: false, message: 'User ID is required' });
    }

    // Authorization check
    const targetUser = await userModel.findOne({ _id: targetUserId, isDeleted: true }).select('parentIds isDeleted').lean();
    if (!targetUser || !targetUser.isDeleted) {
      return res.status(404).json({ status: false, message: 'Deleted user not found' });
    }

    const isAuthorized = requesterLevel === 1 || targetUser.parentIds.some((pid) => String(pid) === String(requesterId));
    if (!isAuthorized) {
      return res.status(403).json({ status: false, message: 'Permission denied' });
    }

    const match = { userId: targetUserId };
    const sDate = startDate ? new Date(new Date(startDate).setHours(0, 0, 0, 0)) : new Date(new Date().setHours(0, 0, 0, 0));
    const eDate = endDate ? new Date(new Date(endDate).setHours(23, 59, 59, 999)) : new Date(new Date().setHours(23, 59, 59, 999));

    match.createdAt = {
      $gte: sDate,
      $lte: eDate
    };

    const transactions = await getFilterStockTransactions(match, {}, { createdAt: -1 });
    res.status(200).json({ status: true, data: transactions });
  } catch (error) {
    console.error('getDeletedUserTransactions controller error:', error);
    res.status(400).json({ status: false, message: error.message });
  }
};

exports.createMLAccount = async (req, res) => {
  try {
    const {
      targetUserId,
      accountCode,
      accountName,
      password,
      menuPrivileges,
      crudControllers,
      transactionPassword,
      mltTransactionPassword,
      assignedTeamId
    } = req.body;
    const loginUserId = getLoginUserId(req);
    const effectiveUserId = getEffectiveUserId(req);

    // Validation
    if (!targetUserId || !accountName || !password) {
      return res.status(400).json({
        status: false,
        message: 'targetUserId, accountName, and password are required'
      });
    }
    const isValid = await validateTransactionPassword(loginUserId, req.body.transactionPassword.trim());
    if (!isValid) {
      return res.status(400).json({
        status: false,
        message: 'Invalid transaction password'
      });
    }
    // Check if account name already exists
    if (accountName.length > 11) {
      return res.status(400).json({
        status: false,
        message: 'Account name cannot be longer than 11 characters'
      });
    }

    const existingAccount = await userModel.findOne({ accountName });
    if (existingAccount) {
      return res.status(400).json({
        status: false,
        message: 'Account name already exists'
      });
    }

    // Fetch target user
    const targetUser = await userModel.findById(targetUserId).populate('accountType');
    if (!targetUser) {
      return res.status(404).json({
        status: false,
        message: 'Target user not found'
      });
    }

    // Use plain password as per project standards
    const hashedPassword = password;

    // Create ML account
    const mlAccount = new userModel({
      accountType: targetUser.accountType._id,
      accountCode: accountCode,
      accountName,
      password: hashedPassword,
      multiLoginOf: targetUserId,
      menuPrivileges: menuPrivileges || ['all'],
      crudControllers: crudControllers || null,
      parentIds: [loginUserId], // ML account's parent is creator (for admin purposes only)
      createdBy: {
        userId: loginUserId,
        accountName: req.context?.loginAccountName || 'unknown'
      },
      status: true,
      marketAccess: req.body.marketAccess || [],
      assignedTeamId: assignedTeamId || null,
      basicDetails: {
        transactionPassword: mltTransactionPassword
      }
    });

    await mlAccount.save();

    res.status(201).json({
      status: true,
      message: 'Multi-Login account created successfully',
      data: {
        _id: mlAccount._id,
        accountName: mlAccount.accountName,
        accountCode: mlAccount.accountCode,
        multiLoginOf: mlAccount.multiLoginOf,
        menuPrivileges: mlAccount.menuPrivileges,
        marketAccess: mlAccount.marketAccess || [],
        assignedTeamId: mlAccount.assignedTeamId,
        crudControllers: mlAccount.crudControllers || null,
        targetUser: {
          _id: targetUser._id,
          accountName: targetUser.accountName,
          accountCode: targetUser.accountCode
        }
      }
    });
  } catch (error) {
    console.error('createMLAccount error:', error);
    res.status(500).json({ status: false, message: error.message });
  }
};

exports.getMLAccounts = async (req, res) => {
  try {
    const { userId } = req.params;
    const effectiveUserId = getEffectiveUserId(req);

    // Verify user has permission to view this user's ML accounts
    const targetUser = await userModel.findById(userId).select('parentIds');
    if (!targetUser) {
      return res.status(404).json({ status: false, message: 'User not found' });
    }

    // Authorization check
    const {
      accountType: { level: requesterLevel }
    } = req.user;
    const isAuthorized =
      requesterLevel === 1 ||
      targetUser.parentIds.some((pid) => String(pid) === String(effectiveUserId)) ||
      String(userId) === String(effectiveUserId);

    if (!isAuthorized) {
      return res.status(403).json({
        status: false,
        message: 'Permission denied'
      });
    }

    // Fetch ML accounts
    const mlAccounts = await userModel
      .find({
        multiLoginOf: userId,
        isDeleted: false
      })
      .select('accountName accountCode createdBy createdAt menuPrivileges marketAccess assignedTeamId crudControllers status')
      .populate('createdBy.userId', 'accountName accountCode')
      .lean();

    res.json({
      status: true,
      data: mlAccounts.map((ml) => ({
        _id: ml._id,
        accountName: ml.accountName,
        accountCode: ml.accountCode,
        menuPrivileges: ml.menuPrivileges,
        marketAccess: ml.marketAccess || [],
        assignedTeamId: ml.assignedTeamId,
        status: ml.status,
        createdAt: ml.createdAt,
        createdBy: ml.createdBy
      }))
    });
  } catch (error) {
    console.error('getMLAccounts error:', error);
    res.status(500).json({ status: false, message: error.message });
  }
};

exports.updateMLAccount = async (req, res) => {
  try {
    const { mlAccountId } = req.params;
    const {
      status,
      menuPrivileges,
      crudControllers,
      password,
      transactionPassword,
      mltTransactionPassword,
      accountName,
      accountCode,
      targetUserId,
      marketAccess,
      assignedTeamId
    } = req.body;
    const loginUserId = getLoginUserId(req);

    if (!transactionPassword) {
      return res.status(400).json({
        status: false,
        message: 'Transaction password is required'
      });
    }

    const isValid = await validateTransactionPassword(loginUserId, transactionPassword.trim());
    if (!isValid) {
      return res.status(400).json({
        status: false,
        message: 'Invalid transaction password'
      });
    }

    const mlAccount = await userModel.findById(mlAccountId);
    if (!mlAccount || !mlAccount.multiLoginOf) {
      return res.status(404).json({
        status: false,
        message: 'ML account not found'
      });
    }

    // Update fields
    if (accountName) {
      // Check if account name already exists if being changed
      if (accountName !== mlAccount.accountName) {
        if (accountName.length > 11) {
          return res.status(400).json({
            status: false,
            message: 'Account name cannot be longer than 11 characters'
          });
        }
        const existingAccount = await userModel.findOne({ accountName });
        if (existingAccount) {
          return res.status(400).json({
            status: false,
            message: 'Account name already exists'
          });
        }
        mlAccount.accountName = accountName;
      }
    }
    if (accountCode) {
      mlAccount.accountCode = accountCode;
    }
    if (status !== undefined) {
      mlAccount.status = status;
    }
    if (menuPrivileges) {
      mlAccount.menuPrivileges = menuPrivileges;
    }
    if (marketAccess) {
      mlAccount.marketAccess = marketAccess;
    }
    if (assignedTeamId !== undefined) {
      mlAccount.assignedTeamId = assignedTeamId;
    }
    if (crudControllers !== undefined) {
      mlAccount.crudControllers = crudControllers && Object.keys(crudControllers).length > 0 ? crudControllers : null;
    }
    if (password) {
      mlAccount.password = password;
    }
    // Update transaction password if provided/verified
    if (mltTransactionPassword) {
      if (!mlAccount.basicDetails) mlAccount.basicDetails = {};
      mlAccount.basicDetails.transactionPassword = mltTransactionPassword;
    }

    await mlAccount.save();

    res.json({
      status: true,
      message: 'ML account updated successfully',
      data: {
        _id: mlAccount._id,
        accountName: mlAccount.accountName,
        status: mlAccount.status,
        menuPrivileges: mlAccount.menuPrivileges,
        marketAccess: mlAccount.marketAccess || [],
        assignedTeamId: mlAccount.assignedTeamId,
        crudControllers: mlAccount.crudControllers || null
      }
    });
  } catch (error) {
    console.error('updateMLAccount error:', error);
    res.status(500).json({ status: false, message: error.message });
  }
};

/**
 * Revoke/delete an ML account
 * DELETE /api/user/ml-account/:mlAccountId
 */
exports.revokeMLAccount = async (req, res) => {
  try {
    const { mlAccountId } = req.params;
    const loginUserId = getLoginUserId(req);

    const mlAccount = await userModel.findById(mlAccountId);
    if (!mlAccount || !mlAccount.multiLoginOf) {
      return res.status(404).json({
        status: false,
        message: 'ML account not found'
      });
    }

    const { transactionPassword } = req.body;
    if (!transactionPassword) {
      return res.status(400).json({
        status: false,
        message: 'Transaction password is required'
      });
    }

    const isValid = await validateTransactionPassword(loginUserId, transactionPassword.trim());
    if (!isValid) {
      return res.status(400).json({
        status: false,
        message: 'Invalid transaction password'
      });
    }

    // Soft delete
    mlAccount.isDeleted = true;
    mlAccount.deletedAt = new Date();
    mlAccount.deletedBy = loginUserId;
    await mlAccount.save();

    res.json({
      status: true,
      message: 'ML account revoked successfully'
    });
  } catch (error) {
    console.error('revokeMLAccount error:', error);
    res.status(500).json({ status: false, message: error.message });
  }
};

// ─── Multi-Login Account Deletion ──────────────────────────────────────────────
/**
 * Delete a multi-login account (soft delete). Level 1 only.
 * Body: userId, transactionPassword.
 */
exports.deleteMultiLoginAccount = async (req, res) => {
  try {
    const currentUserId = getLoginUserId(req);
    const { accountType: reqAccountType } = req.user;
    const level = reqAccountType?.level;
    if (level !== 1) {
      return res.status(403).json({ status: false, message: 'Only superadmin can delete multi-login accounts' });
    }

    const { id: targetUserId } = req.body;
    if (!targetUserId) {
      return res.status(400).json({ status: false, message: 'userId is required' });
    }



    const targetUser = await userModel.findOne({
      _id: targetUserId,
      'createdBy.userId': currentUserId,
      menuPrivileges: { $exists: true, $type: 'array' },
      isDeleted: false,
    }).lean();

    if (!targetUser) {
      return res.status(404).json({ status: false, message: 'Multi-login user not found or access denied' });
    }

    await userModel.findByIdAndUpdate(targetUserId, { isDeleted: true });

    return res.status(200).json({
      status: true,
      message: 'Multi-login account deleted successfully',
    });
  } catch (error) {
    console.error('deleteMultiLoginAccount error:', error);
    return res.status(500).json({ status: false, message: error.message || 'Server error' });
  }
};

// ─── Telegram Bot Linking ──────────────────────────────────────────────────
const crypto = require('crypto');

/**
 * POST /api/user/generate-telegram-link
 * Protected by JWT. Generates a one-time 5-minute link for linking Telegram.
 */
exports.generateTelegramLink = async (req, res) => {
  try {
    const userId = getLoginUserId(req);
    const user = await userModel.findById(userId);
    if (!user) return res.status(404).json({ status: false, message: 'User not found' });

    if (user.telegramId) {
      return res.status(400).json({
        status: false,
        message: 'Your account is already linked to Telegram. Unlink first to generate a new link.'
      });
    }

    const token = crypto.randomBytes(32).toString('hex');
    user.telegramLinkToken = token;
    user.telegramLinkExpiry = new Date(Date.now() + 2 * 60 * 60 * 1000); // 2 hours
    await user.save();

    const botUsername = process.env.BOT_USERNAME;
    const link = `https://t.me/${botUsername}?start=${token}`;

    res.json({ status: true, link, message: 'Link expires in 2 hours.' });
  } catch (error) {
    console.error('generateTelegramLink error:', error);
    res.status(500).json({ status: false, message: error.message });
  }
};

/**
 * POST /api/user/unlink-telegram
 * Protected by JWT. Removes the Telegram binding from the user's account.
 */
exports.unlinkTelegram = async (req, res) => {
  try {
    const userId = getLoginUserId(req);
    const user = await userModel.findById(userId);
    if (!user) return res.status(404).json({ status: false, message: 'User not found' });

    if (!user.telegramId) {
      return res.status(400).json({ status: false, message: 'No Telegram account is linked.' });
    }

    user.telegramId = null;
    user.telegramLinkToken = null;
    user.telegramLinkExpiry = null;
    await user.save();

    res.json({ status: true, message: 'Telegram account unlinked successfully.' });
  } catch (error) {
    console.error('unlinkTelegram error:', error);
    res.status(500).json({ status: false, message: error.message });
  }
};

/**
 * Global Summary: Who linked Who.
 * For each Parent, list all their children.
 * One-to-many relationship view.
 */
exports.getAllLinkedAccountsHierarchy = async (req, res) => {
  try {
    const {
      accountType: { level }
    } = req.user;
    const requesterId = getLoginUserId(req);

    let query = {};

    // 🔒 Hierarchy Filter: Only superadmin (level 1) can see global links.
    // Others can only see links where they or their downline is the parent.
    if (level !== 1) {
      const downlineUserIds = await userModel
        .find({
          $or: [{ _id: requesterId }, { parentIds: requesterId }],
          isDeleted: false
        })
        .distinct('_id');

      query = { parentId: { $in: downlineUserIds } };
    }

    const links = await LinkedAccount.find(query)
      .populate('parentId', 'accountCode accountName')
      .populate('userId', 'accountCode accountName')
      .sort({ createdAt: -1 })
      .lean();

    // Map by parentId to group children
    const groupMap = new Map();

    links.forEach((link) => {
      if (!link.parentId || !link.userId) return;

      const pid = link.parentId._id.toString();
      if (!groupMap.has(pid)) {
        groupMap.set(pid, {
          parent: {
            _id: pid,
            accountCode: link.parentId.accountCode,
            accountName: link.parentId.accountName
          },
          children: []
        });
      }

      groupMap.get(pid).children.push({
        _id: link.userId._id,
        accountCode: link.userId.accountCode,
        accountName: link.userId.accountName,
        linkedAt: link.createdAt,
        ipAddress: link.ipAddress
      });
    });

    return res.status(200).json({
      status: true,
      data: Array.from(groupMap.values())
    });
  } catch (error) {
    console.error('getAllLinkedAccountsHierarchy error:', error);
    return res.status(500).json({ status: false, message: 'Server error' });
  }
};

/**
 * POST /api/user/unblock-ip
 * Unblocks all users matching the provided loginIP.
 * Resets loginAttempts and sets status to true.
 */
exports.unblockByIP = async (req, res) => {
  try {
    const { loginIP } = req.body;
    const requesterId = getLoginUserId(req);
    const {
      accountType: { level }
    } = req.user;

    if (!loginIP || String(loginIP).trim() === '') {
      return res.status(400).json({ status: false, message: 'A valid IP address is required' });
    }

    let filter = { loginIP: String(loginIP).trim(), isDeleted: false };

    // 🔒 Hierarchy Restriction: Non-superadmins can only unblock users in their downline
    if (level !== 1) {
      filter.parentIds = requesterId;
    }

    const result = await userModel.updateMany(filter, {
      $set: {
        isBlocked: false,
        loginAttempts: 0,
        status: true
      }
    });

    // Normalize modifiedCount (depends on mongoose version)
    const count = result.modifiedCount ?? result.nModified ?? 0;

    return res.status(200).json({
      status: true,
      message:
        count > 0 ? `Successfully unblocked ${count} user(s) matching IP ${loginIP}` : `No blocked users found matching IP ${loginIP}`,
      unblockedCount: count
    });
  } catch (error) {
    console.error('unblockByIP error:', error);
    return res.status(500).json({ status: false, message: 'Server error' });
  }
};
