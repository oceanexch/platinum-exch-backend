const TeleChatUser = require("../models/TeleChatUserModel");

/**
 * Add a user to the tele chat list.
 * @param {string} userId - The ID of the user to add.
 * @returns {Promise<Object>} The created document.
 */
exports.addTeleChatUser = async (userId) => {
    const existing = await TeleChatUser.findOne({ userId });
    if (existing) {
        throw new Error("User already added to tele-chat");
    }
    return await TeleChatUser.create({ userId });
};

/**
 * Remove a user from the tele chat list.
 * @param {string} userId - The ID of the user to remove.
 * @returns {Promise<Object>} The result of the deletion.
 */
exports.deleteTeleChatUser = async (userId) => {
    const result = await TeleChatUser.deleteOne({ userId });
    if (result.deletedCount === 0) {
        throw new Error("User not found in tele-chat");
    }
    return result;
};

/**
 * List all users in the tele chat list.
 * @returns {Promise<Array>} List of users with populated details and balances.
 */
exports.getTeleChatUsers = async () => {
    const teleUsers = await TeleChatUser.find()
        .populate({
            path: "userId",
            select: "-basicDetails -marketAccess -accountDetails",
            populate: { path: "accountType", select: "level label" }
        })
        .lean();

    if (!teleUsers.length) return [];

    const balanceService = require("./Balanceservice");
    const userIds = teleUsers.map(tu => tu.userId?._id).filter(id => id);

    if (!userIds.length) return teleUsers;

    const balances = await balanceService.computeCombinedBalances(userIds.map(id => String(id)));
    const balMap = new Map(balances.map(b => [String(b.userId), b]));

    return teleUsers.map(tu => {
        if (!tu.userId) return tu;
            const idStr = String(tu.userId._id);
            const b = balMap.get(idStr) || { cash: 0, jv: 0, ledger: 0, balance: 0 };
            return {
                ...tu,
                balance: b.cash,
                breakdown: { cash: b.cash, jv: b.jv, ledger: b.ledger },
            };
        });
};
