/**
 * Script to refresh positions for all Level 7 (Client) users
 * 
 * This script:
 * 1. Finds all active Level 7 users
 * 2. For each user, aggregates their open positions from StockTransaction
 * 3. Recalculates positions using setUserPosition for markets they have access to
 * 
 * Uses the same aggregation logic as intradaySquareOff and weeklySquareOff
 * 
 * Usage: node scripts/refreshAllLevel7Positions.js [valanId]
 */

require('dotenv').config();
const mongoose = require('mongoose');
const User = require('../src/models/UserModel');
const UserType = require('../src/models/UserTypeModel');
const StockTransaction = require('../src/models/StockTransactionModel');
const { setUserPosition, getActiveWeekValan } = require('../src/services/StockService');

// Connect to database
const connectDB = async () => {
  try {
    await mongoose.connect(process.env.MONGODB_URI);
    console.log('✅ MongoDB Connected');
  } catch (error) {
    console.error('❌ MongoDB Connection Error:', error);
    process.exit(1);
  }
};

/**
 * Get all Level 7 users with their market access
 */
const getLevel7Users = async () => {
  try {
    // Find Level 7 user type
    const level7Type = await UserType.findOne({ level: 7 }).lean();
    
    if (!level7Type) {
      throw new Error('Level 7 user type not found in database');
    }

    console.log(`📋 Found Level 7 type: ${level7Type.name} (${level7Type.label})`);

    // Find all active Level 7 users
    const users = await User.find({
      accountType: level7Type._id,
      status: true,
      isDeleted: false
    })
    .select('_id accountName accountCode marketAccess')
    .lean();

    console.log(`👥 Found ${users.length} active Level 7 users`);
    return users;
  } catch (error) {
    console.error('Error fetching Level 7 users:', error);
    throw error;
  }
};

/**
 * Get user's accessible market IDs
 */
const getUserMarketIds = (user) => {
  if (!user.marketAccess || user.marketAccess.length === 0) {
    return [];
  }

  return user.marketAccess
    .filter(market => market.isSelected)
    .map(market => market.marketId);
};

/**
 * Get user positions by aggregating from StockTransaction
 * This matches the logic used in intradaySquareOff and weeklySquareOff
 */
const getUserPositionsFromTransactions = async (userId, valanId, marketIds) => {
  try {
    const matchStage = {
      userId: new mongoose.Types.ObjectId(userId),
      valanId: new mongoose.Types.ObjectId(valanId),
      transactionStatus: "COMPLETED"
    };

    // Filter by accessible markets if provided
    if (marketIds && marketIds.length > 0) {
      matchStage.marketId = { $in: marketIds };
    }

    const pipeline = [
      {
        $match: matchStage
      },
      {
        $sort: { createdAt: 1 }
      },
      {
        $group: {
          _id: {
            userId: "$userId",
            scriptId: "$scriptId",
            marketId: "$marketId",
            valanId: "$valanId"
          },
          marketName: { $first: "$marketName" },
          scriptName: { $first: "$scriptName" },
          label: { $first: "$label" },
          buyQuantity: {
            $sum: {
              $cond: [{ $eq: ["$transactionType", "BUY"] }, "$quantity", 0]
            }
          },
          sellQuantity: {
            $sum: {
              $cond: [{ $eq: ["$transactionType", "SELL"] }, "$quantity", 0]
            }
          },
          buyLot: {
            $sum: { $cond: [{ $eq: ["$transactionType", "BUY"] }, "$lot", 0] }
          },
          sellLot: {
            $sum: { $cond: [{ $eq: ["$transactionType", "SELL"] }, "$lot", 0] }
          }
        }
      },
      {
        $match: {
          $expr: { $ne: ["$buyQuantity", "$sellQuantity"] }
        }
      }
    ];

    return await StockTransaction.aggregate(pipeline);
  } catch (error) {
    console.error('Error aggregating positions from transactions:', error);
    throw error;
  }
};

/**
 * Refresh positions for a single user
 */
const refreshUserPositions = async (user, valanId, stats) => {
  try {
    const marketIds = getUserMarketIds(user);
    
    if (marketIds.length === 0) {
      console.log(`  ⚠️  ${user.accountName} (${user.accountCode}) - No market access`);
      stats.noMarketAccess++;
      return;
    }

    // Aggregate positions directly from StockTransaction (like intradaySquareOff/weeklySquareOff)
    const positions = await getUserPositionsFromTransactions(user._id, valanId, marketIds);

    if (positions.length === 0) {
      console.log(`  ℹ️  ${user.accountName} (${user.accountCode}) - No open positions`);
      stats.noPositions++;
      return;
    }

    console.log(`  🔄 ${user.accountName} (${user.accountCode}) - Processing ${positions.length} open positions in ${marketIds.length} markets`);

    let successCount = 0;
    let errorCount = 0;

    // Process each unique script position
    for (const pos of positions) {
      const scriptId = pos._id.scriptId;
      const netQty = pos.buyQuantity - pos.sellQuantity;
      
      try {
        await setUserPosition(user._id, scriptId, valanId, false);
        successCount++;
        
        // Optional: Log position details
        if (process.env.VERBOSE === 'true') {
          console.log(`    ✓ ${pos.scriptName} - Net: ${netQty > 0 ? '+' : ''}${netQty}`);
        }
      } catch (error) {
        console.error(`    ❌ Error updating position for script ${scriptId} (${pos.scriptName}):`, error.message);
        errorCount++;
      }
    }

    console.log(`  ✅ ${user.accountName} - Updated ${successCount} positions${errorCount > 0 ? `, ${errorCount} errors` : ''}`);
    
    stats.usersProcessed++;
    stats.positionsUpdated += successCount;
    stats.errors += errorCount;

  } catch (error) {
    console.error(`  ❌ Error processing user ${user.accountName}:`, error.message);
    stats.userErrors++;
  }
};

/**
 * Main execution function
 */
const refreshAllLevel7Positions = async (valanId = null) => {
  try {
    console.log('\n🚀 Starting Level 7 Position Refresh\n');
    console.log('='.repeat(60));

    // Get current valan if not provided
    if (!valanId) {
      const currentValan = await getActiveWeekValan();
      if (!currentValan) {
        throw new Error('No active valan found and no valanId provided');
      }
      valanId = currentValan._id;
      console.log(`📅 Using active valan: ${currentValan.valanName} (${valanId})`);
    } else {
      console.log(`📅 Using provided valanId: ${valanId}`);
    }

    // Get all Level 7 users
    const users = await getLevel7Users();

    if (users.length === 0) {
      console.log('\n⚠️  No Level 7 users found');
      return;
    }

    // Statistics
    const stats = {
      usersProcessed: 0,
      positionsUpdated: 0,
      noMarketAccess: 0,
      noPositions: 0,
      errors: 0,
      userErrors: 0
    };

    console.log('\n📊 Processing users...\n');

    // Process each user
    for (let i = 0; i < users.length; i++) {
      const user = users[i];
      console.log(`[${i + 1}/${users.length}]`);
      await refreshUserPositions(user, valanId, stats);
    }

    // Print summary
    console.log('\n' + '='.repeat(60));
    console.log('📈 SUMMARY');
    console.log('='.repeat(60));
    console.log(`Total Level 7 Users:           ${users.length}`);
    console.log(`Users Processed:               ${stats.usersProcessed}`);
    console.log(`Positions Updated:             ${stats.positionsUpdated}`);
    console.log(`Users with No Market Access:   ${stats.noMarketAccess}`);
    console.log(`Users with No Positions:       ${stats.noPositions}`);
    console.log(`Position Update Errors:        ${stats.errors}`);
    console.log(`User Processing Errors:        ${stats.userErrors}`);
    console.log('='.repeat(60));

    if (stats.usersProcessed > 0) {
      console.log('\n✅ Position refresh completed successfully!');
    } else {
      console.log('\n⚠️  No positions were updated');
    }

  } catch (error) {
    console.error('\n❌ Fatal error:', error);
    throw error;
  }
};

// Run the script
if (require.main === module) {
  (async () => {
    try {
      await connectDB();
      
      // Get valanId from command line argument if provided
      const valanId = process.argv[2] || null;
      
      await refreshAllLevel7Positions(valanId);
      
      console.log('\n👋 Disconnecting from database...');
      await mongoose.connection.close();
      console.log('✅ Done!\n');
      process.exit(0);
    } catch (error) {
      console.error('\n💥 Script failed:', error);
      await mongoose.connection.close();
      process.exit(1);
    }
  })();
}

module.exports = { refreshAllLevel7Positions };
