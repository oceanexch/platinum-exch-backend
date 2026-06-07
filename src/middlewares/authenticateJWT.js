const { verifyAccessToken } = require('../services/TokenService');
const User = require('../models/UserModel');

const authenticateJWT = async (req, res, next) => {
  const token = req.header('Authorization')?.replace('Bearer ', '');

  if (!token) {
    return res.status(401).json({ message: 'Token is missing' });
  }

  try {
    const decoded = verifyAccessToken(token);
    const user = await User.findById(decoded.userId).populate('accountType').lean();

    if (!user) {
      return res.status(401).json({ message: 'User not found' });
    }
    if (user.status === false) {
      return res.status(401).json({
        status: false,
        message: 'Account is blocked'
      });
    }
    // ⏳ Temporary logout (minutes-based)
    if (user.forceLogout) {
      const mins = Number(user.forceLogoutMinutes) || 0;
      const elapsedMinutes = (Date.now() - user.forceLogoutStartedAt) / 60000;

      if (mins > 0 && user.forceLogout == true) {
        if (elapsedMinutes < mins) {
          return res.status(403).json({
            message: "Login Failed",
            remainingMinutes: Math.ceil(mins - elapsedMinutes),
            reason: user.forceLogoutReason || "Admin action",
          });
        }

        // ✅ Auto clear after expiry
        await User.updateOne(
          { _id: user._id },
          {
            $set: {
              forceLogout: false,
              forceLogoutMinutes: 0,
              forceLogoutStartedAt: null,
              forceLogoutBy: null,
              forcedlogoutLoginattempts: 0,
            },
          }
        );
      } else if (mins == 0 && user.forceLogout == true) {
        // mins is 0: force them to log in again
        return res.status(403).json({
          message: "Login Failed",
          reason: "Admin action",
        });
      } else {
      }
    }

    // Establish user context (backward compatible)
        // req.user = { ...decoded, accountType: user.accountType };
    let accountType = user.accountType;
    if (user.multiLoginOf) {
      const master = await User.findById(user.multiLoginOf).populate('accountType').lean();
      if (master) {
        accountType = master.accountType;
      }
    }
    req.user = { ...decoded, accountType };

    // 🔐 Multi-Login Context: Separate login identity from business identity
    // - loginUserId: Who actually logged in (for audit trail)
    // - effectiveUserId: Whose hierarchy/data we're operating on (for business logic)
    req.context = {
      loginUserId: user._id,                          // Who logged in (audit)
      effectiveUserId: user.multiLoginOf || user._id, // Whose data we operate on (business)
      isMultiLogin: !!user.multiLoginOf,              // Quick ML detection flag
      loginAccountName: user.accountName,             // For logging
      isDemo: user.demoid || false                    // Is this a demo account?
    };

    req.ip = req.ip.replace('::ffff:', '');
    next();
  } catch (err) {
    return res.status(401).json({ message: 'Invalid or expired token' });
  }
};

module.exports = authenticateJWT;
