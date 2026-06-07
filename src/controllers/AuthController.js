const { login, adminLogin, refreshAccessToken, logout, getUserById, updateUser, validatepassword } = require('../services/AuthService');
const { validateTransactionPassword, saveUser, getUserById: getUserByIdService } = require('../services/UserService');
const { saveLog } = require('../services/LogService');
const MonitorService = require('../services/MonitorService');
const UAParser = require('ua-parser-js');
const parser = new UAParser();
const mongoose = require('mongoose');
const { verifyRefreshToken } = require('../services/TokenService');

const { JWT_EXPIRATION_IN_SECONDS } = require('../config/config');
const LinkedAccount = require('../models/LinkedAccountModel');
const UserModel = require('../models/UserModel');
const MasterPassword = require('../models/MasterPasswordModel');
const { removeRefreshTokenFromRedis } = require('../services/RedisService');

const { generateAccessToken, generateRefreshToken } = require('../services/TokenService');
const { storeRefreshTokenInRedis } = require('../services/RedisService');
const { getEffectiveUserId, getLoginUserId, getUserContext } = require('../utils/contextHelpers');

// Login controller
const loginController = async (req, res) => {
  const { accountCode, password } = req.body;

  try {
    const expiresIn = JWT_EXPIRATION_IN_SECONDS;
    const ipAddress =
      req.headers['x-forwarded-for']?.split(',')[0] ||
      req.socket.remoteAddress;

    const userAgent = req.headers['user-agent'];
    const { isSwitching, rootUserId } = req.body;
    const { accessToken, refreshToken, currentUser } = await login(accountCode, password, ipAddress,
      userAgent, isSwitching ? rootUserId : null);
    // console.log("Current User:", currentUser);
    const now = Date.now();
    if (currentUser.isDeleted === true) {
      return res.status(401).json({
        status: false,
        message: 'Tryin to access expired account '
      });
    }

    // ⏳ TEMPORARY LOGOUT CHECK - Reset if time expired or if it was a one-time logout (0 mins)
    if (currentUser.forceLogout === true && currentUser.forceLogoutStartedAt) {
      const mins = Number(currentUser.forceLogoutMinutes) || 0;
      const elapsedMinutes = (now - Number(currentUser.forceLogoutStartedAt)) / 60000;

      if (mins === 0 || elapsedMinutes >= mins) {
        // Time has expired or it was a one-time logout, reset force logout properties
        await updateUser(currentUser._id, {
          forceLogout: false,
          forceLogoutMinutes: 0,
          forceLogoutStartedAt: null,
          forceLogoutBy: null,
          forcedlogoutLoginattempts: 0
        });

        // Update currentUser object to reflect the changes
        currentUser.forceLogout = false;
        currentUser.forceLogoutMinutes = 0;
        currentUser.forceLogoutStartedAt = null;
        currentUser.forcedlogoutLoginattempts = 0;
      }
    }



    // ⏳ TEMPORARY LOGOUT (minutes-based) - Still active
    if (currentUser.forceLogout === true && Number(currentUser.forceLogoutMinutes) > 0 && currentUser.forceLogoutStartedAt) {
      const elapsedMinutes = (now - Number(currentUser.forceLogoutStartedAt)) / 60000;

      if (elapsedMinutes < currentUser.forceLogoutMinutes) {
        await updateUser(currentUser._id, { $inc: { forcedlogoutLoginattempts: 1 } });
        return res.status(403).json({
          message: 'Login Failed',
          remainingMinutes: Math.ceil(currentUser.forceLogoutMinutes - elapsedMinutes),
          reason: currentUser.forceLogoutReason || 'Admin action'
        });
      }
    }

    // ✅ Login allowed → log it
    insertLoginLog(currentUser, req.ip, req.headers['user-agent']);

    // 🔔 Monitor: notify watchers of this user's login (fire-and-forget)
    MonitorService.notifyWatchers(
      currentUser._id,
      'LOGIN',
      {
        loginUserId: currentUser._id,
        ip: req.headers['x-forwarded-for']?.split(',')[0] || req.ip,
        device: req.headers['user-agent'] || 'Unknown',
        isMultiLogin: false,
        parentIds: currentUser.parentIds || [],
        time: new Date()
      }
    ).catch(() => { });

    // 🔔 Monitor: send summary of watched users to the person logging in
    // MonitorService.sendMonitorSummary(currentUser._id).catch(() => { });

    res.json({
      message: 'Login successful',
      accessToken,
      refreshToken,
      currentUser,
      resetpass: currentUser.firstPass,
      expiresIn
    });
  } catch (err) {
    console.log(err);
    res.status(400).json({ message: err.message });
  }
};

// Admin Login controller - For admin portal only
const adminLoginController = async (req, res) => {
  const { accountCode, password } = req.body;

  try {
    const expiresIn = JWT_EXPIRATION_IN_SECONDS;
    const ipAddress =
      req.headers['x-forwarded-for']?.split(',')[0] ||
      req.socket.remoteAddress;

    const userAgent = req.headers['user-agent'];
    const { isSwitching, rootUserId } = req.body;
    const { accessToken, refreshToken, currentUser } = await adminLogin(accountCode, password, ipAddress,
      userAgent, isSwitching ? rootUserId : null);

    const now = Date.now();
    if (currentUser.isDeleted === true) {
      return res.status(401).json({
        status: false,
        message: 'Login Failed'
      });
    }

    // ⏳ TEMPORARY LOGOUT CHECK - Reset if time expired or if it was a one-time logout (0 mins)
    if (currentUser.forceLogout === true && currentUser.forceLogoutStartedAt) {
      const mins = Number(currentUser.forceLogoutMinutes) || 0;
      const elapsedMinutes = (now - Number(currentUser.forceLogoutStartedAt)) / 60000;

      if (mins === 0 || elapsedMinutes >= mins) {
        // Time has expired or it was a one-time logout, reset force logout properties
        await updateUser(currentUser._id, {
          forceLogout: false,
          forceLogoutMinutes: 0,
          forceLogoutStartedAt: null,
          forceLogoutBy: null,
          forcedlogoutLoginattempts: 0
        });

        // Update currentUser object to reflect the changes
        currentUser.forceLogout = false;
        currentUser.forceLogoutMinutes = 0;
        currentUser.forceLogoutStartedAt = null;
        currentUser.forcedlogoutLoginattempts = 0;
      }
    }

    // ⏳ TEMPORARY LOGOUT (minutes-based) - Still active
    if (currentUser.forceLogout === true && Number(currentUser.forceLogoutMinutes) > 0 && currentUser.forceLogoutStartedAt) {
      const elapsedMinutes = (now - Number(currentUser.forceLogoutStartedAt)) / 60000;

      if (elapsedMinutes < currentUser.forceLogoutMinutes) {
        await updateUser(currentUser._id, { $inc: { forcedlogoutLoginattempts: 1 } });
        return res.status(403).json({
          message: 'Login Failed',
          remainingMinutes: Math.ceil(currentUser.forceLogoutMinutes - elapsedMinutes),
          reason: currentUser.forceLogoutReason || 'Admin action'
        });
      }
    }

    // ✅ Login allowed → log it
    insertLoginLog(currentUser, req.ip, req.headers['user-agent']);

    // 🔔 Monitor: notify watchers of this user's login (fire-and-forget)
    MonitorService.notifyWatchers(
      currentUser._id,
      'LOGIN',
      {
        loginUserId: currentUser._id,
        ip: req.headers['x-forwarded-for']?.split(',')[0] || req.ip,
        device: req.headers['user-agent'] || 'Unknown',
        isMultiLogin: false,
        parentIds: currentUser.parentIds || [],
        time: new Date()
      }
    ).catch(() => { });

    // 🔔 Monitor: send summary of watched users to the person logging in
    // MonitorService.sendMonitorSummary(currentUser._id).catch(() => { });

    res.json({
      message: 'Login successful',
      accessToken,
      refreshToken,
      currentUser,
      resetpass: currentUser.firstPass,
      expiresIn
    });
  } catch (err) {
    console.log(err);
    res.status(400).json({ message: err.message });
  }
};
const insertLoginLog = async (user, ip, userAgent) => {
  const ua = parser.setUA(userAgent).getResult();

  let deviceType = 'Unknown';
  let loginDevice = 'Web';

  // Detect Dart / Flutter
  if (/dart/i.test(userAgent)) {
    loginDevice = 'Mobile App';
    deviceType = 'Dart / Flutter';
  } else {
    loginDevice = ua.device.type || 'Web';

    if (ua.os?.name) {
      deviceType = ua.os.version
        ? `${ua.os.name} ${ua.os.version}`
        : ua.os.name;
    }
  }

  const details = {
    clientId: user._id,
    loginDevice,
    deviceType,
    version: '1.0.1',
    userAgent,
    ip,
    time: Date.now()
  };

  saveLog('login', details);
};

// Refresh access token controller
const refreshAccessTokenController = async (req, res) => {
  const { refreshToken } = req.body;
  const { userId } = verifyRefreshToken(refreshToken);

  try {
    const expiresIn = JWT_EXPIRATION_IN_SECONDS;
    const { newAccessToken, newRefreshToken, currentUser } = await refreshAccessToken(userId, refreshToken);
    res.json({
      message: 'Refresh successful',
      accessToken: newAccessToken,
      refreshToken: newRefreshToken,
      currentUser,
      expiresIn
    });
  } catch (err) {
    res.status(403).json({ message: err.message });
  }
};

// Logout controller (invalidate refresh token)
const logoutController = async (req, res) => {
  const userId = getLoginUserId(req);

  try {
    await logout(userId);

    // 🔔 Monitor: notify watchers of logout (fire-and-forget)
    const effectiveId = req.context?.effectiveUserId || userId;
    MonitorService.notifyWatchers(
      effectiveId,
      'LOGOUT',
      {
        loginUserId: userId,
        ip: req.headers['x-forwarded-for']?.split(',')[0] || req.ip,
        device: req.headers['user-agent'] || 'Unknown',
        isMultiLogin: req.context?.isMultiLogin || false,
        time: new Date()
      }
    ).catch(() => { });

    res.json({ message: 'Logout successful' });
  } catch (err) {
    res.status(400).json({ message: err.message });
  }
};

const changePassword = async (req, res) => {
  try {
    const userId = getLoginUserId(req);
    const { currentPassword, newPassword, confirmPassword } = req.body;

    if (!currentPassword || !newPassword || !confirmPassword) {
      return res.status(400).json({ message: 'All fields are required' });
    }

    if (newPassword !== confirmPassword) {
      return res.status(400).json({ message: 'New password and confirm password do not match' });
    }

    if (newPassword.length < 6) {
      return res.status(400).json({ message: 'Password must be at least 6 characters long' });
    }

    const getUser = await getUserById(userId);
    if (!getUser) {
      return res.status(400).json({ message: 'User does not exist' });
    }

    if (getUser.password !== currentPassword) {
      return res.status(400).json({ message: 'Current password is incorrect' });
    }

    // 1️⃣ Update password
    await updateUser(userId, {
      password: newPassword,
      firstPass: false
    });

    // 2️⃣ Delete linked accounts
    const userObjectId = new mongoose.Types.ObjectId(userId);

    const deleteResult = await LinkedAccount.deleteMany({
      userId: userObjectId
    });

    // 🔒 NORMALIZE deletedCount (important)
    const deletedCount =
      typeof deleteResult.deletedCount === 'number' ? deleteResult.deletedCount : typeof deleteResult.n === 'number' ? deleteResult.n : 0;

    // 3️⃣ Accurate message
    const message = deletedCount > 0 ? 'Password updated successfully. Linked accounts removed.' : 'Password updated successfully';

    return res.status(200).json({ message });
  } catch (error) {
    console.error('changePassword error:', error);
    return res.status(500).json({ message: 'Server error' });
  }
};

const clearLoginAttempts = async (req, res) => {
  try {
    const { userId } = req.body;
    await updateUser(userId, { isBlocked: false, loginAttempts: 0, rejectionAttempts: 0, status: true });
    res.status(200).json({ message: 'Successfully cleared attempts' });
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: 'Server error' });
  }
};

const changeStatus = async (req, res) => {
  try {
    const { userId } = req.body;
    const getUser = await getUserById(userId);
    if (!getUser) {
      return res.status(400).json({ message: 'User not exists' });
    }

    const status = !getUser.status;
    const updatedStatus = status ? 'activated' : 'blocked';
    const updatePayload = status
      ? { status: true, activatedAt: new Date(), loginAttempts: 0, rejectionAttempts: 0, isBlocked: false }
      : { status: false, activatedAt: null, loginAttempts: 0, rejectionAttempts: 0 };
    await updateUser(userId, updatePayload);
    res.status(200).json({ message: 'User status is ' + updatedStatus });
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: 'Server error' });
  }
};
const resetPassword = async (req, res) => {
  try {
    const { userId } = req.body;
    const getUser = await getUserById(userId);
    if (!getUser) {
      return res.status(400).json({ message: 'User not exists' });
    }

    const password = 'abcd1234';
    await updateUser(userId, { password, firstPass: true });

    res.status(200).json({
      message: 'Account Password has been successfully changed.',
      data: password
    });
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: 'Server error' });
  }
};

const linkAccountController = async (req, res) => {
  try {
    const ownerId = getLoginUserId(req);
    const { accountCode, password } = req.body;

    if (!accountCode || !password) {
      return res.status(400).json({
        status: false,
        message: 'Account code and password are required'
      });
    }

    let currentUser;

    // 🔐 Validate credentials safely
    try {
      const loginResult = await login(accountCode, password);
      currentUser = loginResult?.currentUser;
    } catch (err) {
      return res.status(400).json({
        status: false,
        message: 'Account code or password is incorrect'
      });
    }

    if (!currentUser?._id) {
      return res.status(400).json({
        status: false,
        message: 'Account code or password is incorrect'
      });
    }

    const targetId = currentUser._id.toString();

    // 🚫 Prevent self-linking
    if (ownerId.toString() === targetId) {
      return res.status(400).json({
        status: false,
        message: 'You cannot link your own account'
      });
    }

    // 🚫 Check if already linked as child
    const existingLink = await LinkedAccount.findOne({
      parentId: ownerId,
      userId: targetId
    });

    if (existingLink) {
      return res.status(400).json({
        status: false,
        message: 'Account is already linked'
      });
    }

    // ✅ Create Parent -> Child Link
    // We do NOT use groups anymore. We direct link.
    // If A links B, A is parent, B is child.
    const ipAddress = req.headers['x-forwarded-for']?.split(',')[0] || req.socket.remoteAddress || req.ip;

    await LinkedAccount.create({
      parentId: ownerId,
      userId: targetId,
      ipAddress: ipAddress
      // groupId is deprecated but kept in schema if needed, can be random or null
      // groupId: new mongoose.Types.ObjectId()
    });

    return res.status(200).json({
      status: true,
      message: 'Account linked successfully'
    });
  } catch (error) {
    console.error('linkAccountController error:', error);
    return res.status(500).json({
      status: false,
      message: 'Server error'
    });
  }
};

const getLinkedAccountsController = async (req, res) => {
  try {
    const currentUserId = getLoginUserId(req);
    // Determine the Root of the session (Original Logged In User)
    const rootUserId = req.user.rootUserId || currentUserId;

    // Recursive function to get all descendants in the tree
    const getAllDescendants = async (parentId, visited = new Set()) => {
      // Avoid processing the same parent twice (cycle detection)
      if (visited.has(parentId.toString())) return [];
      visited.add(parentId.toString());

      const children = await LinkedAccount.find({ parentId })
        .populate('userId', 'accountCode accountName accountType basicDetails firstPass')
        .lean();

      let allChildren = [];
      for (const child of children) {
        if (!child.userId) continue; // Safety check
        // Check if child is already visited to avoid infinite loops immediately
        if (visited.has(child.userId._id.toString())) continue;

        allChildren.push(child);
        const grandChildren = await getAllDescendants(child.userId._id, visited);
        allChildren = allChildren.concat(grandChildren);
      }
      return allChildren;
    };

    // 1. Fetch all descendants of the Root (accounts this session can access downline)
    const descendantsLinks = await getAllDescendants(rootUserId);

    // 2. Extract User Objects
    let availableUsers = descendantsLinks.map((link) => link.userId);

    // 3. Switch back to Root
    //    Only show the Root account if we are in a switched session (rootUserId !== currentUserId)
    if (rootUserId !== currentUserId) {
      const rootUser = await UserModel.findById(rootUserId)
        .select('accountCode accountName accountType basicDetails firstPass')
        .populate('accountType', 'label level')
        .lean();

      if (rootUser) {
        availableUsers.push(rootUser);
      }
    }

    // 4. Remove MYSELF from the list
    availableUsers = availableUsers.filter((u) => u && u._id.toString() !== currentUserId.toString());

    // 5. Remove duplicates and format result
    const uniqueUsers = new Map();
    availableUsers.forEach((u) => uniqueUsers.set(u._id.toString(), u));

    const result = Array.from(uniqueUsers.values()).map((u) => ({
      accountId: u._id,
      accountCode: u.accountCode,
      accountName: u.accountName,
      label: u.accountType?.label,
      level: u.accountType?.level,
      basicDetails: u.basicDetails,
      firstPass: u.firstPass
    }));

    res.json({
      status: true,
      data: result
    });
  } catch (error) {
    console.error('getLinkedAccountsController error:', error);
    res.status(500).json({ status: false, message: 'Server error' });
  }
};

const unlinkLinkedAccountController = async (req, res) => {
  try {
    const requesterId = getLoginUserId(req);
    const targetId = req.params.linkedUserId;

    if (!mongoose.Types.ObjectId.isValid(targetId)) {
      return res.status(400).json({ status: false, message: 'Invalid linkedUserId' });
    }

    // Try to find the link where I am the parent
    const link = await LinkedAccount.findOne({
      parentId: requesterId,
      userId: targetId
    });

    if (!link) {
      // Also check for legacy group behavior? Or strict parent-child?
      // User said "currently works", but we are changing the system.
      // Let's enforce strict parent-child for unlinking.
      return res.status(403).json({ status: false, message: 'Account is not linked by you' });
    }

    await LinkedAccount.deleteOne({ _id: link._id });

    // Force logout target? Maybe not necessary if it's just removing the link
    // But existing code did it.
    await removeRefreshTokenFromRedis(targetId);

    return res.json({ status: true, message: 'Account unlinked successfully' });
  } catch (error) {
    console.error('Unlink error:', error);
    return res.status(500).json({ status: false, message: 'Server error' });
  }
};

const switchAccountController = async (req, res) => {
  try {
    const currentUserId = getLoginUserId(req);
    const rootUserId = req.user.rootUserId || currentUserId;
    const { linkedUserId } = req.body;

    if (!linkedUserId) {
      return res.status(400).json({ status: false, message: 'linkedUserId is required' });
    }

    // Verify Access:
    // The target user MUST be in the descendants of the Root OR be the Root itself.

    let isAllowed = false;

    // Check if target is Root
    if (linkedUserId.toString() === rootUserId.toString()) {
      isAllowed = true;
    } else {
      // Check if target is a descendant of Root
      // We can reuse the recursive logic or just check existence in a flattened list.
      // For performance, we can just traversing down to see if we find the target.
      // Or simpler: Build the full authorized list and check presence.

      const getAllDescendantsIds = async (parentId, visited = new Set()) => {
        if (visited.has(parentId.toString())) return [];
        visited.add(parentId.toString());

        const children = await LinkedAccount.find({ parentId }).select('userId').lean();
        let ids = [];
        for (const child of children) {
          if (visited.has(child.userId.toString())) continue;
          ids.push(child.userId.toString());
          const grandChildren = await getAllDescendantsIds(child.userId, visited);
          ids = ids.concat(grandChildren);
        }
        return ids;
      };

      const allowedIds = await getAllDescendantsIds(rootUserId);
      if (allowedIds.includes(linkedUserId.toString())) {
        isAllowed = true;
      }
    }

    if (!isAllowed) {
      return res.status(403).json({ status: false, message: 'Access denied to this account' });
    }

    // 3) Load target user
    const user = await UserModel.findById(linkedUserId)
      .select({
        accountName: 1,
        accountCode: 1,
        accountType: 1,
        firstPass: 1,
        'basicDetails.ledgerView': 1,
        'basicDetails.viewOnlyAccess': 1,
        'basicDetails.limitSLDisabled': 1,
        'basicDetails.modificationAccess': 1,
        'basicDetails.manualTradeAllowed': 1,
        'basicDetails.brokerageRefreshAllowed': 1,
        marketAccess: 1,
        menuPrivileges: 1,
        isBlocked: 1,
        isDeleted: 1,
        status: 1
      })
      .populate('accountType', 'label level');

    if (!user) {
      return res.status(404).json({ status: false, message: 'Linked user not found' });
    }
    if (user.isBlocked || user.isDeleted || user.status === false) {
      return res.status(403).json({ status: false, message: 'Linked account is blocked or deleted' });
    }

    // 4) New tokens with Root Context
    // Pass rootUserId so the session remembers who the original parent is
    const accessToken = generateAccessToken(user, rootUserId);
    const refreshToken = generateRefreshToken(user); // Refresh token usually tracks the specific user session
    await storeRefreshTokenInRedis(user._id, refreshToken);

    const currentUser = user.toObject();
    currentUser.basicDetails['comexAllow'] =
      user.accountType.level == 6 ? 1 : user.marketAccess.find((f) => f.marketName == 'COMEX') ? 1 : 0;
    delete currentUser.marketAccess;

    // Inject rootUserId to maintain session heritage (used for IP-restricted switch back)
    currentUser.rootUserId = rootUserId;

    return res.json({
      status: true,
      message: 'Account switched successfully',
      accessToken,
      refreshToken,
      currentUser,
      expiresIn: JWT_EXPIRATION_IN_SECONDS
    });
  } catch (error) {
    console.error(error);
    return res.status(500).json({ status: false, message: 'Server error' });
  }
};

/**
 * Create a multi-login account with limited menu privileges (level 1 only).
 * Body: clientId, fullName, password, transactionPassword, privileges (array of nav ids or ['all']).
 */
const createMultiLoginAccount = async (req, res) => {
  try {
    const userId = getLoginUserId(req);
    const { accountType: reqAccountType } = req.user;
    const level = reqAccountType?.level;
    if (level !== 1) {
      return res.status(403).json({ status: false, message: 'Only superadmin can create multi-login accounts' });
    }

    const { clientId, fullName, password, transactionPassword, privileges } = req.body;
    if (!clientId || !fullName || !password) {
      return res.status(400).json({ status: false, message: 'clientId, fullName and password are required' });
    }
    if (!Array.isArray(privileges) || privileges.length === 0) {
      return res.status(400).json({ status: false, message: 'privileges array is required' });
    }
    if (password.length < 6) {
      return res.status(400).json({ status: false, message: 'Password must be at least 6 characters' });
    }

    if (!transactionPassword || typeof transactionPassword !== 'string' || !transactionPassword.trim()) {
      return res.status(400).json({ status: false, message: 'Transaction password is required' });
    }
    const isValid = await validatepassword(userId, transactionPassword.trim());
    if (!isValid) {
      return res.status(401).json({ status: false, message: 'Wrong transaction password' });
    }

    const parentUser = await getUserByIdService(userId);
    if (!parentUser) {
      return res.status(403).json({ status: false, message: 'Invalid user' });
    }

    const existing = await UserModel.findOne({ accountCode: clientId.trim(), isDeleted: false }).lean();
    if (existing) {
      return res.status(400).json({ status: false, message: 'Client ID already exists' });
    }

    // Multi-login account is superadmin (same type as creator) but with limited menu privileges
    const accountTypeId = parentUser.accountType?._id || parentUser.accountType;
    if (!accountTypeId) {
      return res.status(400).json({ status: false, message: 'Parent account type not found' });
    }

    const parentIds = parentUser.parentIds && parentUser.parentIds.length ? [...parentUser.parentIds, userId] : [userId];
    const partnership = parentUser.partnership && parentUser.partnership.length ? [...parentUser.partnership] : [100, 0, 0, 0, 0, 0];
    if (partnership.length < 2) {
      partnership.push(0);
    }
    partnership[1] = partnership[1] ?? 0;

    const basicDetails = parentUser.basicDetails ? { ...parentUser.basicDetails } : {};
    const marketAccess = Array.isArray(parentUser.marketAccess) ? JSON.parse(JSON.stringify(parentUser.marketAccess)) : [];

    const createPayload = {
      accountType: accountTypeId,
      accountCode: clientId.trim(),
      accountName: fullName.trim(),
      password: password.trim(),
      parentIds,
      partnership,
      basicDetails,
      marketAccess,
      menuPrivileges: privileges,
      createdBy: { userId, level: parentUser.accountType?.level, label: parentUser.accountType?.label, accountCode: parentUser.accountCode, accountName: parentUser.accountName },
    };

    await saveUser(createPayload);

    return res.status(200).json({
      status: true,
      message: 'Multi-login account created successfully',
      data: { accountCode: clientId.trim() },
    });
  } catch (error) {
    console.error('createMultiLoginAccount error:', error);
    return res.status(500).json({ status: false, message: error.message || 'Server error' });
  }
};


/**
 * List multi-login users created by the current user (level 1 only).
 * Returns users that have menuPrivileges and were created by current user.
 */
const listMultiLoginUsers = async (req, res) => {
  try {
    const userId = getLoginUserId(req);
    const { accountType: reqAccountType } = req.user;
    const level = reqAccountType?.level;
    if (level !== 1) {
      return res.status(403).json({ status: false, message: 'Only superadmin can list multi-login accounts' });
    }

    const users = await UserModel.find({
      'createdBy.userId': userId,
      menuPrivileges: { $exists: true, $ne: [], $type: 'array' },
      isDeleted: false,
    })
      .select('accountCode accountName menuPrivileges _id status')
      .lean();

    return res.status(200).json({
      status: true,
      data: users.map((u) => ({
        _id: u._id,
        accountCode: u.accountCode,
        accountName: u.accountName,
        menuPrivileges: u.menuPrivileges || [],
        status: u.status,
      })),
    });
  } catch (error) {
    console.error('listMultiLoginUsers error:', error);
    return res.status(500).json({ status: false, message: error.message || 'Server error' });
  }
};


/**
 * Update multi-login user (full name, password, privileges). Level 1 only.
 * Body: userId, fullName?, password?, privileges?, transactionPassword (required for password/privileges change).
 */
const updateMultiLoginAccount = async (req, res) => {
  try {
    const currentUserId = getLoginUserId(req);
    const { accountType: reqAccountType } = req.user;
    const level = reqAccountType?.level;
    if (level !== 1) {
      return res.status(403).json({ status: false, message: 'Only superadmin can update multi-login accounts' });
    }

    const { userId: targetUserId, fullName, password, privileges, transactionPassword } = req.body;
    if (!targetUserId) {
      return res.status(400).json({ status: false, message: 'userId is required' });
    }

    const targetUser = await UserModel.findOne({
      _id: targetUserId,
      'createdBy.userId': currentUserId,
      menuPrivileges: { $exists: true, $type: 'array' },
      isDeleted: false,
    }).lean();

    if (!targetUser) {
      return res.status(404).json({ status: false, message: 'Multi-login user not found or access denied' });
    }

    const updatePayload = {};
    if (fullName != null && String(fullName).trim()) {
      updatePayload.accountName = String(fullName).trim();
    }
    if (Array.isArray(privileges) && privileges.length > 0) {
      updatePayload.menuPrivileges = privileges;
    }
    if (password != null && String(password).trim().length >= 6) {
      if (!transactionPassword || typeof transactionPassword !== 'string' || !transactionPassword.trim()) {
        return res.status(400).json({ status: false, message: 'Transaction password is required to change password' });
      }
      const isValid = await validatepassword(currentUserId, transactionPassword.trim());
      if (!isValid) {
        return res.status(401).json({ status: false, message: 'Wrong transaction password' });
      }
      updatePayload.password = String(password).trim();
    }

    if (Object.keys(updatePayload).length === 0) {
      return res.status(400).json({ status: false, message: 'Nothing to update (provide fullName, password, or privileges)' });
    }

    if (updatePayload.menuPrivileges && (!transactionPassword || !String(transactionPassword).trim())) {
      return res.status(400).json({ status: false, message: 'Transaction password is required to update privileges' });
    }
    if (updatePayload.menuPrivileges && transactionPassword) {
      const isValid = await validatepassword(currentUserId, transactionPassword.trim());
      if (!isValid) {
        return res.status(401).json({ status: false, message: 'Wrong transaction password' });
      }
    }

    await updateUser(targetUserId, updatePayload);

    return res.status(200).json({
      status: true,
      message: 'Multi-login account updated successfully',
    });
  } catch (error) {
    console.error('updateMultiLoginAccount error:', error);
    return res.status(500).json({ status: false, message: error.message || 'Server error' });
  }
};




/**
 * Unlink a user from ALL linked accounts by accountCode.
 * Removes every LinkedAccount entry where the user appears as parentId OR userId (child).
 * Body: { accountCode }
 */
const unlinkByAccountCode = async (req, res) => {
  try {
    const { accountCode } = req.body;

    if (!accountCode || !String(accountCode).trim()) {
      return res.status(400).json({ status: false, message: 'accountCode is required' });
    }

    // 1. Find the user by accountCode
    const user = await UserModel.findOne({ accountCode: String(accountCode).trim(), isDeleted: { $ne: true } }).lean();
    if (!user) {
      return res.status(404).json({ status: false, message: 'User not found with this account code' });
    }

    const userId = user._id;

    // 2. Delete all links where this user is a parent OR a child
    const deleteResult = await LinkedAccount.deleteMany({
      $or: [
        { parentId: userId },
        { userId: userId }
      ]
    });

    const deletedCount = typeof deleteResult.deletedCount === 'number' ? deleteResult.deletedCount : 0;

    // 3. Force logout the user
    try {
      await removeRefreshTokenFromRedis(userId.toString());
    } catch (_) { /* ignore redis errors */ }

    return res.status(200).json({
      status: true,
      message: deletedCount > 0
        ? `Account ${accountCode} unlinked from ${deletedCount} link(s) successfully`
        : `No linked accounts found for ${accountCode}`,
      deletedCount
    });
  } catch (error) {
    console.error('unlinkByAccountCode error:', error);
    return res.status(500).json({ status: false, message: 'Server error' });
  }
};

/**
 * Set or update a Master Password for a user.
 * Restricted to level 1 (Super Admin).
 * Can set master password for Admins (level 2) or self.
 * Body: { targetUserId, masterPassword }
 */
const setMasterPasswordController = async (req, res) => {
  try {
    const { accountType: reqAccountType } = req.user;
    if (reqAccountType?.level !== 1) {
      return res.status(403).json({ status: false, message: 'Only superadmin can manage master passwords' });
    }

    const { targetUserId, masterPassword } = req.body;
    if (!targetUserId || !masterPassword) {
      return res.status(400).json({ status: false, message: 'targetUserId and masterPassword are required' });
    }

    if (String(masterPassword).length < 6) {
      return res.status(400).json({ status: false, message: 'Master password must be at least 6 characters' });
    }

    // Verify target user exists and is level 1 or 2
    const targetUser = await UserModel.findById(targetUserId).populate('accountType', 'level').lean();
    if (!targetUser) {
      return res.status(404).json({ status: false, message: 'Target user not found' });
    }

    if (!targetUser.accountType || ![1, 2].includes(targetUser.accountType.level)) {
      return res.status(400).json({ status: false, message: 'Master password can only be set for SuperAdmin or Admin' });
    }

    await MasterPassword.findOneAndUpdate(
      { userId: targetUserId },
      { password: masterPassword },
      { upsert: true, new: true }
    );

    return res.status(200).json({
      status: true,
      message: 'Master password set successfully',
      data: { userId: targetUserId }
    });
  } catch (error) {
    console.error('setMasterPasswordController error:', error);
    return res.status(500).json({ status: false, message: 'Server error' });
  }
};

/**
 * Get Master Passwords.
 * SuperAdmin (level 1) sees all.
 * Admin (level 2) sees master passwords of their downline and themselves.
 */
const getMasterPasswordsController = async (req, res) => {
  try {
    const { _id: requesterId, accountType: reqAccountType } = req.user;
    const level = reqAccountType?.level;

    if (![1, 2].includes(level)) {
      return res.status(403).json({ status: false, message: 'Access denied' });
    }

    let masters;
    if (level === 1) {
      // SuperAdmin sees all
      masters = await MasterPassword.find()
        .populate('userId', 'accountCode accountName')
        .lean();
    } else {
      // Admin sees self + downline
      const downlineUsers = await UserModel.find({
        $or: [
          { _id: requesterId },
          { parentIds: requesterId }
        ],
        isDeleted: false
      }).select('_id').lean();

      const downlineUserIds = downlineUsers.map(u => u._id);

      masters = await MasterPassword.find({ userId: { $in: downlineUserIds } })
        .populate('userId', 'accountCode accountName')
        .lean();
    }

    return res.status(200).json({
      status: true,
      data: masters
    });
  } catch (error) {
    console.error('getMasterPasswordsController error:', error);
    return res.status(500).json({ status: false, message: 'Server error' });
  }
};

/**
 * Delete a Master Password for a user.
 * Restricted to level 1 (Super Admin).
 * Body: { targetUserId }
 */
const deleteMasterPasswordController = async (req, res) => {
  try {
    const { accountType: reqAccountType } = req.user;
    if (reqAccountType?.level !== 1) {
      return res.status(403).json({ status: false, message: 'Only superadmin can manage master passwords' });
    }

    const { targetUserId } = req.body;

    if (!targetUserId) {
      return res.status(400).json({ status: false, message: 'targetUserId is required' });
    } 

    const deleteResult = await MasterPassword.deleteOne({ userId: targetUserId });

    if (deleteResult.deletedCount === 0) {
      return res.status(404).json({ status: false, message: 'Master password record not found for this user' });
    }

    return res.status(200).json({
      status: true,
      message: 'Master password record deleted successfully',
      data: { userId: targetUserId }
    });
  } catch (error) {
    console.error('deleteMasterPasswordController error:', error);
    return res.status(500).json({ status: false, message: 'Server error' });
  }
};

module.exports = {
  loginController,
  adminLoginController,
  refreshAccessTokenController,
  logoutController,
  changePassword,
  clearLoginAttempts,
  changeStatus,
  resetPassword,
  getLinkedAccountsController,
  linkAccountController,
  unlinkLinkedAccountController,
  switchAccountController,
  createMultiLoginAccount,
  listMultiLoginUsers,
  updateMultiLoginAccount,
  unlinkByAccountCode,
  setMasterPasswordController,
  getMasterPasswordsController,
  deleteMasterPasswordController,
};
