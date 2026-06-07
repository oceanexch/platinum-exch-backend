# Stock Transaction Bomber Script

## Overview

This script creates random stock transactions for a specific user across all markets and scripts. It's useful for testing, demo data generation, or populating a user's trading history.

## Features

- ✅ Creates transactions across **all active markets**
- ✅ Processes **all scripts** in each market
- ✅ Handles **multiple expiries** for futures/options
- ✅ Generates **3-5 transactions per script** (mix of BUY/SELL)
- ✅ Creates both **COMPLETED** (2-3) and **PENDING** (1-2) orders
- ✅ Uses **live prices from Redis** with random variations
- ✅ Respects **lot settings** from database
- ✅ Calculates **brokerage and all transaction fields** accurately
- ✅ Supports **Market, Limit, and Stop Loss** order types

## Usage

### Basic Usage

```bash
node scripts/stock_transaction_bomber.js <accountCode>
```

### Example

```bash
node scripts/stock_transaction_bomber.js ACC001
```

## Parameters

- **accountCode** (required): The account code of the user for whom transactions will be created

## What the Script Does

### Step 1: User Validation
- Finds the user by account code
- Validates user exists in the database
- Displays user information (name, ID, level)

### Step 2: Valan Check
- Fetches the currently active valan (trading week)
- All transactions are created within this valan
- Displays valan details (label, start date, end date)

### Step 3: Market Processing
- Fetches all active markets from the database
- Processes each market sequentially
- Displays progress for each market

### Step 4: Script Processing
For each script in each market:

1. **Lot Settings**: Fetches lot quantity from `LotSettingModel`
2. **Expiry Handling**:
   - **NSE-EQ (Market 12)**: Uses `script.script_id` directly (no expiries)
   - **Other Markets**: Uses `script.expiry.script_id` for each expiry
3. **Price Fetching**: Gets live price from Redis or uses fallback
4. **Transaction Generation**: Creates 3-5 transactions per script/expiry

### Step 5: Transaction Creation

Each transaction includes:

#### Completed Orders (2-3 per script)
- **Order Type**: Market
- **Status**: COMPLETED
- **Transaction Type**: Random (BUY or SELL)
- **Quantity Type**: 70% Intraday, 30% Delivery
- **Price**: Live price ± 2% variation
- **Lots**: Random (1-5 lots)

#### Pending Orders (1-2 per script)
- **Order Type**: LIMIT or STOPLOSS (random)
- **Status**: PENDING
- **Transaction Type**: Random (BUY or SELL)
- **Price**: Live price ± 5% variation (more variation for pending)
- **Trade Position**: Calculated based on price vs live price

#### Calculated Fields
All transactions include properly calculated:
- `orderPrice`, `totalOrderPrice`
- `netPrice`, `totalNetPrice`
- `orderBrokerage`, `netBrokerage`
- `brokeragePercentage`, `brokeragePercentageType`
- `m2mPrice`
- `quantityType` (intraday/delivery split)

## Output

The script provides detailed console output:

```
======================================================================
STOCK TRANSACTION BOMBER
======================================================================
Account Code: ACC001
======================================================================

📡 Connecting to database...
✅ Connected successfully

🔍 Finding user with account code: ACC001...
✅ User found: John Doe (ACC001)
   User ID: 507f1f77bcf86cd799439011
   Level: 7

📅 Fetching active valan...
✅ Active valan: Week 1
   Start: 2026-04-27
   End: 2026-05-01

🏪 Fetching all markets...
✅ Found 5 active markets

──────────────────────────────────────────────────────────────────────
📊 Processing Market: NSE (ID: 1)
──────────────────────────────────────────────────────────────────────
   Found 150 scripts in this market
   ✓ COMPLETED BUY RELIANCE 30APR2026: 50 qty @ ₹2450.50 (Market)
   ✓ COMPLETED SELL RELIANCE 30APR2026: 25 qty @ ₹2448.75 (Market)
   ✓ PENDING BUY RELIANCE 30APR2026: 75 qty @ ₹2470.00 (LIMIT)
   ✓ COMPLETED BUY TCS 30APR2026: 10 qty @ ₹3250.25 (Market)
   ...

──────────────────────────────────────────────────────────────────────
📊 Processing Market: MCX (ID: 2)
──────────────────────────────────────────────────────────────────────
   Found 45 scripts in this market
   ✓ COMPLETED BUY GOLD 30APR2026: 100 qty @ ₹62500.00 (Market)
   ✓ COMPLETED SELL GOLD 30APR2026: 100 qty @ ₹62450.50 (Market)
   ✓ PENDING SELL GOLD 30APR2026: 100 qty @ ₹62300.00 (STOPLOSS)
   ...

======================================================================
BOMBING COMPLETE! 💥
======================================================================
Total Transactions Created: 2,450

Summary by Market:
   NSE: 750 transactions
   MCX: 450 transactions
   NOPT: 600 transactions
   FOREX: 350 transactions
   COMEX: 300 transactions

✅ All transactions have been created successfully!
======================================================================

📡 Database connection closed
```

## Transaction Details

### Market-Specific Handling

#### NSE-EQ (Market ID: 12)
- Uses `script.script_id` directly
- No expiry handling (equity market)
- Label format: `RELIANCE`, `TCS`, etc.

#### Futures/Options Markets (NSE, MCX, NOPT, etc.)
- Uses `script.expiry.script_id` for each expiry
- Processes all available expiries
- Label format: `GOLD 30APR2026`, `NIFTY 20300 CE 21APR2026`

### Brokerage Calculation

Default brokerage rate: **0.02%**

```javascript
netBrokerage = (totalOrderPrice × 0.02) / 100
orderBrokerage = netBrokerage / quantity

// For BUY
netPrice = price + orderBrokerage
totalNetPrice = netPrice × quantity

// For SELL
netPrice = price - orderBrokerage
totalNetPrice = netPrice × quantity
```

### Quantity Type Distribution

- **70% Intraday**: Positions closed within the same day
- **30% Delivery**: Positions held overnight

### Order Type Distribution

#### Completed Orders
- **100% Market Orders**: Executed immediately at market price

#### Pending Orders
- **50% Limit Orders**: Buy below or sell above current price
- **50% Stop Loss Orders**: Buy above or sell below current price

## Database Models Used

1. **UserModel**: User information and hierarchy
2. **WeekValanModel**: Active trading week
3. **MarketType**: Market definitions
4. **Script**: Script definitions with expiries
5. **LotSettingModel**: Lot quantities per script
6. **StockTransactionModel**: Transaction records

## Requirements

- Node.js
- MongoDB connection (configured in `.env` file)
- Redis connection (for live price fetching)
- Required npm packages:
  - mongoose
  - moment
  - dotenv

## Environment Variables

Ensure your `.env` file contains:

```env
MONGODB_URI=mongodb://localhost:27017/your_database
REDIS_HOST=localhost
REDIS_PORT=6379
```

## Error Handling

The script handles various error scenarios:

- **User Not Found**: Exits with error message
- **No Active Valan**: Exits with error message
- **No Markets Found**: Skips and continues
- **Script Processing Error**: Logs error and continues with next script
- **Price Fetch Error**: Uses fallback price (₹100)

## Notes

- The script creates transactions with **current timestamp**
- All transactions are linked to the **active valan**
- Transactions respect user's **hierarchy** (parentIds, brokerIds)
- **No validation** is performed (this is a data generation tool)
- Script can be run **multiple times** for the same user
- Each run creates **new transactions** (does not delete existing ones)

## Use Cases

### 1. Testing
Generate test data for a specific user to test:
- Position calculations
- P&L reports
- Margin calculations
- Summary reports

### 2. Demo Data
Populate demo accounts with realistic trading data:
```bash
node scripts/stock_transaction_bomber.js DEMO001
node scripts/stock_transaction_bomber.js DEMO002
```

### 3. Load Testing
Create large volumes of transactions for performance testing:
```bash
# Run for multiple users
for code in ACC001 ACC002 ACC003; do
  node scripts/stock_transaction_bomber.js $code
done
```

### 4. Development
Quickly populate a development database with sample data

## Cleanup

To remove all transactions created by this script:

```javascript
// MongoDB Shell
db.stock_transactions.deleteMany({
  userAgent: 'Stock Transaction Bomber Script'
});
```

Or use the bulk delete functionality in the application.

## Troubleshooting

### "User with account code not found"
- Verify the account code exists in the database
- Check for typos in the account code

### "No active valan found"
- Ensure there's an active valan in the `week_valans` collection with `status: true`

### "No scripts found for this market"
- Check that the market has scripts populated
- Verify the market's `scripts` array is not empty

### Connection Issues
- Verify your `MONGODB_URI` in the `.env` file
- Ensure MongoDB is running and accessible
- Check Redis connection for price fetching

### Script Runs But Creates No Transactions
- Check that markets have `selected: true`
- Verify scripts exist in the database
- Check console output for specific errors

## Performance

- **Average execution time**: 2-5 minutes (depends on number of scripts)
- **Transactions per second**: ~10-20 (depends on database performance)
- **Memory usage**: ~100-200 MB

## Limitations

1. **No validation**: Script bypasses all business logic validations
2. **No margin checks**: Does not verify user's available margin
3. **No position limits**: Does not check quantity limits
4. **No market timing**: Creates transactions regardless of market hours
5. **No duplicate prevention**: Can create duplicate transactions if run multiple times

## Future Enhancements

Possible improvements:
- [ ] Add date range parameter to create historical transactions
- [ ] Add transaction count parameter to control volume
- [ ] Add market filter to target specific markets
- [ ] Add script filter to target specific scripts
- [ ] Add dry-run mode to preview without creating
- [ ] Add rollback functionality to undo created transactions
- [ ] Add progress bar for better UX
- [ ] Add summary export to CSV/JSON

## Related Scripts

- **recalculate_nseeq_interest.js**: Recalculate NSE-EQ interest for a user
- **rebuild_bills.js**: Rebuild final bills for a valan

## Support

For issues or questions:
1. Check the console output for specific error messages
2. Verify all prerequisites are met
3. Check database connectivity
4. Review the script logs

## Quick Reference

```bash
# Basic usage
node scripts/stock_transaction_bomber.js ACC001

# Check created transactions
mongosh "mongodb://..." --eval "db.stock_transactions.countDocuments({userAgent: 'Stock Transaction Bomber Script'})"

# View transactions for a user
mongosh "mongodb://..." --eval "db.stock_transactions.find({userId: ObjectId('USER_ID'), userAgent: 'Stock Transaction Bomber Script'}).pretty()"

# Delete all bomber transactions
mongosh "mongodb://..." --eval "db.stock_transactions.deleteMany({userAgent: 'Stock Transaction Bomber Script'})"
```
