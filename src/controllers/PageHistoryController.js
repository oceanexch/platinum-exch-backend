const PageHistoryService = require("../services/PageHistoryService");
const UserService = require("../services/UserService");
const { getLoginUserId } = require("../utils/contextHelpers");

/**
 * Add a page history record
 */
exports.addPageHistory = async (req, res) => {
    try {
        const requesterId = getLoginUserId(req);
        const { userId, page } = req.body;
        const ipAddress =
            req.headers['x-forwarded-for']?.split(',')[0] ||
            req.socket.remoteAddress;
        const targetUserId = userId || requesterId;
        if (!targetUserId || !page) {
            res.status(400).json({ status: false, message: "Perameter missing" });
        }
        const data = {
            userId: targetUserId,
            page,
            ip: ipAddress || null,
            time: new Date()
        };

        const record = await PageHistoryService.savePageRecord(data);
        res.status(200).json({ status: true, data: record });
    } catch (error) {
        console.error("addPageHistory Error:", error);
        res.status(500).json({ status: false, message: error.message });
    }
};

/**
 * Get page history for a user
 */
exports.getPageHistory = async (req, res) => {
    try {
        const { userId, page, limit } = req.body;

        if (!userId) {
            return res.status(400).json({ status: false, message: "userId is required" });
        }

        const { history, pagination } = await PageHistoryService.getPageHistoryByUserId(userId, page, limit);
        const user = await UserService.getUserById(userId);

        res.status(200).json({
            status: true,
            data: {
                user,
                history,
                pagination
            }
        });
    } catch (error) {
        console.error("getPageHistory Error:", error);
        res.status(500).json({ status: false, message: error.message });
    }
};
