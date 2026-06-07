const { BROKER_ACCESSIBLE_URLS } = require('../config/config');

/**
 * Middleware to check if broker (level 6) is accessing allowed endpoints
 * Brokers can only view data (read-only) for users who have them in brokerPartnership
 * They cannot modify anything
 */
const checkBrokerAccess = (req, res, next) => {
  try {
    const userLevel = req.user?.accountType?.level;

    // Only apply restrictions to level 6 (brokers)
    if (userLevel !== 6) {
      return next();
    }

    const requestPath = req.originalUrl.split('?')[0]; // Get path without query params
    // console.log('[checkBrokerAccess] requestPath:', requestPath);
    // console.log('[checkBrokerAccess] req.baseUrl:', req.baseUrl);
    // console.log('[checkBrokerAccess] req.path:', req.path);
    
    // Construct full path
    const fullPath = req.baseUrl + req.path;
    // console.log('[checkBrokerAccess] fullPath:', fullPath);
    
    const requestMethod = req.method;

    // Check if the URL is in the allowed list
    const isAllowedUrl = BROKER_ACCESSIBLE_URLS.some(allowedUrl => {
      // Direct match
      if (fullPath === allowedUrl || requestPath === allowedUrl) return true;
      
      // Handle parameterized routes like /getLedgerList/:userId
      if (allowedUrl.includes(':')) {
        const pattern = allowedUrl.replace(/:\w+/g, '[^/?]+');
        const regex = new RegExp(`^${pattern}(/|$)`);
        const matches = regex.test(fullPath) || regex.test(requestPath);
        if (matches) {
          // console.log('[checkBrokerAccess] Matched parameterized route:', allowedUrl);
        }
        return matches;
      }
      
      // Check if path starts with allowed URL
      return fullPath.startsWith(allowedUrl) || requestPath.startsWith(allowedUrl);
    });
    // console.log('[checkBrokerAccess] isAllowedUrl:', isAllowedUrl);

    if (!isAllowedUrl) {
      return res.status(403).json({
        status: false,
        message: 'Access denied. Brokers can only access specific view-only endpoints.'
      });
    }

    // Brokers can only perform GET/POST for viewing data, no PUT/DELETE/PATCH
    const allowedMethods = ['GET', 'POST'];
    if (!allowedMethods.includes(requestMethod)) {
      return res.status(403).json({
        status: false,
        message: 'Access denied. Brokers can only view data, not modify it.'
      });
    }

    next();
  } catch (error) {
    console.error('checkBrokerAccess middleware error:', error);
    return res.status(500).json({
      status: false,
      message: 'Error checking broker access permissions'
    });
  }
};

module.exports = checkBrokerAccess;
