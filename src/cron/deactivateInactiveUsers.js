const moment = require("moment");
const userModel = require("../models/UserModel");
const userTypeModel = require("../models/UserTypeModel");
const StockTransaction = require("../models/StockTransactionModel");
const UserPosition = require("../models/UserPositionModel");

exports.deactivateNoActivityUsers = async () => {
    try {
        const levels = await userTypeModel.find({ level: { $in: [2, 3, 4, 5, 7] } }).select("_id").lean();
        const levelIds = levels.map((l) => l._id);
        const cutoff = moment().subtract(15, "days").toDate();

        const activeUsersList = await userModel
            .find({
                accountType: { $in: levelIds },
                status: true,
                deletedAt: null,
                createdAt: { $lt: cutoff }, // 🛡️ Ensure user is in system for at least 15 days
                $or: [{ demoid: { $ne: true } }, { demoid: { $exists: false } }],
            })
            .select("_id activatedAt createdAt")
            .lean();
        const activeUserIds = activeUsersList
            .filter((u) => {
                // If activated recently (within last 15 days), reset the clock and do not deactivate
                const isActivatedLongAgo = !u.activatedAt || (u.activatedAt && u.activatedAt < cutoff);
                return isActivatedLongAgo;
            })
            .map((u) => u._id);
        if (activeUserIds.length === 0) return { deactivated: 0 };

        const [tradedUserIds, positionUserIds] = await Promise.all([
            StockTransaction.distinct("userId", { userId: { $in: activeUserIds }, createdAt: { $gte: cutoff } }),
            UserPosition.aggregate([
                { $match: { userId: { $in: activeUserIds } } },
                { $match: { $expr: { $ne: ["$buyQuantity", "$sellQuantity"] } } },
                { $group: { _id: "$userId" } },
                { $project: { _id: 1 } },
            ]).then((rows) => rows.map((r) => r._id)),
        ]);

        const tradedSet = new Set(tradedUserIds.map((id) => id.toString()));
        const positionSet = new Set(positionUserIds.map((id) => id.toString()));
        const potentialToDeactivate = activeUserIds.filter(
            (id) => !tradedSet.has(id.toString()) && !positionSet.has(id.toString())
        );
        if (potentialToDeactivate.length === 0) return { deactivated: 0 };

        // 🛡️ Parent Exception: If a user has active downline users, do not deactivate that account.
        // We find all parent IDs of users who are currently status:true and are NOT in the deactivation list.
        const parentsOfActiveUsers = await userModel.distinct("parentIds", {
            _id: { $nin: potentialToDeactivate },
            status: true,
        });
        const parentSet = new Set(parentsOfActiveUsers.map((id) => id.toString()));

        // Filter out parents from the deactivation list
        const toDeactivate = potentialToDeactivate.filter(
            (id) => !parentSet.has(id.toString())
        );
        if (toDeactivate.length === 0) return { deactivated: 0 };

        await userModel.updateMany({ _id: { $in: toDeactivate } }, { status: false, activatedAt: null });
        console.log("deactivateNoActivityUsers: deactivated", toDeactivate.length, "users");
        return { deactivated: toDeactivate.length };
    } catch (error) {
        console.error("Error in deactivateNoActivityUsers:", error);
        throw error;
    }
};
