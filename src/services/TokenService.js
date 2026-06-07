// services/tokenService.js
const jwt = require("jsonwebtoken");
const {
  JWT_SECRET,
  JWT_EXPIRATION,
  JWT_REFRESH_SECRET,
  JWT_REFRESH_EXPIRATION
} = require("../config/config");

// Generate access token
exports.generateAccessToken = (user,rootUserId = null) => {
  const payload = { userId: user._id, accountType: user.accountType, rootUserId: rootUserId };
  return jwt.sign(payload, JWT_SECRET, {
    expiresIn: JWT_EXPIRATION,
    
  });
};

// Generate refresh token
exports.generateRefreshToken = (user) => {
  const payload = { userId: user._id };
  return jwt.sign(payload, JWT_REFRESH_SECRET, {
    expiresIn: JWT_REFRESH_EXPIRATION,
  });
};

exports.verifyAccessToken = (token) => {
  return jwt.verify(token, JWT_SECRET);
}

exports.verifyRefreshToken = (token) => {
  return jwt.verify(token, JWT_REFRESH_SECRET);
}