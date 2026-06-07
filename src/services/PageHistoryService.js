const PageHistory = require("../models/PageHistoryModel");
const mongoose = require("mongoose");

/**
 * Save a new page history record
 * @param {Object} data - { userId, page, ip, time }
 */
exports.savePageRecord = async (data) => {
    try {
        const record = new PageHistory({
            ...data,
            time: data.time || new Date()
        });
        return await record.save();
    } catch (error) {
        console.error("Error saving page history record:", error);
        throw error;
    }
};

/**
 * Get page history for a specific user
 * @param {String} userId 
 */
exports.getPageHistoryByUserId = async (userId, page = 1, limit = 10) => {
    try {
        page = parseInt(page) || 1;
        limit = parseInt(limit) || 10;
        const skip = (page - 1) * limit;

        const totalDocs = await PageHistory.countDocuments({ userId: new mongoose.Types.ObjectId(userId) });

        const history = await PageHistory.find({ userId: new mongoose.Types.ObjectId(userId) })
            .sort({ time: -1 })
            .skip(skip)
            .limit(limit)
            .lean();

        return {
            history,
            pagination: {
                total: totalDocs,
                page,
                limit,
                totalPages: Math.ceil(totalDocs / limit)
            }
        };
    } catch (error) {
        console.error("Error fetching page history records:", error);
        throw error;
    }
};
