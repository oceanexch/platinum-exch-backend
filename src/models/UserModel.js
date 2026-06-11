const mongoose = require('mongoose');
const Schema = mongoose.Schema;

// Define the scriptWiseBrokerage Schema
const ScriptWiseBrokerageSchema = new Schema({
  script: { type: String, default: '' },
  deliveryCommission: { type: String, default: '' },
  intradayCommission: { type: String, default: '' },
  percentage: { type: String, default: '' },
  lot: { type: String, default: '' }
}); // Ensure that each ScriptWiseBrokerage gets an _id

const brokerCommissionSchema = new Schema({
  brokerId: { type: Schema.Types.ObjectId, ref: 'User' },
  brokerName: { type: String, default: '' },
  type: { type: String, default: '' },
  deliveryCommission: { type: String, default: '' },
  intradayCommission: { type: String, default: '' },
  scriptWiseBrokerage: [ScriptWiseBrokerageSchema]
});

// Define the Brokerage Schema
const BrokerageSchema = new Schema({
  minPercentageWiseBrokerage: { type: String, default: '' },
  minScriptRate: { type: String, default: '' },
  minLotWiseBrokerage: { type: String, default: '' },
  type: { type: String, default: '' },
  deliveryCommission: { type: String, default: '' },
  intradayCommission: { type: String, default: '' },
  scriptWiseBrokerage: [ScriptWiseBrokerageSchema],
  brokerCommission: [brokerCommissionSchema]
}); // Ensure that Brokerage gets an _id

// Define the Margin Schema
const MarginSchema = new Schema({
  lotOrAmount: { type: String, default: 'lot' },
  totalLotWise: { type: Number, default: 0 },
  totalMargin: { type: Number, default: 0 },
  // currentLotWise: { type: Number, default: 0 },
  // currentMargin: { type: Number, default: 0 },
  maximumLimit: { type: Number, default: 0 },
  marginPer: { type: Number, default: 0 }  // % of totalMargin used as margin (0-100). Used for NSE-EQ interest formula.
}); // Ensure that Margin gets an _id

// Define the Other Schema
const OtherSchema = new Schema({
  allowOrBlock: { type: String, default: 'allow' },
  allowScript: { type: Array, default: [] },
  blockScript: [
    {
      scriptName: { type: String },
      scriptId: { type: String },
      bannedBy: { type: Schema.Types.ObjectId, ref: 'User' }
    }
  ],
  minRateScriptBlock: { type: String, default: '' },
  scriptCount: { type: String, default: '' },
  shortSellAllowed: { type: Boolean, default: true },
  limitOrderAllowed: { type: Boolean, default: true },
  freshLimitAllowed: { type: Number, default: 0 },
  orderBetweenHighLowDisabled: { type: Number, default: 0 },
  isTransferred: { type: Boolean, default: false }
}); // Ensure that Other gets an _id

// Define the Market Access Schema
const MarketAccessSchema = new Schema({
  marketId: { type: String, required: true },
  marketName: { type: String, required: true },
  isSelected: { type: Boolean, required: true },
  brokerage: BrokerageSchema,
  margin: MarginSchema,
  other: OtherSchema
}); // Ensure that MarketAccess gets an _id

const brokerPartnershipSchema = new Schema({
  broker: { type: Schema.Types.Mixed },
  partnership: { type: Number, default: 0 }
});

// Define the Basic Details Schema
const BasicDetailsSchema = new Schema({
  ledgerView: { type: Number, default: 1 },
  viewOnlyAccess: { type: Number, default: 0 },
  limitSLDisabled: { type: Number, default: 1 },
  modificationAccess: { type: Number, default: 1 },
  onlyPositionSquareOff: { type: Number, default: 0 },
  manualTradeAllowed: { type: Number, default: 1 },
  masterCount: { type: Number, default: 10 },
  customerCount: { type: Number, default: 100 },
  brokerageRefreshAllowed: { type: Number, default: 1 },
  brokerCount: { type: Number, default: 5 },
  summaryPostFix: { type: String, default: '' },
  remark: { type: String, default: '' },
  brokerPartnership: [brokerPartnershipSchema],
  manualAccountCode: { type: Boolean, default: false },
  transactionPassword: { type: String, default: '' },
  allowPartnershipEdit: { type: Number, default: 1 }, // 1 = allow, 0 = disallow editing partnership when editing downline
  nseEqAnnualInterest: { type: Number, default: 12 } // Annual interest % for NSE-EQ loan system. Min = upline's rate, Max = parent's maximumLimit distribution
}); // Ensure that BasicDetails gets an _id

// Define the Account Details Schema
const AccountDetailsSchema = new Schema({
  orderBetweenHighLow: { type: Number, default: 0 },
  onlyPositionSquareOff: { type: Number, default: 0 },
  intraDayAutoSquare: { type: Number, default: 0 },
  weeklyAutoSquare: { type: Number, default: 0 },
  applyAutoSquare_NSE_MCX_NOPT: { type: Number, default: 0 },
  positionRollOverDisabled: { type: Number, default: 0 },
  bandScriptAllow: { type: Number, default: 0 },
  m2mLinkedWithLedger: { type: Number, default: 0 },
  applyAutoSquare_FOREX_COMEX: { type: Number, default: 0 },
  applyAutoSquare_NSEEQ: { type: Number, default: 0 },
  m2m_square_off: { type: Number, default: 0 },
  limitSLDisabled: { type: Number, default: 0 },
  alertPercent: { type: Number, default: 0 },
  m2mLoss_NSE_MCX_NOPT: { type: Number, default: 0 },
  m2mProfit_NSE_MCX_NOPT: { type: Number, default: 0 },
  orderLimitType: { type: String, default: 'percentage' },
  orderLimitValue: { type: Number, default: 4 },
  sqOfDisabled_MINUTES: { type: Number, default: 0 },
  m2mLoss_FOREX_COMEX: { type: Number, default: 0 },
  m2mProfit_FOREX_COMEX: { type: Number, default: 0 },
  m2mLoss_NSEEQ: { type: Number, default: 0 },
  m2mProfit_NSEEQ: { type: Number, default: 0 },
  nseeqinterestLinkedwithLedger: { type: Number, default: 0 }, // 1 = calculate interest based on actual loan usage (holding worth - margin + booked P&L), 0 = use old flat interest logic
  weeklyLimitAutoReset: { type: Boolean, default: true } // If false, skip auto-reset for this user on Monday
}); // Ensure that AccountDetails gets an _id

// Snapshot of limit fields taken on first edit within a week; cleared every Saturday midnight
const WeeklyLimitSnapshotSchema = new Schema({
  weekStart: { type: Date, default: null },
  m2mLoss_NSE_MCX_NOPT: { type: Number, default: null },
  m2mProfit_NSE_MCX_NOPT: { type: Number, default: null },
  m2mLoss_FOREX_COMEX: { type: Number, default: null },
  m2mProfit_FOREX_COMEX: { type: Number, default: null },
  m2mLoss_NSEEQ: { type: Number, default: null },
  m2mProfit_NSEEQ: { type: Number, default: null },
  marketMargins: [{
    marketId: { type: String },
    marketName: { type: String },
    lotOrAmount: { type: String },
    totalLotWise: { type: Number },
    totalMargin: { type: Number },
    maximumLimit: { type: Number }
  }]
}, { _id: false });

// Define the main Account Schema
const UserSchema = new Schema(
  {
    accountType: {
      type: Schema.Types.ObjectId,
      ref: 'UserType',
      required: true
    },
    accountCode: { type: String, required: true },
    accountName: { type: String, required: true, unique: true },
    password: { type: String, required: true, minlength: 6 },
    forceLogout: {
      type: Boolean,
      default: false
    },
    telegramChatId: {
      type: Number,
      index: true,
      sparse: true
    },
    telegramId: {
      type: String, // String to avoid overflow or formatting issues, though Number is usually safe
      index: true,
      sparse: true
    },
    monitorTelegramId: {
      type: String,
      index: true,
      sparse: true
    },
    monitorTelegramChatId: {
      type: Number,
      index: true,
      sparse: true
    },
    monitorTelegramGroupChatId: {
      type: Number,
      index: true,
      sparse: true
    },
    email: {
      type: String,
      lowercase: true,
      trim: true,
      index: true,
      sparse: true
    },

    contactNumber: {
      type: String,
      trim: true,
      index: true,
      sparse: true
    },

    demoid: {
      type: Boolean,
      default: false,
      index: true
    },

    forceLogoutMinutes: {
      type: Number,
      default: 0
    },
    forcedlogoutLoginattempts: {
      type: Number,
      default: 0
    },
    isDeleted: {
      type: Boolean,
      default: false,
      index: true // important for soft-delete queries
    },
    deletedAt: {
      type: Date,
      default: null
    },
    deletedBy: {
      type: Schema.Types.ObjectId,
      ref: 'User',
      default: null
    },
    forceLogoutBy: {
      type: Schema.Types.ObjectId,
      ref: 'User'
    },
    country: {
      type: String,
      trim: true,
      default: ''
    },
    forceLogoutStartedAt: {
      type: Number,
      default: null // epoch ms (Number, not Date)
    },
    firstPass: { type: Boolean, default: true },
    partnership: [{ type: Number, default: 0 }],
    parentIds: [{ type: Schema.Types.ObjectId, ref: 'User' }],
    createdBy: { type: Schema.Types.Mixed },
    basicDetails: BasicDetailsSchema,
    marketAccess: [MarketAccessSchema],

    accountDetails: AccountDetailsSchema,
    status: { type: Boolean, default: true },
    activatedAt: { type: Date, default: null },
    loginIP: { type: String, default: '' },
    lastLogin: { type: Date },
    isBlocked: { type: Boolean, required: true, default: false },
    loginAttempts: { type: Number, required: true, default: 0 },
    rejectionAttempts: { type: Number, required: true, default: 0 },
    ledger: { type: Number, default: 0 },
    /** Multi-login: menu privileges (nav ids). If set, user sees only these menus. 'all' = full access. */
    menuPrivileges: { type: [String], default: [] },

    /** Multi-login: explicit CRUD controller state per module. e.g. { trades: { edit: false, delete: false, softDelete: true }, tradeLog: { edit: false, delete: false } }. Used for clear permission checks. */
    crudControllers: { type: Schema.Types.Mixed, default: null },

    /**
     * Multi-Login: If set, this account operates on behalf of the referenced user.
     * - null = Normal account (default)
     * - ObjectId = ML account acting on behalf of that user
     *
     * CRITICAL: This does NOT affect parentIds, partnership, or hierarchy.
     * It only affects which user's data this account can see/operate on.
     */
    multiLoginOf: {
      type: Schema.Types.ObjectId,
      ref: 'User',
      default: null,
      index: true // Important for efficient ML account queries
    },
    /** Multi-login: team selection persistence */
    assignedTeamId: { type: String, default: null },

    weeklyLimitSnapshot: { type: WeeklyLimitSnapshotSchema, default: () => ({}) }
  },
  { timestamps: true }
);

// Pre-validate hook to migrate/clean legacy blockScript data
UserSchema.pre('validate', function (next) {
  if (this.marketAccess) {
    this.marketAccess.forEach((market) => {
      if (market.other && market.other.blockScript) {
        // Convert array to ensure map works
        if (!Array.isArray(market.other.blockScript)) {
          market.other.blockScript = [];
        }

        // We use a new array to rebuild blockScript to handle Mixed types properly before validation
        const newBlockScript = [];

        market.other.blockScript.forEach((script) => {
          if (typeof script === 'string') {
            const trimmed = script.trim();
            if (trimmed.length > 0) {
              newBlockScript.push({ scriptName: trimmed });
            }
          } else if (script && typeof script === 'object') {
            newBlockScript.push(script);
          }
        });

        market.other.blockScript = newBlockScript;
      }
    });
  }
  next();
});

// Create an index on fields that are frequently queried (example: accountType)
UserSchema.index({ 'basicDetails.accountType': 1 });
UserSchema.index({ 'marketAccess.marketId': 1 });

// Global query middleware to exclude deleted users by default
UserSchema.pre(/^find/, function (next) {
  const query = this.getQuery();
  if (query.isDeleted === undefined) {
    this.where({ isDeleted: false });
  }
  next();
});

UserSchema.pre('aggregate', function (next) {
  const hasDeletedFilter = this.pipeline().some(
    (stage) => stage.$match && (stage.$match.isDeleted !== undefined || stage.$match.deletedAt !== undefined)
  );

  if (!hasDeletedFilter) {
    this.pipeline().unshift({ $match: { isDeleted: false } });
  }
  next();
});

const userModel = mongoose.model('User', UserSchema);
module.exports = userModel;
