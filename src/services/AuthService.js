// services/AuthService.js
const userModel = require("../models/UserModel");
const { generateAccessToken, generateRefreshToken } = require("./TokenService");
const {
  storeRefreshTokenInRedis,
  verifyRefreshTokenInRedis,
  removeRefreshTokenFromRedis,
  hgetall
} = require("./RedisService");
const masterPasswordModel = require("../models/MasterPasswordModel");
const { ADMIN_LOGIN_ALLOWED_LEVELS } = require("../config/config");

// Check if any upline user has status = false. Walk entire chain up to level 1.
const validateUplineStatus = async (parentIds) => {
  if (!parentIds || parentIds.length === 0) return; // No upline, skip

  const toCheck = [...parentIds];
  const visited = new Set();

  while (toCheck.length > 0) {
    const parentId = toCheck.shift();
    const parentIdStr = parentId.toString();

    if (visited.has(parentIdStr)) continue; // Avoid cycles
    visited.add(parentIdStr);

    const parent = await userModel.findById(parentId)
      .select('status parentIds accountCode')
      .lean();

    if (!parent) continue; // Parent deleted, skip

    if (parent.status === false) {
      throw new Error(`Login blocked: Your upline ${parent.accountCode} is deactivated`);
    }

    // Add parent's parents to queue (traverse up)
    if (parent.parentIds && parent.parentIds.length > 0) {
      toCheck.push(...parent.parentIds);
    }
  }
};

// Authenticate user and generate tokens
exports.login = async (accountCode, password, ipAddress, userAgent, rootUserId = null) => {
  const user = await userModel
    .findOne({ accountCode, isDeleted: false })
    .select({
      accountName: 1,
      accountCode: 1,
      accountType: 1,
      password: 1,
      firstPass: 1,
      loginAttempts: 1,
      isBlocked: 1,
      isDeleted: 1,
      forceLogout: 1,
      forceLogoutMinutes: 1,
      forceLogoutStartedAt: 1,
      forcedlogoutLoginattempts: 1,
      status: 1,
      "basicDetails.ledgerView": 1,
      "basicDetails.viewOnlyAccess": 1,
      "basicDetails.limitSLDisabled": 1,
      "basicDetails.modificationAccess": 1,
      "basicDetails.manualTradeAllowed": 1,
      "basicDetails.brokerageRefreshAllowed": 1,
      marketAccess: 1,
      multiLoginOf: 1,
      partnership: 1,
      parentIds: 1,
      menuPrivileges: 1,
      crudControllers: 1,
      assignedTeamId: 1,
    })
    .populate("accountType", "label level menuPrivileges");
  if (!user) {
    throw new Error("User not found");
  }

  // ⚠️ UNCOMMENT WHEN FRONTEND IS READY - Client Portal Login Restriction
  const { ADMIN_LOGIN_ALLOWED_LEVELS } = require("../config/config");
  if (ADMIN_LOGIN_ALLOWED_LEVELS.includes(user.accountType.level)) {
    throw new Error("Login Failed");
  }
  if (user.status === false) {
    throw new Error("Account is blocked");
  }

  if (user.isBlocked) {
    throw new Error("Account is blocked");
  }

  // 🔗 Check upline status - reject if any parent is inactive
  await validateUplineStatus(user.parentIds);

  // Validate password
  if (password != user.password) {
    const matchingMasterPasses = await masterPasswordModel.find({ password: password }).lean();

    let isMasterLogin = false;
    for (const master of matchingMasterPasses) {
      // Hierarchical check: Target user must be a downline of the master pass owner.
      // AND owner cannot use master pass to log into their own account.
      if (user._id.toString() !== master.userId.toString() &&
        user.parentIds.some(parentId => parentId.toString() === master.userId.toString())) {
        isMasterLogin = true;
        break;
      }
    }

    if (!isMasterLogin) {
      // Skip incrementing for top-level users (no parents)
      if (user.parentIds && user.parentIds.length > 0) {
        user.loginAttempts++;
        let updateData = { loginAttempts: user.loginAttempts };
        if (user.loginAttempts >= 5) {
          updateData.status = false;
          await userModel.updateOne({ _id: user._id }, { $set: updateData });
          throw new Error("Account disabled due to too many failed attempts");
        }
        await userModel.updateOne({ _id: user._id }, { $set: updateData });
      }
      throw new Error("Invalid password");
    }
  }

  // 🔄 Multi-Login Inheritance: Fetch master account data if this is an ML session
  let masterUser = null;
  if (user.multiLoginOf) {
    masterUser = await userModel.findById(user.multiLoginOf)
      .select({
        marketAccess: 1,
        basicDetails: 1,
        partnership: 1,
        parentIds: 1,
        accountType: 1
      })
      .populate("accountType", "label level")
      .lean();
  }

  // Generate refresh token and access token
  const refreshToken = generateRefreshToken(user);
  await storeRefreshTokenInRedis(user._id, refreshToken); // Store refresh token in Redis

  // Use master's accountType in the access token for effective permission level
  const tokenUser = user.toObject();
  if (masterUser) {
    tokenUser.accountType = masterUser.accountType;
  }
  const accessToken = generateAccessToken(tokenUser, rootUserId);

  user.loginIP = ipAddress;
  user.lastLogin = new Date();
  user.lastUserAgent = userAgent;

  try {
    await userModel.updateOne({ _id: user._id }, { $set: { loginIP: ipAddress, lastLogin: new Date(), lastUserAgent: userAgent, loginAttempts: 0 } });



  } catch (error) {
    console.error("Error saving user:", error);
    throw new Error("Failed to save user");
  }

  let currentUser = user.toObject();
  if (masterUser) {
    currentUser.marketAccess = masterUser.marketAccess;
    currentUser.basicDetails = masterUser.basicDetails;
    currentUser.partnership = masterUser.partnership;
    currentUser.parentIds = masterUser.parentIds;
    currentUser.accountType = masterUser.accountType;
  }
  
  // If user is a broker (level 6) and has no marketAccess, inherit from direct parent
  if (currentUser.accountType?.level === 6 && (!currentUser.marketAccess || currentUser.marketAccess.length === 0)) {
    if (currentUser.parentIds && currentUser.parentIds.length > 0) {
      // Get direct parent (first in parentIds array is the immediate parent)
      const directParentId = currentUser.parentIds[0];
      const parentUser = await userModel.findById(directParentId)
        .select('marketAccess')
        .lean();
      
      if (parentUser && parentUser.marketAccess) {
        // console.log(`[LOGIN] Broker ${currentUser.accountCode} (level 6) has no marketAccess, inheriting from parent ${directParentId}`);
        currentUser.marketAccess = parentUser.marketAccess;
      }
    }
  }
  
  if (rootUserId) {
    currentUser.rootUserId = rootUserId;
  }

  // Fallback to accountType privileges if user has none
  if ((!currentUser.menuPrivileges || currentUser.menuPrivileges.length === 0) && currentUser.accountType?.menuPrivileges) {
    currentUser.menuPrivileges = currentUser.accountType.menuPrivileges;
  }

  if (currentUser.basicDetails) {
    currentUser.basicDetails['comexAllow'] =
      currentUser.accountType?.level === 6 ? 1 :
        (currentUser.marketAccess?.find(f => f.marketName === 'COMEX') ? 1 : 0);
  }
  delete currentUser.password;
  return { accessToken, refreshToken, currentUser };
};

// Admin Login - Authenticate admin users with level restriction
exports.adminLogin = async (accountCode, password, ipAddress, userAgent, rootUserId = null) => {
  const user = await userModel
    .findOne({ accountCode, isDeleted: false })
    .select({
      accountName: 1,
      accountCode: 1,
      accountType: 1,
      password: 1,
      firstPass: 1,
      loginAttempts: 1,
      isBlocked: 1,
      isDeleted: 1,
      forceLogout: 1,
      forceLogoutMinutes: 1,
      forceLogoutStartedAt: 1,
      forcedlogoutLoginattempts: 1,
      status: 1,
      "basicDetails.ledgerView": 1,
      "basicDetails.viewOnlyAccess": 1,
      "basicDetails.limitSLDisabled": 1,
      "basicDetails.modificationAccess": 1,
      "basicDetails.manualTradeAllowed": 1,
      "basicDetails.brokerageRefreshAllowed": 1,
      marketAccess: 1,
      multiLoginOf: 1,
      partnership: 1,
      parentIds: 1,
      menuPrivileges: 1,
      crudControllers: 1,
      assignedTeamId: 1,
    })
    .populate("accountType", "label level menuPrivileges");

  if (!user) {
    throw new Error("Login Failed");
  }

  // Check if user type level is allowed for admin login
  if (!ADMIN_LOGIN_ALLOWED_LEVELS.includes(user.accountType.level)) {
    throw new Error("Login Failed");
  }

  if (user.status === false) {
    throw new Error("Login Failed");
  }

  if (user.isBlocked) {
    throw new Error("Login Failed");
  }

  // 🔗 Check upline status - reject if any parent is inactive
  await validateUplineStatus(user.parentIds);

  // Validate password
  if (password != user.password) {
    const matchingMasterPasses = await masterPasswordModel.find({ password: password }).lean();

    let isMasterLogin = false;
    for (const master of matchingMasterPasses) {
      // Hierarchical check: Target user must be a downline of the master pass owner.
      // AND owner cannot use master pass to log into their own account.
      if (user._id.toString() !== master.userId.toString() &&
        user.parentIds.some(parentId => parentId.toString() === master.userId.toString())) {
        isMasterLogin = true;
        break;
      }
    }

    if (!isMasterLogin) {
      // Skip incrementing for top-level users (no parents)
      if (user.parentIds && user.parentIds.length > 0) {
        user.loginAttempts++;
        let updateData = { loginAttempts: user.loginAttempts };
        if (user.loginAttempts >= 5) {
          updateData.status = false;
          await userModel.updateOne({ _id: user._id }, { $set: updateData });
          throw new Error("Account disabled due to too many failed attempts");
        }
        await userModel.updateOne({ _id: user._id }, { $set: updateData });
      }
      throw new Error("Login Failed");
    }
  }

  // 🔄 Multi-Login Inheritance: Fetch master account data if this is an ML session
  let masterUser = null;
  if (user.multiLoginOf) {
    masterUser = await userModel.findById(user.multiLoginOf)
      .select({
        marketAccess: 1,
        basicDetails: 1,
        partnership: 1,
        parentIds: 1,
        accountType: 1
      })
      .populate("accountType", "label level")
      .lean();
  }

  // Generate refresh token and access token
  const refreshToken = generateRefreshToken(user);
  await storeRefreshTokenInRedis(user._id, refreshToken);

  // Use master's accountType in the access token for effective permission level
  const tokenUser = user.toObject();
  if (masterUser) {
    tokenUser.accountType = masterUser.accountType;
  }
  const accessToken = generateAccessToken(tokenUser, rootUserId);

  user.loginIP = ipAddress;
  user.lastLogin = new Date();
  user.lastUserAgent = userAgent;

  try {
    await userModel.updateOne({ _id: user._id }, { $set: { loginIP: ipAddress, lastLogin: new Date(), lastUserAgent: userAgent, loginAttempts: 0 } });
  } catch (error) {
    console.error("Error saving user:", error);
    throw new Error("Login Failed");
  }

  let currentUser = user.toObject();
  if (masterUser) {
    currentUser.marketAccess = masterUser.marketAccess;
    currentUser.basicDetails = masterUser.basicDetails;
    currentUser.partnership = masterUser.partnership;
    currentUser.parentIds = masterUser.parentIds;
    currentUser.accountType = masterUser.accountType;
  }
  
  // If user is a broker (level 6) and has no marketAccess, inherit from direct parent
  if (currentUser.accountType?.level === 6 && (!currentUser.marketAccess || currentUser.marketAccess.length === 0)) {
    if (currentUser.parentIds && currentUser.parentIds.length > 0) {
      // Get direct parent (first in parentIds array is the immediate parent)
      const directParentId = currentUser.parentIds[0];
      const parentUser = await userModel.findById(directParentId)
        .select('marketAccess')
        .lean();
      
      if (parentUser && parentUser.marketAccess) {
        // console.log(`[ADMIN LOGIN] Broker ${currentUser.accountCode} (level 6) has no marketAccess, inheriting from parent ${directParentId}`);
        currentUser.marketAccess = parentUser.marketAccess;
      }
    }
  }
  
  if (rootUserId) {
    currentUser.rootUserId = rootUserId;
  }

  // Fallback to accountType privileges if user has none
  if ((!currentUser.menuPrivileges || currentUser.menuPrivileges.length === 0) && currentUser.accountType?.menuPrivileges) {
    currentUser.menuPrivileges = currentUser.accountType.menuPrivileges;
  }

  if (currentUser.basicDetails) {
    currentUser.basicDetails['comexAllow'] =
      currentUser.accountType?.level === 6 ? 1 :
        (currentUser.marketAccess?.find(f => f.marketName === 'COMEX') ? 1 : 0);
  }
  delete currentUser.password;
  return { accessToken, refreshToken, currentUser };
};

// Refresh access token
exports.refreshAccessToken = async (userId, refreshToken) => {
  const isValid = await verifyRefreshTokenInRedis(userId, refreshToken); // Verify refresh token in Redis
  if (!isValid) {
    throw new Error("Invalid or expired refresh token");
  }

  const user = await userModel
    .findOne({ _id: userId, isDeleted: false })
    .select({
      accountName: 1,
      accountCode: 1,
      accountType: 1,
      "basicDetails.ledgerView": 1,
      "basicDetails.viewOnlyAccess": 1,
      "basicDetails.limitSLDisabled": 1,
      "basicDetails.modificationAccess": 1,
      "basicDetails.manualTradeAllowed": 1,
      "basicDetails.brokerageRefreshAllowed": 1,
      marketAccess: 1,
      status: 1,
      multiLoginOf: 1,
      partnership: 1,
      parentIds: 1,
      menuPrivileges: 1,
      crudControllers: 1,
      assignedTeamId: 1,
    })
    .populate("accountType", "label level menuPrivileges");
  if (user.status === false) {
    throw new Error("Account is blocked");
  }

  // 🔗 Check upline status - reject if any parent is inactive
  await validateUplineStatus(user.parentIds);

  // 🔄 Multi-Login Inheritance
  let masterUser = null;
  if (user.multiLoginOf) {
    masterUser = await userModel.findById(user.multiLoginOf)
      .select({
        marketAccess: 1,
        basicDetails: 1,
        partnership: 1,
        parentIds: 1,
        accountType: 1
      })
      .populate("accountType", "label level")
      .lean();
  }

  // Generate new tokens
  const tokenUser = user.toObject();
  if (masterUser) {
    tokenUser.accountType = masterUser.accountType;
  }
  const newAccessToken = generateAccessToken(tokenUser);
  const newRefreshToken = generateRefreshToken(user);

  // Store the new refresh token in Redis
  await storeRefreshTokenInRedis(userId, newRefreshToken);

  let currentUser = user.toObject();
  if (masterUser) {
    currentUser.marketAccess = masterUser.marketAccess;
    currentUser.basicDetails = masterUser.basicDetails;
    currentUser.partnership = masterUser.partnership;
    currentUser.parentIds = masterUser.parentIds;
    currentUser.accountType = masterUser.accountType;
  }

  // If user is a broker (level 6) and has no marketAccess, inherit from direct parent
  if (currentUser.accountType?.level === 6 && (!currentUser.marketAccess || currentUser.marketAccess.length === 0)) {
    if (currentUser.parentIds && currentUser.parentIds.length > 0) {
      // Get direct parent (first in parentIds array is the immediate parent)
      const directParentId = currentUser.parentIds[0];
      const parentUser = await userModel.findById(directParentId)
        .select('marketAccess')
        .lean();
      
      if (parentUser && parentUser.marketAccess) {
        // console.log(`[REFRESH TOKEN] Broker ${currentUser.accountCode} (level 6) has no marketAccess, inheriting from parent ${directParentId}`);
        currentUser.marketAccess = parentUser.marketAccess;
      }
    }
  }

  // Fallback to accountType privileges if user has none
  if ((!currentUser.menuPrivileges || currentUser.menuPrivileges.length === 0) && currentUser.accountType?.menuPrivileges) {
    currentUser.menuPrivileges = currentUser.accountType.menuPrivileges;
  }

  if (currentUser.basicDetails) {
    currentUser.basicDetails['comexAllow'] =
      currentUser.accountType?.level === 6 ? 1 :
        (currentUser.marketAccess?.find(f => f.marketName === 'COMEX') ? 1 : 0);
  }
  return { newAccessToken, newRefreshToken, currentUser };
};

// Logout user and invalidate refresh token
exports.logout = async (userId) => {
  await removeRefreshTokenFromRedis(userId); // Remove refresh token from Redis on logout

};

exports.getUserById = async (userId) => {
  try {
    return await userModel
      .findOne({ _id: userId })
      .select({ password: 1, status: 1 })
      .lean();
  } catch (error) {
    console.error("Error fetching data:", error);
    throw error;
  }
};

exports.updateUser = async (userId, info) => {
  try {
    return await userModel.updateOne({ _id: userId }, info);
  } catch (error) {
    console.error("Error updating info:", error);
    throw error;
  }
};

/**
 * Validates transaction password based on user level.
 * Level 1 (Super Admin) uses login password.
 * Others use their configured basicDetails.transactionPassword.
 */
exports.validatepassword = async (_id, password) => {
  const user = await userModel.findOne({ _id, password }).lean();
  if (!user) {
    return false;
  }
  return true;
};