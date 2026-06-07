/**
 * Multi-Login Context Helpers
 * 
 * These utilities ensure correct identity usage throughout the application.
 * 
 * CRITICAL RULES:
 * - Use getEffectiveUserId() for: hierarchy queries, partnership, brokerage, M2M, ledger
 * - Use getLoginUserId() for: audit logs, modifiedBy, createdBy, placedBy, deletedBy
 * 
 * WHY THIS MATTERS:
 * - effectiveUserId = whose business data we're operating on
 * - loginUserId = who actually performed the action (for audit trail)
 * 
 * When an ML account logs in:
 * - loginUserId = ML account's ID
 * - effectiveUserId = target admin's ID
 * 
 * This separation prevents hierarchy corruption while maintaining audit integrity.
 */

/**
 * Get the user ID for hierarchy/business operations
 * 
 * Use this for:
 * - Downline queries: { parentIds: getEffectiveUserId(req) }
 * - Partnership calculations
 * - Brokerage calculations
 * - M2M calculations
 * - Ledger operations
 * - Position queries
 * - Market access checks
 * 
 * @param {Object} req - Express request object
 * @returns {ObjectId|string} The effective user ID
 */
const getEffectiveUserId = (req) => {
    // Priority: req.context (ML-aware) > req.user._id > req.user.userId (legacy)
    return req.context?.effectiveUserId || req.user?._id || req.user?.userId;
};

/**
 * Get the user ID for audit/logging operations
 * 
 * Use this for:
 * - modifiedBy: getLoginUserId(req)
 * - createdBy: getLoginUserId(req)
 * - placedBy: getLoginUserId(req)
 * - deletedBy: getLoginUserId(req)
 * - Activity logs
 * - Security monitoring
 * 
 * @param {Object} req - Express request object
 * @returns {ObjectId|string} The login user ID
 */
const getLoginUserId = (req) => {
    // Priority: req.context (ML-aware) > req.user._id > req.user.userId (legacy)
    return req.context?.loginUserId || req.user?._id || req.user?.userId;
};

/**
 * Check if current request is from an ML account
 * 
 * Use this to:
 * - Show ML indicator in UI
 * - Add extra logging for ML actions
 * - Apply ML-specific business rules
 * 
 * @param {Object} req - Express request object
 * @returns {boolean} True if ML account, false otherwise
 */
const isMultiLoginRequest = (req) => {
    return req.context?.isMultiLogin || false;
};

/**
 * Check if current user is a demo account
 * 
 * @param {Object} req - Express request object
 * @returns {boolean} True if demo user, false otherwise
 */
const isDemoUser = (req) => {
    return req.context?.isDemo || false;
};

/**
 * Get full audit context for comprehensive logging
 * 
 * Use this for:
 * - Activity logs
 * - Security audit trails
 * - Compliance reporting
 * - Debugging ML issues
 * 
 * @param {Object} req - Express request object
 * @returns {Object} Complete audit context
 */
const getAuditContext = (req) => {
    return {
        loginUserId: getLoginUserId(req),
        effectiveUserId: getEffectiveUserId(req),
        isMultiLogin: isMultiLoginRequest(req),
        loginAccountName: req.context?.loginAccountName || req.user?.accountName || 'unknown',
        ip: req.ip?.replace('::ffff:', '') || 'unknown',
        timestamp: new Date(),
        userAgent: req.headers['user-agent'] || 'unknown',
    };
};

/**
 * Validate ML account permissions
 * 
 * Use this to check if ML account has permission for specific actions
 * 
 * @param {Object} req - Express request object
 * @param {string} requiredPermission - Permission to check (e.g., 'trade', 'user_management')
 * @returns {boolean} True if permitted, false otherwise
 */
const hasMLPermission = (req, requiredPermission) => {
    if (!isMultiLoginRequest(req)) {
        return true; // Normal accounts have full permissions
    }

    const menuPrivileges = req.user?.menuPrivileges || [];

    // 'all' means full access
    if (menuPrivileges.includes('all')) {
        return true;
    }

    // Check if specific permission is granted
    return menuPrivileges.includes(requiredPermission);
};

/**
 * Create audit log entry with ML context
 * 
 * Helper to standardize audit logging across the application
 * 
 * @param {Object} req - Express request object
 * @param {string} action - Action performed (e.g., 'PLACE_TRADE', 'BLOCK_SCRIPT')
 * @param {Object} details - Additional details about the action
 * @returns {Object} Formatted audit log entry
 */
const createAuditLogEntry = (req, action, details = {}) => {
    const context = getAuditContext(req);

    return {
        action,
        loginUserId: context.loginUserId,
        effectiveUserId: context.effectiveUserId,
        isMultiLogin: context.isMultiLogin,
        loginAccountName: context.loginAccountName,
        ip: context.ip,
        userAgent: context.userAgent,
        timestamp: context.timestamp,
        ...details,
    };
};

/**
 * Get user context for database operations
 * 
 * Returns both IDs for operations that need both
 * (e.g., creating a trade that needs both ownership and audit trail)
 * 
 * @param {Object} req - Express request object
 * @returns {Object} Object with both user IDs
 */
const getUserContext = (req) => {
    return {
        effectiveUserId: getEffectiveUserId(req),
        loginUserId: getLoginUserId(req),
        isMultiLogin: isMultiLoginRequest(req),
    };
};

module.exports = {
    getEffectiveUserId,
    getLoginUserId,
    isMultiLoginRequest,
    isDemoUser,
    getAuditContext,
    hasMLPermission,
    createAuditLogEntry,
    getUserContext,
};
