const mongoose = require('mongoose');
require('dotenv').config();

// Import models and services
const UserModel = require('../src/models/UserModel');
const WeekValanModel = require('../src/models/WeekValanModel');
const { setBrokerageRefresh } = require('../src/controllers/ReportController');

// Database connection
const connectDB = async () => {
  try {
    await mongoose.connect(process.env.MONGO_URI, {
      useNewUrlParser: true,
      useUnifiedTopology: true,
    });
    console.log('MongoDB connected successfully');
  } catch (error) {
    console.error('MongoDB connection error:', error);
    process.exit(1);
  }
};

// Get current active valan
const getCurrentValan = async () => {
  try {
    const currentDate = new Date();
    const valan = await WeekValanModel.findOne({
      startDate: { $lte: currentDate },
      endDate: { $gte: currentDate }
    }).lean();
    
    if (!valan) {
      throw new Error('No active valan found');
    }
    
    return valan;
  } catch (error) {
    console.error('Error fetching current valan:', error);
    throw error;
  }
};

// Main function to refresh brokerage for all level 7 users
const refreshBrokerageForAllLevel7Users = async () => {
  try {
    console.log('Starting brokerage refresh for all level 7 users...\n');
    
    // Get all level 7 users
    const level7Users = await UserModel.find({
      'accountType.level': 7,
      status: 1 // Only active users
    })
    .select({
      _id: 1,
      accountName: 1,
      accountCode: 1,
      marketAccess: 1
    })
    .lean();
    
    if (!level7Users || level7Users.length === 0) {
      console.log('No level 7 users found');
      return;
    }
    
    console.log(`Found ${level7Users.length} level 7 users\n`);
    
    // Get current valan
    const currentValan = await getCurrentValan();
    console.log(`Current Valan: ${currentValan.label} (${currentValan._id})\n`);
    
    let totalProcessed = 0;
    let totalSuccess = 0;
    let totalFailed = 0;
    
    // Process each user
    for (const user of level7Users) {
      console.log(`\n${'='.repeat(60)}`);
      console.log(`Processing User: ${user.accountName} (${user.accountCode})`);
      console.log(`User ID: ${user._id}`);
      console.log(`${'='.repeat(60)}`);
      
      // Get all market IDs from user's market access
      const marketIds = user.marketAccess
        .filter(market => market.marketId) // Ensure marketId exists
        .map(market => market.marketId);
      
      if (marketIds.length === 0) {
        console.log('  ⚠️  No market access found for this user');
        continue;
      }
      
      console.log(`  Markets to process: ${marketIds.join(', ')}\n`);
      
      // Process each market for this user
      for (const marketId of marketIds) {
        totalProcessed++;
        
        try {
          // Create mock request and response objects
          const mockReq = {
            body: {
              userId: user._id.toString(),
              marketId: marketId,
              valanId: currentValan._id.toString()
            },
            user: {
              userId: user._id.toString() // Assuming system user
            },
            ip: '127.0.0.1'
          };
          
          const mockRes = {
            status: function(code) {
              this.statusCode = code;
              return this;
            },
            json: function(data) {
              this.data = data;
              return this;
            }
          };
          
          console.log(`  Processing Market ID: ${marketId}...`);
          
          // Call the brokerage refresh function
          await setBrokerageRefresh(mockReq, mockRes);
          
          if (mockRes.statusCode === 200 && mockRes.data?.status === 'true') {
            console.log(`  ✅ Success: ${mockRes.data.message}`);
            totalSuccess++;
          } else {
            console.log(`  ❌ Failed: ${mockRes.data?.message || 'Unknown error'}`);
            totalFailed++;
          }
          
          // Add a small delay to avoid overwhelming the database
          await new Promise(resolve => setTimeout(resolve, 100));
          
        } catch (error) {
          console.log(`  ❌ Error: ${error.message}`);
          totalFailed++;
        }
      }
    }
    
    // Summary
    console.log(`\n${'='.repeat(60)}`);
    console.log('SUMMARY');
    console.log(`${'='.repeat(60)}`);
    console.log(`Total Users Processed: ${level7Users.length}`);
    console.log(`Total Market Refreshes Attempted: ${totalProcessed}`);
    console.log(`Successful: ${totalSuccess}`);
    console.log(`Failed: ${totalFailed}`);
    console.log(`${'='.repeat(60)}\n`);
    
  } catch (error) {
    console.error('Error in main function:', error);
    throw error;
  }
};

// Run the script
const run = async () => {
  try {
    await connectDB();
    await refreshBrokerageForAllLevel7Users();
    console.log('\n✅ Script completed successfully');
    process.exit(0);
  } catch (error) {
    console.error('\n❌ Script failed:', error);
    process.exit(1);
  }
};

run();
