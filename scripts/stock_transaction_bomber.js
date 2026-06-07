/**
 * Stock Transaction Bomber
 * 
 * Creates random stock transactions for a user across all markets and scripts
 * 
 * Usage:
 *   node scripts/stock_transaction_bomber.js <accountCode>
 * 
 * Example:
 *   node scripts/stock_transaction_bomber.js ACC001
 */

require('dotenv').config();
const mongoose = require('mongoose');
const UserModel = require('../src/models/UserModel');
const UserTypeModel = require('../src/models/UserTypeModel');
const { MarketType, Script } = require('../src/models/MarketTypeModel');
const LotSettingModel = require('../src/models/LotSettingModel');
const WeekValanModel = require('../src/models/WeekValanModel');
const StockTransactionModel = require('../src/models/StockTransactionModel');
const { getSingleStockData } = require('../src/services/RedisService');
const moment = require('moment');

// Parse command line arguments
const args = process.argv.slice(2);
const accountCode = args[0];

if (!accountCode) {
  console.error('❌ Error: Account code is required');
  console.log('\nUsage:');
  console.log('  node scripts/stock_transaction_bomber.js <accountCode>');
  console.log('\nExample:');
  console.log('  node scripts/stock_transaction_bomber.js ACC001');
  process.exit(1);
}

// Helper: Get random element from array
const randomElement = (arr) => arr[Math.floor(Math.random() * arr.length)];

// Helper: Get random number between min and max
const randomBetween = (min, max) => Math.floor(Math.random() * (max - min + 1)) + min;

// Helper: Get random price with variation
const getRandomPrice = (basePrice, variationPercent = 2) => {
  const variation = basePrice * (variationPercent / 100);
  const randomVariation = (Math.random() * 2 - 1) * variation;
  return Number((basePrice + randomVariation).toFixed(2));
};

// Helper: Get current price from Redis or use fallback
async function getCurrentPrice(scriptId, fallbackPrice = 100) {
  try {
    const stockData = await getSingleStockData(scriptId);
    if (stockData) {
      const parsed = typeof stockData === 'string' ? JSON.parse(stockData) : stockData;
      const price = Number(parsed.SellPrice || parsed.Ltp || parsed.BuyPrice || fallbackPrice);
      return price > 0 ? price : fallbackPrice;
    }
    return fallbackPrice;
  } catch (err) {
    console.log(`⚠️  Could not fetch price for ${scriptId}, using fallback: ${fallbackPrice}`);
    return fallbackPrice;
  }
}

// Helper: Calculate brokerage and other transaction fields
function calculateTransactionFields(params) {
  const {
    quantity,
    price,
    lot,
    transactionType,
    brokerageRate = 0.02, // Default 0.02%
    isIntraday = true
  } = params;

  const totalOrderPrice = quantity * price;
  
  // Calculate brokerage
  const brokeragePercentage = brokerageRate;
  const netBrokerage = (totalOrderPrice * brokeragePercentage) / 100;
  const orderBrokerage = quantity > 0 ? netBrokerage / quantity : 0;

  // Calculate net price
  let netPrice, totalNetPrice;
  if (transactionType === 'BUY') {
    netPrice = price + orderBrokerage;
    totalNetPrice = netPrice * quantity;
  } else {
    netPrice = price - orderBrokerage;
    totalNetPrice = netPrice * quantity;
  }

  const m2mPrice = transactionType === 'BUY' 
    ? totalNetPrice 
    : totalNetPrice;

  return {
    orderPrice: Number(price.toFixed(4)),
    totalOrderPrice: Number(totalOrderPrice.toFixed(4)),
    netPrice: Number(netPrice.toFixed(4)),
    totalNetPrice: Number(totalNetPrice.toFixed(4)),
    orderBrokerage: Number(orderBrokerage.toFixed(4)),
    netBrokerage: Number(netBrokerage.toFixed(4)),
    brokeragePercentage: Number(brokeragePercentage.toFixed(4)),
    brokeragePercentageType: {
      intraday: isIntraday ? brokeragePercentage : 0,
      delivery: isIntraday ? 0 : brokeragePercentage
    },
    m2mPrice: Number(m2mPrice.toFixed(4)),
    brokerTotalBrokerage: 0,
    brokerTotalPercentage: 0,
    quantityType: {
      intraday: isIntraday ? quantity : 0,
      delivery: isIntraday ? 0 : quantity
    }
  };
}

// Helper: Get expiry string from label
function getExpiry(label) {
  if (!label) return 'NA';
  const parts = label.split(' ');
  if (parts.length > 1) {
    return parts[parts.length - 1].toUpperCase();
  }
  return 'NA';
}

async function bomberMain() {
  try {
    console.log('='.repeat(70));
    console.log('STOCK TRANSACTION BOMBER');
    console.log('='.repeat(70));
    console.log(`Account Code: ${accountCode}`);
    console.log('='.repeat(70));
    console.log();

    // Connect to database
    console.log('📡 Connecting to database...');
    await mongoose.connect(process.env.MONGODB_URI);
    console.log('✅ Connected successfully\n');

    // Step 1: Find user by account code
    console.log(`🔍 Finding user with account code: ${accountCode}...`);
    const user = await UserModel.findOne({ accountCode: accountCode })
      .select('_id accountName accountCode parentIds createdBy partnership')
      .lean();

    if (!user) {
      console.error(`❌ Error: User with account code ${accountCode} not found`);
      process.exit(1);
    }

    console.log(`✅ User found: ${user.accountName} (${user.accountCode})`);
    console.log(`   User ID: ${user._id}`);
    console.log();

    // Step 2: Get active valan
    console.log('📅 Fetching active valan...');
    const activeValan = await WeekValanModel.findOne({ status: true }).lean();
    if (!activeValan) {
      console.error('❌ Error: No active valan found');
      process.exit(1);
    }
    console.log(`✅ Active valan: ${activeValan.label}`);
    console.log(`   Start: ${moment(activeValan.startDate).format('YYYY-MM-DD')}`);
    console.log(`   End: ${moment(activeValan.endDate).format('YYYY-MM-DD')}`);
    console.log();

    // Step 3: Get all markets
    console.log('🏪 Fetching all markets...');
    const markets = await MarketType.find({})
      .populate('scripts')
      .lean();
    
    console.log(`✅ Found ${markets.length} active markets`);
    console.log();

    // Step 4: Process each market
    let totalTransactions = 0;
    const transactionSummary = [];

    for (const market of markets) {
      console.log('─'.repeat(70));
      console.log(`📊 Processing Market: ${market.market_type_name} (ID: ${market.market_type_id})`);
      console.log('─'.repeat(70));

      if (!market.scripts || market.scripts.length === 0) {
        console.log('⚠️  No scripts found for this market, skipping...\n');
        continue;
      }

      console.log(`   Found ${market.scripts.length} scripts in this market`);

      // Process each script in the market
      for (const script of market.scripts) {
        try {
          // Get lot settings for this script
          let lotSetting = await LotSettingModel.findOne({
            marketId: market.market_type_id,
            scriptId: script.script_id
          }).lean();

          // If no specific lot setting, use default quantity
          const lotQuantity = lotSetting?.quantity || script.lot_size || 1;

          // Determine which script IDs to use based on market
          let scriptIdsToProcess = [];
          
          if (market.market_type_id === '12') {
            // NSE-EQ: Use script.script_id directly (no expiries)
            scriptIdsToProcess.push({
              scriptId: script.script_id,
              label: script.script_name,
              expiry: 'NA'
            });
          } else if (market.market_type_id === '3') {
            // NOPT (Options): Use expiry.script_id with special label format
            // Format: SCRIPTNAME STRIKE OPTIONTYPE EXPIRY
            // Example: BANKNIFTY 55500 CE 28APR2026
            if (script.expiry && script.expiry.length > 0) {
              script.expiry.forEach(exp => {
                if (exp.script_id && exp.expiry_date && exp.expiry_date !== 'NA') {
                  const expiryLabel = moment(exp.expiry_date, ['DD-MM-YYYY', 'DDMMMYYYY', 'YYYY-MM-DD'])
                    .format('DDMMMYYYY')
                    .toUpperCase();
                  
                  // For NOPT, include strike and option_type in label
                  const strike = script.strike || '';
                  const optionType = script.option_type || '';
                  const label = strike && optionType 
                    ? `${script.script_name} ${strike} ${optionType} ${expiryLabel}`
                    : `${script.script_name} ${expiryLabel}`;
                  
                  scriptIdsToProcess.push({
                    scriptId: exp.script_id,
                    label: label,
                    expiry: expiryLabel
                  });
                }
              });
            } else {
              // Fallback: use main script_id if no expiries
              scriptIdsToProcess.push({
                scriptId: script.script_id,
                label: script.script_name,
                expiry: 'NA'
              });
            }
          } else {
            // Other markets: Use expiry.script_id for each expiry
            if (script.expiry && script.expiry.length > 0) {
              script.expiry.forEach(exp => {
                if (exp.script_id && exp.expiry_date && exp.expiry_date !== 'NA') {
                  const expiryLabel = moment(exp.expiry_date, ['DD-MM-YYYY', 'DDMMMYYYY', 'YYYY-MM-DD'])
                    .format('DDMMMYYYY')
                    .toUpperCase();
                  
                  scriptIdsToProcess.push({
                    scriptId: exp.script_id,
                    label: `${script.script_name} ${expiryLabel}`,
                    expiry: expiryLabel
                  });
                }
              });
            } else {
              // Fallback: use main script_id if no expiries
              scriptIdsToProcess.push({
                scriptId: script.script_id,
                label: script.script_name,
                expiry: 'NA'
              });
            }
          }

          // Create transactions for each script/expiry
          for (const scriptInfo of scriptIdsToProcess) {
            // Get current price
            const basePrice = await getCurrentPrice(scriptInfo.scriptId, 100);

            // Generate 3-5 transactions (mix of BUY/SELL and some PENDING)
            const numTransactions = randomBetween(3, 5);
            const numCompleted = randomBetween(2, 3); // 2-3 completed
            const numPending = numTransactions - numCompleted; // Rest are pending

            for (let i = 0; i < numTransactions; i++) {
              const isPending = i >= numCompleted;
              const transactionType = randomElement(['BUY', 'SELL']);
              const isIntraday = Math.random() > 0.3; // 70% intraday, 30% delivery

              // Random lot (1-5 lots)
              const lots = randomBetween(1, 5);
              const quantity = lots * lotQuantity;

              // Price variation
              const price = isPending 
                ? getRandomPrice(basePrice, 5) // More variation for pending orders
                : getRandomPrice(basePrice, 2); // Less variation for completed

              // Calculate transaction fields
              const calcFields = calculateTransactionFields({
                quantity,
                price,
                lot: lots,
                transactionType,
                brokerageRate: 0.02,
                isIntraday
              });

              // Determine order type and status
              let orderType, transactionStatus, shortmsg, tradePosition;
              
              if (isPending) {
                // Pending orders: Limit only (STOPLOSS is not in the enum)
                orderType = 'LIMIT';
                transactionStatus = 'PENDING';
                
                // Determine if it's a stop loss based on price vs market
                const isStopLoss = transactionType === 'BUY' 
                  ? price > basePrice 
                  : price < basePrice;
                
                shortmsg = isStopLoss 
                  ? (transactionType === 'BUY' ? 'Buy stop loss' : 'Sell stop loss')
                  : (transactionType === 'BUY' ? 'Buy limit' : 'Sell limit');
                
                // Trade position for pending orders
                tradePosition = transactionType === 'BUY'
                  ? (price < basePrice ? 'DOWN' : 'UP')
                  : (price < basePrice ? 'DOWN' : 'UP');
              } else {
                // Completed orders: Market
                orderType = 'Market';
                transactionStatus = 'COMPLETED';
                shortmsg = 'Market';
                tradePosition = 'NRM';
              }

              // Create transaction document
              const transaction = {
                userId: user._id,
                valanId: activeValan._id,
                marketId: market.market_type_id,
                marketName: market.market_type_name,
                scriptId: scriptInfo.scriptId,
                scriptName: script.script_name,
                label: scriptInfo.label,
                expiry: scriptInfo.expiry,
                lot: lots,
                quantity: quantity,
                ...calcFields,
                type: 'NRM',
                transactionType: transactionType,
                transactionStatus: transactionStatus,
                orderType: orderType,
                tradePosition: tradePosition,
                ip: '127.0.0.1',
                userAgent: 'Stock Transaction Bomber Script',
                message: `Stock ${transactionType.toLowerCase()} ${transactionStatus.toLowerCase()}`,
                shortmsg: shortmsg,
                parentIds: user.parentIds || [],
                myParent: user.createdBy?.userId || null,
                brokerIds: [],
                partnership: user.partnership || [],
                minPercentageWiseBrokerage: [],
                minLotWiseBrokerage: [],
                otherBrokerage: {},
                isExitPosition: false,
                createdBy: user._id,
                createdAt: new Date()
              };

              // Save transaction
              await StockTransactionModel.create(transaction);
              totalTransactions++;

              console.log(`   ✓ ${transactionStatus} ${transactionType} ${scriptInfo.label}: ${quantity} qty @ ₹${price} (${orderType})`);
            }

            transactionSummary.push({
              market: market.market_type_name,
              script: scriptInfo.label,
              transactions: numTransactions
            });
          }

        } catch (scriptError) {
          console.error(`   ❌ Error processing script ${script.script_name}:`, scriptError.message);
        }
      }

      console.log();
    }

    // Final summary
    console.log('='.repeat(70));
    console.log('BOMBING COMPLETE! 💥');
    console.log('='.repeat(70));
    console.log(`Total Transactions Created: ${totalTransactions}`);
    console.log();
    console.log('Summary by Market:');
    
    const marketSummary = {};
    transactionSummary.forEach(item => {
      if (!marketSummary[item.market]) {
        marketSummary[item.market] = 0;
      }
      marketSummary[item.market] += item.transactions;
    });

    Object.keys(marketSummary).forEach(market => {
      console.log(`   ${market}: ${marketSummary[market]} transactions`);
    });

    console.log();
    console.log('✅ All transactions have been created successfully!');
    console.log('='.repeat(70));
    console.log();
    
    // Generate MongoDB delete commands
    console.log('📝 MONGODB DELETE COMMANDS');
    console.log('='.repeat(70));
    console.log();
    console.log('To delete all transactions created by this script for this user:');
    console.log();
    console.log('// Delete by User ID and UserAgent');
    console.log(`db.stock_transactions.deleteMany({`);
    console.log(`  userId: ObjectId("${user._id}"),`);
    console.log(`  userAgent: "Stock Transaction Bomber Script"`);
    console.log(`});`);
    console.log();
    console.log('// Delete by User ID and Time Range (last 5 minutes)');
    const fiveMinutesAgo = new Date(Date.now() - 5 * 60 * 1000);
    console.log(`db.stock_transactions.deleteMany({`);
    console.log(`  userId: ObjectId("${user._id}"),`);
    console.log(`  createdAt: { $gte: ISODate("${fiveMinutesAgo.toISOString()}") }`);
    console.log(`});`);
    console.log();
    console.log('// Delete by User ID and Valan');
    console.log(`db.stock_transactions.deleteMany({`);
    console.log(`  userId: ObjectId("${user._id}"),`);
    console.log(`  valanId: ObjectId("${activeValan._id}")`);
    console.log(`});`);
    console.log();
    console.log('// Delete by User ID, Valan, and Time Range (today)');
    const startOfToday = moment().startOf('day').toDate();
    const endOfToday = moment().endOf('day').toDate();
    console.log(`db.stock_transactions.deleteMany({`);
    console.log(`  userId: ObjectId("${user._id}"),`);
    console.log(`  valanId: ObjectId("${activeValan._id}"),`);
    console.log(`  createdAt: {`);
    console.log(`    $gte: ISODate("${startOfToday.toISOString()}"),`);
    console.log(`    $lte: ISODate("${endOfToday.toISOString()}")`);
    console.log(`  }`);
    console.log(`});`);
    console.log();
    console.log('// Count transactions before deleting');
    console.log(`db.stock_transactions.countDocuments({`);
    console.log(`  userId: ObjectId("${user._id}"),`);
    console.log(`  userAgent: "Stock Transaction Bomber Script"`);
    console.log(`});`);
    console.log();
    console.log('='.repeat(70));

  } catch (error) {
    console.error('\n❌ Error during bombing:', error.message);
    console.error(error.stack);
    process.exit(1);
  } finally {
    await mongoose.connection.close();
    console.log('\n📡 Database connection closed');
  }
}

// Run the bomber
bomberMain();
