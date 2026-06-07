/**
 * Socket Connection Configuration
 * Configure maximum socket connections per user level
 */

const SOCKET_CONNECTION_LIMITS = {
  // Level-based connection limits
  1: -1,   // Super Admin - max 2 connections (changed from unlimited)
  2: 2,   // Admin level 2 - max 2 connections
  3: 2,   // Admin level 3 - max 2 connections  
  4: 2,   // Master level 4 - max 2 connections
  5: 2,   // Master level 5 - max 2 connections
  6: 2,   // Broker level 6 - max 2 connections
  7: 1,   // Client level 7 - max 1 connection
  
  // Default fallback for any undefined levels
  default: 1
};

/**
 * Get maximum connections allowed for a user level
 * @param {number} userLevel - User account type level
 * @returns {number} - Maximum connections (-1 for unlimited)
 */
function getMaxConnections(userLevel) {
  const limit = SOCKET_CONNECTION_LIMITS.hasOwnProperty(userLevel) 
    ? SOCKET_CONNECTION_LIMITS[userLevel] 
    : SOCKET_CONNECTION_LIMITS.default;
  
  return limit;
}

/**
 * Update connection limit for a specific level
 * @param {number} level - User level
 * @param {number} maxConnections - Maximum connections (-1 for unlimited)
 */
function updateConnectionLimit(level, maxConnections) {
  if (typeof level === 'number' && typeof maxConnections === 'number') {
    SOCKET_CONNECTION_LIMITS[level] = maxConnections;
    return true;
  }
  return false;
}

/**
 * Get all current connection limits
 * @returns {Object} - Current connection limits configuration
 */
function getAllConnectionLimits() {
  return { ...SOCKET_CONNECTION_LIMITS };
}

/**
 * Reset to default configuration
 */
function resetToDefaults() {
  SOCKET_CONNECTION_LIMITS[1] = -1; // Super Admin - unlimited
  SOCKET_CONNECTION_LIMITS[2] = 2;  // Admin level 2
  SOCKET_CONNECTION_LIMITS[3] = 2;  // Admin level 3
  SOCKET_CONNECTION_LIMITS[4] = 2;  // Master level 4
  SOCKET_CONNECTION_LIMITS[5] = 2;  // Master level 5
  SOCKET_CONNECTION_LIMITS[6] = 2;  // Broker level 6
  SOCKET_CONNECTION_LIMITS[7] = 1;  // Client level 7
  SOCKET_CONNECTION_LIMITS.default = 1;
}

/**
 * Validate if a connection limit value is valid
 * @param {number} limit - Connection limit to validate
 * @returns {boolean} - True if valid
 */
function isValidLimit(limit) {
  return typeof limit === 'number' && (limit === -1 || limit >= 1);
}

module.exports = {
  SOCKET_CONNECTION_LIMITS,
  getMaxConnections,
  updateConnectionLimit,
  getAllConnectionLimits,
  resetToDefaults,
  isValidLimit
};