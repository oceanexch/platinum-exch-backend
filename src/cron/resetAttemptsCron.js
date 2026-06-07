const userModel = require("../models/UserModel");

/**
 * Resets loginAttempts and rejectionAttempts for all active users.
 * This is scheduled to run daily at 1:00 AM.
 * It specifically avoids changing the user's status.
 */
exports.resetUserAttempts = async () => {
    try {
        console.log("--------------------------------------------------");
        console.log("Reset User Attempts Cron started:", new Date().toLocaleString());
        
        // Reset counters for all users who are not deleted
        const result = await userModel.updateMany(
            { isDeleted: false },
            { 
                $set: { 
                    loginAttempts: 0, 
                    rejectionAttempts: 0 
                } 
            }
        );

        console.log(`Reset successful. Users updated: ${result.modifiedCount || result.nModified || 0}`);
        console.log("Reset User Attempts Cron finished.");
        console.log("--------------------------------------------------");
        
        return result;
    } catch (error) {
        console.error("Error in resetUserAttempts cron job:", error);
        throw error;
    }
};
