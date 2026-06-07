const {
  setGetValanDetails,
  saveTransaction,
  deleteTransaction,
  getStocks,
  getProfitLossWithLivePrices,
  getStocksUserScriptWise,
  getScriptWiseReport,
  getMarketWiseClientMargin,
  getWeekValan,
  getScriptSummaryReport,
  getActiveWeekValan,
  getUserQuantity,
  updateUserQuantity,
  getLiveStock,
  setUserPosition,
  getFilterStockTransaction,
  updateTransaction,
  setUserQuantity,
  getShortTrades,
  getLineTrades,
  saveDeletedLineTrade: saveDeletedLineTradeToDb,
  getDeletedLineTrades,
  getCurrentDateRange,
  getExpiry,
  getDownlineSummaryReport,
  getClientStockTransactions,
  clientStockByMaster,
  deleteTradeRecord,
  getUsersScriptWisePosition,
  getPAndLWithLivePricesForNseEq,
  getNseEqInterestMap,
  bulkDeleteTransactions,
  recoverTransactions,
  recalculateFinalBill,
  recalculateUserPositions
} = require('../services/StockService');
const { validateTransactionPassword, getUserById } = require('../services/UserService');
const { validatepassword } = require('../services/AuthService');
const { saveLog } = require('../services/LogService');
const { getEffectiveUserId, getLoginUserId, getUserContext, isDemoUser } = require('../utils/contextHelpers');
const UserModel = require('../models/UserModel');
const mongoose = require('mongoose');
const moment = require('moment');
const quantitySetting = require('../models/QuantitySettingModel');
const WeekValanModel = require('../models/WeekValanModel');
const StockTransaction = require('../models/StockTransactionModel');
const { getHolidayByFilter, getTimeByMarket, getFilterLimitDisable, getFilterExpiries } = require('../services/SettingService');

const M2MService = require('../services/M2MService');
const MonitorService = require('../services/MonitorService');

const { getStockData, getSingleStockData, getMultipleStockData, hget, hgetall } = require('../services/RedisService');
const ScriptFroze = require('../models/ScriptFrozeModel');
const UserScript = require('../models/UserScriptModel'); // Added Import
const NseEqInterestModel = require('../models/NseEqInterestModel');
const { redisClient } = require('../config/redis');
const { getUser } = require('../services/UserService');
const { StockTransactionEvent, DashboardStockEvent } = require('../services/RedisStockService');
const { CommonStockValidator, MarketOrderValidator, LimitOrderValidator, ManualOrderValidator } = require('../validators/StockValidator');
const isWithinVariationTime = (startTime, endTime) => {
  if (!startTime || !endTime) return true;
  const now = moment();
  const start = moment(startTime, 'HH:mm');
  const end = moment(endTime, 'HH:mm');
  if (start.isSameOrBefore(end)) {
    return now.isBetween(start, end, null, '[]');
  } else {
    return now.isSameOrAfter(start) || now.isSameOrBefore(end);
  }
};

const getParentDetails = async (userId, marketId) => {
  // console.log(
  //   "Fetching parent details for userId:",
  //   userId,
  //   "and marketId:",
  //   marketId
  // );
  try {
    const user = await UserModel.findOne({
      _id: new mongoose.Types.ObjectId(userId)
    })
      .populate({
        path: 'parentIds',
        select: 'accountCode marketAccess accountDetails basicDetails'
      })

      // Fetch full document to ensure no fields (like basicDetails.viewOnlyAccess) are missed
      // .select({ ... }) removed
      .lean();

    if (!user) return null;

    const response = {
      _id: user._id,
      marketAccess: user.marketAccess || [],
      basicDetails: user.basicDetails,
      accountDetails: user.accountDetails,
      myParent: user.createdBy?.userId,
      partnership: user.partnership || [],
      loginIP: user.loginIP || '',
      parentIds: [],
      minPercentageWiseBrokerage: [],
      minLotWiseBrokerage: [],
      getMarket: (user.marketAccess || []).find((m) => m.marketId == marketId)
    };
    if (user && user.parentIds) {
      user.parentIds.forEach((parent) => {
        if (parent.marketAccess) {
          const marketAccess = parent.marketAccess.find((mk) => mk.marketId == marketId);
          if (marketAccess) {
            response.parentIds.push(parent._id);
            response.minPercentageWiseBrokerage.push(marketAccess.brokerage.minPercentageWiseBrokerage);
            response.minLotWiseBrokerage.push(marketAccess.brokerage.minLotWiseBrokerage);
          }
        }
      });
    }
    return response;
  } catch (error) {
    console.log('Error in getParentDetails:', error);
    return null;
  }
};
exports.saveStock = async (req, res) => {
  try {
    const { effectiveUserId, loginUserId } = getUserContext(req);
    let reqData = { ...req.body };
    if (!reqData.userId) reqData.userId = effectiveUserId;

    const lookupKey = reqData.symbol || reqData.scriptId;
    let [services, getValan, liveStock, qSettingDefault, qSettingScript] = await Promise.all([
      getParentDetails(reqData.userId, reqData.marketId),
      setGetValanDetails(),
      getLiveStock(lookupKey),
      quantitySetting.findOne({ clientId: reqData.userId, scriptId: "999", marketId: reqData.marketId }).lean(),
      quantitySetting.findOne({ clientId: reqData.userId, scriptId: reqData.scriptId, marketId: reqData.marketId }).lean()
    ]);

    if (!liveStock) {
      const identifiersToTry = [reqData.scriptId, reqData.label, reqData.scriptName, reqData.symbol].filter(Boolean);
      for (const ident of identifiersToTry) {
        if (ident && ident !== lookupKey) {
          const data = await getLiveStock(ident);
          if (data) {
            liveStock = typeof data === "string" ? JSON.parse(data) : data;
            break;
          }
        }
      }
    }

    const userIp = req.headers['x-forwarded-for'] || req.socket.remoteAddress || req.ip;

    if (!services) {
      await saveLog('rejection', {
        action: 'INS',
        clientId: reqData.userId,
        marketId: reqData.marketId,
        scriptId: reqData.scriptId,
        symbol: reqData.label || reqData.scriptName,
        order_type: reqData.orderType,
        lot: reqData.lot,
        qty: reqData.quantity,
        order_price: reqData.price,
        message: 'User details not found',
        ip: userIp,
        time: new Date(),
        txn_type: reqData.transactionType
      });
      return res.status(400).json({ status: 'false', message: 'User details not found' });
    }
    services.getValan = getValan;

    if (!liveStock) {
      await saveLog('rejection', {
        action: 'INS',
        clientId: reqData.userId,
        marketId: reqData.marketId,
        scriptId: reqData.scriptId,
        symbol: reqData.label || reqData.scriptName,
        order_type: reqData.orderType,
        lot: reqData.lot,
        qty: reqData.quantity,
        order_price: reqData.price,
        message: 'No active live data found for ' + (reqData.label || reqData.scriptName) + '. Trading paused.',
        ip: userIp,
        time: new Date(),
        parentIds: services.parentIds,
        txn_type: reqData.transactionType
      });
      return res.status(400).json({ status: 'false', message: 'No active live data found for ' + (reqData.label || reqData.scriptName) + '. Trading paused.' });
    }

    // Block trade if Buy or Sell price is 0 (Buyer/Seller only mode)
    if (liveStock.BuyPrice === 0 || liveStock.SellPrice === 0) {
      const side = liveStock.BuyPrice === 0 ? 'Seller' : 'Buyer';
      const rejectionMsg = `Trading blocked: Script is in ${side} only mode.`;
      await saveLog('rejection', {
        action: 'INS',
        clientId: reqData.userId,
        marketId: reqData.marketId,
        scriptId: reqData.scriptId,
        symbol: reqData.label || reqData.scriptName,
        order_type: reqData.orderType,
        lot: reqData.lot,
        qty: reqData.quantity,
        order_price: reqData.price,
        message: rejectionMsg,
        ip: userIp,
        time: new Date(),
        parentIds: services.parentIds,
        txn_type: reqData.transactionType
      });
      return res.status(400).json({ status: 'false', message: rejectionMsg });
    }

    // Requirement 1 & 2: Discard incoming price, use live price + variation
    const qSetting = qSettingScript || qSettingDefault;
    const variation = (qSetting && isWithinVariationTime(qSetting.variationStartTime, qSetting.variationEndTime))
      ? (Number(qSetting.buySellVariation) || 0)
      : 0;

    let basePrice = (reqData.transactionType === 'BUY') ? liveStock.SellPrice : liveStock.BuyPrice;
    if (reqData.transactionType === 'BUY') {
      reqData.price = basePrice + variation;
    } else {
      reqData.price = basePrice - variation;
    }


    // Normalization

    reqData.userIp = userIp;
    reqData.createdBy = loginUserId;
    reqData.message = reqData.message || 'Stock ' + reqData.transactionType.toLowerCase() + ' successfully';

    // ===== PHASE 1.5: M2M Blocked Check =====
    const blockKeys = [`m2m_blocked:${reqData.userId}`];
    if (services.parentIds && services.parentIds.length > 0) {
      services.parentIds.forEach(pid => blockKeys.push(`m2m_blocked:${pid}`));
    }
    const isM2MBlocked = await redisClient.exists(...blockKeys);
    if (isM2MBlocked > 0) {
      return res.status(403).json({ status: 'false', message: 'Trading blocked due to M2M limit breach' });
    }

    // Create base rejection log for all validations
    const baseRejectionLog = {
      action: 'INS',
      clientId: reqData.userId,
      marketId: reqData.marketId,
      scriptId: reqData.scriptId,
      symbol: reqData.label || reqData.scriptName,
      order_type: reqData.orderType,
      lot: reqData.lot,
      qty: reqData.quantity,
      order_price: reqData.price,
      message: '',
      ip: userIp,
      time: new Date(),
      parentIds: services.parentIds,
      txn_type: reqData.transactionType
    };

    // Valan Check
    if (moment().format('YYYY-MM-DD') > moment(getValan.endDate).format('YYYY-MM-DD')) {
      baseRejectionLog.message = 'No valan found';
      await saveLog('rejection', baseRejectionLog);
      return res.status(400).json({ status: 'false', message: 'No valan found' });
    }

    // ===== PHASE 2: Parallel Basic Validations =====
    const [basicValidation, staleValidation, marketValidation, qtyValidation, expiryValidation] = await Promise.all([
      CommonStockValidator.validateBasicRules(reqData, services),
      CommonStockValidator.validateStaleData(reqData.scriptId, lookupKey),
      CommonStockValidator.validateMarketStatus(reqData, services),
      CommonStockValidator.validateQuantityLimits(
        reqData.userId,
        reqData.scriptId,
        reqData.marketId,
        reqData.lot,
        reqData.quantity,
        reqData.price,
        services.parentIds,
        reqData.scriptName,
        reqData.transactionType,
        services.getValan?._id
      ),
      CommonStockValidator.validateExpiryStatus(reqData, services)
    ]);

    // // Check Phase 2 results
    if (!basicValidation.isValid) {
      baseRejectionLog.message = basicValidation.message;
      await saveLog('rejection', baseRejectionLog);
      return res.status(basicValidation.statusCode || 400).json({ status: 'false', message: basicValidation.message });
    }

    if (!staleValidation.isValid) {
      baseRejectionLog.message = staleValidation.message;
      await saveLog('rejection', baseRejectionLog);
      return res.status(400).json({ status: 'false', message: staleValidation.message });
    }

    if (!marketValidation.isValid) {
      baseRejectionLog.message = marketValidation.message;
      await saveLog('rejection', baseRejectionLog);
      return res.status(400).json({ status: 'false', message: marketValidation.message });
    }

    if (!qtyValidation.isValid) {
      baseRejectionLog.message = qtyValidation.message;
      await saveLog('rejection', baseRejectionLog);
      return res.status(400).json({ status: 'false', message: qtyValidation.message });
    }

    if (!expiryValidation.isValid) {
      baseRejectionLog.message = expiryValidation.message;
      await saveLog('rejection', baseRejectionLog);
      return res.status(400).json({ status: 'false', message: expiryValidation.message });
    }

    // validations results check ...


    // Build services object
    services.getValan = getValan;
    services.getMarket = services.marketAccess.find((mkt) => mkt.marketId == reqData.marketId);

    if (!services.getMarket) {
      baseRejectionLog.message = 'Segment is missing';
      await saveLog('rejection', baseRejectionLog);
      return res.status(400).json({ status: 'false', message: 'Segment is missing' });
    }

    // ===== PHASE 3: Parallel Advanced Validations =====
    const [squareOffValidation, m2mValidation, marginValidation, marketOrderValidation, calcResult] = await Promise.all([
      CommonStockValidator.validatePositionSquareOff(reqData, services),
      CommonStockValidator.validateM2MLimits(reqData, services),
      CommonStockValidator.validateMarginLimits(reqData, services),
      MarketOrderValidator.validate(reqData, services, liveStock),
      CommonStockValidator.calculateBrokerageAndMargin(reqData, services, liveStock)
    ]);

    // Check Phase 3 results
    if (!squareOffValidation.isValid) {
      baseRejectionLog.message = squareOffValidation.message;
      await saveLog('rejection', baseRejectionLog);
      return res.status(400).json({ status: 'false', message: squareOffValidation.message });
    }

    if (!m2mValidation.isValid) {
      baseRejectionLog.message = m2mValidation.message;
      await saveLog('rejection', baseRejectionLog);
      return res.status(400).json({ status: 'false', message: m2mValidation.message });
    }

    if (!marginValidation.isValid) {
      baseRejectionLog.message = marginValidation.message;
      await saveLog('rejection', baseRejectionLog);
      return res.status(400).json({ status: 'false', message: marginValidation.message });
    }

    if (!marketOrderValidation.isValid) {
      baseRejectionLog.message = marketOrderValidation.message;
      await saveLog('rejection', baseRejectionLog);
      return res.status(400).json({ status: 'false', message: marketOrderValidation.message });
    }

    if (!calcResult.isValid) {
      baseRejectionLog.message = calcResult.message;
      await saveLog('rejection', baseRejectionLog);
      return res.status(400).json({ status: 'false', message: calcResult.message });
    }


    // ===== SAVE =====
    const { newBuyQty, newSellQty, checkQuantity, otherBrokerage, ...transactionData } = calcResult.data;

    const stock = {
      ...reqData,
      valanId: getValan._id,
      expiry: getExpiry(reqData.label),
      ip: userIp,
      userAgent: req.headers['user-agent'],
      message: reqData.message,
      transactionStatus: 'COMPLETED',
      type: ['NRM', 'BF', 'FW', 'CF'].includes(reqData.type) ? reqData.type : 'NRM',

      otherBrokerage: otherBrokerage,
      ...transactionData,

      parentIds: services.parentIds,
      myParent: services.myParent,
      brokerIds: (services.basicDetails.brokerPartnership || []).map((b) => (b.broker && b.broker._id ? b.broker._id : b.broker)),
      partnership: services.partnership,
      minPercentageWiseBrokerage: services.minPercentageWiseBrokerage,
      minLotWiseBrokerage: services.minLotWiseBrokerage,
      shortmsg: 'Market'
    };

    const savedStock = await saveTransaction(stock);


    // Calculate if the position is now fully squared off (equal buy/sell) for optimization flag
    const totalBuy = (checkQuantity.previous?.buyQty || 0) + (checkQuantity.current?.buyQty || 0);
    const totalSell = (checkQuantity.previous?.sellQty || 0) + (checkQuantity.current?.sellQty || 0);
    const isEqualQty = totalBuy === totalSell;

    await setUserPosition(reqData.userId, reqData.scriptId, getValan._id, isEqualQty);
    await updateUserQuantity({ userId: reqData.userId }, { previous: checkQuantity.previous, current: checkQuantity.current });

    StockTransactionEvent({
      userId: reqData.userId,
      parentIds: services.parentIds,
      marketId: reqData.marketId,
      scriptId: reqData.scriptId,
      transactionType: reqData.transactionType,
      valanId: getValan._id,
      userScriptId: reqData.userScriptId ?? null,
      price: reqData.price,
      quantity: reqData.quantity,
      orderType: reqData.orderType,
      status: 'COMPLETED',
      _id: savedStock._id,
      label: reqData.label,
      scriptName: reqData.scriptName
    });

    DashboardStockEvent({
      userId: reqData.userId,
      parentIds: services.parentIds,
      marketId: reqData.marketId,
      scriptId: reqData.scriptId,
      transactionType: reqData.transactionType,
      valanId: getValan._id,
      userScriptId: reqData.userScriptId ?? null,
      lot: reqData.lot || 0,
      quantity: reqData.quantity,
      orderType: reqData.orderType,
      price: reqData.price,
      status: 'COMPLETED',
      _id: savedStock._id,
      label: reqData.label
    });

    // 🔔 Monitor: notify watchers of trade (fire-and-forget)
    MonitorService.notifyWatchers(reqData.userId, 'TRADE_PLACED', {
      loginUserId,
      isMultiLogin: req.context?.isMultiLogin || false,
      ip: userIp,
      device: req.headers['user-agent'] || 'Unknown',
      parentIds: services.parentIds || [],
      label: reqData.label,
      transactionType: reqData.transactionType,
      lot: reqData.lot,
      quantity: reqData.quantity,
      price: reqData.price,
      marketName: reqData.marketName,
      marketId: reqData.marketId,
      orderType: reqData.orderType,
      time: new Date()
    }).catch(() => { });

    M2MService.invalidateM2MCache(reqData.userId, getValan._id).catch((err) => {
      console.error('Error invalidating M2M cache:', err);
    });

    res.status(200).json({ status: true, message: stock.message, data: savedStock });
  } catch (error) {
    console.log(error);
    res.status(500).json({ status: 'false', message: error.message });
  }
};

/**
 * Strips expiry dates/numbers from a scriptId to get the base symbol name.
 * Examples: "SILVER25FEB25" → "SILVER", "NIFTY23OCT23FUT" → "NIFTY", "CRUDEOIL25MAR" → "CRUDEOIL"
 * Handles formats: SYMBOLDDMMMYY, SYMBOLDDMMMYYFUT, SYMBOLYYMMMDD etc.
 */
const getBaseScriptName = (scriptId = '') => {
  if (!scriptId) return '';
  let base = String(scriptId).trim().toUpperCase().replace(/\s+/g, "");
  // Remove suffixes
  base = base.replace(/(FUT|OPT|CE|PE)$/i, '');
  // Remove month-based expiries (e.g., 25FEB25, 27FEB2026, 05MAR, FEB 2025)
  const months = 'JAN|FEB|MAR|APR|MAY|JUN|JUL|AUG|SEP|OCT|NOV|DEC';
  const expiryPattern = `\\d{0,2}(${months})\\d{0,4}`;
  base = base.replace(new RegExp(expiryPattern, 'i'), '');
  // Strip any remaining trailing digits/special chars/spaces
  base = base.replace(/[^A-Z]+$/, '');
  return base.trim();
};

const getOtherBrokerDetails = (
  marketId,
  lot,
  brokerCommission,
  scriptId,
  price,
  quantity,
  quantityType,
  totalOrderPrice,
  brokerPartnership,
  brokerage,
  clientNetBrokerage,
  clientIntradayRate,
  clientDeliveryRate,
  transactionType,
  isClientScriptWise = false
) => {
  const otherBrokers = { totalOrderBrokerage: 0, totalBrokerPercentage: 0 };
  for (let obroker of (brokerCommission || [])) {
    if (!obroker.brokerId) continue;
    const brokerId = String(obroker.brokerId);

    // Safety check for partnership lookup
    const foundPartnership = (brokerPartnership || []).find((bkr) => {
      if (!bkr || !bkr.broker) return false;
      const targetId = bkr.broker._id ? String(bkr.broker._id) : String(bkr.broker);
      return targetId === brokerId;
    });
    const getPartnership = foundPartnership ? (foundPartnership.partnership || 0) : 0;
    let brokerageIntradayPercentage = obroker.intradayCommission || 0;
    let brokerageDeliveryPercentage = obroker.deliveryCommission || 0;

    const normalizedTradeScript = getBaseScriptName(scriptId);
    const scriptWiseBrokerage = obroker.scriptWiseBrokerage || [];
    const checkScriptBrokerage = scriptWiseBrokerage.find((s) => s.script && normalizedTradeScript === getBaseScriptName(s.script));
    if (checkScriptBrokerage) {
      brokerageIntradayPercentage = checkScriptBrokerage.intradayCommission || 0;
      brokerageDeliveryPercentage = checkScriptBrokerage.deliveryCommission || 0;
    } else if (isClientScriptWise) {
      brokerageIntradayPercentage = 0;
      brokerageDeliveryPercentage = 0;
    }

    if (!brokerage) {
      brokerageIntradayPercentage = 0;
      brokerageDeliveryPercentage = 0;
    }

    const brokeragePercentageType = {
      intraday: brokerageIntradayPercentage,
      delivery: brokerageDeliveryPercentage
    };

    let netBrokerage = 0;
    let orderBrokerage = 0;
    if (obroker.type == 'lot') {
      const lotFactor = quantity > 0 ? lot / quantity : 0;
      netBrokerage =
        quantityType.intraday * brokerageIntradayPercentage * lotFactor + quantityType.delivery * brokerageDeliveryPercentage * lotFactor;
      orderBrokerage = quantity > 0 ? netBrokerage / quantity : 0;
    } else {
      // -----------------------------------------------------------------------
      // PROPORTION FORMULA (As requested by user)
      // If 0.02% (ClientRate) = 2000 (ClientNetBrokerage),
      // then 0.015% (BrokerRate) = 2000 * (0.015 / 0.02) = 1500
      // -----------------------------------------------------------------------

      const totalQty = quantityType.intraday + quantityType.delivery || 1;
      const cRate = (quantityType.intraday * (clientIntradayRate || 0) + quantityType.delivery * (clientDeliveryRate || 0)) / totalQty;
      const bRate = (quantityType.intraday * brokerageIntradayPercentage + quantityType.delivery * brokerageDeliveryPercentage) / totalQty;

      if (clientNetBrokerage > 0 && cRate > 0) {
        netBrokerage = clientNetBrokerage * (bRate / cRate);
      } else {
        netBrokerage =
          (quantityType.intraday * price * brokerageIntradayPercentage) / 100 +
          (quantityType.delivery * price * brokerageDeliveryPercentage) / 100;
      }
      orderBrokerage = quantity > 0 ? netBrokerage / quantity : 0;
    }

    const netPrice = price + orderBrokerage;
    const totalNetPrice = netPrice * quantity;

    // brokeragePercentage = broker's effective rate (as % of price)
    const brokeragePercentage = price > 0 ? (orderBrokerage * 100) / price : 0;

    otherBrokers[brokerId] = {
      quantityType,
      brokeragePercentage: brokeragePercentage || 0,
      brokeragePercentageType,
      quantity,
      price,
      orderBrokerage,
      netBrokerage,
      partnership: getPartnership
    };

    otherBrokers.totalOrderBrokerage += netBrokerage;
    otherBrokers.totalBrokerPercentage += brokeragePercentage || 0;
  }

  return otherBrokers;
};

exports.getParentDetails = getParentDetails;

exports.getUserStocks = async (req, res) => {
  try {
    const effectiveUserId = getEffectiveUserId(req);

    const isRequesterDemo = isDemoUser(req);

    // Get user with broker market access inheritance
    const { getUserWithMarketAccess } = require('../utils/brokerHelpers');
    const userInfo = await getUserWithMarketAccess(effectiveUserId);

    // Use safe date range getter
    let startOfDay, endOfDay;
    try {
      const dateRange = getCurrentDateRange();
      startOfDay = dateRange.startOfDay;
      endOfDay = dateRange.endOfDay;
    } catch (e) {
      // Fallback if imported function fails
      const date = new Date();
      startOfDay = new Date(date.setHours(0, 0, 0, 0));
      endOfDay = new Date(date.setHours(23, 59, 59, 999));
    }

    let query = {
      parentIds: new mongoose.Types.ObjectId(effectiveUserId),
      createdAt: { $gte: startOfDay, $lte: endOfDay }
    };

    // If user is a broker with inherited marketAccess, filter by those markets
    if (userInfo && userInfo.accountType?.level === 6 && userInfo.marketAccess && userInfo.marketAccess.length > 0) {
      const { getMarketIds } = require('../utils/brokerHelpers');
      const marketIds = getMarketIds(userInfo.marketAccess);
      if (marketIds.length > 0) {
        query.marketId = { $in: marketIds };
      }
    }

    const response = await getStocks(query, isRequesterDemo);
    res.status(200).json({ status: true, data: response });
  } catch (error) {
    res.status(500).json({ status: 'false', message: error.message });
  }
};

exports.getStocks = async (req, res) => {
  try {
    // console.log("getStocks Params:", req.body);
    const effectiveUserId = getEffectiveUserId(req);
    const { accountType } = req.user;

    // Defensive check
    const level = accountType ? accountType.level : undefined;
    if (!level) {
      // Fallback or error? Assuming error for now, or log it.
      console.error('Account Type or Level missing in req.user');
    }

    const isRequesterDemo = isDemoUser(req);

    const { transactionStatus, market, script, startDate, endDate, master, broker, client, orderType } = req.body;

    const filterKeys = {
      market,
      script,
      startDate,
      endDate,
      master,
      broker,
      client,
      orderType,
      transactionStatus
    };
    const matchFilter = {};
    Object.keys(filterKeys).forEach((data) => {
      // Safe checks for string/array length
      const value = filterKeys[data];

      if (data == 'market' && value) {
        if (typeof value === 'string' && value.includes(',')) {
          matchFilter['marketId'] = { $in: value.split(',').map((id) => id.trim()) };
        } else if (Array.isArray(value)) {
          matchFilter['marketId'] = { $in: value };
        } else {
          matchFilter['marketId'] = value;
        }
      }
      if (data == 'script' && value) {
        matchFilter['scriptName'] = { $regex: new RegExp(`^${value}`, 'i') };
      }
      if (data == 'startDate' && value) {
        const start = new Date(value + 'T00:00:00.000+05:30');
        matchFilter['createdAt'] = { ...matchFilter['createdAt'], $gte: start };
      }
      if (data == 'endDate' && value) {
        const end = new Date(value + 'T23:59:59.999+05:30');
        matchFilter['createdAt'] = { ...matchFilter['createdAt'], $lte: end };
      }
      if (data == 'master' && value) {
        matchFilter['parentIds'] =
          String(value).toLowerCase() == 'self' ? new mongoose.Types.ObjectId(effectiveUserId) : new mongoose.Types.ObjectId(master);
      }
      if (data == 'broker' && value) {
        matchFilter['brokerIds'] =
          String(value).toLowerCase() == 'self' ? new mongoose.Types.ObjectId(effectiveUserId) : new mongoose.Types.ObjectId(broker);
      }
      if (data == 'client' && value) {
        matchFilter['userId'] =
          String(value).toLowerCase() == 'self' ? new mongoose.Types.ObjectId(effectiveUserId) : new mongoose.Types.ObjectId(client);
      }
      if (data == 'orderType' && value && value.length > 0) {
        matchFilter['orderType'] = { $in: orderType };
      }
      if (data == 'transactionStatus' && value && value.length > 0) {
        matchFilter['transactionStatus'] = { $in: transactionStatus };
      }
    });

    const response = await getStocks(
      {
        [level == 7 ? 'userId' : level == 6 ? 'brokerIds' : 'parentIds']: new mongoose.Types.ObjectId(effectiveUserId),
        ...matchFilter
      },
      isRequesterDemo
    );
    res.status(200).json({ status: true, data: response });
  } catch (error) {
    console.log('getStocks Error:', error);
    res.status(500).json({ status: 'false', message: error.message });
  }
};


exports.getSummaryReport = async (req, res) => {
  try {
    let userId = getEffectiveUserId(req);
    const askerLevel = req.user.accountType?.level;
    let level = askerLevel;
    const isRequesterDemo = isDemoUser(req);

    const matchFilter = {};
    const { id, market, script, valan, startDate, endDate, master, broker, client } = req.query;

    if (id != 'self') {
      userId = id;
      const user = await getUser({ _id: userId }, { _id: 0, accountCode: 1, accountName: 1, accountType: 1 });

      level = user.accountType.level;
      // console.log(`\n🔍 Drill-down to user ${userId} (${user.accountCode}), setting viewer perspective level to: ${level}`);
    } else if (client) {
      userId = client;
      const user = await getUser({ _id: userId }, { accountType: 1 });
      level = user.accountType.level;
    } else if (broker) {
      userId = broker;
      const user = await getUser({ _id: userId }, { accountType: 1 });
      level = user.accountType.level;
    } else if (master) {
      userId = master;
      const user = await getUser({ _id: userId }, { accountType: 1 });
      level = user.accountType.level;
    }

    const filterKeys = {
      market,
      script,
      valan,
      startDate,
      endDate,
      master,
      broker,
      client
    };

    // Default to active valan only if no valan and no date filters are specified
    if (!valan && !startDate && !endDate) {
      const { _id: activeValanId } = await getActiveWeekValan();
      matchFilter['valanId'] = activeValanId;
    }

    Object.keys(filterKeys).forEach((key) => {
      const val = filterKeys[key];
      if (!val || val === 'all' || val === 'undefined' || val === 'null') return;
      if (key === 'market') {
        if (val === '12') {
          matchFilter['marketId'] = '__NONE__';
        } else if (typeof val === 'string' && val.includes(',')) {
          matchFilter['marketId'] = { $in: val.split(',') };
        } else {
          matchFilter['marketId'] = val;
        }
      }
      if (key === 'script') matchFilter['scriptName'] = { $regex: new RegExp(`^${val}$`, 'i') };
      if (key === 'valan') matchFilter['valanId'] = new mongoose.Types.ObjectId(val);
      if (key === 'startDate' || key === 'endDate') {
        const { startOfDay, endOfDay } = getCurrentDateRange(val);
        matchFilter['createdAt'] = {
          ...matchFilter['createdAt'],
          [key === 'startDate' ? '$gte' : '$lte']: key === 'startDate' ? startOfDay : endOfDay
        };
      }
      // These are already handled by setting userId/level for drill-down perspective,
      // but we add them to matchFilter to ensure only relevant transactions are fetched.
      if (key === 'master') matchFilter['parentIds'] = new mongoose.Types.ObjectId(val);
      if (key === 'broker') matchFilter['brokerIds'] = new mongoose.Types.ObjectId(val);
      if (key === 'client') matchFilter['userId'] = new mongoose.Types.ObjectId(val);
    });

    if (!matchFilter['marketId']) {
      matchFilter['marketId'] = { $ne: '12' };
    }

    // Only override asker perspective for broker (level 6). Other levels keep existing behavior.
    const askerExtraOpts = (askerLevel === 6)
      ? { askerLevel: 6, askerId: getLoginUserId(req).toString() }
      : {};

    let brokerLevelMatch;
    if (level == 6) {
      // Broker view: include ALL trades of this broker's clients (by client id),
      // not just trades where brokerIds was tagged. Matches the downstream broker
      // rendering which is already restricted to brokerPartnership clients.
      const brokerIdObj = new mongoose.Types.ObjectId(userId);
      const brokerIdStr = userId.toString();
      const brokerClients = await UserModel.find({
        $or: [
          { 'basicDetails.brokerPartnership.broker._id': brokerIdObj },
          { 'basicDetails.brokerPartnership.broker._id': brokerIdStr },
          { 'basicDetails.brokerPartnership.broker': brokerIdObj },
          { 'basicDetails.brokerPartnership.broker': brokerIdStr }
        ],
        isDeleted: false,
        demoid: isRequesterDemo ? true : { $ne: true }
      }).select('_id').lean();
      brokerLevelMatch = { userId: { $in: brokerClients.map(c => c._id) } };
    } else {
      const filterKey = level == 7 ? 'userId' : 'parentIds';
      brokerLevelMatch = { $or: [{ [filterKey]: new mongoose.Types.ObjectId(userId) }, { [filterKey]: userId.toString() }] };
    }

    const result = await getProfitLossWithLivePrices(
      {
        ...brokerLevelMatch,
        transactionStatus: 'COMPLETED',
        ...matchFilter
      },
      level,
      userId.toString(),
      askerExtraOpts
    );
    const response = result && result.data ? result.data : result;
    const scriptNames = result && result.scriptNames ? result.scriptNames : [];
    const livePriceCount = result && result.livePriceCount != null ? result.livePriceCount : 0;
    const socketSymbols = result && result.socketSymbols && Array.isArray(result.socketSymbols) ? result.socketSymbols : [];

    const responseMap = new Map(response.map((item) => [item.userId.toString(), item]));

    const getParentsId = [...new Set(response.flatMap((ids) => ids.parentIds.slice(level)))];
    const getClientId = [...new Set(response.map((ids) => ids.userId.toString()))];

    // Fetch all descendants in the sub-tree to calculate recursive limits
    const allUsersInHierarchy = await UserModel.find({
      $or: [{ _id: new mongoose.Types.ObjectId(userId) }, { parentIds: new mongoose.Types.ObjectId(userId) }],
      isDeleted: false,
      demoid: isRequesterDemo ? true : { $ne: true }
    })
      .select('accountCode accountName accountDetails parentIds partnership')
      .lean();

    if (level === 6) {
      const brokerIdObj = new mongoose.Types.ObjectId(userId);
      const brokerIdStr = userId.toString();
      const brokerClient = await UserModel.find({
        _id: { $in: getClientId },
        $or: [
          { 'basicDetails.brokerPartnership.broker._id': brokerIdObj },
          { 'basicDetails.brokerPartnership.broker._id': brokerIdStr },
          { 'basicDetails.brokerPartnership.broker': brokerIdObj },
          { 'basicDetails.brokerPartnership.broker': brokerIdStr }
        ],
        isDeleted: false,
        demoid: isRequesterDemo ? true : { $ne: true }
      })
        .select('accountName accountCode partnership accountDetails basicDetails')
        .populate('accountType', 'label level')
        .lean();

      const brokerDirectClientWithData = brokerClient.map((element) => {
        const dt = responseMap.get(element._id.toString()) || {};
        const totalM2M = Number(dt.m2m) || 0;
        const partnership = element.partnership || [];

        const uplineShare = partnership.slice(0, level - 1).reduce((acc, v) => acc + (Number(v) || 0), 0);
        const brockerpartIds = element.basicDetails.brokerPartnership.map((item) => item.broker);
        const selfShare = brockerpartIds.includes(userId.toString()) ? element.basicDetails.brokerPartnership.find((item) => item.broker.toString() === userId.toString())?.partnership : 0;
        const rowData = { ...dt };

        // COMMENTED OUT: StockService already calculates these values correctly with broker brokerage included
        // DO NOT recalculate here as it overrides the correct values from getProfitLossWithLivePrices
        // rowData.uplineNetPrice = (totalM2M * uplineShare * -1) / 100;
        // rowData.selfNetPrice = (totalM2M * selfShare * -1) / 100;
        // rowData.downlineNetPrice = 0;

        const limits = getRecursiveM2MLimits(element._id, allUsersInHierarchy, level);
        const finalRow = { ...element, ...rowData, ...limits, valanId: matchFilter['valanId'] };
        return finalRow;
      });

      return res.status(200).json({ status: true, data: brokerDirectClientWithData, scriptNames, livePriceCount, socketSymbols });
    }

    const directReportingIds = new Set();
    response.forEach((item) => {
      if (item.parentIds && item.parentIds.length > level) {
        // Child at Level+1 who is the next in line
        directReportingIds.add(item.parentIds[level].toString());
      } else if (item.userId) {
        // Direct child (end user/client)
        directReportingIds.add(item.userId.toString());
      }
    });

    const allDirectUsers = await UserModel.find({
      _id: { $in: Array.from(directReportingIds) },
      demoid: isRequesterDemo ? true : { $ne: true }
    })
      .select({
        accountName: 1,
        accountCode: 1,
        partnership: 1,
        accountDetails: 1,
        createdBy: 1,
        'basicDetails.summaryPostFix': 1
      })
      .populate('accountType', 'label level -_id')
      .lean();

    const myDirect = allDirectUsers.filter((u) => u.accountType?.level < 7);
    const myDirectClient = allDirectUsers.filter((u) => u.accountType?.level === 7);

    const myDirectWithSum = myDirect.map((element) => {
      try {
        const getSum = getTotalSum(response, element._id);
        const totalM2M = Number(getSum.m2m) || 0;
        const partnership = element.partnership || [];
        const uplineShare = partnership.slice(0, level - 1).reduce((acc, v) => acc + (Number(v) || 0), 0);
        const selfShare = Number(partnership[level - 1]) || 0;
        const brokerShare = Number(partnership[5]) || 0;
        const totalSelfShare = selfShare + brokerShare;
        const downlineShare = 100 - uplineShare - totalSelfShare;

        const rowData = { ...getSum };
        rowData.uplineNetPrice = (totalM2M * uplineShare * -1) / 100;
        rowData.selfNetPrice = (totalM2M * totalSelfShare * -1) / 100;
        rowData.downlineNetPrice = (totalM2M * downlineShare * -1) / 100;
        // SuperAdmin/upper level: selfBrokerage includes both brokerShare% AND viewer's own %
        rowData.selfBrokerage = ((rowData.brokerage - rowData.brokerBrokerage) * totalSelfShare) / 100;

        const limits = getRecursiveM2MLimits(element._id, allUsersInHierarchy, level);
        return { ...element, ...rowData, ...limits, brokerNetPrice: 0, valanId: matchFilter['valanId'] };
      } catch (err) {
        console.error(`❌ Error processing user ${element.accountCode}:`, err);
        return { ...element, ...getTotalSum(response, element._id), brokerNetPrice: 0, valanId: matchFilter['valanId'] };
      }
    });

    // Actual logged-in user (NOT the drill-down userId)
    const loggedInUserId = getLoginUserId(req);

    const myDirectClientWithData = myDirectClient.map((element) => {
      const dt = responseMap.get(element._id.toString()) || {};
      const totalM2M = Number(dt.m2m) || 0;

      // Back-derive uplineShare% and brokerShare% from pipeline values
      const uplineNetPrice = Number(dt.uplineNetPrice) || 0;
      const brokerNetPrice = Number(dt.brokerNetPrice) || 0;
      const uplineSharePct = totalM2M !== 0 ? (uplineNetPrice * -100) / totalM2M : 0;
      const brokerSharePct = totalM2M !== 0 ? (brokerNetPrice * -100) / totalM2M : 0;

      // General Self Share (including broker part)
      const fullSelfShare = 100 - uplineSharePct;

      // Check if the ACTUAL logged-in user is the direct parent (creator) of this client
      const isDirectParent = element.createdBy?.userId?.toString() === loggedInUserId?.toString();

      let selfNetPrice;
      let selfBrokerage;

      if (askerLevel === 6) {
        // Broker asker: pipeline + enriched already produced correct values from the
        // broker's perspective using live-adjusted finalM2M. Do not recompute here —
        // back-deriving from a stale uplineSharePct inflates selfNetPrice when there are
        // open positions.
        selfNetPrice = Number(dt.selfNetPrice) || 0;
        selfBrokerage = Number(dt.selfBrokerage) || 0;
      } else if (isDirectParent) {
        // Direct parent: selfNetPrice excludes broker share
        const netSelfShare = 100 - uplineSharePct - brokerSharePct;
        selfNetPrice = (totalM2M * netSelfShare * -1) / 100;

        // Direct parent: selfBrokerage uses ONLY viewer's own fixed partnership %
        const viewerOwnShare = Number(dt.myShare) || 0; // partnership[level-1]
        selfBrokerage = ((Number(dt.brokerage) - Number(dt.brokerBrokerage)) * viewerOwnShare) / 100;
      } else {
        // Upper level drilling down: includes full slice (own share + broker share)
        selfNetPrice = (totalM2M * fullSelfShare * -1) / 100;
        selfBrokerage = ((Number(dt.brokerage) - Number(dt.brokerBrokerage)) * fullSelfShare) / 100;
      }

      const rowData = { ...dt };
      rowData.selfNetPrice = selfNetPrice;
      rowData.selfBrokerage = selfBrokerage;
      rowData.downlineNetPrice = askerLevel === 6 ? (Number(dt.downlineNetPrice) || 0) : 0;

      const summedOtherBrokerage = (rowData.summedOtherBrokerage || []).flat(1);
      const aggregatedSum = summedOtherBrokerage.reduce((acc, item) => {
        if (!acc[item.brokerId]) acc[item.brokerId] = 0;
        acc[item.brokerId] += item.netBrokerage || 0;
        return acc;
      }, {});
      rowData.summedOtherBrokerage = [...Object.values(aggregatedSum), ...new Array(5 - Object.values(aggregatedSum).length).fill(0)];

      const limits = getRecursiveM2MLimits(element._id, allUsersInHierarchy, level);
      return { ...element, ...rowData, ...limits, valanId: matchFilter['valanId'] };
    });

    const combinedData = [...myDirectWithSum, ...myDirectClientWithData];

    // Asker level 7 (customer viewing own report): bill = self, no broker margin/my brokerage/self brokerage
    if (askerLevel === 7) {
      combinedData.forEach((row) => {
        row.selfNetPrice = Number(row.bill) || 0;
        delete row.myBrokerage;
        delete row.selfBrokerage;
        delete row.brokerNetPrice;
      });
    }

    // Log final data being sent to frontend

    res.status(200).json({ status: true, data: combinedData, scriptNames, livePriceCount, socketSymbols });
  } catch (error) {
    console.error(error);
    res.status(500).json({ status: false, message: error.message });
  }
};
/**
 * Returns summary report data for real-time P&L (used by socket handler).
 * Same logic as getSummaryReport but returns { data, reportsTotal } instead of res.json.
 * @param {Object} payload - { id, market, script, valan, startDate, endDate, master, broker, client }
 * @param {string} reqUserId - logged-in user id (used when id === 'self')
 * @param {number} reqLevel - logged-in user level
 * @returns {Promise<{ data: Array, reportsTotal: Object, scriptNames: Array, socketSymbols: Array }>}
 */
exports.getSummaryReportData = async (payload, reqUserId, reqLevel) => {
  let userId = reqUserId;
  const askerLevel = reqLevel;
  let level = reqLevel;
  const isRequesterDemo = (await UserModel.findById(reqUserId).select('demoid').lean())?.demoid === true;
  const matchFilter = {};
  const { id, market, script, valan, startDate, endDate, master, broker, client } = payload || {};
  if (id && id !== 'self') {
    userId = id;
    const user = await getUser({ _id: userId }, { _id: 0, accountCode: 1, accountName: 1, accountType: 1 });
    // Use viewed user's level for correct calculations
    level = user.accountType.level;
  } else if (client) {
    userId = client;
    const user = await getUser({ _id: userId }, { accountType: 1 });
    level = user.accountType.level;
  } else if (broker) {
    userId = broker;
    const user = await getUser({ _id: userId }, { accountType: 1 });
    level = user.accountType.level;
  } else if (master) {
    userId = master;
    const user = await getUser({ _id: userId }, { accountType: 1 });
    level = user.accountType.level;
  }

  const filterKeys = { market, script, valan, startDate, endDate, master, broker, client };

  // Default to active valan only if no valan and no date filters are specified
  if (!valan && !startDate && !endDate) {
    const { _id: activeValanId } = await getActiveWeekValan();
    matchFilter['valanId'] = activeValanId;
  }

  Object.keys(filterKeys).forEach((data) => {
    const val = filterKeys[data];
    if (!val || val === 'all' || val === 'undefined' || val === 'null') return;
    if (data === 'market') {
      if (val === '12') {
        matchFilter['marketId'] = '__NONE__';
      } else if (typeof val === 'string' && val.includes(',')) {
        matchFilter['marketId'] = { $in: val.split(',') };
      } else {
        matchFilter['marketId'] = val;
      }
    }
    if (data === 'script') matchFilter['scriptName'] = { $regex: new RegExp(`^${val}$`, 'i') };
    if (data === 'valan') matchFilter['valanId'] = new mongoose.Types.ObjectId(val);
    if (data === 'startDate' || data === 'endDate') {
      const { startOfDay, endOfDay } = getCurrentDateRange(val);
      matchFilter['createdAt'] = {
        ...matchFilter['createdAt'],
        [data === 'startDate' ? '$gte' : '$lte']: data === 'startDate' ? startOfDay : endOfDay
      };
    }
    if (data === 'master') matchFilter['parentIds'] = new mongoose.Types.ObjectId(val);
    if (data === 'broker') matchFilter['brokerIds'] = new mongoose.Types.ObjectId(val);
    if (data === 'client') matchFilter['userId'] = new mongoose.Types.ObjectId(val);
  });

  if (!matchFilter['marketId']) {
    matchFilter['marketId'] = { $ne: '12' };
  }
  const askerExtraOpts = (askerLevel === 6)
    ? { askerLevel: 6, askerId: reqUserId.toString() }
    : {};

  let brokerLevelMatch;
  if (level === 6) {
    // Broker view: include ALL trades of this broker's clients (by client id),
    // not just trades where brokerIds was tagged. Matches the downstream broker
    // rendering which is already restricted to brokerPartnership clients.
    const brokerIdObj = new mongoose.Types.ObjectId(userId);
    const brokerIdStr = userId.toString();
    const brokerClients = await UserModel.find({
      $or: [
        { 'basicDetails.brokerPartnership.broker._id': brokerIdObj },
        { 'basicDetails.brokerPartnership.broker._id': brokerIdStr },
        { 'basicDetails.brokerPartnership.broker': brokerIdObj },
        { 'basicDetails.brokerPartnership.broker': brokerIdStr }
      ],
      isDeleted: false,
      demoid: isRequesterDemo ? true : { $ne: true }
    }).select('_id').lean();
    brokerLevelMatch = { userId: { $in: brokerClients.map(c => c._id) } };
  } else {
    const filterKey = level === 7 ? 'userId' : 'parentIds';
    brokerLevelMatch = { $or: [{ [filterKey]: new mongoose.Types.ObjectId(userId) }, { [filterKey]: userId.toString() }] };
  }

  const result = await getProfitLossWithLivePrices(
    {
      ...brokerLevelMatch,
      transactionStatus: 'COMPLETED',
      ...matchFilter
    },
    level,
    userId.toString(),
    askerExtraOpts
  );
  const response = result && result.data ? result.data : result;
  const socketSymbols = result && result.socketSymbols && Array.isArray(result.socketSymbols) ? result.socketSymbols : [];
  const responseMap = new Map(response.map((item) => [item.userId.toString(), item]));
  const getParentsId = [...new Set(response.flatMap((ids) => ids.parentIds.slice(level)))];
  const getClientId = [...new Set(response.map((ids) => ids.userId.toString()))];

  // Fetch all descendants in the sub-tree to calculate recursive limits
  const allUsersInHierarchy = await UserModel.find({
    $or: [{ _id: new mongoose.Types.ObjectId(userId) }, { parentIds: new mongoose.Types.ObjectId(userId) }],
    isDeleted: false,
    demoid: isRequesterDemo ? true : { $ne: true }
  })
    .select('accountCode accountName accountDetails parentIds partnership')
    .lean();

  if (level === 6) {
    const getClientId = [...new Set(response.map((ids) => ids.userId.toString()))];
    const brokerIdObj = new mongoose.Types.ObjectId(userId);
    const brokerIdStr = userId.toString();
    const brokerClient = await UserModel.find({
      _id: { $in: getClientId },
      $or: [
        { 'basicDetails.brokerPartnership.broker._id': brokerIdObj },
        { 'basicDetails.brokerPartnership.broker._id': brokerIdStr },
        { 'basicDetails.brokerPartnership.broker': brokerIdObj },
        { 'basicDetails.brokerPartnership.broker': brokerIdStr }
      ],
      isDeleted: false,
      demoid: isRequesterDemo ? true : { $ne: true }
    })
      .select('accountName accountCode partnership accountType')
      .populate('accountType', 'label level')
      .lean();

    const combinedData = brokerClient.map((el) => {
      const dt = responseMap.get(el._id.toString()) || {};
      const totalM2M = Number(dt.m2m) || 0;
      const partnership = el.partnership || [];
      const uplineShare = partnership.slice(0, level - 1).reduce((acc, v) => acc + (Number(v) || 0), 0);
      const selfShare = 100 - uplineShare;

      const rowData = { ...dt };
      rowData.uplineNetPrice = (totalM2M * uplineShare * -1) / 100;
      rowData.selfNetPrice = (totalM2M * selfShare * -1) / 100;
      rowData.downlineNetPrice = 0;

      const limits = getRecursiveM2MLimits(el._id, allUsersInHierarchy, level);
      return { ...el, ...rowData, ...limits, valanId: matchFilter['valanId'] };
    });

    const reportsTotal = combinedData.reduce(
      (acc, it) => {
        acc.m2m += Number(it.m2m) || 0;
        acc.selfNetPrice += Number(it.selfNetPrice) || 0;
        acc.uplineNetPrice += Number(it.uplineNetPrice) || 0;
        acc.downlineNetPrice += Number(it.downlineNetPrice) || 0;
        return acc;
      },
      {
        m2m: 0,
        selfNetPrice: 0,
        uplineNetPrice: 0,
        downlineNetPrice: 0,
        gross: 0,
        brokerage: 0,
        bill: 0,
        selfBrokerage: 0,
        brokerNetPrice: 0,
        summedOtherBrokerage: [0, 0, 0, 0, 0]
      }
    );

    return { data: combinedData, reportsTotal, socketSymbols };
  }

  const allDirectUsers = await UserModel.find({
    _id: { $in: [...getParentsId, ...getClientId] },
    demoid: isRequesterDemo ? true : { $ne: true }
  })
    .select({
      accountName: 1,
      accountCode: 1,
      partnership: 1,
      accountDetails: 1,
      createdBy: 1
    })
    .populate('accountType', 'label level -_id')
    .lean();

  const myDirect = allDirectUsers.filter((u) => u.accountType?.level < 7);
  const myDirectClient = allDirectUsers.filter((u) => u.accountType?.level === 7);
  const myDirectWithSum = myDirect.map((element) => {
    const getSum = getTotalSum(response, element._id);
    const totalM2M = getSum.m2m || 0;
    const partnership = element.partnership || [];
    const uplineShare = partnership.slice(0, level - 1).reduce((acc, v) => acc + (Number(v) || 0), 0);
    const selfShare = partnership[level - 1] || 0;
    const brokerShare = Number(partnership[5]) || 0;
    const totalSelfShare = selfShare + brokerShare;
    const downlineShare = 100 - uplineShare - totalSelfShare;

    // User requested fix: self brokerage = (client brokerage - broker brokerage) * (myShare + brokerShare) / 100
    // SuperAdmin/upper level sees both their own % AND broker % in selfBrokerage
    const recalculatedSelfBrokerage = ((getSum.brokerage - getSum.brokerBrokerage) * totalSelfShare) / 100;

    const recalculatedUplineNetPrice = (totalM2M * uplineShare * -1) / 100;
    const recalculatedSelfNetPrice = (totalM2M * totalSelfShare * -1) / 100;
    const recalculatedDownlineNetPrice = (totalM2M * downlineShare * -1) / 100;

    const limits = getRecursiveM2MLimits(element._id, allUsersInHierarchy, level);

    return {
      ...element,
      ...getSum,
      ...limits,
      selfNetPrice: recalculatedSelfNetPrice,
      selfBrokerage: recalculatedSelfBrokerage,
      uplineNetPrice: recalculatedUplineNetPrice,
      downlineNetPrice: recalculatedDownlineNetPrice,
      brokerNetPrice: 0,
      valanId: matchFilter['valanId']
    };
  });
  const myDirectClientWithData = myDirectClient.map((element) => {
    const dt = responseMap.get(element._id.toString()) || {};
    const totalM2M = Number(dt.m2m) || 0;

    // Back-derive uplineShare% and brokerShare% from pipeline values
    const uplineNetPrice = Number(dt.uplineNetPrice) || 0;
    const brokerNetPrice = Number(dt.brokerNetPrice) || 0;
    const uplineSharePct = totalM2M !== 0 ? (uplineNetPrice * -100) / totalM2M : 0;
    const brokerSharePct = totalM2M !== 0 ? (brokerNetPrice * -100) / totalM2M : 0;

    // General Self Share (including broker part)
    const fullSelfShare = 100 - uplineSharePct;

    // Check if the ACTUAL logged-in user (reqUserId) is the direct parent (creator)
    const isDirectParent = element.createdBy?.userId?.toString() === reqUserId?.toString();

    let selfNetPrice;
    let selfBrokerage;

    if (askerLevel === 6) {
      // Broker asker: trust pipeline + enriched (live-adjusted finalM2M based).
      selfNetPrice = Number(dt.selfNetPrice) || 0;
      selfBrokerage = Number(dt.selfBrokerage) || 0;
    } else if (isDirectParent) {
      // Direct parent: selfNetPrice excludes broker share
      const netSelfShare = 100 - uplineSharePct - brokerSharePct;
      selfNetPrice = (totalM2M * netSelfShare * -1) / 100;

      // Direct parent: selfBrokerage uses ONLY viewer's own fixed partnership %
      const viewerOwnShare = Number(dt.myShare) || 0; // partnership[level-1]
      selfBrokerage = ((Number(dt.brokerage) - Number(dt.brokerBrokerage)) * viewerOwnShare) / 100;
    } else {
      // Upper level drilling down: includes full slice (own share + broker share)
      selfNetPrice = (totalM2M * fullSelfShare * -1) / 100;
      selfBrokerage = ((Number(dt.brokerage) - Number(dt.brokerBrokerage)) * fullSelfShare) / 100;
    }

    const rowData = { ...dt };
    rowData.selfNetPrice = selfNetPrice;
    rowData.selfBrokerage = selfBrokerage;
    rowData.downlineNetPrice = askerLevel === 6 ? (Number(dt.downlineNetPrice) || 0) : 0;

    const summedOtherBrokerage = (rowData.summedOtherBrokerage || []).flat(1);
    const aggregatedSum = summedOtherBrokerage.reduce((acc, item) => {
      if (!acc[item.brokerId]) acc[item.brokerId] = 0;
      acc[item.brokerId] += item.netBrokerage || 0;
      return acc;
    }, {});
    rowData.summedOtherBrokerage = [...Object.values(aggregatedSum), ...new Array(5 - Object.values(aggregatedSum).length).fill(0)];

    const limits = getRecursiveM2MLimits(element._id, allUsersInHierarchy, level);

    return { ...element, ...rowData, ...limits, valanId: matchFilter['valanId'] };
  });
  const combinedData = [...myDirectWithSum, ...myDirectClientWithData];

  // Asker level 7 (customer viewing own report): bill = self, no broker margin/my brokerage/self brokerage
  if (askerLevel === 7) {
    combinedData.forEach((row) => {
      row.selfNetPrice = Number(row.bill) || 0;
      row.brokerBrokerage = 0;
      row.myBrokerage = 0;
      row.selfBrokerage = 0;
    });
  }

  // Log final data being sent (socket)
  // console.log('\n🚀 FINAL DATA (SOCKET):');

  const reportsTotal = combinedData.reduce(
    (acc, item) => {
      acc.gross += Number(item.gross) || 0;
      acc.brokerage += Number(item.brokerage) || 0;
      acc.bill += Number(item.bill) || 0;
      acc.m2m += Number(item.m2m) || 0;
      acc.selfBrokerage += Number(item.selfBrokerage) || 0;
      acc.selfNetPrice += Number(item.selfNetPrice) || 0;
      acc.downlineNetPrice += Number(item.downlineNetPrice) || 0;
      acc.uplineNetPrice += Number(item.uplineNetPrice) || 0;
      acc.brokerNetPrice += Number(item.brokerNetPrice) || 0;
      (item.summedOtherBrokerage || []).forEach((v, i) => {
        if (i < 5) acc.summedOtherBrokerage[i] += Number(v) || 0;
      });
      return acc;
    },
    {
      gross: 0,
      brokerage: 0,
      bill: 0,
      m2m: 0,
      selfBrokerage: 0,
      selfNetPrice: 0,
      downlineNetPrice: 0,
      uplineNetPrice: 0,
      brokerNetPrice: 0,
      summedOtherBrokerage: [0, 0, 0, 0, 0]
    }
  );
  return { data: combinedData, reportsTotal, scriptNames: result?.scriptNames || [], socketSymbols };
};
const getTotalSum = (data, id) => {
  const idString = id.toString();

  const initialValues = {
    brokerage: 0,
    bill: 0,
    m2m: 0,
    brokerBrokerage: 0,
    gross: 0,
    selfBrokerage: 0,
    myShare: 0,
    selfNetPrice: 0,
    brokerNetPrice: 0,
    uplineNetPrice: 0,
    downlineNetPrice: 0,
    summedOtherBrokerage: [0, 0, 0, 0, 0],
    stockTransactions: []
  };

  const result = data.reduce(
    (acc, item) => {
      const isHierarchyMatch = item.parentIds && item.parentIds.some((parentId) => parentId.toString() === idString);
      const isBrokerMatch = item.brokerIds && item.brokerIds.some((brokerId) => brokerId?.toString() === idString);

      if (isHierarchyMatch || isBrokerMatch) {
        for (const key in initialValues) {
          if (key === 'summedOtherBrokerage') {
            if (item[key] && Array.isArray(item[key])) {
              const summedOtherBrokerage = item.summedOtherBrokerage.flat(1);

              const aggregatedSum = summedOtherBrokerage.reduce((accInner, it) => {
                if (!accInner[it.brokerId]) accInner[it.brokerId] = 0;
                accInner[it.brokerId] += it.netBrokerage || 0;
                return accInner;
              }, {});

              Object.values(aggregatedSum).forEach((val, index) => {
                if (index < acc[key].length) acc[key][index] += val;
              });
            }
          } else if (key === 'stockTransactions') {
            if (item[key] && Array.isArray(item[key])) {
              acc[key].push(...item[key]);
            }
          } else {
            const val = item[key];
            if (val !== undefined && val !== null) {
              const n = typeof val === 'number' ? val : parseFloat(val);
              if (!isNaN(n)) acc[key] += n;
            }
          }
        }
      }
      return acc;
    },
    JSON.parse(JSON.stringify(initialValues))
  );

  return result;
};

exports.getStocksUserScriptWise = async (req, res) => {
  try {
    let { id, market, script, scriptName, valan, startDate, endDate, applyExtraMatch } = req.query;
    if (startDate === 'undefined' || startDate === 'null') startDate = undefined;
    if (endDate === 'undefined' || endDate === 'null') endDate = undefined;
    if (market === 'undefined' || market === 'null') market = undefined;
    if (script === 'undefined' || script === 'null') script = undefined;
    if (valan === 'undefined' || valan === 'null') valan = undefined;
    if (id === 'undefined' || id === 'null' || id === '') id = undefined;
    let userId = getEffectiveUserId(req);
    let level = req.user.accountType?.level;
    if (id && String(id).toLowerCase() !== 'self') {
      userId = id;
      const userDoc = await getUser({ _id: userId }, { _id: 0, accountCode: 1, accountName: 1, accountType: 1 });
      if (!userDoc || !userDoc.accountType) {
        console.warn(`[getStocksUserScriptWise] User ${userId} not found or missing accountType`);
        return res.status(200).send({ status: "true", data: [], message: "User not found" });
      }
      level = userDoc.accountType.level;
    }
    const userIdObj = new mongoose.Types.ObjectId(userId);
    const user = await getUser({ _id: userIdObj }, { _id: 0, accountCode: 1, accountName: 1, accountType: 1 });

    const matchFilter = {};
    const { _id: activeValanId, startDate: valanStart, endDate: valanEnd, label: valanLabel } = await getActiveWeekValan();
    if (valan) {
      matchFilter['valanId'] = new mongoose.Types.ObjectId(valan);
    } else if (!startDate && !endDate) {
      matchFilter['valanId'] = activeValanId;
    }

    const filterKeys = { market, script, valan, startDate, endDate };
    Object.keys(filterKeys).forEach((data) => {
      const val = filterKeys[data];
      if (!val || val === 'undefined' || val === 'null') return;
      if (data === 'market') {
        if (val === 'all') {
          // no filter
        } else if (typeof val === 'string' && val.includes(',')) {
          matchFilter['marketId'] = { $in: val.split(',') };
        } else {
          matchFilter['marketId'] = val;
        }
      }
      // If market is NOT provided → exclude 12
      if (!market) {
        matchFilter['marketId'] = { $ne: '12' };
      }
      if (data === 'scriptName') {
        matchFilter['scriptName'] = { $regex: new RegExp(`^${val}$`, 'i') };
      }
      if (data === 'script') {
        matchFilter['scriptName'] = { $regex: new RegExp(`^${val.split(' ')[0]}$`, 'i') };
      }
      if (data === 'valan') {
        matchFilter['valanId'] = new mongoose.Types.ObjectId(val);
      }
      if (data === 'startDate' || data === 'endDate') {
        const { startOfDay, endOfDay } = getCurrentDateRange(val);
        matchFilter['createdAt'] = {
          ...matchFilter['createdAt'],
          [data === 'startDate' ? '$gte' : '$lte']: data === 'startDate' ? startOfDay : endOfDay
        };
      }
    });

    const response = await getStocksUserScriptWise(
      {
        [user.accountType.level == 7 ? 'userId' : user.accountType.level == 6 ? 'brokerIds' : 'parentIds']: userIdObj,
        transactionStatus: 'COMPLETED',
        ...matchFilter
      },
      level,
      applyExtraMatch
    );

    const valanInfo = { valanStart, valanEnd, valanLabel };
    res.status(200).json({ status: true, data: response, user, valanInfo });
  } catch (error) {
    console.error(error);
    res.status(500).json({ status: false, message: error.message });
  }
};

exports.getScriptWiseReport = async (req, res) => {
  try {
    let { id, clientId, clientid, market, script, scriptName, valan, startDate, endDate } = req.query;
    if (startDate === 'undefined' || startDate === 'null') startDate = undefined;
    if (endDate === 'undefined' || endDate === 'null') endDate = undefined;
    if (market === 'undefined' || market === 'null') market = undefined;
    if (script === 'undefined' || script === 'null') script = undefined;
    if (valan === 'undefined' || valan === 'null') valan = undefined;
    let userId = id || clientId || clientid || req.query.userId;
    if (!userId || String(userId).toLowerCase() === 'self') {
      userId = getEffectiveUserId(req);
    }
    userId = new mongoose.Types.ObjectId(userId);

    const matchFilter = {};
    const { _id: activeValanId, startDate: valanStart, endDate: valanEnd, label: valanLabel } = await getActiveWeekValan();

    if (valan) {
      matchFilter['valanId'] = new mongoose.Types.ObjectId(valan);
    } else if (!startDate && !endDate) {
      matchFilter['valanId'] = activeValanId;
    }

    const filterKeys = { market, script, startDate, endDate };
    Object.keys(filterKeys).forEach((key) => {
      const val = filterKeys[key];
      if (!val || val === 'undefined' || val === 'null') return;

      if (key == 'market') {
        if (val === 'all') {
          // Skip
        } else if (val === '12') {
          matchFilter['marketId'] = '__NONE__';
        } else if (typeof val === 'string' && val.includes(',')) {
          matchFilter['marketId'] = { $in: val.split(',') };
        } else {
          matchFilter['marketId'] = val;
        }
      }
      if (key == 'scriptName') matchFilter['scriptName'] = { $regex: new RegExp(`^${val}$`, 'i') };
      if (key == 'script') matchFilter['scriptName'] = { $regex: new RegExp(`^${val.split(' ')[0]}$`, 'i') };
      if (key == 'startDate' || key == 'endDate') {
        const { startOfDay, endOfDay } = getCurrentDateRange(val);
        matchFilter['createdAt'] = {
          ...matchFilter['createdAt'],
          [key === 'startDate' ? '$gte' : '$lte']: key === 'startDate' ? startOfDay : endOfDay
        };
      }
    });

    const user = await getUser({ _id: userId }, { _id: 0, accountCode: 1, accountName: 1, accountType: 1 });

    if (!user || !user.accountType) {
      console.warn(`[getScriptWiseReport] User ${userId} not found or missing accountType`);
      return res.status(200).json({ status: true, data: [] });
    }

    const response = await getScriptWiseReport(
      {
        [user.accountType.level == 7 ? 'userId' : user.accountType.level == 6 ? 'brokerIds' : 'parentIds']: userId,
        transactionStatus: 'COMPLETED',
        ...matchFilter
      },
      user.accountType.level,
      userId
    );

    const valanInfo = { valanStart, valanEnd, valanLabel };
    res.status(200).json({ status: true, data: response, valanInfo });
  } catch (error) {
    console.error(error);
    res.status(500).json({ status: false, message: error.message });
  }
};

exports.getWeekValan = async (req, res) => {
  try {
    const response = await getWeekValan();
    res.status(200).json({ status: true, data: response });
  } catch (error) {
    res.status(500).json({ status: false, message: error.message });
  }
};
// new one
exports.getScriptSummaryReport = async (req, res) => {
  try {
    // ── Parameters (Merge Query and Body for fallback support) ──────────────────────────
    const params = { ...req.query, ...req.body };
    const { id, clientId, clientid, market, script, scriptName, valan, startDate, endDate, master, broker, client } = params;

    // Determine requester perspective (viewer's role)
    let userId = id;
    if (!userId || String(userId).toLowerCase() === 'self') {
      userId = getEffectiveUserId(req);
    }
    const userIdObj = new mongoose.Types.ObjectId(userId);

    // Fetch basic perspective user details
    const user = await getUser({ _id: userIdObj }, { accountCode: 1, accountName: 1, accountType: 1, demoid: 1 });
    if (!user) {
      return res.status(404).json({ status: false, message: 'Perspective user not found' });
    }
    const level = user.accountType.level;
    const isRequesterDemo = isDemoUser(req);

    // Security: Perspective user must match requester's demo status
    if (!isRequesterDemo && user.demoid === true) {
      return res.status(403).json({ status: false, message: 'Cannot access demo report from real account' });
    }
    if (isRequesterDemo && user.demoid !== true) {
      return res.status(403).json({ status: false, message: 'Cannot access real report from demo account' });
    }


    // ── Build Match Filter ────────────────────────────────────────────────
    const matchFilter = {};

    // 1. Valan / Date range
    const hasStartDate = startDate && startDate !== 'undefined' && startDate !== 'null';
    const hasEndDate = endDate && endDate !== 'undefined' && endDate !== 'null';

    if (hasStartDate || hasEndDate) {
      matchFilter['createdAt'] = {};
      if (hasStartDate) matchFilter['createdAt']['$gte'] = new Date(`${startDate}T00:00:00.000+05:30`);
      if (hasEndDate) matchFilter['createdAt']['$lte'] = new Date(`${endDate}T23:59:59.999+05:30`);
    } else if (valan && valan !== 'undefined' && valan !== 'null') {
      matchFilter['valanId'] = new mongoose.Types.ObjectId(valan);
    } else {
      const activeValan = await getActiveWeekValan();
      matchFilter['valanId'] = activeValan._id;
    }

    // 2. Market filter
    if (market && market !== 'undefined' && market !== 'null' && market !== 'all') {
      if (market === '12') {
        matchFilter['marketId'] = '__NONE__';
      } else if (typeof market === 'string' && market.includes(',')) {
        matchFilter['marketId'] = { $in: market.split(',') };
      } else {
        matchFilter['marketId'] = market;
      }
    } else {
      matchFilter['marketId'] = { $ne: '12' };
    }

    // 3. Script name filter
    if (scriptName) {
      matchFilter['scriptName'] = { $regex: new RegExp(`^${scriptName}$`, 'i') };
    } else if (script) {
      // Handles formats like "GOLD 30MAR2026"
      const baseName = script.split(' ')[0];
      matchFilter['scriptName'] = { $regex: new RegExp(`^${baseName}$`, 'i') };
    }

    // 4. Hierarchy / User isolation logic
    const targetUserId = clientId || clientid || params.userId || client || broker || master;

    if (targetUserId && targetUserId !== 'undefined' && targetUserId !== 'null' && targetUserId !== 'self' && targetUserId !== 'all') {
      const targetUserIdObj = new mongoose.Types.ObjectId(targetUserId);
      const targetUser = await getUser({ _id: targetUserIdObj }, { accountType: 1 });
      const targetLevel = targetUser?.accountType?.level || 7;

      if (targetLevel === 7) {
        // Specifically filtering for a single client
        matchFilter['userId'] = { $in: [targetUserIdObj, targetUserId.toString()] };
      } else {
        // Filtering for a master or broker (show sum of their combined downlines)
        const targetKey = targetLevel === 6 ? 'brokerIds' : 'parentIds';
        matchFilter[targetKey] = { $in: [targetUserIdObj, targetUserId.toString()] };
      }

      // SECURITY: Force scope to stay within the requester's hierarchy if not viewing self
      if (level !== 7 && userIdObj.toString() !== targetUserId.toString()) {
        const hierarchyKey = level === 6 ? 'brokerIds' : 'parentIds';

        // If the key exists (e.g. Master level 2 filtering for a Sub-master level 3), use $and to avoid overwrite
        if (matchFilter[hierarchyKey]) {
          const existing = matchFilter[hierarchyKey];
          delete matchFilter[hierarchyKey];
          matchFilter['$and'] = [
            { [hierarchyKey]: existing },
            { [hierarchyKey]: { $in: [userIdObj, userId.toString()] } }
          ];
        } else {
          matchFilter[hierarchyKey] = { $in: [userIdObj, userId.toString()] };
        }
      }
    } else {
      // DEFAULT: View all downlines under the current requester perspective
      const defaultKey = level === 7 ? 'userId' : level === 6 ? 'brokerIds' : 'parentIds';
      matchFilter[defaultKey] = { $in: [userIdObj, userId.toString()] };
    }

    matchFilter['transactionStatus'] = 'COMPLETED';

    const reports = await getScriptSummaryReport(matchFilter, level, userIdObj, isRequesterDemo);

    // Fetch active valan info for return
    const activeWeek = await getActiveWeekValan();
    const valanInfo = {
      valanStart: activeWeek.startDate,
      valanEnd: activeWeek.endDate,
      valanLabel: activeWeek.label
    };

    res.status(200).json({ status: true, data: { reports, valanInfo } });
  } catch (error) {
    console.error('getScriptSummaryReport Error:', error);
    res.status(500).json({ status: false, message: error.message });
  }
};

const convertTime = (time) => {
  const currentDate = moment().format('YYYY-MM-DD');
  const dateTimeStr = `${currentDate} ${time}`;
  const dateTime = moment(dateTimeStr, 'YYYY-MM-DD HH:mm:ss');
  return dateTime.valueOf();
};

exports.exitPosition = async (req, res) => {
  try {
    const { effectiveUserId, loginUserId } = getUserContext(req);
    const transactions = req.body.transactions;
    if (!Array.isArray(transactions) || transactions.length === 0) {
      return res.status(400).json({
        status: 'false',
        message: 'No transactions provided.'
      });
    }

    // Fetch the requester's full profile once at the top
    const requester = await UserModel.findById(loginUserId).populate('accountType').lean();
    if (!requester) {
      return res.status(401).json({ status: 'false', message: 'Requester not found' });
    }

    const userIp = req.headers['x-forwarded-for'] || req.socket.remoteAddress || req.ip;

    // ---------------- STALE PRICE CHECK ----------------
    const firstTx = transactions[0];
    const stalenessConfig = await ScriptFroze.findOne({
      scriptId: firstTx.scriptId,
      isEnabled: true
    }).lean();
    if (stalenessConfig) {
      const lastTick = await redisClient.get(`last_tick:${firstTx.scriptId}`);
      if (lastTick) {
        const diff = Date.now() - parseInt(lastTick);
        const timeoutMs = stalenessConfig.timeoutSeconds * 1000;
        if (diff > timeoutMs) {
          return res.status(400).json({
            status: 'false',
            message: `Market data is stale (last update ${Math.round(diff / 1000)}s ago). Trading paused.`
          });
        }
      } else {
        return res.status(400).json({
          status: 'false',
          message: 'Market data not available yet. Trading paused.'
        });
      }
    }
    // ---------------- END STALE CHECK ----------------

    const getValan = await getActiveWeekValan();
    if (!getValan) {
      return res.status(400).json({
        status: 'false',
        message: 'No active valan found.'
      });
    }

    const results = await Promise.allSettled(
      transactions.map(async (tx, index) => {
        try {
          let {
            marketId,
            marketName,
            scriptId,
            scriptName,
            label,
            lot,
            quantity,
            price,
            transactionType,
            orderType,
            userId,
            message: txMessage,
            limitPrice
          } = tx;

          quantity = Number(quantity) || 0;
          lot = Number(lot) || 0;

          // Determine if this is a pending order (limit/stop loss)
          const isPendingOrder = ['LIMIT', 'Limit', 'STOPPLOSS', 'STOPLOSS', 'SL', 'SL-M'].some(type =>
            String(orderType).toUpperCase().includes(type)
          );

          // For pending orders, use limitPrice if provided
          if (isPendingOrder && limitPrice !== undefined && limitPrice !== null) {
            price = Number(limitPrice);
          } else {
            price = Number(price) || 0;
          }

          // Always fetch live price to ensure trade ability
          let liveStock = null;
          const identifiersToTry = [scriptId, label, scriptName].filter(Boolean);
          for (const ident of identifiersToTry) {
            const data = await getLiveStock(ident);
            if (data) {
              liveStock = typeof data === "string" ? JSON.parse(data) : data;
              break;
            }
          }

          if (!liveStock) {
            throw new Error(`No live data found for ${label || scriptName}`);
          }

          if (!isPendingOrder || !price) {
            if (!price || orderType === "MARKET" || orderType === "Market" || (typeof orderType === 'string' && orderType.includes("Exit Position"))) {
              const bid = Number(liveStock.BuyPrice || liveStock.Bid || 0);
              const ask = Number(liveStock.SellPrice || liveStock.Ask || 0);
              const ltp = Number(liveStock.LastTradePrice || 0);

              // Requirement: Apply variation
              let basePrice = 0;
              if (transactionType === "BUY") {
                basePrice = ask || ltp;
              } else {
                basePrice = bid || ltp;
              }

              // We'll calculate variation later when quantitySetting is fetched
              price = basePrice;
            }
          }



          if (!price && !isPendingOrder) {
            throw new Error(`Live price not available for ${label || scriptName}`);
          }
          tx.price = price; // Sync back for validators

          const currentLivePrice = (transactionType === "BUY")
            ? (Number(liveStock.SellPrice) || Number(liveStock.Ask) || Number(liveStock.LastTradePrice) || 0)
            : (Number(liveStock.BuyPrice) || Number(liveStock.Bid) || Number(liveStock.LastTradePrice) || 0);

          const isStopLoss = isPendingOrder ? ((transactionType === "BUY") ? price > currentLivePrice : price < currentLivePrice) : false;

          if (!userId) {
            userId = loginUserId;
          }

          // Check requester's permissions for every transaction
          if (requester.basicDetails.viewOnlyAccess == 1) {
            throw new Error('Trading is not allowed as you are in view-only mode.');
          }

          lot = +lot;

          const userIp = req.ip;
          const expiry = getExpiry(label);

          const currentTime = moment().valueOf();
          const checkHoliday = await getHolidayByFilter({
            marketId,
            startDate: { $lte: currentTime },
            endDate: { $gte: currentTime }
          });

          if (checkHoliday) {
            const hStart = moment(checkHoliday.startDate);
            let holidayMessage = 'Market Closed due to ' + checkHoliday.holiday;
            if (hStart.format('HH:mm') !== '00:00') {
              holidayMessage = `Market Closed from ${hStart.format('hh:mm A')} due to ${checkHoliday.holiday}`;
            }
            throw new Error(holidayMessage);
          }

          let message = txMessage || 'Stock ' + transactionType.toLowerCase() + ' successfully';
          let transactionStatus = isPendingOrder ? 'PENDING' : 'COMPLETED';

          // Market Timing Check moved below getParentDetails

          // Fetch limits and variation
          // COMMENTED OUT: Qty settings validation
          // let qSettings = await quantitySetting
          //   .find({
          //     clientId: userId,
          //     marketId: marketId,
          //     $or: [{ scriptId: scriptId }, { scriptId: "999" }]
          //   })
          //   .lean();
          //
          // const qSettingScript = qSettings.find(q => q.scriptId === scriptId);
          // const qSettingDefault = qSettings.find(q => q.scriptId === "999");
          // const qSetting = qSettingScript || qSettingDefault;
          //
          // const variation = (qSetting && isWithinVariationTime(qSetting.variationStartTime, qSetting.variationEndTime))
          //   ? (Number(qSetting.buySellVariation) || 0)
          //   : 0;
          //
          // // Apply variation to market price
          // if (!isPendingOrder && (orderType === "MARKET" || orderType === "Market" || (typeof orderType === 'string' && orderType.includes("Exit Position")))) {
          //   if (transactionType === "BUY") {
          //     price = price + variation;
          //   } else {
          //     price = price - variation;
          //   }
          //   tx.price = price;
          // }
          //
          // const lotLimits = qSettings.filter(q => q.scriptId === scriptId).find((lmt) => lmt.qtySetting == 'Lot');
          // const qtyLimits = qSettings.filter(q => q.scriptId === scriptId).find((lmt) => lmt.qtySetting == 'Qty');


          const services = await getParentDetails(userId, marketId);
          if (!services) {
            throw new Error('User details not found');
          }

          const {
            marketAccess,
            basicDetails,
            accountDetails,
            partnership,
            parentIds,
            myParent,
            minPercentageWiseBrokerage,
            minLotWiseBrokerage,
            getMarket
          } = services;

          if (!getMarket) {
            throw new Error('Segment is missing or not allowed for this user');
          }

          services.getValan = getValan;

          // ===== ORIGINAL VALIDATION LOGIC =====
          // 2. Market Timing Check (Dynamic with Square-off allowance)
          const marketValidation = await CommonStockValidator.validateMarketStatus(tx, services);
          if (!marketValidation.isValid) {
            throw new Error(marketValidation.message);
          }

          // Order Type Specific Validation
          if (liveStock) {
            if (orderType === "MARKET" || orderType === "Market" || (typeof orderType === 'string' && orderType.includes("Exit Position"))) {
              const mktVal = await MarketOrderValidator.validate(tx, services, liveStock);
              if (!mktVal.isValid) throw new Error(mktVal.message);
            } else if (orderType === "LIMIT" || orderType === "Limit") {
              console.log(`[LIMIT-DEBUG][Controller:batch] LimitOrderValidator userId=${tx.userId} scriptId=${tx.scriptId} marketId=${tx.marketId} price=${tx.price} orderType=${orderType}`);
              const lmtVal = await LimitOrderValidator.validate(tx, services, liveStock);
              console.log(`[LIMIT-DEBUG][Controller:batch] Result isValid=${lmtVal.isValid} message=${lmtVal.message || ''}`);
              if (!lmtVal.isValid) throw new Error(lmtVal.message);
            }
          }

          /* ===== PARALLEL VALIDATIONS (COMMENTED OUT) =====
          // Create base rejection log for validations
          const baseRejectionLog = {
            action: 'INS',
            clientId: userId,
            marketId: marketId,
            scriptId: scriptId,
            symbol: label || scriptName,
            order_type: orderType,
            lot: lot,
            qty: quantity,
            order_price: price,
            message: '',
            ip: userIp,
            time: new Date(),
            parentIds: parentIds,
            txn_type: transactionType
          };

          const [
            basicValidation,
            marketValidation,
            qtyValidation,
            expiryValidation,
            squareOffValidation,
            m2mValidation,
            marginValidation,
            orderTypeValidation
          ] = await Promise.all([
            CommonStockValidator.validateBasicRules(tx, services),
            CommonStockValidator.validateMarketStatus(tx, services),
            CommonStockValidator.validateQuantityLimits(
              userId,
              scriptId,
              marketId,
              lot,
              quantity,
              price,
              parentIds,
              scriptName,
              transactionType,
              getValan._id
            ),
            CommonStockValidator.validateExpiryStatus(tx, services),
            CommonStockValidator.validatePositionSquareOff(tx, services),
            CommonStockValidator.validateM2MLimits(tx, services),
            CommonStockValidator.validateMarginLimits(tx, services),
            isPendingOrder
              ? LimitOrderValidator.validate(tx, services, liveStock)
              : MarketOrderValidator.validate(tx, services, liveStock)
          ]);

          // Check all validation results
          const validations = [
            { name: 'Basic Rules', result: basicValidation },
            { name: 'Market Status', result: marketValidation },
            { name: 'Quantity Limits', result: qtyValidation },
            { name: 'Expiry Status', result: expiryValidation },
            { name: 'Square-Off', result: squareOffValidation },
            { name: 'M2M Limits', result: m2mValidation },
            { name: 'Margin Limits', result: marginValidation },
            { name: 'Order Type', result: orderTypeValidation }
          ];

          for (const validation of validations) {
            if (!validation.result.isValid) {
              baseRejectionLog.message = validation.result.message;
              await saveLog('rejection', baseRejectionLog);
              throw new Error(validation.result.message);
            }
          }
          ===== END PARALLEL VALIDATIONS ===== */

          const brokerIds = (basicDetails.brokerPartnership || []).map((bkr) =>
            bkr.broker && bkr.broker._id ? bkr.broker._id : bkr.broker
          );

          if (marketId == '2') {
            if (+price < +getMarket.brokerage.minScriptRate) {
              throw new Error('Min Script rate is ' + getMarket.brokerage.minScriptRate);
            }
          }

          if (marketId == '3') {
            if (+price < +getMarket.other.minRateScriptBlock && transactionType == 'BUY') {
              throw new Error('Min Script rate is ' + getMarket.other.minRateScriptBlock);
            }
          }

          const checkQuantity = await getUserQuantity({
            userId,
            marketId,
            marketName,
            scriptId,
            scriptName,
            quantity,
            transactionType
          });

          // Use BrokerageService for consistent brokerage calculation
          const BrokerageService = require('../services/BrokerageService');
          const brokerageResult = await BrokerageService.calculateBrokerage({
            ...tx,
            userId,
            marketId,
            marketName,
            scriptId,
            scriptName,
            quantity,
            transactionType,
            lot,
            price,
            type: 'NRM',
            label,
            orderType,
            quantityType: checkQuantity
          }, services);

          const {
            netPrice,
            totalNetPrice,
            orderBrokerage,
            netBrokerage,
            brokeragePercentage,
            m2mPrice,
            otherBrokerage,
            brokerTotalPercentage,
            brokeragePercentageType,
            brokerTotalBrokerage,
            brockersBrokerage,
            totalOrderPrice
          } = brokerageResult;

          const checkMargins = await getMarketWiseClientMargin(
            userId,
            {
              transactionStatus: 'COMPLETED',
              marketId,
              valanId: getValan._id
            },
            {
              $project: {
                marketId: 1,
                // transactions: {
                //   $concatArrays: [
                //     "$transactions",
                //     [
                //       {
                //         txnType: transactionType,
                //         qty: quantity,
                //         lot: lot,
                //         price: price,
                //         date: new Date(),
                //       },
                //     ],
                //   ],
                // },
                transactions: {
                  $concatArrays: ['$transactions', []]
                }
              }
            }
          );

          let margin = 0;
          let newBuyQty = (brokerageResult.newBuyQty || 0);
          let newSellQty = (brokerageResult.newSellQty || 0);
          if (checkMargins.length != 0) {
            // if position exist with same market
            let markets = checkMargins[0].markets;
            let scriptFound = false;
            markets = markets.map((market) => {
              // if script position exist recalculate lot margin with new order.
              if (market.marketId == marketId && market.scriptId == scriptId) {
                scriptFound = true;
                newBuyQty += market.buyQty;
                newSellQty += market.sellQty;
                market.buyQty = newBuyQty;
                market.sellQty = newSellQty;
                if (market.buyQty == market.sellQty) {
                  market.netMargin = 0;
                  market.netLot = 0;
                } else {
                  market.netLot = parseFloat(market.netLot) + (transactionType == 'BUY' ? lot : -Math.abs(lot));
                  market.netMargin = market.netMargin + (transactionType == 'BUY' ? totalOrderPrice : -Math.abs(totalOrderPrice));
                }
              }
              return market;
            });
            const { latestMargin, latestLotWise } = markets.reduce(
              (acc, item) => {
                acc.latestMargin += Math.abs(item.netMargin);
                acc.latestLotWise += Math.abs(item.netLot);
                return acc;
              },
              {
                latestMargin: scriptFound ? 0 : totalOrderPrice, //if script position does not exist add it.
                latestLotWise: scriptFound ? 0 : lot
              }
            );
            const lotOrAmount = getMarket.margin.lotOrAmount;
            margin = lotOrAmount == 'lot' ? latestLotWise : latestMargin;
          } else {
            const lotOrAmount = getMarket.margin.lotOrAmount;
            margin = lotOrAmount == 'lot' ? lot : totalOrderPrice;
          }



          // Determine message and shortmsg based on order type
          if (isPendingOrder) {
            const txnType = transactionType.toUpperCase();
            if (isStopLoss) {
              message = txnType === 'BUY' ? 'Buy stop loss placed' : 'Sell stop loss placed';
            } else {
              message = txnType === 'BUY' ? 'Buy limit placed' : 'Sell limit placed';
            }
          }

          const shortmsg = isPendingOrder
            ? (isStopLoss
              ? (transactionType === 'BUY' ? 'Buy stop loss' : 'Sell stop loss')
              : (transactionType === 'BUY' ? 'Buy limit' : 'Sell limit'))
            : 'Position exit (market)';

          // --------- Compute tradePosition from live price ---------
          // BUY: if order price < live SellPrice → DOWN (standard limit buy), else UP (stop buy)
          // SELL: if order price < live BuyPrice → DOWN (stop loss), else UP (standard limit sell)
          let tradePosition = 'NRM';
          const isBuyOrder = transactionType.toUpperCase() === 'BUY';
          if (isBuyOrder) {
            tradePosition = +price < parseFloat(liveStock.SellPrice) ? 'DOWN' : 'UP';
          } else {
            tradePosition = +price < parseFloat(liveStock.BuyPrice) ? 'DOWN' : 'UP';
          }
          // ----------------------------------------------------------

          const stock = {
            userId,
            valanId: getValan._id,
            marketId,
            marketName,
            scriptId,
            scriptName,
            label,
            expiry,
            lot,
            quantity,
            quantityType: brokerageResult.quantityType,
            orderPrice: price,
            totalOrderPrice,
            netPrice,
            totalNetPrice,
            orderBrokerage: isPendingOrder ? 0 : orderBrokerage,
            netBrokerage: isPendingOrder ? 0 : netBrokerage,
            brokeragePercentage: isPendingOrder ? 0 : brokeragePercentage,
            brokeragePercentageType: isPendingOrder ? { intraday: 0, delivery: 0 } : brokeragePercentageType,
            m2mPrice,
            brokerTotalBrokerage: isPendingOrder ? 0 : brokerTotalBrokerage,
            brokerTotalPercentage: isPendingOrder ? 0 : brokerTotalPercentage,
            otherBrokerage: isPendingOrder ? {} : otherBrokerage,
            type: 'NRM',
            transactionType,
            transactionStatus,
            orderType,
            ip: userIp,
            userAgent: req.headers['user-agent'],
            message,
            parentIds,
            myParent,
            brokerIds,
            partnership,
            minPercentageWiseBrokerage,
            minLotWiseBrokerage,
            createdBy: loginUserId,
            shortmsg,
            tradePosition, // server-computed — always overrides reqData
            isExitPosition: !isPendingOrder ? false : true,
            brockersBrokerage: isPendingOrder ? [] : (brockersBrokerage || [])
          };

          const savedStock = await saveTransaction(stock);

          if (!isPendingOrder) {
            const isEqualQty = (brokerageResult.newBuyQty || 0) == (brokerageResult.newSellQty || 0);
            await setUserPosition(userId, scriptId, getValan._id, isEqualQty);
            await updateUserQuantity(
              { userId },
              {
                previous: checkQuantity.previous,
                current: checkQuantity.current
              }
            );
          }

          DashboardStockEvent({
            userId,
            parentIds,
            marketId,
            scriptId,
            transactionType,
            valanId: getValan._id,
            lot,
            quantity,
            orderType,
            price,
            status: isPendingOrder ? 'PENDING' : 'COMPLETED',
            _id: savedStock._id,
            label
          });

          // 🔔 Monitor: notify watchers per exited/limit transaction (fire-and-forget)
          MonitorService.notifyWatchers(userId, isPendingOrder ? 'LIMIT_PLACED' : 'POSITION_EXIT', {
            loginUserId,
            isMultiLogin: req.context?.isMultiLogin || false,
            ip: userIp,
            device: req.headers['user-agent'] || 'Unknown',
            parentIds: parentIds || [],
            label,
            transactionType,
            lot,
            quantity,
            price,
            marketName,
            marketId,
            orderType,
            time: new Date()
          }).catch(() => { });

          return {
            status: 'true',
            message,
            scriptName,
            label,
            expiry,
            scriptId
          };
        } catch (error) {
          // Log the error with transaction index for debugging
          console.error(`Error processing transaction at index ${index}:`, error);
          return {
            status: 'false',
            message: error.message,
            error: error,
            scriptName: tx.scriptName,
            label: tx.label,
            expiry: getExpiry(tx.label), // Calculate expiry for error case too if possible
            scriptId: tx.scriptId
          };
        }
      })
    );

    // Prepare the response
    const successTransactions = results
      .filter((result) => result.status === 'fulfilled' && result.value.status === 'true')
      .map((result) => result.value);
    const failedTransactions = results
      .filter((result) => result.status === 'fulfilled' && result.value.status === 'false')
      .map((result) => result.value);
    const rejectedTransactions = results
      .filter((result) => result.status === 'rejected')
      .map((result) => ({
        status: 'false',
        message: result.reason.message,
        error: result.reason,
        scriptName: result.reason.scriptName,
        label: result.reason.label,
        expiry: result.reason.expiry,
        scriptId: result.reason.scriptId
      }));

    // Check if ALL transactions succeeded
    const hasFailures = failedTransactions.length > 0 || rejectedTransactions.length > 0;
    const allSucceeded = successTransactions.length === transactions.length;

    // Respond with a summary
    res.status(hasFailures ? 400 : 200).json({
      status: allSucceeded ? 'true' : 'false',
      message: allSucceeded
        ? 'All transactions processed successfully.'
        : `${failedTransactions.length + rejectedTransactions.length} transaction(s) failed.`,
      success: successTransactions,
      failed: failedTransactions,
      rejected: rejectedTransactions
    });
  } catch (error) {
    console.error('Bulk saveStocks error:', error);
    res.status(500).json({ status: 'false', message: error.message });
  }
};

exports.getStockData = async (req, res) => {
  try {
    const stocks = await getStockData('stocks');
    res.status(200).json({ status: true, data: stocks });
  } catch (error) {
    console.error('error:', error);
    res.status(500).json({ status: 'false', message: error.message });
  }
};

exports.manualTrade = async (req, res) => {
  try {
    const { effectiveUserId, loginUserId } = getUserContext(req);
    let reqData = { ...req.body };
    // reqData.scriptId = reqData.label;
    //    reqData.scriptId = reqData.label ? reqData.label.replace(/\s+/g, "").toUpperCase() : "";
    // reqData.scriptName = getBaseScriptName(reqData.scriptId);
    if (reqData.type == 'CF' || reqData.type == 'BF') {
      reqData.brokerage = false;
    }
    // Normalization
    reqData.quantity = Number(reqData.quantity) || 0;
    reqData.price = Number(reqData.price) || 0;
    reqData.lot = Number(reqData.lot) || 0;
    reqData.label = reqData.label ? reqData.label.trim() : '';
    if (!reqData.userId) reqData.userId = effectiveUserId;

    const userIp = req.headers['x-forwarded-for'] || req.socket.remoteAddress || req.ip;
    reqData.userIp = userIp;
    reqData.createdBy = loginUserId;

    const [services, qSettingDefault, qSettingScript] = await Promise.all([
      getParentDetails(reqData.userId, reqData.marketId),
      quantitySetting.findOne({ clientId: reqData.userId, scriptId: "999", marketId: reqData.marketId }).lean(),
      quantitySetting.findOne({ clientId: reqData.userId, scriptId: reqData.scriptId, marketId: reqData.marketId }).lean()
    ]);

    if (!services) return res.status(400).json({ status: 'false', message: 'User details not found' });

    // Requirement 2: Apply variation to manual trade price
    const qSetting = qSettingScript || qSettingDefault;
    const variation = (qSetting && isWithinVariationTime(qSetting.variationStartTime, qSetting.variationEndTime))
      ? (Number(qSetting.buySellVariation) || 0)
      : 0;

    if (reqData.transactionType === 'BUY') {
      reqData.price = reqData.price + variation;
    } else {
      reqData.price = reqData.price - variation;
    }


    let getValan;
    const dateInput = reqData.tradeDate || reqData.date;
    if (dateInput) {
      const tradeDate = moment(dateInput).toDate();
      getValan = await WeekValanModel.findOne({
        startDate: { $lte: tradeDate },
        endDate: { $gte: tradeDate }
      }).lean();
    }

    if (!getValan) {
      getValan = await setGetValanDetails();
    }
    services.getValan = getValan;

    // ===== PHASE 1.5: M2M Blocked Check =====
    const blockKeys = [`m2m_blocked:${reqData.userId}`];
    if (services.parentIds && services.parentIds.length > 0) {
      services.parentIds.forEach(pid => blockKeys.push(`m2m_blocked:${pid}`));
    }
    const isM2MBlocked = await redisClient.exists(...blockKeys);
    if (isM2MBlocked > 0) {
      return res.status(403).json({ status: 'false', message: 'Trading blocked due to M2M limit breach' });
    }

    // Rejection log template (shared across all manual trade validations)
    const baseRejectionLog = {
      action: 'INS',
      clientId: reqData.userId,
      marketId: reqData.marketId,
      scriptId: reqData.scriptId,
      symbol: reqData.label,
      order_type: reqData.orderType || 'Manual',
      lot: reqData.lot,
      qty: reqData.quantity,
      order_price: reqData.price,
      message: '',
      ip: userIp,
      time: new Date(),
      parentIds: services.parentIds,
      txn_type: reqData.transactionType,
    };

    // Valan validity
    if (moment().format('YYYY-MM-DD') > moment(getValan.endDate).format('YYYY-MM-DD')) {
      baseRejectionLog.message = 'No valan found';
      await saveLog('rejection', baseRejectionLog);
      return res.status(400).json({ status: 'false', message: 'No valan found' });
    }

    services.getMarket = services.marketAccess.find((mkt) => mkt.marketId == reqData.marketId);

    if (!services.getMarket) {
      baseRejectionLog.message = 'Segment is missing';
      await saveLog('rejection', baseRejectionLog);
      return res.status(400).json({ status: 'false', message: 'Segment is missing' });
    }

    // ===== PHASE 2: Basic Validations =====
    // NOTE: validateMarketStatus & validateStaleData intentionally skipped for manual trades
    // (admin places these off-market hours with a chosen price, not live feed).
    const [basicValidation, qtyValidation, expiryValidation] = await Promise.all([
      CommonStockValidator.validateBasicRules(reqData, services),
      CommonStockValidator.validateQuantityLimits(
        reqData.userId,
        reqData.scriptId,
        reqData.marketId,
        reqData.lot,
        reqData.quantity,
        reqData.price,
        services.parentIds,
        reqData.scriptName,
        reqData.transactionType,
        getValan._id
      ),
      CommonStockValidator.validateExpiryStatus(reqData, services)
    ]);

    if (!basicValidation.isValid) {
      baseRejectionLog.message = basicValidation.message;
      await saveLog('rejection', baseRejectionLog);
      return res.status(basicValidation.statusCode || 400).json({ status: 'false', message: basicValidation.message });
    }

    if (!qtyValidation.isValid) {
      baseRejectionLog.message = qtyValidation.message;
      await saveLog('rejection', baseRejectionLog);
      return res.status(400).json({ status: 'false', message: qtyValidation.message });
    }

    if (!expiryValidation.isValid) {
      baseRejectionLog.message = expiryValidation.message;
      await saveLog('rejection', baseRejectionLog);
      return res.status(400).json({ status: 'false', message: expiryValidation.message });
    }

    // ===== PHASE 3: Advanced Validations =====
    const [squareOffValidation, m2mValidation, marginValidation, manualValidation, calcResult] = await Promise.all([
      CommonStockValidator.validatePositionSquareOff(reqData, services),
      CommonStockValidator.validateM2MLimits(reqData, services),
      CommonStockValidator.validateMarginLimits(reqData, services),
      ManualOrderValidator.validate(reqData, services),
      // Empty liveStock: manual trade uses reqData.price entirely
      CommonStockValidator.calculateBrokerageAndMargin(reqData, services, {})
    ]);

    if (!squareOffValidation.isValid) {
      baseRejectionLog.message = squareOffValidation.message;
      await saveLog('rejection', baseRejectionLog);
      return res.status(400).json({ status: 'false', message: squareOffValidation.message });
    }

    if (!m2mValidation.isValid) {
      baseRejectionLog.message = m2mValidation.message;
      await saveLog('rejection', baseRejectionLog);
      return res.status(400).json({ status: 'false', message: m2mValidation.message });
    }

    if (!marginValidation.isValid) {
      baseRejectionLog.message = marginValidation.message;
      await saveLog('rejection', baseRejectionLog);
      return res.status(400).json({ status: 'false', message: marginValidation.message });
    }

    if (!manualValidation.isValid) {
      baseRejectionLog.message = manualValidation.message;
      await saveLog('rejection', baseRejectionLog);
      return res.status(400).json({ status: 'false', message: manualValidation.message });
    }

    if (!calcResult.isValid) {
      baseRejectionLog.message = calcResult.message;
      await saveLog('rejection', baseRejectionLog);
      return res.status(400).json({ status: 'false', message: calcResult.message });
    }

    const { checkQuantity, otherBrokerage, ...transactionData } = calcResult.data;

    const stock = {
      ...reqData,
      valanId: getValan._id,
      expiry: getExpiry(reqData.label),
      ip: userIp,
      userAgent: req.headers['user-agent'],
      message: reqData.message || 'Stock ' + reqData.transactionType.toLowerCase() + ' successfully',
      transactionStatus: 'COMPLETED',
      type: ['NRM', 'BF', 'FW', 'CF'].includes(reqData.type) ? reqData.type : 'NRM',

      otherBrokerage: otherBrokerage,
      ...transactionData,

      parentIds: services.parentIds,
      myParent: services.myParent,
      brokerIds: (services.basicDetails.brokerPartnership || []).map((b) => (b.broker && b.broker._id ? b.broker._id : b.broker)),
      partnership: services.partnership,
      minPercentageWiseBrokerage: services.minPercentageWiseBrokerage,
      minLotWiseBrokerage: services.minLotWiseBrokerage,
      shortmsg: (reqData.type === 'CF' || reqData.type === 'BF') ? reqData.type : 'Market',
      createdAt: reqData.tradeDate || reqData.date || new Date()
    };

    const savedStock = await saveTransaction(stock);

    const isEqualQty = transactionData.newBuyQty == transactionData.newSellQty;
    await setUserPosition(reqData.userId, reqData.scriptId, getValan._id, isEqualQty);
    await updateUserQuantity({ userId: reqData.userId }, { previous: checkQuantity.previous, current: checkQuantity.current });

    StockTransactionEvent({
      userId: reqData.userId,
      parentIds: services.parentIds,
      marketId: reqData.marketId,
      scriptId: reqData.scriptId,
      transactionType: reqData.transactionType,
      valanId: getValan._id,
      userScriptId: reqData.userScriptId ?? null,
      price: reqData.price,
      quantity: reqData.quantity,
      orderType: reqData.orderType || 'Limit',
      status: 'COMPLETED',
      _id: savedStock._id,
      label: reqData.label
    });

    DashboardStockEvent({
      userId: reqData.userId,
      parentIds: services.parentIds,
      marketId: reqData.marketId,
      scriptId: reqData.scriptId,
      transactionType: reqData.transactionType,
      valanId: getValan._id,
      userScriptId: reqData.userScriptId ?? null,
      lot: reqData.lot || 0,
      quantity: reqData.quantity,
      orderType: reqData.orderType || 'Limit',
      price: reqData.price,
      status: 'COMPLETED',
      _id: savedStock._id,
      label: reqData.label
    });

    // 🔔 Monitor: notify watchers of manual trade (fire-and-forget)
    MonitorService.notifyWatchers(reqData.userId, 'TRADE_PLACED', {
      loginUserId,
      isMultiLogin: req.context?.isMultiLogin || false,
      ip: userIp,
      device: req.headers['user-agent'] || 'Unknown',
      parentIds: services.parentIds || [],
      label: reqData.label,
      transactionType: reqData.transactionType,
      lot: reqData.lot,
      quantity: reqData.quantity,
      price: reqData.price,
      marketName: reqData.marketName,
      marketId: reqData.marketId,
      orderType: reqData.orderType || 'Manual',
      reason: 'Manual Trade',
      time: new Date()
    }).catch(() => { });

    // Invalidate M2M cache after trade execution
    M2MService.invalidateM2MCache(reqData.userId, getValan._id).catch((err) => {
      console.error('Error invalidating M2M cache:', err);
    });

    res.status(200).json({ status: true, message: stock.message });
  } catch (error) {
    console.log(error);
    res.status(500).json({ status: 'false', message: error.message });
  }
};

exports.getUserManualStocks = async (req, res) => {
  try {
    const effectiveUserId = getEffectiveUserId(req);

    // Fetch current user to check demoid status
    const isRequesterDemo = isDemoUser(req);

    const { market, date } = req.body;
    const matchFilter = {
      createdBy: new mongoose.Types.ObjectId(effectiveUserId),
      orderType: 'Manual'
    };

    if (market) {
      if (Array.isArray(market)) {
        matchFilter['marketId'] = { $in: market };
      } else if (typeof market === 'string' && market.includes(',')) {
        matchFilter['marketId'] = { $in: market.split(',').map((id) => id.trim()) };
      } else {
        matchFilter['marketId'] = market;
      }
    }
    if (date) {
      const start = new Date(date + 'T00:00:00.000+05:30');
      const end = new Date(date + 'T23:59:59.999+05:30');
      matchFilter['createdAt'] = { $gte: start, $lte: end };
    }

    const response = await getStocks(matchFilter, isRequesterDemo);
    res.status(200).json({ status: true, data: response });
  } catch (error) {
    console.log(error);
    res.status(500).json({ status: 'false', message: error.message });
  }
};


// exports.rollOverPosition = async (req, res) => {
//   try {
//     const { effectiveUserId, loginUserId } = getUserContext(req);
//     const transactions = req.body.transactions;
//     if (!Array.isArray(transactions) || transactions.length === 0) {
//       return res.status(400).json({
//         status: 'false',
//         message: 'No transactions provided.'
//       });
//     }

//     const getValan = await getActiveWeekValan();
//     if (!getValan) {
//       return res.status(400).json({
//         status: 'false',
//         message: 'No active valan found.'
//       });
//     }

//     const { Script } = require('../models/MarketTypeModel');
//     const currentTime = moment().format('YYYY-MM-DD');

//     const resolvedNextScripts = [];

//     for (const item of transactions) {
//       // Find the Script document where expiry.script_id matches the incoming scriptId
//       const scriptDoc = await Script.findOne({
//         'expiry.script_id': item.scriptId
//       }).lean();

//       if (!scriptDoc || !scriptDoc.expiry || scriptDoc.expiry.length === 0) {
//         continue;
//       }

//       // Parse and sort all expiries
//       const sortedExpiries = scriptDoc.expiry
//         .filter(e => e.expiry_date && e.expiry_date !== 'NA')
//         .map(e => ({
//           ...e,
//           parsedDate: moment(e.expiry_date, ["DD-MM-YYYY", "DDMMMYYYY", "YYYY-MM-DD"]).toDate(),
//           formattedDate: moment(e.expiry_date, ["DD-MM-YYYY", "DDMMMYYYY", "YYYY-MM-DD"]).format('YYYY-MM-DD')
//         }))
//         .filter(e => e.parsedDate && !isNaN(e.parsedDate.getTime()))
//         .sort((a, b) => a.parsedDate - b.parsedDate);

//       if (sortedExpiries.length === 0) {
//         continue;
//       }

//       // Find the current scriptId in the expiry array
//       const currentExpiryIndex = sortedExpiries.findIndex(e =>
//         e.script_id === item.scriptId || e.symbol === item.scriptId
//       );

//       // Find the next expiry after the current position's expiry
//       let nextExp = null;

//       if (currentExpiryIndex >= 0 && currentExpiryIndex < sortedExpiries.length - 1) {
//         const currentExp = sortedExpiries[currentExpiryIndex];

//         // Special handling for NOPT (market 3): monthly rolls to monthly, weekly rolls to weekly
//         if (String(item.marketId) === "3") {
//           // Check if current expiry is a monthly expiry (last Thursday of month)
//           const currentDate = moment(currentExp.parsedDate);
//           const nextWeek = moment(currentDate).add(7, 'days');
//           const isCurrentMonthly = nextWeek.month() !== currentDate.month();

//           if (isCurrentMonthly) {
//             // Current is monthly: Find next monthly expiry only (skip all weeklies)
//             for (let i = currentExpiryIndex + 1; i < sortedExpiries.length; i++) {
//               const candidateExp = sortedExpiries[i];
//               const candidateDate = moment(candidateExp.parsedDate);
//               const nextWeekFromCandidate = moment(candidateDate).add(7, 'days');
//               const isCandidateMonthly = nextWeekFromCandidate.month() !== candidateDate.month();

//               if (isCandidateMonthly) {
//                 nextExp = candidateExp;
//                 break;
//               }
//             }
//           } else {
//             // Current is weekly: Get next weekly (which is just the next expiry)
//             nextExp = sortedExpiries[currentExpiryIndex + 1];
//           }
//         } else {
//           // For other markets, just get the next expiry
//           nextExp = sortedExpiries[currentExpiryIndex + 1];
//         }
//       }

//       if (!nextExp) {
//         continue;
//       }

//       const nextScriptId = nextExp.script_id || nextExp.symbol;

//       // Generate a readable label based on market type
//       let nextLabel;
//       if (String(item.marketId) === "3") {
//         // Options: "NIFTY 20300 CE 21APR2026"
//         const formattedDate = moment(nextExp.parsedDate).format('DDMMMYYYY').toUpperCase();
//         nextLabel = `${scriptDoc.script_name} ${scriptDoc.strike} ${scriptDoc.option_type} ${formattedDate}`;
//       } else {
//         // Futures/Others: "GOLD 26JUN2026"
//         const formattedDate = moment(nextExp.parsedDate).format('DDMMMYYYY').toUpperCase();
//         nextLabel = `${scriptDoc.script_name} ${formattedDate}`;
//       }


//       resolvedNextScripts.push({
//         oldTx: item,
//         nextScriptId,
//         nextLabel,
//         nextExpiryDate: nextExp.formattedDate
//       });
//     }

//     if (resolvedNextScripts.length === 0) {
//       return res.status(400).json({ status: 'false', message: 'No valid next scripts found.' });
//     }

//     const uniqueNextScriptIds = [...new Set(resolvedNextScripts.map(r => r.nextScriptId))];
//     const uniqueOldScriptIds = [...new Set(resolvedNextScripts.map(r => r.oldTx.scriptId))];
//     const allScriptIds = [...new Set([...uniqueOldScriptIds, ...uniqueNextScriptIds])];
//     const liveStock = await getMultipleStockData(allScriptIds);

//     const stockMap = new Map(liveStock.map((item) => {
//       if (!item) return [null, null];
//       const key = item.InstrumentIdentifier || item.Symbol;
//       return [key, item];
//     }));

//     const newTxns = resolvedNextScripts.reduce((acc, { oldTx, nextScriptId, nextLabel }) => {
//       // Live price for the OLD expiry (used to close the existing position)
//       const oldLivePriceData = stockMap.get(oldTx.scriptId);
//       let oldSell = oldTx.price;
//       let oldBuy = oldTx.price;
//       if (oldLivePriceData) {
//         oldSell = oldLivePriceData.SellPrice || oldLivePriceData.LastTradePrice || oldTx.price;
//         oldBuy = oldLivePriceData.BuyPrice || oldLivePriceData.LastTradePrice || oldTx.price;
//       }

//       // Live price for the NEW expiry (used to open the new position)
//       const newLivePriceData = stockMap.get(nextScriptId);
//       let nextSell = oldTx.price;
//       let nextBuy = oldTx.price;
//       if (newLivePriceData) {
//         nextSell = newLivePriceData.SellPrice || newLivePriceData.LastTradePrice || oldTx.price;
//         nextBuy = newLivePriceData.BuyPrice || newLivePriceData.LastTradePrice || oldTx.price;
//       }

//       // Closing trade: same scriptId as old position, priced at old expiry's live price
//       // BUY position is closed with a SELL at old expiry's sell price (and vice versa)
//       const updatedItem = {
//         ...oldTx,
//         price: oldTx.transactionType === 'BUY' ? oldSell : oldBuy
//       };
//       acc.push(updatedItem);

//       // Opening trade: new scriptId, opposite direction, priced at new expiry's live price
//       const cloneItem = {
//         ...oldTx,
//         scriptId: nextScriptId,
//         label: nextLabel,
//         transactionType: oldTx.transactionType === 'BUY' ? 'SELL' : 'BUY',
//         price: oldTx.transactionType === 'BUY' ? nextBuy : nextSell
//       };
//       acc.push(cloneItem);

//       return acc;
//     }, []);

//     const results = await Promise.allSettled(
//       newTxns.map((tx, index) => {
//         return setRollOver(tx, loginUserId, index, getValan._id, req.ip, true);
//       })
//     );

//     // Prepare the response
//     const successTransactions = results
//       .filter((result) => result.status === 'fulfilled' && result.value.status === 'true')
//       .map((result) => result.value);
//     const failedTransactions = results
//       .filter((result) => result.status === 'fulfilled' && result.value.status === 'false')
//       .map((result) => result.value);
//     const rejectedTransactions = results
//       .filter((result) => result.status === 'rejected')
//       .map((result) => ({
//         status: 'false',
//         message: result.reason.message,
//         error: result.reason
//       }));

//     // Respond with a summary
//     res.status(200).json({
//       status: 'true',
//       message: 'Bulk stock transactions processed.',
//       success: successTransactions,
//       failed: failedTransactions,
//       rejected: rejectedTransactions
//     });
//   } catch (error) {
//     console.error('Bulk saveStocks error:', error);
//     res.status(500).json({ status: 'false', message: error.message });
//   }
// };

exports.rollOverPosition = async (req, res) => {
  try {
    const { effectiveUserId, loginUserId } = getUserContext(req);
    const transactions = req.body.transactions;
    if (!Array.isArray(transactions) || transactions.length === 0) {
      return res.status(400).json({
        status: 'false',
        message: 'No transactions provided.'
      });
    }

    const getValan = await getActiveWeekValan();
    if (!getValan) {
      return res.status(400).json({
        status: 'false',
        message: 'No active valan found.'
      });
    }

    const { Script } = require('../models/MarketTypeModel');
    const currentTime = moment().format('YYYY-MM-DD');

    const resolvedNextScripts = [];

    for (const item of transactions) {
      // Find the Script document where expiry.script_id matches the incoming scriptId
      const scriptDoc = await Script.findOne({
        'expiry.script_id': item.scriptId
      }).lean();

      if (!scriptDoc || !scriptDoc.expiry || scriptDoc.expiry.length === 0) {
        continue;
      }

      // Parse and sort all expiries
      const sortedExpiries = scriptDoc.expiry
        .filter(e => e.expiry_date && e.expiry_date !== 'NA')
        .map(e => ({
          ...e,
          parsedDate: moment(e.expiry_date, ["DD-MM-YYYY", "DDMMMYYYY", "YYYY-MM-DD"]).toDate(),
          formattedDate: moment(e.expiry_date, ["DD-MM-YYYY", "DDMMMYYYY", "YYYY-MM-DD"]).format('YYYY-MM-DD')
        }))
        .filter(e => e.parsedDate && !isNaN(e.parsedDate.getTime()))
        .sort((a, b) => a.parsedDate - b.parsedDate);

      if (sortedExpiries.length === 0) {
        continue;
      }

      // Find the current scriptId in the expiry array
      const currentExpiryIndex = sortedExpiries.findIndex(e =>
        e.script_id === item.scriptId || e.symbol === item.scriptId
      );

      // Find the next expiry after the current position's expiry
      let nextExp = null;

      if (currentExpiryIndex >= 0 && currentExpiryIndex < sortedExpiries.length - 1) {
        const currentExp = sortedExpiries[currentExpiryIndex];

        // Special handling for NOPT (market 3): monthly rolls to monthly, weekly rolls to weekly
        if (String(item.marketId) === "3") {
          // Check if current expiry is a monthly expiry (last Thursday of month)
          const currentDate = moment(currentExp.parsedDate);
          const nextWeek = moment(currentDate).add(7, 'days');
          const isCurrentMonthly = nextWeek.month() !== currentDate.month();

          if (isCurrentMonthly) {
            // Current is monthly: Find next monthly expiry only (skip all weeklies)
            for (let i = currentExpiryIndex + 1; i < sortedExpiries.length; i++) {
              const candidateExp = sortedExpiries[i];
              const candidateDate = moment(candidateExp.parsedDate);
              const nextWeekFromCandidate = moment(candidateDate).add(7, 'days');
              const isCandidateMonthly = nextWeekFromCandidate.month() !== candidateDate.month();

              if (isCandidateMonthly) {
                nextExp = candidateExp;
                break;
              }
            }
          } else {
            // Current is weekly: Get next weekly (which is just the next expiry)
            nextExp = sortedExpiries[currentExpiryIndex + 1];
          }
        } else {
          // For other markets, just get the next expiry
          nextExp = sortedExpiries[currentExpiryIndex + 1];
        }
      }

      if (!nextExp) {
        continue;
      }

      const nextScriptId = nextExp.script_id || nextExp.symbol;

      // Generate a readable label based on market type
      let nextLabel;
      if (String(item.marketId) === "3") {
        // Options: "NIFTY 20300 CE 21APR2026"
        const formattedDate = moment(nextExp.parsedDate).format('DDMMMYYYY').toUpperCase();
        nextLabel = `${scriptDoc.script_name} ${scriptDoc.strike} ${scriptDoc.option_type} ${formattedDate}`;
      } else {
        // Futures/Others: "GOLD 26JUN2026"
        const formattedDate = moment(nextExp.parsedDate).format('DDMMMYYYY').toUpperCase();
        nextLabel = `${scriptDoc.script_name} ${formattedDate}`;
      }


      resolvedNextScripts.push({
        oldTx: item,
        nextScriptId,
        nextLabel,
        nextExpiryDate: nextExp.formattedDate,
        nextExpiryOriginal: nextExp.expiry_date_orginal,
        nextSymbol: nextExp.symbol || scriptDoc.symbol,
        nextExpiryId: nextExp.script_expiry_id || nextExp.symbol || nextScriptId
      });
    }

    if (resolvedNextScripts.length === 0) {
      return res.status(400).json({ status: 'false', message: 'No valid next scripts found.' });
    }

    const uniqueNextScriptIds = [...new Set(resolvedNextScripts.map(r => r.nextScriptId))];
    const uniqueOldScriptIds = [...new Set(resolvedNextScripts.map(r => r.oldTx.scriptId))];
    const allScriptIds = [...new Set([...uniqueOldScriptIds, ...uniqueNextScriptIds])];
    const liveStock = await getMultipleStockData(allScriptIds);

    const stockMap = new Map(liveStock.map((item) => {
      if (!item) return [null, null];
      const key = item.InstrumentIdentifier || item.Symbol;
      return [key, item];
    }));

    const newTxns = resolvedNextScripts.reduce((acc, { oldTx, nextScriptId, nextLabel }) => {
      // Live price for the OLD expiry (used to close the existing position)
      const oldLivePriceData = stockMap.get(oldTx.scriptId);
      let oldSell = oldTx.price;
      let oldBuy = oldTx.price;
      if (oldLivePriceData) {
        oldSell = oldLivePriceData.SellPrice || oldLivePriceData.LastTradePrice || oldTx.price;
        oldBuy = oldLivePriceData.BuyPrice || oldLivePriceData.LastTradePrice || oldTx.price;
      }

      // Live price for the NEW expiry (used to open the new position)
      const newLivePriceData = stockMap.get(nextScriptId);
      let nextSell = oldTx.price;
      let nextBuy = oldTx.price;
      if (newLivePriceData) {
        nextSell = newLivePriceData.SellPrice || newLivePriceData.LastTradePrice || oldTx.price;
        nextBuy = newLivePriceData.BuyPrice || newLivePriceData.LastTradePrice || oldTx.price;
      }

      // Closing trade: same scriptId as old position, priced at old expiry's live price
      // BUY position is closed with a SELL at old expiry's sell price (and vice versa)
      const updatedItem = {
        ...oldTx,
        price: oldTx.transactionType === 'BUY' ? oldSell : oldBuy
      };
      acc.push(updatedItem);

      // Opening trade: new scriptId, opposite direction, priced at new expiry's live price
      const cloneItem = {
        ...oldTx,
        scriptId: nextScriptId,
        label: nextLabel,
        transactionType: oldTx.transactionType === 'BUY' ? 'SELL' : 'BUY',
        price: oldTx.transactionType === 'BUY' ? nextBuy : nextSell
      };
      acc.push(cloneItem);

      return acc;
    }, []);

    const results = await Promise.allSettled(
      newTxns.map((tx, index) => {
        return setRollOver(tx, loginUserId, index, getValan._id, req.ip, true);
      })
    );

    // Prepare the response
    const successTransactions = results
      .filter((result) => result.status === 'fulfilled' && result.value.status === 'true')
      .map((result) => result.value);
    const failedTransactions = results
      .filter((result) => result.status === 'fulfilled' && result.value.status === 'false')
      .map((result) => result.value);
    const rejectedTransactions = results
      .filter((result) => result.status === 'rejected')
      .map((result) => ({
        status: 'false',
        message: result.reason.message,
        error: result.reason
      }));

    // Add new UserScript entry for rolled-over expiry (keep old script intact)
    if (successTransactions.length > 0) {
      await Promise.allSettled(
        resolvedNextScripts.map(({ oldTx, nextScriptId, nextLabel, nextExpiryOriginal, nextSymbol, nextExpiryId }) => {
          const uid = oldTx.userId || loginUserId;
          const nextKey = `${oldTx.marketId}-${nextScriptId}-${nextExpiryOriginal}-0-`;
          return UserScript.findOneAndUpdate(
            { createdBy: new mongoose.Types.ObjectId(uid), keyIdentifier: nextKey },
            {
              $setOnInsert: {
                marketId: oldTx.marketId,
                marketName: oldTx.marketName,
                scriptId: nextScriptId,
                scriptName: oldTx.scriptName,
                symbol: nextSymbol,
                label: nextLabel,
                expiryId: nextExpiryId,
                expiryDate: nextExpiryOriginal,
                keyIdentifier: nextKey,
                strike: oldTx.strike || 0,
                cepe: oldTx.cepe || '',
                createdBy: new mongoose.Types.ObjectId(uid)
              }
            },
            { upsert: true, new: true }
          );
        })
      );
    }

    // Respond with a summary
    res.status(200).json({
      status: 'true',
      message: 'Bulk stock transactions processed.',
      success: successTransactions,
      failed: failedTransactions,
      rejected: rejectedTransactions
    });
  } catch (error) {
    console.error('Bulk saveStocks error:', error);
    res.status(500).json({ status: 'false', message: error.message });
  }
};
const setRollOver = async (tx, createdBy, index, valanId, ip, isRollOver = false) => {
  try {
    let { marketId, marketName, scriptId, scriptName, label, lot, quantity, price, transactionType, orderType, userId } = tx;

    if (!userId) {
      userId = createdBy;
    }

    const {
      marketAccess,
      basicDetails,
      accountDetails,
      partnership,
      parentIds,
      myParent,
      minPercentageWiseBrokerage,
      minLotWiseBrokerage,
      loginIP
    } = await getParentDetails(userId, marketId);

    const userIp = ip && ip !== '0' && ip !== '0.0.0.0' ? ip : loginIP || '0.0.0.0';
    lot = +lot;
    const expiry = getExpiry(label);
    let message = 'Stock ' + transactionType.toLowerCase() + ' successfully';
    let transactionStatus = 'COMPLETED';

    if (accountDetails.positionRollOverDisabled && isRollOver) {
      throw new Error('Position roll over is disabled');
    }
    const rejectionLog = {
      action: 'INS',
      clientId: userId,
      marketId,
      scriptId,
      symbol: label,
      order_type: orderType,
      lot,
      qty: quantity,
      order_price: price,
      message: '',
      ip: userIp,
      time: new Date(),
      parentIds,
      txn_type: transactionType
    };
    if (createdBy.toString() === userId.toString() && basicDetails.viewOnlyAccess == 1) {
      rejectionLog.message = 'Self trading is not allowed as you are in view-only mode. Only your upline can place trades for you.';
      await saveLog('rejection', rejectionLog);
      throw new Error('Self trading is not allowed as you are in view-only mode. Only your upline can place trades for you.');
    }

    const brokerIds = (basicDetails.brokerPartnership || []).map((bkr) => (bkr.broker && bkr.broker._id ? bkr.broker._id : bkr.broker));

    const getMarket = marketAccess.find((mkt) => mkt.marketId == marketId);
    if (!getMarket) {
      throw new Error('Segment is missing');
    }

    const checkQuantity = await getUserQuantity({
      userId,
      marketId,
      marketName,
      scriptId,
      scriptName,
      quantity,
      transactionType
    });

    const totalOrderPrice = quantity * price;
    let brokerageIntradayPercentage = getMarket.brokerage.intradayCommission || 0;
    let brokerageDeliveryPercentage = getMarket.brokerage.deliveryCommission || 0;

    const normalizedTradeScript = getBaseScriptName(scriptId);
    const checkScriptBrokerage = getMarket.brokerage.scriptWiseBrokerage.find(
      (s) => s.script && normalizedTradeScript === getBaseScriptName(s.script)
    );
    let isClientScriptWise = false;
    if (checkScriptBrokerage) {
      brokerageIntradayPercentage = checkScriptBrokerage.intradayCommission || 0;
      brokerageDeliveryPercentage = checkScriptBrokerage.deliveryCommission || 0;
      isClientScriptWise = true;
    }

    const quantityType = {
      intraday: Math.abs(checkQuantity.intraday),
      delivery: Math.abs(checkQuantity.delivery)
    };
    const brokeragePercentageType = {
      intraday: brokerageIntradayPercentage,
      delivery: brokerageDeliveryPercentage
    };

    let netBrokerage = 0;
    let orderBrokerage = 0;
    if (getMarket.brokerage.type == 'lot') {
      const lotFactor = quantity > 0 ? lot / quantity : 0;
      netBrokerage =
        checkQuantity.intraday * brokerageIntradayPercentage * lotFactor + checkQuantity.delivery * brokerageDeliveryPercentage * lotFactor;
      orderBrokerage = quantity > 0 ? netBrokerage / quantity : 0;
    } else {
      netBrokerage =
        (checkQuantity.intraday * price * brokerageIntradayPercentage) / 100 +
        (checkQuantity.delivery * price * brokerageDeliveryPercentage) / 100;
      orderBrokerage = quantity > 0 ? netBrokerage / quantity : 0;
    }

    let netPrice = 0;
    let totalNetPrice = 0;
    if (transactionType == 'BUY') {
      netPrice = price + orderBrokerage;
      totalNetPrice = netPrice * quantity;
    } else {
      netPrice = price - orderBrokerage;
      totalNetPrice = netPrice * quantity;
    }

    const lotOrAmount = getMarket.margin.lotOrAmount;
    const myLot = getMarket.margin.totalLotWise || 0;
    const myAmount = getMarket.margin.totalMargin || 0;

    // const brokeragePercentage = ((orderBrokerage * 100) / price).toFixed(2);

    const _pct = price && Number.isFinite(Number(price)) ? (orderBrokerage * 100) / price : 0;
    const brokeragePercentage = Number.isFinite(_pct) ? Number(_pct.toFixed(2)) : 0;

    const getBrokerData = getOtherBrokerDetails(
      marketId,
      lot,
      getMarket.brokerage.brokerCommission,
      scriptId,
      price,
      quantity,
      quantityType,
      totalOrderPrice,
      basicDetails.brokerPartnership,
      true,
      netBrokerage,
      brokerageIntradayPercentage,
      brokerageDeliveryPercentage,
      transactionType,
      isClientScriptWise
    );

    let m2mPrice = 0;
    if (transactionType == 'BUY') {
      m2mPrice = totalNetPrice - getBrokerData.totalOrderBrokerage;
    } else {
      m2mPrice = totalNetPrice + getBrokerData.totalOrderBrokerage;
    }

    const brokerTotalBrokerage = getBrokerData.totalOrderBrokerage;
    // const brokerTotalPercentage =
    //   getBrokerData.totalBrokerPercentage.toFixed(2);

    const _btp = getBrokerData.totalBrokerPercentage;
    const brokerTotalPercentage = Number.isFinite(_btp) ? Number(Number(_btp).toFixed(2)) : 0;
    const otherBrokerage = getBrokerData;

    const checkMargins = await getMarketWiseClientMargin(
      userId,
      {
        transactionStatus: 'COMPLETED',
        marketId,
        valanId: valanId
      },
      {
        $project: {
          marketId: 1,
          // transactions: {
          //   $concatArrays: [
          //     "$transactions",
          //     [
          //       {
          //         txnType: transactionType,
          //         qty: quantity,
          //         lot: lot,
          //         price: price,
          //         date: new Date(),
          //       },
          //     ],
          //   ],
          // },
          transactions: {
            $concatArrays: ['$transactions', []]
          }
        }
      }
    );

    let margin = 0;
    let newBuyQty = transactionType == 'BUY' ? quantity : 0;
    let newSellQty = transactionType == 'SELL' ? quantity : 0;
    if (checkMargins.length != 0) {
      // if position exist with same market
      let markets = checkMargins[0].markets;
      let scriptFound = false;
      markets = markets.map((market) => {
        // if script position exist recalculate lot margin with new order.
        if (market.marketId == marketId && market.scriptId == scriptId) {
          scriptFound = true;
          newBuyQty += market.buyQty;
          newSellQty += market.sellQty;
          market.buyQty = newBuyQty;
          market.sellQty = newSellQty;
          if (market.buyQty == market.sellQty) {
            market.netMargin = 0;
            market.netLot = 0;
          } else {
            market.netLot = parseFloat(market.netLot) + (transactionType == 'BUY' ? lot : -Math.abs(lot));
            market.netMargin = market.netMargin + (transactionType == 'BUY' ? totalOrderPrice : -Math.abs(totalOrderPrice));
          }
        }
        return market;
      });
      const { latestMargin, latestLotWise } = markets.reduce(
        (acc, item) => {
          acc.latestMargin += Math.abs(item.netMargin);
          acc.latestLotWise += Math.abs(item.netLot);
          return acc;
        },
        {
          latestMargin: scriptFound ? 0 : totalOrderPrice, //if script position does not exist add it.
          latestLotWise: scriptFound ? 0 : lot
        }
      );
      margin = lotOrAmount == 'lot' ? latestLotWise : latestMargin;
    } else {
      margin = lotOrAmount == 'lot' ? lot : totalOrderPrice;
    }

    if (!isRollOver && ((margin > myLot && lotOrAmount == 'lot') || (margin > myAmount && lotOrAmount == 'amount'))) {
      throw new Error('Market limit exceed');
    }

    const stock = {
      userId,
      valanId,
      marketId,
      marketName,
      scriptId,
      scriptName,
      label,
      expiry,
      lot,
      quantity,
      quantityType,
      orderPrice: price,
      totalOrderPrice,
      netPrice,
      totalNetPrice,
      orderBrokerage,
      netBrokerage,
      brokeragePercentage,
      brokeragePercentageType,
      m2mPrice,
      brokerTotalBrokerage,
      brokerTotalPercentage,
      otherBrokerage,
      type: 'NRM',
      transactionType,
      transactionStatus,
      orderType,
      ip: userIp,
      message,
      parentIds,
      myParent,
      brokerIds,
      partnership,
      minPercentageWiseBrokerage,
      minLotWiseBrokerage,
      createdBy,
      shortmsg: isRollOver ? 'Roll-Over' : orderType
    };

    const savedStock = await saveTransaction(stock);
    const isEqualQty = newBuyQty == newSellQty;
    await setUserPosition(userId, scriptId, valanId, isEqualQty);
    await updateUserQuantity(
      { userId },
      {
        previous: checkQuantity.previous,
        current: checkQuantity.current
      }
    );

    StockTransactionEvent({
      userId,
      parentIds,
      marketId,
      scriptId,
      transactionType,
      valanId,
      userScriptId: tx.userScriptId ?? null,
      lot,
      quantity,
      orderType,
      price,
      label,
      scriptName
    });

    DashboardStockEvent({
      userId,
      parentIds,
      marketId,
      scriptId,
      transactionType,
      valanId,
      lot,
      quantity,
      orderType,
      price,
      status: 'COMPLETED',
      _id: savedStock._id,
      label
    });

    return {
      status: 'true',
      message,
      _id: savedStock._id
    };
  } catch (error) {
    // Log the error with transaction index for debugging
    console.error(`Error processing transaction at index ${index}:`, error.message);
    return {
      status: 'false',
      message: error.message,
      error: error
    };
  }
};

exports.setRollOver = setRollOver;

exports.deleteTrade = async (req, res) => {
  try {
    const deletedBy = getLoginUserId(req);
    const { accountType } = req.user;
    const userLevel = accountType?.level;
    const isCustomerOrBroker = userLevel === 6 || userLevel === 7;

    let { tradeId, password, reduceQty } = req.body;
    const isPartialReduce = typeof reduceQty === 'number' && reduceQty > 0;

    if (!isCustomerOrBroker) {
      if (!password || typeof password !== 'string' || !password.trim()) {
        return res.status(400).json({ status: 'false', message: 'Transaction password is required' });
      }
      const isValid = await validateTransactionPassword(deletedBy, password.trim());
      if (!isValid) {
        return res.status(401).json({ status: 'false', message: 'Wrong transaction password' });
      }
    }
    tradeId = new mongoose.Types.ObjectId(tradeId);

    let transactionStatus = 'DELETED';

    const getTrade = await getFilterStockTransaction(
      { _id: tradeId },
      {
        marketId: 1,
        scriptId: 1,
        quantity: 1,
        lot: 1,
        userId: 1,
        valanId: 1,
        transactionType: 1,
        createdAt: 1,
        transactionStatus: 1,
        label: 1,
        orderType: 1,
        parentIds: 1,
        price: 1,
        orderPrice: 1,
        totalOrderPrice: 1,
        netPrice: 1,
        totalNetPrice: 1,
        m2mPrice: 1,
        orderBrokerage: 1,
        netBrokerage: 1,
        brokerTotalBrokerage: 1,
        shortmsg: 1
      },
      { _id: 1 }
    );

    if (!getTrade) {
      return res.status(400).json({ status: 'false', message: 'No trade exists' });
    }

    const orderPriceForLog = getTrade.price ?? getTrade.orderPrice ?? getTrade.netPrice ?? 0;
    const rejectionLog = {
      action: 'DEL',
      userId: getTrade.userId,
      symbol: getTrade.label,
      marketId: getTrade.marketId,
      scriptId: getTrade.scriptId,
      order_type: getTrade.orderType,
      lot: getTrade.lot,
      qty: getTrade.quantity,
      order_price: orderPriceForLog,
      message: '',
      ip: req.headers['x-forwarded-for'] || req.socket.remoteAddress || req.ip,
      time: new Date(),
      parentIds: getTrade.parentIds,
      created_by: deletedBy,
      txn_type: getTrade.transactionType
    };

    if (getTrade.transactionStatus == 'DELETED') {
      rejectionLog.message = 'Trade already deleted';
      await saveLog('rejection', rejectionLog);
      return res.status(400).json({ status: 'false', message: 'Trade already deleted' });
    }

    // Generate delete message based on order type and transaction type
    let message = 'Stock deleted successfully';
    if (getTrade.shortmsg) {
      message = `${getTrade.shortmsg} deleted`;
    } else if (getTrade.orderType) {
      const txnType = getTrade.transactionType === 'BUY' ? 'Buy' : 'Sell';
      const orderTypeStr = String(getTrade.orderType).toLowerCase();

      if (orderTypeStr.includes('limit') && !orderTypeStr.includes('stop')) {
        message = `${txnType} limit deleted`;
      } else if (orderTypeStr.includes('stop') || orderTypeStr.includes('sl')) {
        message = `${txnType} stop loss deleted`;
      } else if (orderTypeStr.includes('market')) {
        message = `Market order deleted`;
      }
    }

    const { userId, marketId, scriptId, valanId, quantity, transactionType, createdAt } = getTrade;

    const { marketAccess } = await getParentDetails(userId, marketId);

    const getMarket = marketAccess.find((mkt) => mkt.marketId == marketId);
    if (!getMarket) {
      rejectionLog.message = 'Segment is missing';
      await saveLog('rejection', rejectionLog);
      return res.status(400).json({ status: 'false', message: 'Segment is missing' });
    }

    const lotOrAmount = getMarket.margin.lotOrAmount;
    const myLot = getMarket.margin.totalLotWise || 0;
    const myAmount = getMarket.margin.totalMargin || 0;

    const checkMargins = await getMarketWiseClientMargin(
      userId,
      {
        transactionStatus: 'COMPLETED',
        marketId,
        valanId,
        _id: { $ne: tradeId }
      },
      {
        $project: {
          marketId: 1,
          transactions: {
            $concatArrays: ['$transactions', []]
          }
        }
      }
    );

    let margin = 0;
    let newBuyQty = 0;
    let newSellQty = 0;
    if (checkMargins.length != 0) {
      let markets = checkMargins[0].markets;

      markets = markets.map((market) => {
        // if script position exist recalculate lot margin with new order.
        if (market.marketId == marketId && market.scriptId == scriptId) {
          newBuyQty = market.buyQty;
          newSellQty = market.sellQty;
          if (market.buyQty == market.sellQty) {
            market.netMargin = 0;
            market.netLot = 0;
          }
        }
        return market;
      });

      const { latestMargin, latestLotWise } = markets.reduce(
        (acc, item) => {
          acc.latestMargin += Math.abs(item.netMargin);
          acc.latestLotWise += Math.abs(parseFloat(item.netLot));
          return acc;
        },
        {
          latestMargin: 0,
          latestLotWise: 0
        }
      );
      margin = lotOrAmount == 'lot' ? latestLotWise : latestMargin;
    }

    // if ((margin > myLot && lotOrAmount == 'lot') || (margin > myAmount && lotOrAmount == 'amount')) {
    //   rejectionLog.message = 'Market limit exceed';
    //   await saveLog('rejection', rejectionLog);
    //   return res.status(400).json({ status: 'false', message: 'Market limit exceed' });
    // }

    if (isPartialReduce && reduceQty < quantity) {
      const newQty = quantity - reduceQty;
      const ratio = newQty / quantity;
      const round4 = (n) => Math.round(n * 10000) / 10000;
      await updateTransaction(tradeId, {
        quantity: newQty,
        lot: round4(getTrade.lot * ratio),
        totalOrderPrice: round4(getTrade.totalOrderPrice * ratio),
        totalNetPrice: round4(getTrade.totalNetPrice * ratio),
        m2mPrice: round4(getTrade.m2mPrice * ratio),
        orderBrokerage: round4((getTrade.orderBrokerage || 0) * ratio),
        netBrokerage: round4((getTrade.netBrokerage || 0) * ratio),
        brokerTotalBrokerage: round4((getTrade.brokerTotalBrokerage || 0) * ratio),
        isEdited: true
      });
      await setUserPosition(userId, scriptId, valanId, false);
      await setUserQuantity({
        userId,
        marketId,
        scriptId,
        quantity: reduceQty,
        transactionType,
        createdAt
      });
      rejectionLog.qty = reduceQty;
      rejectionLog.order_price = orderPriceForLog;
      rejectionLog.message = 'Partial delete (matched pair); remaining qty displays in trade log as market executed';
      await saveLog('trade', rejectionLog);
      DashboardStockEvent({
        userId,
        parentIds: getTrade.parentIds,
        marketId,
        scriptId,
        transactionType,
        valanId,
        lot: round4(getTrade.lot * ratio),
        quantity: newQty,
        orderType: getTrade.orderType,
        price: getTrade.price,
        status: 'COMPLETED',
        _id: tradeId,
        label: getTrade.label
      });
      await recalculateFinalBill(userId, valanId, marketId);
      return res.status(200).json({
        status: true,
        message: `${reduceQty} qty deleted; ${newQty} qty remains and displays in trade log as market executed`,
        data: { partial: true, remainingQty: newQty }
      });
    }

    await updateTransaction(tradeId, { transactionStatus });
    const isEqualQty = newBuyQty == newSellQty;
    await setUserPosition(userId, scriptId, valanId, isEqualQty);
    await setUserQuantity({
      userId,
      marketId,
      scriptId,
      quantity,
      transactionType,
      createdAt
    });

    DashboardStockEvent({
      userId,
      parentIds: getTrade.parentIds,
      marketId,
      scriptId,
      transactionType,
      valanId,
      lot: getTrade.lot,
      quantity,
      orderType: getTrade.orderType,
      price: getTrade.price,
      status: 'DELETED',
      _id: tradeId,
      label: getTrade.label
    });

    // 🔔 Monitor: notify watchers of soft delete (fire-and-forget)
    MonitorService.notifyWatchers(userId, 'TRADE_DELETED', {
      loginUserId: deletedBy,
      isMultiLogin: req.context?.isMultiLogin || false,
      ip: req.headers['x-forwarded-for'] || req.socket.remoteAddress || req.ip,
      device: req.headers['user-agent'] || 'Unknown',
      parentIds: getTrade.parentIds || [],
      label: getTrade.label,
      transactionType: transactionType,
      lot: getTrade.lot,
      quantity: quantity,
      price: getTrade.orderPrice,
      marketId,
      orderType: getTrade.orderType,
      transactionStatus: getTrade.transactionStatus,
      time: new Date()
    }).catch(() => { });

    rejectionLog.message = message;
    await saveLog('trade', rejectionLog);
    await recalculateFinalBill(userId, valanId, marketId);

    res.status(200).json({ status: true, message });
  } catch (error) {
    console.log(error);
    res.status(500).json({ status: 'false', message: error.message });
  }
};

/**
 * Mark a trade as "executed only" from short trade (sets isEdited: true so it shows as Edited in market, remains COMPLETED).
 * Used for leftover trades after deleting matched pairs from short trade.
 */
exports.markTradeAsExecutedFromShort = async (req, res) => {
  try {
    const deletedBy = getLoginUserId(req);
    const { accountType } = req.user;
    const userLevel = accountType?.level;
    const isCustomerOrBroker = userLevel === 6 || userLevel === 7;

    const { tradeId, password } = req.body;

    if (!isCustomerOrBroker) {
      if (!password || typeof password !== 'string' || !password.trim()) {
        return res.status(400).json({ status: 'false', message: 'Transaction password is required' });
      }
      const isValid = await validateTransactionPassword(deletedBy, password.trim());
      if (!isValid) {
        return res.status(401).json({ status: 'false', message: 'Wrong transaction password' });
      }
    }

    const tradeIdObj = new mongoose.Types.ObjectId(tradeId);
    const getTrade = await getFilterStockTransaction({ _id: tradeIdObj }, { transactionStatus: 1, userId: 1 }, { _id: 1 });

    if (!getTrade) {
      return res.status(400).json({ status: 'false', message: 'No trade exists' });
    }
    if (getTrade.transactionStatus === 'DELETED') {
      return res.status(400).json({ status: 'false', message: 'Trade is already deleted' });
    }

    await updateTransaction(tradeIdObj, { isEdited: true });

    res.status(200).json({ status: true, message: 'Trade marked as executed (edited).' });
  } catch (error) {
    console.error(error);
    res.status(500).json({ status: 'false', message: error.message });
  }
};

exports.hardDeleteTrade = async (req, res) => {
  try {
    const deletedBy = getLoginUserId(req);
    const { accountType } = req.user;
    const userLevel = accountType?.level;
    const isCustomerOrBroker = userLevel === 6 || userLevel === 7;

    let { tradeId, password } = req.body;

    if (!tradeId) {
      return res.status(400).json({ status: 'false', message: 'Trade ID is required' });
    }
    if (!isCustomerOrBroker) {
      if (!password || typeof password !== 'string' || !password.trim()) {
        return res.status(400).json({ status: 'false', message: 'Transaction password is required' });
      }
      const isValid = await validateTransactionPassword(deletedBy, password.trim());
      if (!isValid) {
        return res.status(401).json({ status: 'false', message: 'Wrong transaction password' });
      }
    }

    tradeId = new mongoose.Types.ObjectId(tradeId);

    const getTrade = await getFilterStockTransaction(
      { _id: tradeId },
      {
        marketId: 1,
        scriptId: 1,
        quantity: 1,
        lot: 1,
        userId: 1,
        valanId: 1,
        transactionType: 1,
        createdAt: 1,
        transactionStatus: 1,
        label: 1,
        orderType: 1,
        parentIds: 1,
        price: 1,
        orderPrice: 1
      },
      { _id: 1 }
    );

    if (!getTrade) {
      return res.status(400).json({ status: 'false', message: 'No trade exists' });
    }

    const { userId, marketId, scriptId, valanId, quantity, transactionType, createdAt, orderPrice } = getTrade;

    const { marketAccess } = await getParentDetails(userId, marketId);

    const getMarket = marketAccess.find((mkt) => mkt.marketId == marketId);
    if (!getMarket) {
      return res.status(400).json({ status: 'false', message: 'Segment is missing' });
    }

    const lotOrAmount = getMarket.margin.lotOrAmount;
    const myLot = getMarket.margin.totalLotWise || 0;
    const myAmount = getMarket.margin.totalMargin || 0;

    const checkMargins = await getMarketWiseClientMargin(
      userId,
      {
        transactionStatus: 'COMPLETED',
        marketId,
        valanId,
        _id: { $ne: tradeId }
      },
      {
        $project: {
          marketId: 1,
          transactions: {
            $concatArrays: ['$transactions', []]
          }
        }
      }
    );

    let margin = 0;
    if (checkMargins.length != 0) {
      let markets = checkMargins[0].markets;
      const { latestMargin, latestLotWise } = markets.reduce(
        (acc, item) => {
          acc.latestMargin += Math.abs(item.netMargin);
          acc.latestLotWise += Math.abs(parseFloat(item.netLot));
          return acc;
        },
        { latestMargin: 0, latestLotWise: 0 }
      );
      margin = lotOrAmount == 'lot' ? latestLotWise : latestMargin;
    }

    // if ((margin > myLot && lotOrAmount == 'lot') || (margin > myAmount && lotOrAmount == 'amount')) {
    //   return res.status(400).json({ status: 'false', message: 'Market limit exceed' });
    // }

    // Get current live price for the script
    let deletedPrice = getTrade.orderPrice; // Default to original trade price

    // Call service to perform the actual deletion and updates
    await deleteTradeRecord({
      tradeId,
      userId,
      marketId,
      scriptId,
      valanId,
      quantity,
      transactionType,
      createdAt,
      deletedBy,
      deletedPrice
    });

    // 4. Log the deletion action
    const deletionLog = {
      action: 'HARD_DEL',
      userId: userId,
      symbol: getTrade.label,
      marketId,
      scriptId,
      order_type: getTrade.orderType,
      lot: getTrade.lot,
      qty: quantity,
      order_price: deletedPrice,
      message: 'Hard deleted record',
      ip: req.headers['x-forwarded-for'] || req.socket.remoteAddress || req.ip,
      time: new Date(),
      parentIds: getTrade.parentIds,
      created_by: deletedBy,
      txn_type: transactionType
    };
    await saveLog('trade', deletionLog);

    // 5. Emit event for dashboard
    DashboardStockEvent({
      userId,
      parentIds: getTrade.parentIds,
      marketId,
      scriptId,
      transactionType,
      valanId,
      lot: getTrade.lot,
      quantity,
      orderType: getTrade.orderType,
      price: getTrade.orderPrice,
      status: 'DELETED',
      _id: tradeId,
      label: getTrade.label
    });

    // 🔔 Monitor: notify watchers of hard delete (fire-and-forget)
    MonitorService.notifyWatchers(userId, 'TRADE_DELETED', {
      loginUserId: deletedBy,
      isMultiLogin: req.context?.isMultiLogin || false,
      ip: req.headers['x-forwarded-for'] || req.socket.remoteAddress || req.ip,
      device: req.headers['user-agent'] || 'Unknown',
      parentIds: getTrade.parentIds || [],
      label: getTrade.label,
      transactionType: transactionType,
      lot: getTrade.lot,
      quantity: quantity,
      price: deletedPrice, // Price at deletion
      marketId,
      orderType: getTrade.orderType,
      transactionStatus: getTrade.transactionStatus,
      time: new Date()
    }).catch(() => { });

    res.status(200).json({ status: true, message: 'Stock record permanently deleted' });
  } catch (error) {
    console.log(error);
    res.status(500).json({ status: 'false', message: error.message });
  }
};

exports.bulkDeleteTrade = async (req, res) => {
  try {
    const deletedBy = getLoginUserId(req);
    const { accountType } = req.user;
    const userLevel = accountType?.level;
    const isCustomerOrBroker = userLevel === 6 || userLevel === 7;

    let { ids, type, password } = req.body;

    if (!ids || !Array.isArray(ids) || ids.length === 0) {
      return res.status(400).json({ status: 'false', message: 'Trade IDs array is required' });
    }

    if (!isCustomerOrBroker) {
      if (!password || typeof password !== 'string' || !password.trim()) {
        return res.status(400).json({ status: 'false', message: 'Transaction password is required' });
      }
      const isValid = await validateTransactionPassword(deletedBy, password.trim());
      if (!isValid) {
        return res.status(401).json({ status: 'false', message: 'Wrong transaction password' });
      }
    }

    const mongooseIds = ids.map((id) => new mongoose.Types.ObjectId(id));

    // Fetch userIds and valanIds for cache invalidation before deletion
    const affectedTrades = await StockTransaction.find({ _id: { $in: mongooseIds } }, { userId: 1, valanId: 1 }).lean();
    const uniqueUserValanPairs = [...new Set(affectedTrades.map((t) => `${t.userId}_${t.valanId}`))];

    await bulkDeleteTransactions(mongooseIds, type || 'soft', deletedBy);

    // Invalidate M2M cache for affected users
    uniqueUserValanPairs.forEach((pair) => {
      const [uId, vId] = pair.split('_');
      M2MService.invalidateM2MCache(uId, vId).catch((err) => console.error('Error invalidating M2M cache:', err));
    });

    await saveLog('trade', {
      action: type === 'hard' ? 'HARD_BULK_DEL' : 'SOFT_BULK_DEL',
      message: `Bulk ${type || 'soft'} delete for ${ids.length} trades`,
      ip: req.headers['x-forwarded-for'] || req.socket.remoteAddress || req.ip,
      time: new Date(),
      created_by: deletedBy,
      ids: ids
    });

    res.status(200).json({ status: true, message: `Bulk ${type || 'soft'} delete successful` });
  } catch (error) {
    console.log(error);
    res.status(500).json({ status: 'false', message: error.message });
  }
};

exports.recoverTrade = async (req, res) => {
  try {
    const loginUserId = getLoginUserId(req);
    const { accountType } = req.user;
    const userLevel = accountType?.level;
    const isCustomerOrBroker = userLevel === 6 || userLevel === 7;

    let { ids, password } = req.body;

    if (!ids || !Array.isArray(ids) || ids.length === 0) {
      return res.status(400).json({ status: 'false', message: 'Trade IDs array is required' });
    }

    if (!isCustomerOrBroker) {
      if (!password || typeof password !== 'string' || !password.trim()) {
        return res.status(400).json({ status: 'false', message: 'Transaction password is required' });
      }
      const isValid = await validateTransactionPassword(loginUserId, password.trim());
      if (!isValid) {
        return res.status(401).json({ status: 'false', message: 'Wrong transaction password' });
      }
    }

    const mongooseIds = ids.map((id) => new mongoose.Types.ObjectId(id));

    // Fetch userIds and valanIds for cache invalidation
    const affectedTrades = await StockTransaction.find({ _id: { $in: mongooseIds } }, { userId: 1, valanId: 1 }).lean();
    const uniqueUserValanPairs = [...new Set(affectedTrades.map((t) => `${t.userId}_${t.valanId}`))];

    await recoverTransactions(mongooseIds);

    // Invalidate M2M cache for affected users
    uniqueUserValanPairs.forEach((pair) => {
      const [uId, vId] = pair.split('_');
      M2MService.invalidateM2MCache(uId, vId).catch((err) => console.error('Error invalidating M2M cache:', err));
    });

    await saveLog('trade', {
      action: 'RECOVER_BULK',
      message: `Bulk recovery for ${ids.length} trades`,
      ip: req.headers['x-forwarded-for'] || req.socket.remoteAddress || req.ip,
      time: new Date(),
      created_by: loginUserId,
      ids: ids
    });

    res.status(200).json({ status: true, message: 'Bulk recovery successful' });
  } catch (error) {
    console.log(error);
    res.status(500).json({ status: 'false', message: error.message });
  }
};

exports.editTrade = async (req, res) => {
  try {
    const { effectiveUserId, loginUserId } = getUserContext(req);
    let {
      marketId,
      marketName,
      scriptId,
      scriptName,
      label,
      lot,
      quantity,
      price,
      transactionType,
      orderType,
      userId,
      tradeId,
      createdAt,
      message: bodyMessage
    } = req.body;
    label = label.trim();
    if (!userId) {
      userId = effectiveUserId;
    }

    lot = +lot;

    const userIp = req.body.ip || req.headers['x-forwarded-for'] || req.ip;
    const expiry = getExpiry(label);

    const services = await getParentDetails(userId, marketId);
    if (!services) {
      rejectionLog.message = 'User details not found';
      await saveLog('rejection', rejectionLog);
      return res.status(400).json({ status: 'false', message: 'User details not found' });
    }

    const {
      marketAccess,
      basicDetails,
      accountDetails,
      partnership,
      parentIds,
      myParent,
      minPercentageWiseBrokerage,
      minLotWiseBrokerage
    } = services;

    let message = bodyMessage || 'Stock ' + transactionType.toLowerCase() + ' successfully';

    tradeId = new mongoose.Types.ObjectId(tradeId);

    const rejectionLog = {
      action: 'EDT',
      clientId: userId,
      symbol: label,
      marketId,
      scriptId,
      order_type: orderType,
      lot,
      qty: quantity,
      order_price: price,
      message: 'Trade edited successfully',
      ip: userIp,
      time: new Date(),
      parentIds,
      created_by: userId,
      txn_type: transactionType
    };

    if (loginUserId.toString() === userId.toString() && basicDetails.viewOnlyAccess == 1) {
      rejectionLog.message = 'Self trading is not allowed as you are in view-only mode. Only your upline can place trades for you.';
      await saveLog('rejection', rejectionLog);
      return res.status(403).json({
        status: 'false',
        message: 'Self trading is not allowed as you are in view-only mode. Only your upline can place trades for you.'
      });
    }

    let getValan;
    const dateInput = createdAt || req.body.date;
    if (dateInput) {
      const tradeDate = moment(dateInput).toDate();
      getValan = await WeekValanModel.findOne({
        startDate: { $lte: tradeDate },
        endDate: { $gte: tradeDate }
      }).lean();
    }
    if (!getValan) {
      getValan = await setGetValanDetails();
    }
    services.getValan = getValan;


    const getTrade = await getFilterStockTransaction(
      { _id: tradeId },
      {
        quantity: 1,
        lot: 1,
        price: 1,
        scriptId: 1,
        scriptName: 1,
        label: 1,
        transactionType: 1,
        orderType: 1,
        transactionStatus: 1,
        valanId: 1,
        createdAt: 1
      },
      { _id: 1 }
    );

    if (!getTrade) {
      rejectionLog.message = 'No trade exists';
      await saveLog('rejection', rejectionLog);
      return res.status(400).json({ status: 'false', message: 'No trade exists' });
    }

    let transactionStatus = getTrade.transactionStatus;

    // Check what has changed in the trade
    const isQuantityChanged = getTrade.quantity !== quantity;
    const isLotChanged = getTrade.lot !== lot;
    const isPriceChanged = getTrade.price !== price;
    const isScriptChanged = getTrade.scriptId !== scriptId || getTrade.label !== label;
    // if (transactionStatus === "DELETED" || transactionStatus === "COMPLETED") {
    //   rejectionLog.message = "Trade cannot be edited";
    //   await saveLog("trade", rejectionLog);
    //   return res
    //     .status(400)
    //     .json({ status: "false", message: "Trade cannot be edited" });
    // }

    let checkLimits = await quantitySetting
      .find({ clientId: userId, scriptId, marketId })
      .select({
        qtySetting: 1,
        minOrder: 1,
        maxOrder: 1,
        positionLimit: 1,
        isRange: 1,
        startRange: 1,
        endRange: 1
      })
      .lean();

    if (checkLimits.length == 0) {
      checkLimits = await quantitySetting
        .find({ clientId: userId, scriptId: '999', marketId })
        .select({
          qtySetting: 1,
          minOrder: 1,
          maxOrder: 1,
          positionLimit: 1,
          isRange: 1,
          startRange: 1,
          endRange: 1
        })
        .lean();
    }
    // if (checkLimits.length == 0) {
    //   rejectionLog.message = 'Limit not exists';
    //   await saveLog('rejection', rejectionLog);
    //   return res.status(400).json({ status: 'false', message: 'Limit not exists' });
    // }

    const lotLimits = checkLimits.find((lmt) => lmt.qtySetting == 'Lot');
    const qtyLimits = checkLimits.find((lmt) => lmt.qtySetting == 'Qty');

    if (lotLimits) {
      const numLot = Number(lot);
      const minOrder = Number(lotLimits.minOrder);
      const maxOrder = Number(lotLimits.maxOrder);

      if (numLot < minOrder || numLot > maxOrder) {
        rejectionLog.message = `Lot limit reached. Allowed: ${minOrder} to ${maxOrder}, Provided: ${numLot}`;
        await saveLog('rejection', rejectionLog);
        return res.status(400).json({ status: 'false', message: `Lot limit reached. Allowed: ${minOrder} to ${maxOrder}, Provided: ${numLot}` });
      }

      if (lotLimits.isRange) {
        if (price < lotLimits.startRange || price > lotLimits.endRange) {
          rejectionLog.message = 'Range limit reached';
          await saveLog('rejection', rejectionLog);
          return res.status(400).json({ status: 'false', message: 'Range limit reached' });
        }
      }
    }

    if (qtyLimits) {
      if (quantity < qtyLimits.minOrder || quantity > qtyLimits.maxOrder) {
        rejectionLog.message = 'Quantity limit reached';
        await saveLog('rejection', rejectionLog);
        return res.status(400).json({ status: 'false', message: 'Quantity limit reached' });
      }

      if (qtyLimits.isRange) {
        if (price < qtyLimits.startRange || price > qtyLimits.endRange) {
          rejectionLog.message = 'Range limit reached';
          await saveLog('rejection', rejectionLog);
          return res.status(400).json({ status: 'false', message: 'Range limit reached' });
        }
      }
    }

    // Use the getValan already declared above at line 3180
    // If you need to re-fetch it for some reason, just assign:
    // getValan = await getActiveWeekValan(); (if it was 'let' instead of 'const')
    // But since it's 'const', we just use the one we have.
    // if (getTrade.valanId.toString() != getValan._id.toString()) {
    //   rejectionLog.message = "Valan is closed";
    //   await saveLog("trade", rejectionLog);
    //   return res
    //     .status(400)
    //     .json({ status: "false", message: "Valan is closed" });
    // }

    const currentDate = moment().format('YYYY-MM-DD');

    const marketWisePosition = await getFilterLimitDisable({
      marketId,
      onlySquareOff: 'Yes',
      date: currentDate
    });

    const brokerIds = (basicDetails.brokerPartnership || []).map((bkr) => (bkr.broker && bkr.broker._id ? bkr.broker._id : bkr.broker));

    const getMarket = marketAccess.find((mkt) => mkt.marketId == marketId);
    if (!getMarket) {
      rejectionLog.message = 'Segment is missing';
      await saveLog('rejection', rejectionLog);
      return res.status(400).json({ status: 'false', message: 'Segment is missing' });
    }

    if (marketId == '2') {
      if (+price < +getMarket.brokerage.minScriptRate) {
        rejectionLog.message = 'Min Script rate is ' + getMarket.brokerage.minScriptRate;
        await saveLog('rejection', rejectionLog);
        return res.status(400).json({
          status: 'false',
          message: 'Min Script rate is ' + getMarket.brokerage.minScriptRate
        });
      }
    }

    if (marketId == '3') {
      if (+price < +getMarket.other.minRateScriptBlock && transactionType == 'BUY') {
        rejectionLog.message = 'Min Script rate is ' + getMarket.other.minRateScriptBlock;
        await saveLog('rejection', rejectionLog);
        return res.status(400).json({
          status: 'false',
          message: 'Min Script rate is ' + getMarket.other.minRateScriptBlock
        });
      }
    }

    // Always get checkQuantity, but only for fresh limit validation if quantity/lot changed
    let checkQuantity = await getUserQuantity({
      userId,
      marketId,
      marketName,
      scriptId,
      scriptName,
      quantity,
      transactionType,
      edited: (isQuantityChanged || isLotChanged) ? {
        quantity: getTrade.quantity,
        isEdited: true,
        tradeDate: getTrade.createdAt
      } : undefined
    });

    if (transactionStatus === 'PENDING') {
      // Use scriptId first, then fallback to label for live price lookup
      let liveStockInfo = await getSingleStockData(scriptId);
      if (!liveStockInfo && label) {
        liveStockInfo = await getSingleStockData(label);
      }

      if (!liveStockInfo) {
        rejectionLog.message = 'Live stock data not available';
        await saveLog('rejection', rejectionLog);
        return res.status(400).json({ status: 'false', message: 'Live stock data not available' });
      }
      const liveStock = JSON.parse(liveStockInfo);

      const reqDataForValidator = {
        ...req.body,
        userId,
        userIp,
        createdBy: loginUserId,
        label,
        lot,
        quantity,
        price,
        transactionType,
        marketId,
        scriptId,
        scriptName,
        orderType,
        quantityType: checkQuantity,
        isEdit: true,
        isQuantityChanged,
        isLotChanged,
        isPriceChanged,
        isScriptChanged,
        tradeId // Pass the trade ID being edited for fresh limit validation
      };

      // Only run validations that are relevant to what changed
      const validations = [];

      // Always validate basic rules and market status
      validations.push(
        CommonStockValidator.validateBasicRules(reqDataForValidator, services),
        CommonStockValidator.validateMarketStatus(reqDataForValidator, services)
      );

      // Only validate stale data if script changed
      if (isScriptChanged) {
        validations.push(CommonStockValidator.validateStaleData(scriptId, label));
      }

      // Only validate M2M and margin limits if quantity/lot changed
      if (isQuantityChanged || isLotChanged) {
        validations.push(
          CommonStockValidator.validateM2MLimits(reqDataForValidator, services),
          CommonStockValidator.validateMarginLimits(reqDataForValidator, services, tradeId)
        );
      }

      // Always validate limit order (for price validation)
      console.log(`[LIMIT-DEBUG][Controller:editLimit] LimitOrderValidator userId=${reqDataForValidator.userId} scriptId=${reqDataForValidator.scriptId} marketId=${reqDataForValidator.marketId} price=${reqDataForValidator.price} orderType=${reqDataForValidator.orderType}`);
      validations.push(LimitOrderValidator.validate(reqDataForValidator, services, liveStock));

      const results = await Promise.all(validations);

      // Check all validation results
      for (const result of results) {
        if (!result.isValid) {
          console.log(`[LIMIT-DEBUG][Controller:editLimit] BLOCKED userId=${reqDataForValidator.userId} marketId=${reqDataForValidator.marketId} reason=${result.message}`);
          return res.status(result.statusCode || 400).json({
            status: 'false',
            message: result.message
          });
        }
      }
    }

    const totalOrderPrice = quantity * price;
    let brokerageIntradayPercentage = getMarket.brokerage.intradayCommission || 0;
    let brokerageDeliveryPercentage = getMarket.brokerage.deliveryCommission || 0;

    const normalizedTradeScript = getBaseScriptName(scriptId);
    const checkScriptBrokerage = getMarket.brokerage.scriptWiseBrokerage.find(
      (s) => s.script && normalizedTradeScript === getBaseScriptName(s.script)
    );
    let isClientScriptWise = false;
    if (checkScriptBrokerage) {
      brokerageIntradayPercentage = checkScriptBrokerage.intradayCommission || 0;
      brokerageDeliveryPercentage = checkScriptBrokerage.deliveryCommission || 0;
      isClientScriptWise = true;
    }

    const quantityType = {
      intraday: Math.abs(checkQuantity.intraday),
      delivery: Math.abs(checkQuantity.delivery)
    };
    const brokeragePercentageType = {
      intraday: brokerageIntradayPercentage,
      delivery: brokerageDeliveryPercentage
    };

    let netBrokerage = 0;
    let orderBrokerage = 0;
    if (transactionStatus !== 'PENDING') {
      if (getMarket.brokerage.type == 'lot') {
        const lotFactor = quantity > 0 ? lot / quantity : 0;
        netBrokerage =
          checkQuantity.intraday * brokerageIntradayPercentage * lotFactor + checkQuantity.delivery * brokerageDeliveryPercentage * lotFactor;
        orderBrokerage = quantity > 0 ? netBrokerage / quantity : 0;
      } else {
        netBrokerage =
          (checkQuantity.intraday * price * brokerageIntradayPercentage) / 100 +
          (checkQuantity.delivery * price * brokerageDeliveryPercentage) / 100;
        orderBrokerage = quantity > 0 ? netBrokerage / quantity : 0;
      }
    }

    let netPrice = 0;
    let totalNetPrice = 0;
    if (transactionType == 'BUY') {
      netPrice = price + orderBrokerage;
      totalNetPrice = netPrice * quantity;
    } else {
      netPrice = price - orderBrokerage;
      totalNetPrice = netPrice * quantity;
    }

    const lotOrAmount = getMarket.margin.lotOrAmount;
    const myLot = getMarket.margin.totalLotWise || 0;
    const myAmount = getMarket.margin.totalMargin || 0;

    // const brokeragePercentage = ((orderBrokerage * 100) / price).toFixed(2);
    const _pct = price && Number.isFinite(Number(price)) ? (orderBrokerage * 100) / price : 0;
    const brokeragePercentage = Number.isFinite(_pct) ? Number(_pct.toFixed(2)) : 0;
    const getBrokerData = getOtherBrokerDetails(
      marketId,
      lot,
      getMarket.brokerage.brokerCommission,
      scriptId,
      price,
      quantity,
      quantityType,
      totalOrderPrice,
      basicDetails.brokerPartnership,
      transactionStatus !== 'PENDING',
      netBrokerage,
      brokerageIntradayPercentage,
      brokerageDeliveryPercentage,
      transactionType,
      isClientScriptWise
    );

    let m2mPrice = 0;
    if (transactionType == 'BUY') {
      m2mPrice = totalNetPrice - getBrokerData.totalOrderBrokerage;
    } else {
      m2mPrice = totalNetPrice + getBrokerData.totalOrderBrokerage;
    }
    const brokerTotalBrokerage = getBrokerData.totalOrderBrokerage;
    // const brokerTotalPercentage =
    //   getBrokerData.totalBrokerPercentage.toFixed(2);

    const _btp = getBrokerData.totalBrokerPercentage;
    const brokerTotalPercentage = Number.isFinite(_btp) ? Number(Number(_btp).toFixed(2)) : 0;
    const otherBrokerage = getBrokerData;

    const checkMargins = await getMarketWiseClientMargin(
      userId,
      {
        transactionStatus: 'COMPLETED',
        marketId,
        valanId: getValan._id,
        _id: { $ne: tradeId }
      },
      {
        $project: {
          marketId: 1,
          // transactions: {
          //   $concatArrays: [
          //     "$transactions",
          //     [
          //       {
          //         txnType: transactionType,
          //         qty: quantity,
          //         lot: lot,
          //         price: price,
          //         date: new Date(),
          //       },
          //     ],
          //   ],
          // },
          transactions: {
            $concatArrays: ['$transactions', []]
          }
        }
      }
    );

    let margin = 0;
    let newBuyQty = transactionType == 'BUY' ? quantity : 0;
    let newSellQty = transactionType == 'SELL' ? quantity : 0;
    if (checkMargins.length != 0) {
      // if position exist with same market
      let markets = checkMargins[0].markets;
      let scriptFound = false;
      markets = markets.map((market) => {
        // if script position exist recalculate lot margin with new order.
        if (market.marketId == marketId && market.scriptId == scriptId) {
          scriptFound = true;
          newBuyQty += market.buyQty;
          newSellQty += market.sellQty;
          market.buyQty = newBuyQty;
          market.sellQty = newSellQty;
          if (market.buyQty == market.sellQty) {
            market.netMargin = 0;
            market.netLot = 0;
          } else {
            market.netLot = parseFloat(market.netLot) + (transactionType == 'BUY' ? lot : -Math.abs(lot));
            market.netMargin = market.netMargin + (transactionType == 'BUY' ? totalOrderPrice : -Math.abs(totalOrderPrice));
          }
        }
        return market;
      });
      const { latestMargin, latestLotWise } = markets.reduce(
        (acc, item) => {
          acc.latestMargin += Math.abs(item.netMargin);
          acc.latestLotWise += Math.abs(item.netLot);
          return acc;
        },
        {
          latestMargin: scriptFound ? 0 : totalOrderPrice, //if script position does not exist add it.
          latestLotWise: scriptFound ? 0 : lot
        }
      );
      margin = lotOrAmount == 'lot' ? latestLotWise : latestMargin;
    } else {
      margin = lotOrAmount == 'lot' ? lot : totalOrderPrice;
    }

    // if ((margin > myLot && lotOrAmount == 'lot') || (margin > myAmount && lotOrAmount == 'amount')) {
    //   rejectionLog.message = 'Market limit exceed';
    //   await saveLog('rejection', rejectionLog);
    //   return res.status(400).json({ status: 'false', message: 'Market limit exceed' });
    // }

    if (accountDetails.onlyPositionSquareOff || marketWisePosition) {
      if (transactionType == 'BUY') {
        if (newBuyQty > newSellQty) {
          rejectionLog.message = 'Only square off position';
          await saveLog('rejection', rejectionLog);
          return res.status(400).json({ status: 'false', message: 'Only square off position' });
        }
      } else {
        if (newSellQty > newBuyQty) {
          rejectionLog.message = 'Only square off position';
          await saveLog('rejection', rejectionLog);
          return res.status(400).json({ status: 'false', message: 'Only square off position' });
        }
      }
    }
    // --------- LIVE PRICE FETCH (FOR tradePosition) ----------
    // console.log("scriptName", scriptName);

    const liveStockInfo = await getSingleStockData(scriptId || label);
    if (!liveStockInfo) {
      rejectionLog.message = 'Live stock data not available';
      await saveLog('rejection', rejectionLog);
      return res.status(400).json({ status: 'false', message: 'Live stock data not available' });
    }

    const liveStock = JSON.parse(liveStockInfo);
    // ---------------------------------------------------------
    let tradePosition = 'NRM';

    if (transactionType === 'BUY') {
      tradePosition = +price < liveStock.SellPrice ? 'DOWN' : 'UP';
    } else {
      tradePosition = +price < liveStock.BuyPrice ? 'DOWN' : 'UP';
    }

    const stock = {
      userId,
      valanId: getValan._id,
      marketId,
      marketName,
      scriptId,
      scriptName,
      label,
      expiry,
      lot,
      quantity,
      quantityType,
      orderPrice: price,
      totalOrderPrice,
      netPrice,
      totalNetPrice,
      orderBrokerage,
      netBrokerage,
      brokeragePercentage,
      brokeragePercentageType,
      m2mPrice,
      brokerTotalBrokerage,
      brokerTotalPercentage,
      otherBrokerage,
      type: 'NRM',
      transactionType,
      tradePosition,
      transactionStatus,
      orderType,
      ip: userIp,
      userAgent: req.headers['user-agent'],
      message,
      parentIds,
      myParent,
      brokerIds,
      partnership,
      minPercentageWiseBrokerage,
      minLotWiseBrokerage,
      isEdited: true,
      createdBy: loginUserId,
      shortmsg: 'Edited'
    };
    if (createdAt) {
      stock.createdAt = new Date(createdAt);
    }
    const oldTrade = await StockTransaction.findOne({
      _id: tradeId
    });
    const oldTradeLog = {
      action: 'EDT',
      userId: oldTrade.userId,
      symbol: oldTrade.label,
      marketId: oldTrade.marketId,
      marketName: oldTrade.marketName,
      scriptId: oldTrade.scriptId,
      scriptName: oldTrade.scriptName,
      order_type: oldTrade.orderType,
      lot: oldTrade.lot,
      qty: oldTrade.quantity,
      order_price: oldTrade.orderPrice,
      message: bodyMessage || 'Trade edited successfully',
      ip: oldTrade.ip,
      time: oldTrade.createdAt,
      parentIds: oldTrade.parentIds,
      created_by: oldTrade.createdBy,
      txn_type: oldTrade.transactionType
    };
    await saveLog('trade', oldTradeLog);

    const tradeLog = {
      action: 'EDT',
      userId: userId,
      symbol: stock.label,
      marketId,
      marketName,
      scriptId,
      scriptName,
      order_type: orderType,
      lot: stock.lot,
      qty: stock.quantity,
      order_price: stock.orderPrice,
      message: bodyMessage || 'Trade edited successfully',
      ip: userIp,
      time: new Date(),
      parentIds,
      created_by: loginUserId,
      txn_type: transactionType
    };

    await saveLog('trade', tradeLog);
    const savedStock = await saveTransaction(stock);

    // 🔔 Monitor: notify watchers of edit (fire-and-forget)
    MonitorService.notifyWatchers(userId, 'TRADE_EDITED', {
      loginUserId,
      isMultiLogin: req.context?.isMultiLogin || false,
      ip: userIp,
      device: req.headers['user-agent'] || 'Unknown',
      parentIds: services.parentIds || [],
      label: stock.label,
      transactionType: transactionType,
      lot: stock.lot,
      quantity: stock.quantity,
      price: stock.orderPrice,
      oldValues: {
        lot: oldTrade.lot,
        quantity: oldTrade.quantity,
        price: oldTrade.orderPrice
      },
      marketName,
      marketId,
      orderType: orderType,
      transactionStatus: oldTrade.transactionStatus,
      time: new Date()
    }).catch(() => { });

    if (transactionStatus !== 'PENDING') {
      const isEqualQty = newBuyQty == newSellQty;
      await setUserPosition(userId, scriptId, getValan._id, isEqualQty);
      await updateUserQuantity({ userId }, { previous: checkQuantity.previous, current: checkQuantity.current });
    }
    await deleteTransaction(tradeId);

    // Recalculate Final Bill if it's a previous valan trade
    if (getTrade.valanId.toString() !== getValan._id.toString()) {
      await recalculateFinalBill(userId, getTrade.valanId, marketId);
    }

    res.status(200).json({ status: true, message: "Trade edited successfully" });
  } catch (error) {
    console.log(error);
    res.status(500).json({ status: 'false', message: error.message });
  }
};

exports.saveLimitStock = async (req, res) => {
  try {
    const { effectiveUserId, loginUserId } = getUserContext(req);
    let reqData = { ...req.body };

    // Normalization
    if (!reqData.userId) reqData.userId = effectiveUserId;
    reqData.createdBy = loginUserId;
    // Parent Details
    const services = await getParentDetails(reqData.userId, reqData.marketId);
    if (!services) return res.status(400).json({ status: 'false', message: 'User details not found' });

    const userIp = req.headers['x-forwarded-for'] || req.socket.remoteAddress || req.ip;
    reqData.userIp = userIp;
    // reqData.createdBy already set to loginUserId above

    // ===== PHASE 1.5: M2M Blocked Check =====
    const blockKeys = [`m2m_blocked:${reqData.userId}`];
    if (services.parentIds && services.parentIds.length > 0) {
      services.parentIds.forEach(pid => blockKeys.push(`m2m_blocked:${pid}`));
    }
    const isM2MBlocked = await redisClient.exists(...blockKeys);
    if (isM2MBlocked > 0) {
      return res.status(403).json({ status: 'false', message: 'Trading blocked due to M2M limit breach' });
    }

    // Create base rejection log for all validations
    const baseRejectionLog = {
      action: 'INS',
      clientId: reqData.userId,
      marketId: reqData.marketId,
      scriptId: reqData.scriptId,
      symbol: reqData.label || reqData.scriptName,
      order_type: reqData.orderType,
      lot: reqData.lot,
      qty: reqData.quantity,
      order_price: reqData.price,
      message: '',
      ip: userIp,
      time: new Date(),
      parentIds: services.parentIds,
      txn_type: reqData.transactionType
    };

    // 1. Basic Rules
    const basicValidation = await CommonStockValidator.validateBasicRules(reqData, services);
    if (!basicValidation.isValid) {
      baseRejectionLog.message = basicValidation.message;
      await saveLog('rejection', baseRejectionLog);
      return res.status(basicValidation.statusCode || 400).json({ status: 'false', message: basicValidation.message });
    }

    // 2. Stale Data Check
    const lookupKey = reqData.symbol || reqData.scriptId;
    const staleValidation = await CommonStockValidator.validateStaleData(reqData.scriptId, lookupKey);
    if (!staleValidation.isValid) {
      baseRejectionLog.message = staleValidation.message;
      await saveLog('rejection', baseRejectionLog);
      return res.status(400).json({ status: 'false', message: staleValidation.message });
    }

    // 3. Market Status
    const getValan = await setGetValanDetails();
    services.getValan = getValan;

    const marketValidation = await CommonStockValidator.validateMarketStatus(reqData, services);
    if (!marketValidation.isValid) {
      baseRejectionLog.message = marketValidation.message;
      await saveLog('rejection', baseRejectionLog);
      return res.status(400).json({ status: 'false', message: marketValidation.message });
    }

    // 4. Quantity Review
    const qtyValidation = await CommonStockValidator.validateQuantityLimits(
      reqData.userId,
      reqData.scriptId,
      reqData.marketId,
      reqData.lot,
      reqData.quantity,
      reqData.price,
      services.parentIds,
      reqData.scriptName,
      reqData.transactionType,
      services.getValan?._id
    );
    if (!qtyValidation.isValid) {
      baseRejectionLog.message = qtyValidation.message;
      await saveLog('rejection', baseRejectionLog);
      return res.status(400).json({ status: 'false', message: qtyValidation.message });
    }

    // 4.5 Expiry Status Check
    const expiryValidation = await CommonStockValidator.validateExpiryStatus(reqData, services);
    if (!expiryValidation.isValid) {
      baseRejectionLog.message = expiryValidation.message;
      await saveLog('rejection', baseRejectionLog);
      return res.status(400).json({ status: 'false', message: expiryValidation.message });
    }

    // 5. Valan & Stock Existence
    if (moment().format('YYYY-MM-DD') > moment(getValan.endDate).format('YYYY-MM-DD')) {
      baseRejectionLog.message = 'No valan found';
      await saveLog('rejection', baseRejectionLog);
      return res.status(400).json({ status: 'false', message: 'No valan found' });
    }

    const liveStock = await getLiveStock(lookupKey);
    if (!liveStock) {
      baseRejectionLog.message = 'No stock exists for ' + lookupKey;
      await saveLog('rejection', baseRejectionLog);
      return res.status(400).json({ status: 'false', message: 'No stock exists' });
    }

    // Block trade if Buy or Sell price is 0 (Buyer/Seller only mode)
    if (liveStock.BuyPrice === 0 || liveStock.SellPrice === 0) {
      const side = liveStock.BuyPrice === 0 ? 'Buyer' : 'Seller';
      baseRejectionLog.message = `Trading blocked: Script is in ${side} only mode.`;
      await saveLog('rejection', baseRejectionLog);
      return res.status(400).json({ status: 'false', message: baseRejectionLog.message });
    }

    // 6. Limit Order Specifics
    services.getMarket = services.marketAccess.find((mkt) => mkt.marketId == reqData.marketId);

    if (!services.getMarket) {
      baseRejectionLog.message = 'Segment is missing';
      await saveLog('rejection', baseRejectionLog);
      return res.status(400).json({ status: 'false', message: 'Segment is missing' });
    }

    // 6a. Position Square-Off Check
    const squareOffValidation = await CommonStockValidator.validatePositionSquareOff(reqData, services);
    if (!squareOffValidation.isValid) {
      baseRejectionLog.message = squareOffValidation.message;
      await saveLog('rejection', baseRejectionLog);
      return res.status(400).json({ status: 'false', message: squareOffValidation.message });
    }

    // 6b. M2M Profit/Loss Limit Check
    const m2mValidation = await CommonStockValidator.validateM2MLimits(reqData, services);
    if (!m2mValidation.isValid) {
      baseRejectionLog.message = m2mValidation.message;
      await saveLog('rejection', baseRejectionLog);
      return res.status(400).json({ status: 'false', message: m2mValidation.message });
    }

    // 6c. Margin Limit Check (Priority)
    const marginValidation = await CommonStockValidator.validateMarginLimits(reqData, services);
    if (!marginValidation.isValid) {
      baseRejectionLog.message = marginValidation.message;
      await saveLog('rejection', baseRejectionLog);
      return res.status(400).json({ status: 'false', message: marginValidation.message });
    }

    console.log(`[LIMIT-DEBUG][Controller:newLimit] LimitOrderValidator userId=${reqData.userId} scriptId=${reqData.scriptId} marketId=${reqData.marketId} price=${reqData.price} orderType=${reqData.orderType}`);
    const limitOrderValidation = await LimitOrderValidator.validate(reqData, services, liveStock);
    console.log(`[LIMIT-DEBUG][Controller:newLimit] Result isValid=${limitOrderValidation.isValid} message=${limitOrderValidation.message || ''}`);
    if (!limitOrderValidation.isValid) {
      console.log(`[LIMIT-DEBUG][Controller:newLimit] BLOCKED userId=${reqData.userId} marketId=${reqData.marketId} scriptId=${reqData.scriptId} reason=${limitOrderValidation.message}`);
      baseRejectionLog.message = limitOrderValidation.message;
      await saveLog('rejection', baseRejectionLog);
      return res.status(400).json({ status: 'false', message: limitOrderValidation.message });
    }

    // 7. Quantity Review for PENDING trade
    const checkQuantity = await getUserQuantity({
      userId: reqData.userId,
      marketId: reqData.marketId,
      marketName: reqData.marketName,
      scriptId: reqData.scriptId,
      scriptName: reqData.scriptName,
      quantity: reqData.quantity,
      transactionType: reqData.transactionType
    });

    // 8. Save
    const totalOrderPrice = reqData.quantity * reqData.price;
    const quantityType = {
      intraday: Math.abs(checkQuantity.intraday),
      delivery: Math.abs(checkQuantity.delivery)
    };

    const isBuy = reqData.transactionType.toUpperCase() === 'BUY';
    const marketPrice = isBuy
      ? parseFloat(liveStock.SellPrice) || parseFloat(liveStock.Ltp) || parseFloat(liveStock.LastTradePrice) || 0
      : parseFloat(liveStock.BuyPrice) || parseFloat(liveStock.Ltp) || parseFloat(liveStock.LastTradePrice) || 0;

    const isStopLoss = isBuy ? reqData.price > marketPrice : reqData.price < marketPrice;

    // Determine message and shortmsg based on transaction type and order type
    const txnType = reqData.transactionType.toUpperCase();
    let successMessage, shortMessage;

    if (isStopLoss) {
      successMessage = txnType === 'BUY' ? 'Buy stop loss placed' : 'Sell stop loss placed';
      shortMessage = txnType === 'BUY' ? 'Buy stop loss' : 'Sell stop loss';
    } else {
      successMessage = txnType === 'BUY' ? 'Buy limit placed' : 'Sell limit placed';
      shortMessage = txnType === 'BUY' ? 'Buy limit' : 'Sell limit';
    }

    // --------- Compute tradePosition from live price ---------
    // BUY: if order price < live SellPrice → DOWN (standard limit buy), else UP (stop buy)
    // SELL: if order price < live BuyPrice → DOWN (stop loss), else UP (standard limit sell)
    let tradePosition = 'NRM';
    const isBuyOrder = reqData.transactionType.toUpperCase() === 'BUY';
    if (isBuyOrder) {
      tradePosition = +reqData.price < parseFloat(liveStock.SellPrice) ? 'DOWN' : 'UP';
    } else {
      tradePosition = +reqData.price < parseFloat(liveStock.BuyPrice) ? 'DOWN' : 'UP';
    }
    // ----------------------------------------------------------

    const stock = {
      ...reqData,
      valanId: getValan._id,
      expiry: getExpiry(reqData.label),
      ip: userIp,
      userAgent: req.headers['user-agent'],
      message: successMessage,
      transactionStatus: 'PENDING', // Limit orders are PENDING
      type: 'NRM',

      // Required fields for StockTransaction model
      orderPrice: reqData.price,
      totalOrderPrice: totalOrderPrice,
      quantityType: quantityType,

      // Set zero/base values for brokerage-related fields for PENDING trades
      netPrice: reqData.price,
      totalNetPrice: totalOrderPrice,
      orderBrokerage: 0,
      netBrokerage: 0,
      brokeragePercentage: 0,
      brokeragePercentageType: {
        intraday: 0,
        delivery: 0
      },
      brokerTotalBrokerage: 0,
      brokerTotalPercentage: 0,
      otherBrokerage: {}, // Empty for now, calculated on execution
      m2mPrice: reqData.price,

      parentIds: services.parentIds,
      myParent: services.myParent,
      brokerIds: (services.basicDetails.brokerPartnership || []).map((b) => (b.broker && b.broker._id ? b.broker._id : b.broker)),
      partnership: services.partnership,
      minPercentageWiseBrokerage: services.minPercentageWiseBrokerage,
      minLotWiseBrokerage: services.minLotWiseBrokerage,
      createdBy: reqData.createdBy,
      shortmsg: shortMessage,
      tradePosition, // server-computed — always overrides reqData
    };

    const savedStock = await saveTransaction(stock);


    try {
      let effectiveUserScriptId = reqData.userScriptId;
      if (!effectiveUserScriptId) {
        const script = await UserScript.findOne({ createdBy: reqData.userId, scriptId: reqData.scriptId, label: reqData.label }).lean();
        if (script) effectiveUserScriptId = script._id;
      }

      DashboardStockEvent({
        userId: reqData.userId,
        parentIds: services.parentIds,
        marketId: reqData.marketId,
        scriptId: reqData.scriptId,
        transactionType: reqData.transactionType,
        valanId: getValan._id,
        userScriptId: effectiveUserScriptId,
        lot: reqData.lot,
        quantity: reqData.quantity,
        orderType: reqData.orderType,
        price: reqData.price,
        status: 'PENDING',
        _id: savedStock._id,
        label: reqData.label
      });
    } catch (notificationErr) {
      console.error('Error sending limit trade notification:', notificationErr);
    }

    // 🔔 Monitor: notify watchers of limit placement (fire-and-forget)
    MonitorService.notifyWatchers(reqData.userId, 'LIMIT_PLACED', {
      loginUserId,
      isMultiLogin: req.context?.isMultiLogin || false,
      ip: userIp,
      device: req.headers['user-agent'] || 'Unknown',
      parentIds: services.parentIds || [],
      label: reqData.label,
      transactionType: reqData.transactionType,
      lot: reqData.lot,
      quantity: reqData.quantity,
      price: reqData.price,
      marketName: reqData.marketName,
      marketId: reqData.marketId,
      orderType: reqData.orderType,
      time: new Date()
    }).catch(() => { });

    // Invalidate M2M cache after trade execution
    M2MService.invalidateM2MCache(reqData.userId, getValan._id).catch((err) => {
      console.error('Error invalidating M2M cache:', err);
    });

    res.status(200).json({ status: true, message: stock.message });
  } catch (error) {
    console.log(error);
    res.status(500).json({ status: 'false', message: error.message });
  }
};

exports.getShortTradeReport = async (req, res) => {
  try {
    const userId = getEffectiveUserId(req);
    const level = req.user.accountType?.level;

    const { market, script, master, broker, client, startDate, endDate } = req.body;
    // console.log("Minutes : ", req.body.minute);
    // Use current date as default if not provided
    let sDate, eDate;
    if (startDate) {
      const range = getCurrentDateRange(startDate);
      sDate = range.startOfDay;
    }
    if (endDate) {
      const range = getCurrentDateRange(endDate);
      eDate = range.endOfDay;
    }

    if (!sDate || !eDate) {
      const today = getCurrentDateRange();
      if (!sDate) sDate = today.startOfDay;
      if (!eDate) eDate = today.endOfDay;
    }

    const matchFilter = {
      createdAt: { $gte: sDate, $lte: eDate },
      transactionStatus: 'COMPLETED'
    };

    // Determine target based on level
    if (level == 7) {
      matchFilter.userId = new mongoose.Types.ObjectId(userId);
    } else {
      matchFilter.parentIds = new mongoose.Types.ObjectId(userId);
    }

    if (market) {
      matchFilter['marketId'] = market;
    }
    if (script) {
      matchFilter['scriptId'] = script;
    }
    if (master) {
      matchFilter['parentIds'] = new mongoose.Types.ObjectId(master);
    }
    if (broker) {
      matchFilter['brokerIds'] = new mongoose.Types.ObjectId(broker);
    }
    if (client) {
      matchFilter['userId'] = new mongoose.Types.ObjectId(client);
    }

    const inMinutes = req.body.minute || (await hget('shortTradeMdata', 'minute')) || 15;
    const timeRange = Number(inMinutes) * 60 * 1000;
    const response = await getShortTrades(matchFilter, timeRange);
    res.status(200).json({ status: true, data: response });
  } catch (error) {
    console.log(error);
    res.status(500).json({ status: 'false', message: error.message });
  }
};
exports.getShortTradeReportAllUsers = async (req, res) => {
  try {
    const body = req.body || {};
    const { startDate, endDate, noOfTrades, market, script } = body;

    // ✅ Minute handling (body > redis > default)
    const minuteFromBody = body.minute ?? body.minutes;
    const inMinutesNum = minuteFromBody != null ? Number(minuteFromBody) : NaN;
    const inMinutes = Number.isFinite(inMinutesNum) && inMinutesNum > 0 ? inMinutesNum : (await hget('shortTradeMdata', 'minute')) || 15;

    const timeRange = Math.max(1, inMinutes) * 60 * 1000;

    // ✅ Date range
    let sDate, eDate;
    if (startDate) sDate = getCurrentDateRange(startDate).startOfDay;
    if (endDate) eDate = getCurrentDateRange(endDate).endOfDay;

    if (!sDate || !eDate) {
      const today = getCurrentDateRange();
      if (!sDate) sDate = today.startOfDay;
      if (!eDate) eDate = today.endOfDay;
    }

    // ✅ Base match
    const matchFilter = {
      createdAt: { $gte: sDate, $lte: eDate },
      transactionStatus: 'COMPLETED'
    };
    if (market) matchFilter.marketId = market;
    if (script) matchFilter.scriptId = script;

    // ✅ Get trades with both BUY and SELL in the time window (minute = window in minutes)
    let response = await getShortTrades(matchFilter, timeRange);

    /**
     * noOfTrades = minimum total trades (BUY + SELL) in the window. 0 = no filter (show all).
     * e.g. noOfTrades: 2 → windows where (countBuy + countSell) >= 2 (e.g. 1 buy + 1 sell).
     */
    const n = noOfTrades != null && !isNaN(Number(noOfTrades)) && Number(noOfTrades) > 0 ? Number(noOfTrades) : null;

    if (n != null) {
      response = response.filter((item) => {
        const docs = (item.windowDocs || []).filter((d) => d.transactionStatus === 'COMPLETED');
        const countBuy = docs.filter((d) => d.transactionType === 'BUY').length;
        const countSell = docs.filter((d) => d.transactionType === 'SELL').length;
        return countBuy + countSell >= n;
      });

      // Dedupe: getShortTrades returns one row per transaction; same window can appear multiple times
      const seen = new Set();
      response = response.filter((item) => {
        const key = `${item.userId}-${item.scriptId}-${new Date(item.windowStart).getTime()}`;
        if (seen.has(key)) return false;
        seen.add(key);
        return true;
      });
    }

    res.status(200).json({
      status: true,
      data: response
    });
  } catch (error) {
    console.error(error);
    res.status(500).json({
      status: false,
      message: error.message
    });
  }
};

exports.getLineTradeReport = async (req, res) => {
  try {
    const { market, script, buyRateFrom, buyRateTo, sellRateFrom, sellRateTo, minute, startDate, endDate } = req.body;

    if (!market || !script) {
      return res.status(400).json({ status: false, message: 'market and script are required' });
    }

    let sDate, eDate;
    if (startDate) {
      const range = getCurrentDateRange(startDate);
      sDate = range.startOfDay;
    }
    if (endDate) {
      const range = getCurrentDateRange(endDate);
      eDate = range.endOfDay;
    }
    if (!sDate || !eDate) {
      const today = getCurrentDateRange();
      if (!sDate) sDate = today.startOfDay;
      if (!eDate) eDate = today.endOfDay;
    }

    // Get requester ID to filter downline users only
    const requesterId = getEffectiveUserId(req);

    const matchFilter = {
      parentIds: new mongoose.Types.ObjectId(requesterId),
      marketId: String(market),
      scriptId: String(script),
      createdAt: { $gte: sDate, $lte: eDate },
      transactionStatus: 'COMPLETED'
    };

    const inMinutes = minute != null && minute !== '' ? Number(minute) : 15;
    const timeRange = (Number.isFinite(inMinutes) ? Math.max(1, inMinutes) : 15) * 60 * 1000;
    const num = (v) => (v != null && v !== '' && !Number.isNaN(Number(v)) ? Number(v) : undefined);
    const response = await getLineTrades(matchFilter, timeRange, num(buyRateFrom), num(buyRateTo), num(sellRateFrom), num(sellRateTo));
    res.status(200).json({ status: true, data: response });
  } catch (error) {
    console.log(error);
    res.status(500).json({ status: 'false', message: error.message });
  }
};

exports.getShortTrades = async (req, res) => {
  try {
    const userId = getEffectiveUserId(req);
    const { scriptId, marketId } = req.body;
    const response = await getShortTrades({
      userId,
      scriptId,
      marketId
    });
    res.status(200).json({ status: true, data: response });
  } catch (error) {
    console.log(error);
    res.status(500).json({ status: 'false', message: error.message });
  }
};

exports.getLineTrades = async (req, res) => {
  try {
    const userId = getEffectiveUserId(req);
    const { scriptId, marketId } = req.body;
    const response = await getLineTrades({ userId, scriptId, marketId });
    res.status(200).json({ status: true, data: response });
  } catch (error) {
    console.log(error);
    res.status(500).json({ status: 'false', message: error.message });
  }
};

const getMyLevel = (req) => {
  return +req.user.accountType.level;
};

exports.deleteTradeRecord = async (req, res) => {
  try {
    const userId = getEffectiveUserId(req);
    const { tradeId } = req.body;
    const response = await deleteTradeRecord({ userId, tradeId });
    // setUserPosition
    res.status(200).json({ status: true, data: response });
  } catch (error) {
    console.log(error);
    res.status(500).json({ status: 'false', message: error.message });
  }
};

exports.saveDeletedLineTrade = async (req, res) => {
  try {
    const requesterId = getLoginUserId(req);
    const payload = req.body || {};
    await saveDeletedLineTradeToDb(payload);
    res.status(200).json({ status: true, message: 'Deleted line trade saved to history' });
  } catch (error) {
    console.error('saveDeletedLineTrade controller error:', error);
    const status = error.message && error.message.includes('required') ? 400 : 500;
    res.status(status).json({ status: false, message: error.message });
  }
};
exports.getDeletedLineTrades = async (req, res) => {
  try {
    const reportContextKey = req.query?.reportContextKey ?? req.body?.reportContextKey ?? '';
    const startDate = req.query?.startDate ?? req.body?.startDate;
    const endDate = req.query?.endDate ?? req.body?.endDate;

    const filter = {};
    if (reportContextKey) {
      filter.reportContextKey = reportContextKey;
    }

    let sDate, eDate;
    if (startDate) sDate = getCurrentDateRange(startDate).startOfDay;
    if (endDate) eDate = getCurrentDateRange(endDate).endOfDay;

    // Default to today if no other filter is provided
    if (!reportContextKey && !sDate && !eDate) {
      const today = getCurrentDateRange();
      sDate = today.startOfDay;
      eDate = today.endOfDay;
    }

    if (sDate || eDate) {
      filter.createdAt = {};
      if (sDate) filter.createdAt.$gte = sDate;
      if (eDate) filter.createdAt.$lte = eDate;
    }

    const data = await getDeletedLineTrades(filter);
    res.status(200).json({ status: true, data: data || [] });
  } catch (error) {
    console.log(error);
    res.status(500).json({ status: false, message: error.message });
  }
};

exports.getBulkTradingReport = async (req, res) => {
  try {
    const body = req.body || {};
    const { startDate, endDate, noOfTrades, market, script } = body;

    // Minute: body > redis bulkTradeMdata > default 15 (same pattern as short trade, different redis key)
    const redisBulk = await hgetall('bulkTradeMdata').catch(() => ({}));
    const minuteFromBody = body.minute ?? body.minutes;
    const inMinutesNum = minuteFromBody != null ? Number(minuteFromBody) : redisBulk?.minute != null ? Number(redisBulk.minute) : NaN;
    const inMinutes = Number.isFinite(inMinutesNum) && inMinutesNum > 0 ? inMinutesNum : 15;
    const timeRange = Math.max(1, inMinutes) * 60 * 1000;

    // Date range (same as getShortTradeReportAllUsers)
    let sDate, eDate;
    if (startDate) sDate = getCurrentDateRange(startDate).startOfDay;
    if (endDate) eDate = getCurrentDateRange(endDate).endOfDay;
    if (!sDate || !eDate) {
      const today = getCurrentDateRange();
      if (!sDate) sDate = today.startOfDay;
      if (!eDate) eDate = today.endOfDay;
    }

    // Get requester ID to filter downline users only
    const requesterId = getEffectiveUserId(req);

    // Base match - filter by downline users
    const matchFilter = {
      parentIds: new mongoose.Types.ObjectId(requesterId),
      createdAt: { $gte: sDate, $lte: eDate },
      transactionStatus: 'COMPLETED'
    };
    if (market) matchFilter.marketId = market;
    if (script) matchFilter.scriptId = script;

    // Same as short trade: get buy-sell / sell-buy windows (profit > 0) within minute window
    let response = await getShortTrades(matchFilter, timeRange);

    // noOfTrades: minimum total trades in window (same as getShortTradeReportAllUsers). 0 = no filter.
    const noOfTradesVal = noOfTrades != null ? noOfTrades : redisBulk?.noOfTrade;
    const n = noOfTradesVal != null && !isNaN(Number(noOfTradesVal)) && Number(noOfTradesVal) > 0 ? Number(noOfTradesVal) : null;

    if (n != null) {
      response = response.filter((item) => {
        const docs = (item.windowDocs || []).filter((d) => d.transactionStatus === 'COMPLETED');
        const countBuy = docs.filter((d) => d.transactionType === 'BUY').length;
        const countSell = docs.filter((d) => d.transactionType === 'SELL').length;
        return countBuy + countSell >= n;
      });

      const seen = new Set();
      response = response.filter((item) => {
        const key = `${item.userId}-${item.scriptId}-${new Date(item.windowStart).getTime()}`;
        if (seen.has(key)) return false;
        seen.add(key);
        return true;
      });
    }

    res.status(200).json({ status: true, data: response });
  } catch (error) {
    console.log(error);
    res.status(500).json({ status: false, message: error.message });
  }
};

exports.getBulkLot = async (req, res) => {
  try {
    const { fromDate, toDate, lotQty } = req.body;
    const requesterId = getEffectiveUserId(req);

    if (!fromDate || !toDate || lotQty === undefined) {
      return res.status(400).json({ status: false, message: 'fromDate, toDate, and lotQty are required' });
    }

    const sDate = moment(fromDate).startOf('day').toDate();
    const eDate = moment(toDate).endOf('day').toDate();

    // 1. Fetch transactions for downline within date range
    const transactions = await StockTransaction.find({
      parentIds: new mongoose.Types.ObjectId(requesterId),
      createdAt: { $gte: sDate, $lte: eDate },
      transactionStatus: 'COMPLETED'
    }).lean();

    if (transactions.length === 0) {
      return res.status(200).json({ status: true, data: [] });
    }

    const userGroups = {};
    const scriptIds = new Set();

    for (const tx of transactions) {
      const uId = tx.userId.toString();
      if (!userGroups[uId]) {
        userGroups[uId] = {
          userId: tx.userId,
          scripts: {}
        };
      }

      const sid = tx.scriptId;
      if (!userGroups[uId].scripts[sid]) {
        userGroups[uId].scripts[sid] = {
          label: tx.label,
          scriptName: tx.scriptName,
          buyQty: 0,
          sellQty: 0,
          buyVal: 0, // totalOrderPrice
          sellVal: 0,
          buyLot: 0,
          sellLot: 0
        };
      }
      const s = userGroups[uId].scripts[sid];

      const type = (tx.transactionType || '').toUpperCase();
      if (type === 'BUY') {
        s.buyQty += tx.quantity || 0;
        s.buyVal += tx.totalOrderPrice || 0;
        s.buyLot += tx.lot || 0;
      } else {
        // Anything not BUY is handled as SELL/SHORT
        s.sellQty += tx.quantity || 0;
        s.sellVal += tx.totalOrderPrice || 0;
        s.sellLot += tx.lot || 0;
      }
      scriptIds.add(sid);
    }

    // 2. Live prices for valuation
    const priceMap = {};
    const livePrices = await getMultipleStockData(Array.from(scriptIds));
    Array.from(scriptIds).forEach((id, idx) => {
      if (livePrices[idx]) priceMap[id] = livePrices[idx];
    });

    // 3. Process and Filter
    const results = [];
    const minLotFilter = Number(lotQty);

    for (const uId in userGroups) {
      const group = userGroups[uId];
      const filteredScripts = [];
      let userTotalVolumeLots = 0;
      let userTotalUnrealizedPart = 0;
      let userTotalOverallProfit = 0;

      for (const sid in group.scripts) {
        const s = group.scripts[sid];

        // VOLUME RULE: Bulk is defined by the volume of trades done
        const transactionVolumeLots = Math.max(s.buyLot || 0, s.sellLot || 0);
        if (transactionVolumeLots < minLotFilter) continue;

        const netQty = Number(((s.buyQty || 0) - (s.sellQty || 0)).toFixed(2));
        const matchedQty = Math.min(s.buyQty || 0, s.sellQty || 0);

        // Averages
        const avgBuy = s.buyQty > 0 ? s.buyVal / s.buyQty : 0;
        const avgSell = s.sellQty > 0 ? s.sellVal / s.sellQty : 0;

        // Part 1: Realized Profit (Closed portion)
        // Client Perspective: Sell - Buy
        const realizedProfit = matchedQty * (avgSell - avgBuy);

        // Part 2: Unrealized Profit (Open portion)
        let unrealizedProfitPart = 0;
        const live = priceMap[sid];
        if (Math.abs(netQty) > 0.1 && live) {
          const bid = Number(live.SellPrice ?? live.ask ?? live.Ltp ?? 0);
          const ask = Number(live.BuyPrice ?? live.bid ?? live.Ltp ?? 0);

          if (netQty > 0) {
            // Client is LONG: Exit at Bid
            const exitPrice = bid || Number(live.Ltp || 0);
            if (exitPrice > 0) unrealizedProfitPart = netQty * (exitPrice - avgBuy);
          } else {
            // Client is SHORT: Exit at Ask
            const exitPrice = ask || Number(live.Ltp || 0);
            if (exitPrice > 0) unrealizedProfitPart = Math.abs(netQty) * (avgSell - exitPrice);
          }
        }

        // Total Performance for the script
        const totalProfit = realizedProfit + unrealizedProfitPart;

        filteredScripts.push({
          scriptId: sid,
          label: s.label,
          buyQty: Number(s.buyQty.toFixed(2)),
          sellQty: Number(s.sellQty.toFixed(2)),
          holdingLots: Number(transactionVolumeLots.toFixed(2)),
          netQty: netQty,
          side: netQty > 0 ? 'LONG' : netQty < 0 ? 'SHORT' : 'CLOSED',
          // RULE: Show only the "live" part in this field. 0 if closed.
          unrealizedPL: Number(unrealizedProfitPart.toFixed(2)),
          // Total profit per transaction lot (avg pand l is total/lots)
          avgPL: transactionVolumeLots > 0.001 ? Number((totalProfit / transactionVolumeLots).toFixed(2)) : 0
        });

        userTotalVolumeLots += transactionVolumeLots;
        userTotalUnrealizedPart += unrealizedProfitPart;
        userTotalOverallProfit += totalProfit;
      }

      if (filteredScripts.length > 0) {
        results.push({
          userId: group.userId,
          totalHoldingLots: Number(userTotalVolumeLots.toFixed(2)),
          unrealizedPL: Number(userTotalUnrealizedPart.toFixed(2)),
          avgPL: userTotalVolumeLots > 0.001 ? Number((userTotalOverallProfit / userTotalVolumeLots).toFixed(2)) : 0,
          scripts: filteredScripts
        });
      }
    }

    // 4. Enrich with User Info
    const userIds = results.map((r) => r.userId);
    const isRequesterDemo = isDemoUser(req);
    const usersInfo = await UserModel.find({
      _id: { $in: userIds },
      demoid: isRequesterDemo ? true : { $ne: true }
    })
      .select('accountCode accountName')
      .lean();
    const userInfoMap = {};
    usersInfo.forEach((u) => {
      userInfoMap[u._id.toString()] = u;
    });

    const finalData = results
      .map((r) => {
        const u = userInfoMap[r.userId.toString()];
        return {
          ...r,
          accountCode: u?.accountCode || 'N/A',
          accountName: u?.accountName || 'N/A'
        };
      })
      .sort((a, b) => b.totalHoldingLots - a.totalHoldingLots);

    res.status(200).json({ status: true, data: finalData });
  } catch (error) {
    console.error('[getBulkLot] ERROR:', error);
    res.status(500).json({ status: false, message: error.message });
  }
};


// exports.getUserPositionReport = async (req, res) => {
//   try {
//     const { clientType, marketId, scriptId, masterId, clientId, brokerId, expiryDate, startDate, endDate, valanId: reqValanId, userid } = req.body;

//     let userId = getEffectiveUserId(req);
//     const level = req.user.accountType?.level;

//     // If userid is provided in request body, use it to filter data for that specific user
//     if (userid) {
//       userId = mongoose.Types.ObjectId.isValid(userid) ? new mongoose.Types.ObjectId(userid) : userid;
//     }

//     userId = new mongoose.Types.ObjectId(userId);
//     const currentUser = await UserModel.findById(userId).select('demoid').lean();
//     const isRequesterDemo = currentUser?.demoid === true;

//     /* ----------------------------
//        1️⃣ Match filter (dynamic)
//     -----------------------------*/
//     const matchFilter = {};

//     // 🔹 Active Valan (Primary Filter)
//     const activeValan = await getActiveWeekValan();
//     const activeValanId = activeValan._id;

//     if (reqValanId) {
//       matchFilter['valanId'] = new mongoose.Types.ObjectId(reqValanId);
//     } else if (!startDate && !endDate) {
//       matchFilter['valanId'] = activeValanId;
//     }

//     // 🔹 If userid is provided, filter for that specific user only
//     if (userid) {
//       matchFilter['userId'] = userId;
//     } else {
//       // 🔹 Client type logic (only when userid is NOT provided)
//       const userIdStr = userId.toString();

//       // Determine the filter key based on user level
//       // Level 6 (Broker) uses brokerIds, others use parentIds
//       const hierarchyKey = level == 6 ? 'brokerIds' : 'parentIds';

//       if (clientType === 'MY' && level != '7') {
//         // "MY" means only direct clients created by me (myParent = me)
//         // For brokers (level 6), also check brokerIds
//         if (level == 6) {
//           matchFilter['$or'] = [
//             { myParent: userId },
//             { myParent: userIdStr },
//             { brokerIds: userId },
//             { brokerIds: userIdStr }
//           ];
//         } else {
//           matchFilter['$or'] = [
//             { myParent: userId },
//             { myParent: userIdStr }
//           ];
//         }
//       } else if (clientType === 'ALL') {
//         // "ALL" means entire downline
//         matchFilter['$or'] = [
//           { parentIds: userId },
//           { parentIds: userIdStr },
//           { brokerIds: userId },
//           { brokerIds: userIdStr }
//         ];
//       }
//     }

//     /* ----------------------------
//        2️⃣ Optional filters
//     -----------------------------*/
//     const filterKeys = {
//       marketId,
//       scriptId,
//       masterId,
//       clientId,
//       brokerId,
//       expiryDate,
//       startDate,
//       endDate
//     };

//     Object.keys(filterKeys).forEach((key) => {
//       const val = filterKeys[key];
//       if (!val || val === '') return;

//       if (key === 'marketId') {
//         if (typeof val === 'string' && val.includes(',')) {
//           matchFilter['marketId'] = { $in: val.split(',').map((v) => v.trim()) };
//         } else if (Array.isArray(val)) {
//           matchFilter['marketId'] = { $in: val };
//         } else {
//           matchFilter['marketId'] = val;
//         }
//       }

//       if (key === 'scriptId') {
//         if (typeof val === 'string' && val.includes(',')) {
//           matchFilter['scriptId'] = { $in: val.split(',').map((v) => v.trim()) };
//         } else if (Array.isArray(val)) {
//           matchFilter['scriptId'] = { $in: val };
//         } else {
//           matchFilter['scriptId'] = val;
//         }
//       }

//       if (key === 'masterId') {
//         if (typeof val === 'string' && val.includes(',')) {
//           const ids = val.split(',').map((v) => v.trim()).filter(v => mongoose.Types.ObjectId.isValid(v)).map(v => new mongoose.Types.ObjectId(v));
//           matchFilter['parentIds'] = { $in: ids };
//         } else {
//           const mId = String(val).toLowerCase() === 'self' ? userId : val;
//           matchFilter['parentIds'] = mongoose.Types.ObjectId.isValid(mId) ? new mongoose.Types.ObjectId(mId) : mId;
//         }
//       }

//       if (key === 'clientId') {
//         if (typeof val === 'string' && val.includes(',')) {
//           const ids = val.split(',').map((v) => v.trim()).filter(v => mongoose.Types.ObjectId.isValid(v)).map(v => new mongoose.Types.ObjectId(v));
//           matchFilter['userId'] = { $in: ids };
//         } else {
//           const cId = String(val).toLowerCase() === 'self' ? userId : val;
//           matchFilter['userId'] = mongoose.Types.ObjectId.isValid(cId) ? new mongoose.Types.ObjectId(cId) : cId;
//         }
//       }

//       if (key === 'brokerId') {
//         if (typeof val === 'string' && val.includes(',')) {
//           const ids = val.split(',').map((v) => v.trim()).filter(v => mongoose.Types.ObjectId.isValid(v)).map(v => new mongoose.Types.ObjectId(v));
//           matchFilter['brokerIds'] = { $in: ids };
//         } else {
//           const bId = String(val).toLowerCase() === 'self' ? userId : val;
//           matchFilter['brokerIds'] = mongoose.Types.ObjectId.isValid(bId) ? new mongoose.Types.ObjectId(bId) : bId;
//         }
//       }

//       if (key === 'expiryDate') {
//         matchFilter['expiry'] = moment(val, 'YYYY-MM-DD').format('DDMMMYYYY').toUpperCase();
//       }

//       if (key === 'startDate') {
//         if (!matchFilter['createdAt']) matchFilter['createdAt'] = {};
//         matchFilter['createdAt']['$gte'] = moment.utc(val).startOf('day').toDate();
//       }

//       if (key === 'endDate') {
//         if (!matchFilter['createdAt']) matchFilter['createdAt'] = {};
//         matchFilter['createdAt']['$lte'] = moment.utc(val).endOf('day').toDate();
//       }
//     });

//     // console.log("getUserPositionReport: Match Filter Built:", JSON.stringify(matchFilter, null, 2));

//     /* ----------------------------
//        3️⃣ Fetch user info
//     -----------------------------*/

//     const user = await getUser(
//       { _id: userId },
//       {
//         _id: 0,
//         accountCode: 1,
//         accountName: 1,
//         accountType: 1,
//         accountDetails: 1
//       }
//     );

//     // console.log("getUserPositionReport: User Info Fetched:", user ? "Success" : "Failed");

//     /* ----------------------------
//        4️⃣ FIXED BASE USER FILTER
//        (THIS WAS THE ISSUE)
//     -----------------------------*/

//     let baseUserFilter = {};

//     // If userid is provided, we already filtered in matchFilter, so skip base filter
//     if (!userid) {
//       if (level == 7) {
//         // Client login - only sees their own
//         baseUserFilter = { userId: userId };
//       } else {
//         // Admin / Master / Broker login
//         const userIdStr = userId.toString();
//         baseUserFilter = {
//           $or: [
//             { parentIds: userId },
//             { parentIds: userIdStr },
//             { brokerIds: userId },
//             { brokerIds: userIdStr },
//             { userId: userId },
//             { userId: userIdStr }
//           ]
//         };
//       }
//     }
//     // console.log("getUserPositionReport: Base User Filter:", JSON.stringify(baseUserFilter, null, 2));

//     /* ----------------------------
//        5️⃣ Final filter (Combine using $and to avoid property collisions)
//     -----------------------------*/
//     const finalMatchStages = [{ transactionStatus: 'COMPLETED' }];

//     if (Object.keys(baseUserFilter).length > 0) {
//       finalMatchStages.push(baseUserFilter);
//     }
//     if (Object.keys(matchFilter).length > 0) {
//       finalMatchStages.push(matchFilter);
//     }

//     const filter = finalMatchStages.length > 1 ? { $and: finalMatchStages } : finalMatchStages[0];

//     // console.log("getUserPositionReport: FINAL FILTER sent to DB:", JSON.stringify(filter, null, 2));

//     // 🔍 Debug (optional – remove later)
//     // console.log("FINAL FILTER =>", JSON.stringify(filter, null, 2));

//     /* ----------------------------
//        6️⃣ Fetch report data
//     -----------------------------*/
//     let response = await getScriptWiseReport(filter, user.accountType.level, userId, isRequesterDemo);

//     /* ----------------------------
//        6.5️⃣ Enrich response with user-wise account details
//     -----------------------------*/
//     if (Array.isArray(response) && response.length > 0) {
//       // Get all unique userIds from userDetails (service returns userId in userDetails._id)
//       const userIds = response
//         .map(item => item.userDetails?._id)
//         .filter(Boolean);

//       if (userIds.length > 0) {
//         // Fetch all users' account details
//   const usersAccountDetails = await UserModel.find(
//   { _id: { $in: userIds } },
//   {
//     _id: 1,
//     'accountDetails.m2mLoss_NSE_MCX_NOPT': 1,
//     'accountDetails.m2mProfit_NSE_MCX_NOPT': 1,
//     'accountDetails.m2mLoss_FOREX_COMEX': 1,
//     'accountDetails.m2mProfit_FOREX_COMEX': 1,
//     'accountDetails.m2mLoss_NSEQ': 1,
//     'accountDetails.m2mProfit_NSEQ': 1
//   }
// ).lean();

//         // Create a map for quick lookup
//         const userDetailsMap = {};
//         usersAccountDetails.forEach(u => {
//           userDetailsMap[u._id.toString()] = u.accountDetails || {};
//         });

//         // Enrich each response item with user's account details
//         response = response.map(item => ({
//           ...item,
//           userAccountDetails: userDetailsMap[item.userDetails?._id?.toString()] || {}
//         }));
//       }
//     }

//     /* ----------------------------
//        7️⃣ Response
//     -----------------------------*/
//     res.status(200).json({
//       status: true,
//       data: response
//     });
//   } catch (error) {
//     console.error('getUserPositionReport error:', error);
//     res.status(500).json({
//       status: false,
//       message: error.message
//     });
//   }
// };
exports.getUserPositionReport = async (req, res) => {
  try {
    const { clientType, marketId, scriptId, masterId, clientId, brokerId, expiryDate, startDate, endDate, valanId: reqValanId, userid } = req.body;

    let userId = getEffectiveUserId(req);
    const level = req.user.accountType?.level;

    // If userid is provided in request body, use it to filter data for that specific user
    if (userid) {
      userId = mongoose.Types.ObjectId.isValid(userid) ? new mongoose.Types.ObjectId(userid) : userid;
    }

    userId = new mongoose.Types.ObjectId(userId);
    const currentUser = await UserModel.findById(userId).select('demoid').lean();
    const isRequesterDemo = currentUser?.demoid === true;

    /* ----------------------------
       1️⃣ Match filter (dynamic)
    -----------------------------*/
    const matchFilter = {};

    // 🔹 Active Valan (Primary Filter)
    const activeValan = await getActiveWeekValan();
    const activeValanId = activeValan._id;

    if (reqValanId) {
      matchFilter['valanId'] = new mongoose.Types.ObjectId(reqValanId);
    } else if (!startDate && !endDate) {
      matchFilter['valanId'] = activeValanId;
    }

    // 🔹 If userid is provided, filter for that specific user only
    if (userid) {
      matchFilter['userId'] = userId;
    } else {
      // 🔹 Client type logic (only when userid is NOT provided)
      const userIdStr = userId.toString();

      // Determine the filter key based on user level
      // Level 6 (Broker) uses brokerIds, others use parentIds
      const hierarchyKey = level == 6 ? 'brokerIds' : 'parentIds';

      if (clientType === 'MY' && level != '7') {
        // "MY" means only direct clients created by me (myParent = me)
        // For brokers (level 6), also check brokerIds AND broker partnerships
        if (level == 6) {
          // Find all users who have this broker in their brokerPartnership
          // AND were created by this broker (myParent check)
          const brokerPartnerUsers = await UserModel.find({
            $or: [
              { 'basicDetails.brokerPartnership.broker._id': userId },
              { 'basicDetails.brokerPartnership.broker._id': userIdStr },
              { 'basicDetails.brokerPartnership.broker': userId },
              { 'basicDetails.brokerPartnership.broker': userIdStr }
            ],
            $and: [
              {
                $or: [
                  { createdBy: userId },
                  { createdBy: userIdStr }
                ]
              }
            ],
            isDeleted: false,
            demoid: isRequesterDemo ? true : { $ne: true }
          }).select('_id').lean();

          const myPartnerUserIds = brokerPartnerUsers.map(u => u._id);

          matchFilter['$or'] = [
            { myParent: userId },
            { myParent: userIdStr },
            { brokerIds: userId },
            { brokerIds: userIdStr },
            // CRITICAL FIX: Include transactions for users who have this broker assigned
            // even if trades were made before broker assignment
            { userId: { $in: myPartnerUserIds } }
          ];
        } else {
          matchFilter['$or'] = [
            { myParent: userId },
            { myParent: userIdStr }
          ];
        }
      } else if (clientType === 'ALL') {
        // "ALL" means entire downline
        if (level == 6) {
          // For brokers: Find all users who have this broker in their brokerPartnership
          const brokerPartnerUsers = await UserModel.find({
            $or: [
              { 'basicDetails.brokerPartnership.broker._id': userId },
              { 'basicDetails.brokerPartnership.broker._id': userIdStr },
              { 'basicDetails.brokerPartnership.broker': userId },
              { 'basicDetails.brokerPartnership.broker': userIdStr }
            ],
            isDeleted: false,
            demoid: isRequesterDemo ? true : { $ne: true }
          }).select('_id').lean();

          const partnerUserIds = brokerPartnerUsers.map(u => u._id);

          matchFilter['$or'] = [
            { parentIds: userId },
            { parentIds: userIdStr },
            { brokerIds: userId },
            { brokerIds: userIdStr },
            { userId: { $in: partnerUserIds } }
          ];
        } else {
          matchFilter['$or'] = [
            { parentIds: userId },
            { parentIds: userIdStr },
            { brokerIds: userId },
            { brokerIds: userIdStr }
          ];
        }
      }
    }

    /* ----------------------------
       2️⃣ Optional filters
    -----------------------------*/
    const filterKeys = {
      marketId,
      scriptId,
      masterId,
      clientId,
      brokerId,
      expiryDate,
      startDate,
      endDate
    };

    Object.keys(filterKeys).forEach((key) => {
      const val = filterKeys[key];
      if (!val || val === '') return;

      if (key === 'marketId') {
        if (typeof val === 'string' && val.includes(',')) {
          matchFilter['marketId'] = { $in: val.split(',').map((v) => v.trim()) };
        } else if (Array.isArray(val)) {
          matchFilter['marketId'] = { $in: val };
        } else {
          matchFilter['marketId'] = val;
        }
      }

      if (key === 'scriptId') {
        if (typeof val === 'string' && val.includes(',')) {
          matchFilter['scriptId'] = { $in: val.split(',').map((v) => v.trim()) };
        } else if (Array.isArray(val)) {
          matchFilter['scriptId'] = { $in: val };
        } else {
          matchFilter['scriptId'] = val;
        }
      }

      if (key === 'masterId') {
        if (typeof val === 'string' && val.includes(',')) {
          const ids = val.split(',').map((v) => v.trim()).filter(v => mongoose.Types.ObjectId.isValid(v)).map(v => new mongoose.Types.ObjectId(v));
          matchFilter['parentIds'] = { $in: ids };
        } else {
          const mId = String(val).toLowerCase() === 'self' ? userId : val;
          matchFilter['parentIds'] = mongoose.Types.ObjectId.isValid(mId) ? new mongoose.Types.ObjectId(mId) : mId;
        }
      }

      if (key === 'clientId') {
        if (typeof val === 'string' && val.includes(',')) {
          const ids = val.split(',').map((v) => v.trim()).filter(v => mongoose.Types.ObjectId.isValid(v)).map(v => new mongoose.Types.ObjectId(v));
          matchFilter['userId'] = { $in: ids };
        } else {
          const cId = String(val).toLowerCase() === 'self' ? userId : val;
          matchFilter['userId'] = mongoose.Types.ObjectId.isValid(cId) ? new mongoose.Types.ObjectId(cId) : cId;
        }
      }

      if (key === 'brokerId') {
        if (typeof val === 'string' && val.includes(',')) {
          const ids = val.split(',').map((v) => v.trim()).filter(v => mongoose.Types.ObjectId.isValid(v)).map(v => new mongoose.Types.ObjectId(v));
          matchFilter['brokerIds'] = { $in: ids };
        } else {
          const bId = String(val).toLowerCase() === 'self' ? userId : val;
          matchFilter['brokerIds'] = mongoose.Types.ObjectId.isValid(bId) ? new mongoose.Types.ObjectId(bId) : bId;
        }
      }

      if (key === 'expiryDate') {
        matchFilter['expiry'] = moment(val, 'YYYY-MM-DD').format('DDMMMYYYY').toUpperCase();
      }

      if (key === 'startDate') {
        if (!matchFilter['createdAt']) matchFilter['createdAt'] = {};
        matchFilter['createdAt']['$gte'] = moment.utc(val).startOf('day').toDate();
      }

      if (key === 'endDate') {
        if (!matchFilter['createdAt']) matchFilter['createdAt'] = {};
        matchFilter['createdAt']['$lte'] = moment.utc(val).endOf('day').toDate();
      }
    });

    // console.log("getUserPositionReport: Match Filter Built:", JSON.stringify(matchFilter, null, 2));

    /* ----------------------------
       3️⃣ Fetch user info
    -----------------------------*/

    const user = await getUser(
      { _id: userId },
      {
        _id: 0,
        accountCode: 1,
        accountName: 1,
        accountType: 1,
        accountDetails: 1
      }
    );

    // console.log("getUserPositionReport: User Info Fetched:", user ? "Success" : "Failed");

    /* ----------------------------
       4️⃣ FIXED BASE USER FILTER
       (THIS WAS THE ISSUE)
    -----------------------------*/

    let baseUserFilter = {};

    // If userid is provided, we already filtered in matchFilter, so skip base filter
    if (!userid) {
      if (level == 7) {
        // Client login - only sees their own
        baseUserFilter = { userId: userId };
      } else if (level == 6) {
        // Broker login - sees downline + broker partnership clients
        const userIdStr = userId.toString();

        // Find all users who have this broker in their brokerPartnership
        const brokerPartnerUsers = await UserModel.find({
          $or: [
            { 'basicDetails.brokerPartnership.broker._id': userId },
            { 'basicDetails.brokerPartnership.broker._id': userIdStr },
            { 'basicDetails.brokerPartnership.broker': userId },
            { 'basicDetails.brokerPartnership.broker': userIdStr }
          ],
          isDeleted: false,
          demoid: isRequesterDemo ? true : { $ne: true }
        }).select('_id').lean();

        const partnerUserIds = brokerPartnerUsers.map(u => u._id);

        baseUserFilter = {
          $or: [
            { parentIds: userId },
            { parentIds: userIdStr },
            { brokerIds: userId },
            { brokerIds: userIdStr },
            { userId: userId },
            { userId: userIdStr },
            { userId: { $in: partnerUserIds } }
          ]
        };
      } else {
        // Admin / Master login
        const userIdStr = userId.toString();
        baseUserFilter = {
          $or: [
            { parentIds: userId },
            { parentIds: userIdStr },
            { brokerIds: userId },
            { brokerIds: userIdStr },
            { userId: userId },
            { userId: userIdStr }
          ]
        };
      }
    }
    // console.log("getUserPositionReport: Base User Filter:", JSON.stringify(baseUserFilter, null, 2));

    /* ----------------------------
       5️⃣ Final filter (Combine using $and to avoid property collisions)
    -----------------------------*/
    const finalMatchStages = [{ transactionStatus: 'COMPLETED' }];

    if (Object.keys(baseUserFilter).length > 0) {
      finalMatchStages.push(baseUserFilter);
    }
    if (Object.keys(matchFilter).length > 0) {
      finalMatchStages.push(matchFilter);
    }

    const filter = finalMatchStages.length > 1 ? { $and: finalMatchStages } : finalMatchStages[0];

    // console.log("getUserPositionReport: FINAL FILTER sent to DB:", JSON.stringify(filter, null, 2));

    // 🔍 Debug (optional – remove later)
    // console.log("FINAL FILTER =>", JSON.stringify(filter, null, 2));

    /* ----------------------------
       6️⃣ Fetch report data
    -----------------------------*/
    let response = await getScriptWiseReport(filter, user.accountType.level, userId, isRequesterDemo);
    // console.log("getScriptWiseReport response hiiiiiiiiiiiiiiiiiiiiiiiiiiiiiiiiiiiiiiiiiii", response);
    /* ----------------------------
       6.5️⃣ Enrich response with user-wise account details
    -----------------------------*/
    if (Array.isArray(response) && response.length > 0) {
      // Get all unique userIds from userDetails (service returns userId in userDetails._id)
      const userIds = response
        .map(item => item.userDetails?._id)
        .filter(Boolean);

      if (userIds.length > 0) {
        // Fetch all users' account details
        const usersAccountDetails = await UserModel.find(
          { _id: { $in: userIds } },
          {
            _id: 1,
            'accountDetails.m2mLoss_NSE_MCX_NOPT': 1,
            'accountDetails.m2mProfit_NSE_MCX_NOPT': 1,
            'accountDetails.m2mLoss_FOREX_COMEX': 1,
            'accountDetails.m2mProfit_FOREX_COMEX': 1,
            'accountDetails.m2mLoss_NSEQ': 1,
            'accountDetails.m2mProfit_NSEQ': 1
          }
        ).lean();

        // Create a map for quick lookup
        const userDetailsMap = {};
        usersAccountDetails.forEach(u => {
          userDetailsMap[u._id.toString()] = u.accountDetails || {};
        });

        // Enrich each response item with user's account details
        response = response.map(item => ({
          ...item,
          userAccountDetails: userDetailsMap[item.userDetails?._id?.toString()] || {}
        }));
      }
    }

    /* ----------------------------
       7️⃣ Response
    -----------------------------*/
    res.status(200).json({
      status: true,
      data: response
    });
  } catch (error) {
    console.error('getUserPositionReport error:', error);
    res.status(500).json({
      status: false,
      message: error.message
    });
  }
};
const getRecursiveM2MLimits = (targetUserId, allUsers, viewerLevel) => {
  const targetIdStr = targetUserId.toString();
  let totalProfit = 0;
  let totalLoss = 0;

  allUsers.forEach((u) => {
    const isTarget = u._id.toString() === targetIdStr;
    const isDescendant = u.parentIds && u.parentIds.some((pid) => pid.toString() === targetIdStr);

    if (isTarget || isDescendant) {
      totalProfit += Number(u.accountDetails?.m2mProfit_NSE_MCX_NOPT || 0);
      totalLoss += Number(u.accountDetails?.m2mLoss_NSE_MCX_NOPT || 0);
    }
  });

  return {
    m2mProfitLimit: totalProfit / 100,
    m2mLossLimit: totalLoss / 100
  };
};

exports.getDownlineSummaryReport = async (req, res) => {
  try {
    let userId = getEffectiveUserId(req);
    let level = req.user.accountType?.level;

    // console.log(`\n🔐 getDownlineSummaryReport - Effective user: ${userId}, Level: ${level}`);

    const matchFilter = {};
    const { id, script, scriptName, market, valan, startDate, endDate } = req.query;

    // Always fetch active valan for info
    const activeValan = await getActiveWeekValan();
    let valanStart = null,
      valanEnd = null,
      valanLabel = null;
    if (activeValan) {
      valanStart = activeValan.startDate;
      valanEnd = activeValan.endDate;
      valanLabel = activeValan.label || null;
    }

    // 'script' = InstrumentIdentifier/label (e.g. 'GOLD26APRFUT')
    // 'scriptName' = base name stored in transactions (e.g. 'GOLD')
    // Apply valanId filter only when no script filter is active
    const hasScriptFilter = !!(script || scriptName);
    // ── Valan / Date range ────────────────────────────────────────────────
    const hasStartDate = startDate && startDate !== 'undefined' && startDate !== 'null';
    const hasEndDate = endDate && endDate !== 'undefined' && endDate !== 'null';

    if (hasStartDate || hasEndDate) {
      matchFilter['createdAt'] = {};
      if (hasStartDate) matchFilter['createdAt']['$gte'] = new Date(`${startDate}T00:00:00.000+05:30`);
      if (hasEndDate) matchFilter['createdAt']['$lte'] = new Date(`${endDate}T23:59:59.999+05:30`);
    } else if (valan && valan !== 'undefined' && valan !== 'null') {
      matchFilter['valanId'] = new mongoose.Types.ObjectId(valan);
    } else if (activeValan && !hasScriptFilter) {
      matchFilter['valanId'] = activeValan._id;
    }

    // ── Market filter ─────────────────────────────────────────────────────
    if (market && market !== 'undefined' && market !== 'null' && market !== 'all') {
      if (market === '12') {
        matchFilter['marketId'] = '__NONE__';
      } else if (typeof market === 'string' && market.includes(',')) {
        matchFilter['marketId'] = { $in: market.split(',') };
      } else {
        matchFilter['marketId'] = market;
      }
    } else {
      // Default: exclude market 12 if no specific market is requested
      matchFilter['marketId'] = { $ne: '12' };
    }

    if (scriptName) {
      matchFilter['scriptName'] = { $regex: new RegExp(`^${scriptName}$`, 'i') };
    } else if (script) {
      // Fallback: strip expiry suffix and match base name exactly
      matchFilter['scriptName'] = { $regex: new RegExp(`^${script.split(' ')[0]}$`, 'i') };
    }

    if (id != 'self') {
      userId = id;
      const user = await getUser({ _id: userId }, { _id: 0, accountCode: 1, accountName: 1, accountType: 1 });
      // DON'T change level - keep logged-in user's level for correct Self/Downline calculation
    }

    // ---- Script Filter: return individual user summaries for this script ----
    if (hasScriptFilter) {
      const filterKey = level == 7 ? 'userId' : level == 6 ? 'brokerIds' : 'parentIds';
      const txMatch = {
        $or: [{ [filterKey]: new mongoose.Types.ObjectId(userId) }, { [filterKey]: userId.toString() }],
        transactionStatus: 'COMPLETED',
        ...matchFilter
      };

      // 1. Fetch transactions grouped by user
      let reports = await StockTransaction.aggregate([
        { $match: txMatch },
        {
          $group: {
            _id: '$userId',
            buyLot: { $sum: { $cond: [{ $eq: ['$transactionType', 'BUY'] }, '$lot', 0] } },
            sellLot: { $sum: { $cond: [{ $eq: ['$transactionType', 'SELL'] }, '$lot', 0] } },
            buyQuantity: { $sum: { $cond: [{ $eq: ['$transactionType', 'BUY'] }, '$quantity', 0] } },
            sellQuantity: { $sum: { $cond: [{ $eq: ['$transactionType', 'SELL'] }, '$quantity', 0] } },
            buyOrderPrice: { $sum: { $cond: [{ $eq: ['$transactionType', 'BUY'] }, '$totalOrderPrice', 0] } },
            sellOrderPrice: { $sum: { $cond: [{ $eq: ['$transactionType', 'SELL'] }, '$totalOrderPrice', 0] } },
            buyNetPrice: { $sum: { $cond: [{ $eq: ['$transactionType', 'BUY'] }, '$totalNetPrice', 0] } },
            sellNetPrice: { $sum: { $cond: [{ $eq: ['$transactionType', 'SELL'] }, '$totalNetPrice', 0] } },
            netBrokerage: { $sum: '$netBrokerage' },
            brokerTotalBrokerage: { $sum: '$brokerTotalBrokerage' },
            brockersBrokerage: { $push: '$brockersBrokerage' },
            scriptId: { $first: '$scriptId' },
            marketName: { $first: '$marketName' },
            marketId: { $first: '$marketId' },
            scriptName: { $first: '$scriptName' },
            label: { $first: '$label' },
            valanId: { $first: '$valanId' }
          }
        },
        {
          $lookup: {
            from: 'users',
            localField: '_id',
            foreignField: '_id',
            as: 'userInfo'
          }
        },
        { $unwind: '$userInfo' }
      ]);

      if (reports.length > 0) {
        const { getMultipleStockData } = require('../services/RedisService');
        const scriptIds = [...new Set(reports.map((r) => r.scriptId))];
        const redisPrices = await getMultipleStockData(scriptIds);

        const priceMap = {};
        scriptIds.forEach((id, i) => {
          priceMap[id] = redisPrices[i] || { BuyPrice: 0, SellPrice: 0 };
        });

        reports = reports.map((r) => {
          const buyLot = Number(r.buyLot || 0);
          const sellLot = Number(r.sellLot || 0);
          const remainingLot = buyLot - sellLot;
          const buyQuantity = Number(r.buyQuantity || 0);
          const sellQuantity = Number(r.sellQuantity || 0);
          const remainingQty = buyQuantity - sellQuantity;
          const buyOrderPrice = Number(r.buyOrderPrice || 0);
          const sellOrderPrice = Number(r.sellOrderPrice || 0);
          const buyNetPrice = Number(r.buyNetPrice || 0);
          const sellNetPrice = Number(r.sellNetPrice || 0);

          const buyNetAveragePrice = buyQuantity > 0 ? buyNetPrice / buyQuantity : null;
          const sellNetAveragePrice = sellQuantity > 0 ? sellNetPrice / sellQuantity : null;

          const stockPrice = priceMap[r.scriptId] || { BuyPrice: 0, SellPrice: 0 };
          const livePrice = remainingQty === 0 ? 0 : remainingQty > 0 ? stockPrice.SellPrice || 0 : stockPrice.BuyPrice || 0;

          const gross = sellOrderPrice - buyOrderPrice + remainingQty * livePrice;
          const totalm2m = sellNetPrice - buyNetPrice + remainingQty * livePrice;

          const partnership = r.userInfo.partnership || [];
          const myIndex = Number(partnership[level - 1] || 0);
          const brokerIndex = Number(partnership[5] || 0);

          const brokerBrokerage = Number(r.brokerTotalBrokerage || 0);
          const m2m = -totalm2m - brokerBrokerage;

          const uplineShare = partnership.slice(0, level - 1).reduce((acc, v) => acc + (Number(v) || 0), 0);
          const downlineShare = 100 - uplineShare - myIndex;

          return {
            _id: r._id,
            label: r.label,
            marketName: r.marketName,
            marketId: r.marketId,
            scriptName: r.scriptName,
            buyLot: Number(buyLot.toFixed(4)),
            sellLot: Number(sellLot.toFixed(4)),
            remainingLot: Number(remainingLot.toFixed(4)),
            buyQuantity: Number(buyQuantity.toFixed(4)),
            sellQuantity: Number(sellQuantity.toFixed(4)),
            remainingQty: Number(remainingQty.toFixed(4)),
            buyNetAveragePrice: buyNetAveragePrice ? Number(buyNetAveragePrice.toFixed(4)) : null,
            sellNetAveragePrice: sellNetAveragePrice ? Number(sellNetAveragePrice.toFixed(4)) : null,
            m2m: Number(m2m.toFixed(4)),
            gross: Number(gross.toFixed(4)),
            orderPrice: Number(livePrice.toFixed(4)),
            livePrice: Number(livePrice.toFixed(4)),
            selfQty: Number(((remainingQty * myIndex) / 100).toFixed(4)),
            selfNetPrice: Number(((m2m * myIndex) / 100).toFixed(4)),
            brokerNetPrice: Number(((m2m * brokerIndex) / 100).toFixed(4)),
            uplineNetPrice: Number(((m2m * uplineShare) / 100).toFixed(4)),
            downlineNetPrice: Number(((m2m * downlineShare) / 100).toFixed(4)),
            brokerage: Number((r.netBrokerage || 0).toFixed(4)),
            brokerBrokerage: Number(brokerBrokerage.toFixed(4)),
            selfBrokerage: Number((
              (level === 6 ? (r.brockersBrokerage || []).reduce((accSum, txnComm) => accSum + (Array.isArray(txnComm) ? (txnComm.find(b => b && b.brokerId && b.brokerId.toString() === userId.toString())?.rate || 0) : 0), 0) : 0) +
              (((r.netBrokerage || 0) - brokerBrokerage) * myIndex / 100)
            ).toFixed(4)),
            accountName: r.userInfo?.accountName,
            accountCode: r.userInfo?.accountCode,
            client: r.userInfo?.accountType?.level === 7,
            valanId: r.valanId
          };
        });
      }
      const valanInfo = { valanStart, valanEnd, valanLabel };
      return res.status(200).json({
        status: true,
        data: {
          reports,
          valanInfo
        }
      });
    }

    // ---- Default: aggregated summary flow ----
    const filterKey = level == 7 ? 'userId' : level == 6 ? 'brokerIds' : 'parentIds';
    const response = await getDownlineSummaryReport(
      {
        $or: [{ [filterKey]: new mongoose.Types.ObjectId(userId) }, { [filterKey]: userId.toString() }],
        transactionStatus: 'COMPLETED',
        ...matchFilter
      },
      level,
      req.user._id,
      scriptName
    );

    const responseMap = new Map(response.map((item) => [item.userId.toString(), item]));

    const directReportingIds = new Set();
    response.forEach((item) => {
      if (item.parentIds && item.parentIds.length > level) {
        // Child at Level+1 who is the next in line in the hierarchy
        directReportingIds.add(item.parentIds[level].toString());
      } else if (item.userId) {
        // Direct child (end user/client)
        directReportingIds.add(item.userId.toString());
      }
    });

    const isRequesterDemo = isDemoUser(req);
    const allDirectUsers = await UserModel.find({
      _id: { $in: Array.from(directReportingIds) },
      demoid: isRequesterDemo ? true : { $ne: true }
    })
      .select({ accountName: 1, accountCode: 1, 'basicDetails.summaryPostFix': 1 })
      .populate('accountType', 'label level -_id')
      .lean();

    const myDirect = allDirectUsers.filter((u) => u.accountType?.level < 7);
    const myDirectClient = allDirectUsers.filter((u) => u.accountType?.level === 7);

    const myDirectWithSum = myDirect.map((element) => {
      const getSum = getSummaryTotalSum(response, element._id);
      return {
        ...element,
        ...getSum,
        client: false,
        valanId: matchFilter['valanId']
      };
    });

    const myDirectClientWithData = myDirectClient.map((element) => {
      const dt = responseMap.get(element._id.toString()) || {};
      return {
        ...element,
        ...dt,
        client: true,
        valanId: matchFilter['valanId']
      };
    });

    const reports = [...myDirectWithSum, ...myDirectClientWithData].sort((a, b) => {
      const nameA = (a.accountName || '').toLowerCase();
      const nameB = (b.accountName || '').toLowerCase();
      return nameA.localeCompare(nameB);
    });
    const valanInfo = { valanStart, valanEnd, valanLabel };
    res.status(200).json({ status: true, data: { reports, valanInfo } });
  } catch (error) {
    console.error(error);
    res.status(500).json({ status: false, message: error.message });
  }
};

const getSummaryTotalSum = (data, id) => {
  const idString = id.toString();

  const initialValues = {
    label: '',
    scriptId: '',
    scriptName: '',
    marketName: '',
    orderPrice: 0,
    buyQuantity: 0,
    sellQuantity: 0,
    remainingQty: 0,
    m2m: 0,
    selfQty: 0,
    selfNetPrice: 0,
    uplineNetPrice: 0,
    downlineNetPrice: 0,
    buyNetAveragePrice: 0,
    sellNetAveragePrice: 0,
    count: 0
  };

  const summary = data.reduce(
    (acc, item) => {
      const isHierarchyMatch = item.parentIds && item.parentIds.some((parentId) => parentId.toString() === idString);
      const isBrokerMatch = item.brokerIds && item.brokerIds.some((brokerId) => brokerId.toString() === idString);

      if (isHierarchyMatch || isBrokerMatch) {
        for (const key in initialValues) {
          if (item[key] !== undefined && item[key] !== null) {
            if (typeof item[key] === 'number') {
              if (key == 'orderPrice') {
                acc[key] = item[key];
              } else {
                acc[key] += item[key];
              }
            } else {
              if (!acc[key]) {
                acc[key] = item[key];
              }
            }
          }
        }
        acc.count += 1;
      }
      return acc;
    },
    { ...initialValues }
  );

  summary.buyNetAveragePrice = summary.count > 0 ? summary.buyNetAveragePrice / summary.count : 0;
  summary.sellNetAveragePrice = summary.count > 0 ? summary.sellNetAveragePrice / summary.count : 0;

  return summary;
};

exports.getClientStockTransactions = async (req, res) => {
  try {
    const userId = getEffectiveUserId(req);
    const { startOfDay, endOfDay } = getCurrentDateRange();
    const { _id: valanId } = await getActiveWeekValan();
    const matchFilter = {
      userId: new mongoose.Types.ObjectId(userId),
      //createdAt: { $gte: startOfDay, $lte: endOfDay },
      valanId: valanId,
      transactionStatus: 'COMPLETED'
    };

    const response = await getClientStockTransactions(matchFilter);
    res.status(200).json({ status: true, data: response });
  } catch (error) {
    console.log(error);
    res.status(500).json({ status: 'false', message: error.message });
  }
};

exports.clientStockByMaster = async (req, res) => {
  try {
    const userId = getEffectiveUserId(req);

    const { startOfDay, endOfDay } = getCurrentDateRange();
    const { _id: valanId } = await getActiveWeekValan();
    const myLevel = +req.user.accountType.level;
    const filterKey = myLevel === 6 ? 'brokerIds' : 'parentIds';

    const matchFilter = {
      [filterKey]: new mongoose.Types.ObjectId(userId),
      //createdAt: { $gte: startOfDay, $lte: endOfDay },
      valanId: valanId,
      transactionStatus: 'COMPLETED'
    };

    const isRequesterDemo = isDemoUser(req);
    const response = await clientStockByMaster(matchFilter, myLevel, isRequesterDemo);
    if (res) {
      res.status(200).json({ status: true, data: response });
    }
    return response;
  } catch (error) {
    console.log(error);
    res.status(500).json({ status: 'false', message: error.message });
  }
};

exports.refreshMargin = async (req, res) => {
  try {
    const userId = getEffectiveUserId(req);
    const { _id: targetUser } = req.body;
    const { _id: valanId } = await getActiveWeekValan();

    await M2MService.invalidateM2MCache(targetUser, valanId);

    res.status(200).json({ status: true, message: 'Margin refreshed successfully' });
  } catch (error) {
    console.error('Error refreshing margin:', error);
    res.status(500).json({ status: false, message: error.message });
  }
};

exports.hardRefreshMargin = async (req, res) => {
  try {
    const userId = getEffectiveUserId(req);
    const { _id: targetUser } = req.body;
    const { _id: valanId } = await getActiveWeekValan();

    // Invalidate specific user cache
    await M2MService.invalidateM2MCache(targetUser, valanId);

    res.status(200).json({ status: true, message: 'Margin hard refreshed successfully' });
  } catch (error) {
    console.error('Error hard refreshing margin:', error);
    res.status(500).json({ status: false, message: error.message });
  }
};

exports.adjustShortTrade = async (req, res) => {
  try {
    const requesterId = getLoginUserId(req);
    const { uplineId, downlineId, password } = req.body;
    // console.log("Upline ID : ", uplineId);
    // console.log("Downline ID : ", downlineId);
    // console.log("Password : ", password);
    if (!uplineId || !downlineId) {
      return res.status(400).json({ status: false, message: 'Both Upline and Downline IDs are required' });
    }

    if (!password || typeof password !== 'string' || !password.trim()) {
      return res.status(400).json({ status: false, message: 'Transaction password is required' });
    }

    const isValid = await validatepassword(requesterId, password.trim());
    if (!isValid) {
      return res.status(401).json({ status: false, message: 'Wrong transaction password' });
    }

    const upline = await StockTransaction.findById(new mongoose.Types.ObjectId(uplineId)).lean();
    const downline = await StockTransaction.findById(new mongoose.Types.ObjectId(downlineId)).lean();
    // console.log("Upline : ", upline);
    // console.log("Downline : ", downline);
    if (!upline || !downline) {
      return res.status(404).json({ status: false, message: 'One or both trades not found' });
    }

    if (upline.transactionStatus === 'DELETED' || downline.transactionStatus === 'DELETED') {
      return res.status(400).json({ status: false, message: 'Cannot adjust deleted trades' });
    }

    if (upline.userId.toString() !== downline.userId.toString() || upline.scriptId !== downline.scriptId) {
      return res.status(400).json({ status: false, message: 'Trades must belong to the same user and script' });
    }

    if (upline.transactionType === downline.transactionType) {
      return res.status(400).json({ status: false, message: 'Upline and Downline must be opposite transaction types' });
    }

    if (upline.quantity < downline.quantity) {
      return res.status(400).json({ status: false, message: 'Downline quantity cannot exceed Upline quantity' });
    }

    const adjQty = downline.quantity;
    const adjLot = downline.lot;

    // 1. Perform Adjustment
    const newQty = upline.quantity - adjQty;
    const newLot = upline.lot - adjLot;

    if (newQty <= 0) {
      // Full reversal
      await StockTransaction.updateMany({ _id: { $in: [uplineId, downlineId] } }, [
        {
          $set: {
            prevStatus: "$transactionStatus",
            transactionStatus: 'DELETED'
          }
        }
      ]);
    } else {
      // Partial reduction of Upline
      const ratio = newQty / upline.quantity;
      await StockTransaction.updateOne(
        { _id: uplineId },
        {
          quantity: newQty,
          lot: newLot,
          totalOrderPrice: Number((newQty * upline.orderPrice).toFixed(4)),
          totalNetPrice: Number((newQty * upline.netPrice).toFixed(4)),
          m2mPrice: Number((newQty * upline.orderPrice).toFixed(4)),
          orderBrokerage: Number((upline.orderBrokerage * ratio).toFixed(4)),
          netBrokerage: Number((upline.netBrokerage * ratio).toFixed(4)),
          brokerTotalBrokerage: Number((upline.brokerTotalBrokerage * ratio).toFixed(4)),
          isEdited: true
        }
      );

      // Delete Downline
      await StockTransaction.updateOne({ _id: downlineId }, [
        {
          $set: {
            prevStatus: "$transactionStatus",
            transactionStatus: 'DELETED'
          }
        }
      ]);
    }

    // 2. Sync Position & Quantity
    await setUserPosition(upline.userId, upline.scriptId, upline.valanId, false);

    // Update UserQuantity (reversing the downline and the portion removed from upline)
    await setUserQuantity({
      userId: upline.userId,
      marketId: upline.marketId,
      scriptId: upline.scriptId,
      quantity: adjQty,
      transactionType: downline.transactionType,
      createdAt: downline.createdAt
    });
    await setUserQuantity({
      userId: upline.userId,
      marketId: upline.marketId,
      scriptId: upline.scriptId,
      quantity: adjQty,
      transactionType: upline.transactionType,
      createdAt: upline.createdAt
    });

    // 3. Emit Socket Events
    DashboardStockEvent({
      ...upline,
      status: newQty <= 0 ? 'DELETED' : 'COMPLETED',
      quantity: newQty,
      lot: newLot,
      _id: upline._id,
      label: upline.label
    });

    DashboardStockEvent({
      ...downline,
      status: 'DELETED',
      _id: downline._id,
      label: downline.label
    });

    res.status(200).json({
      status: true,
      message: 'Short trade adjusted successfully',
      data: {
        uplineId,
        newQty,
        newLot,
        downlineId,
        status: 'DELETED'
      }
    });
  } catch (error) {
    console.error('adjustShortTrade controller error:', error);
    res.status(500).json({ status: false, message: error.message });
  }
};

exports.getUsersScriptWisePosition = async (req, res) => {
  try {
    const { userIds, startDate, endDate, valanId } = req.body;
    let level = req.user?.accountType?.level || 1; // Used for hierarchy offset calculations if needed

    if (!userIds || !Array.isArray(userIds) || userIds.length === 0) {
      return res.status(400).json({ status: false, message: 'Please provide an array of userIds' });
    }

    const matchFilter = {};

    let activeValanId = valanId;
    if (!activeValanId) {
      const { _id: defaultValanId } = await getActiveWeekValan();
      activeValanId = defaultValanId;
    }

    matchFilter['valanId'] = new mongoose.Types.ObjectId(activeValanId);
    matchFilter['transactionStatus'] = 'COMPLETED';

    const originalUserIds = userIds.map((id) => id.toString());
    let finalUserIds = userIds;
    const isRequesterDemo = isDemoUser(req);
    if (userIds.length === 1) {
      const targetUser = await UserModel.findById(userIds[0]).populate('accountType').lean(); // Add .lean()
      if (targetUser && targetUser.accountType && targetUser.accountType.level < 7) {
        // Expand to all clients (level 7) in their downline
        const clientType = await require('../models/UserTypeModel').findOne({ level: 7 }).select('_id');
        if (clientType) {
          const clients = await UserModel.find({
            parentIds: targetUser._id,
            accountType: clientType._id,
            isDeleted: false
          }).select('_id');

          if (clients.length > 0) {
            finalUserIds = clients.map((c) => c._id.toString());
          }
        }
      }
      matchFilter['userId'] = { $in: finalUserIds.map((id) => new mongoose.Types.ObjectId(id)) };
    } else {
      // Multiple userIds comparison: Include downline trades for each requested user
      matchFilter['$or'] = [
        { userId: { $in: userIds.map((id) => new mongoose.Types.ObjectId(id)) } },
        { parentIds: { $in: userIds.map((id) => new mongoose.Types.ObjectId(id)) } }
      ];
    }

    if (startDate) {
      matchFilter.createdAt = { ...matchFilter.createdAt, $gte: getCurrentDateRange(startDate).startOfDay };
    }
    if (endDate) {
      matchFilter.createdAt = { ...matchFilter.createdAt, $lte: getCurrentDateRange(endDate).endOfDay };
    }

    // Call service to get positions
    const response = await getUsersScriptWisePosition(matchFilter, level, originalUserIds);

    res.status(200).json({ status: true, data: response });
  } catch (error) {
    console.error(error);
    res.status(500).json({ status: false, message: error.message });
  }
};

/**
 * Specialized Summary Report for NSE-EQ market only.
 * Includes accumulated loan interest.
 */
exports.getNseEqSummaryReport = async (req, res) => {
  try {
    let userId = getEffectiveUserId(req);
    let level = req.user.accountType?.level;
    const isRequesterDemo = isDemoUser(req);
    let { id, startDate, endDate, valan, script, master, broker, client } = req.query;

    if (startDate === 'undefined' || startDate === 'null') startDate = undefined;
    if (endDate === 'undefined' || endDate === 'null') endDate = undefined;

    const matchFilter = {
      marketId: '12', // NSE_EQ
      transactionStatus: 'COMPLETED'
    };

    if (id && id != 'self') {
      userId = id;
      const user = await getUser({ _id: userId }, { _id: 0, accountCode: 1, accountName: 1, accountType: 1 });
      level = user.accountType.level;
    } else if (client) {
      userId = client;
      const user = await getUser({ _id: userId }, { accountType: 1 });
      level = user.accountType.level;
    } else if (broker) {
      userId = broker;
      const user = await getUser({ _id: userId }, { accountType: 1 });
      level = user.accountType.level;
    } else if (master) {
      userId = master;
      const user = await getUser({ _id: userId }, { accountType: 1 });
      level = user.accountType.level;
    }

    let interestStartDate = startDate;
    let interestEndDate = endDate;

    // ── Apply standard filters ────────
    if (startDate || endDate) {
      matchFilter['createdAt'] = {};
      if (startDate) {
        matchFilter['createdAt']['$gte'] = new Date(`${startDate}T00:00:00.000+05:30`);
      }
      if (endDate) {
        matchFilter['createdAt']['$lte'] = new Date(`${endDate}T23:59:59.999+05:30`);
      }
    } else if (valan && valan !== 'undefined' && valan !== 'null') {
      matchFilter['valanId'] = new mongoose.Types.ObjectId(valan);
      const valanDetails = await WeekValanModel.findById(valan).lean();
      if (valanDetails) {
        // Include Saturday and Sunday before the valan week
        const valanStartDate = moment(valanDetails.startDate);
        const saturday = valanStartDate.clone().subtract(2, 'days');
        interestStartDate = saturday.format('YYYY-MM-DD');
        interestEndDate = moment(valanDetails.endDate).format('YYYY-MM-DD');
      }
    } else {
      const activeValan = await getActiveWeekValan();
      matchFilter['valanId'] = activeValan._id;
      interestStartDate = moment(activeValan.startDate).format('YYYY-MM-DD');
      interestEndDate = moment(activeValan.endDate).format('YYYY-MM-DD');
    }

    if (script && script !== 'undefined' && script !== 'null') {
      matchFilter['scriptName'] = { $regex: new RegExp(`^${script}`, 'i') };
    }

    const filterKeys = { valan, startDate, endDate, master, broker, client };
    Object.keys(filterKeys).forEach((key) => {
      const val = filterKeys[key];
      if (!val || val === 'all' || val === 'undefined' || val === 'null' || val === '') return;
      if (key === 'valan') matchFilter['valanId'] = new mongoose.Types.ObjectId(val);
      if (key === 'startDate' || key === 'endDate') {
        const { startOfDay, endOfDay } = getCurrentDateRange(val);
        matchFilter['createdAt'] = {
          ...matchFilter['createdAt'],
          [key === 'startDate' ? '$gte' : '$lte']: key === 'startDate' ? startOfDay : endOfDay
        };
      }
      if (key === 'master') matchFilter['parentIds'] = new mongoose.Types.ObjectId(val);
      if (key === 'broker') matchFilter['brokerIds'] = new mongoose.Types.ObjectId(val);
      if (key === 'client') matchFilter['userId'] = new mongoose.Types.ObjectId(val);
    });

    let filterKey = level == 6 ? 'brokerIds' : level == 7 ? 'userId' : 'parentIds';

    const result = await getPAndLWithLivePricesForNseEq(
      {
        $or: [{ [filterKey]: new mongoose.Types.ObjectId(userId) }, { [filterKey]: userId.toString() }],
        transactionStatus: 'COMPLETED',
        ...matchFilter
      },
      level,
      userId.toString(),
      {
        interestStartDate,
        interestEndDate,
        isRequesterDemo
      }
    );

    res.status(200).json({
      status: true,
      data: result.data || [],
      scriptNames: result.scriptNames || [],
      livePriceCount: result.livePriceCount || 0,
      socketSymbols: result.socketSymbols || []
    });
  } catch (error) {
    console.error('[getNseEqSummaryReport] error:', error);
    res.status(500).json({ status: false, message: error.message });
  }
};

/**
 * Specialized Script Summary Report for NSE-EQ market only.
 */
exports.getNseEqScriptSummaryReport = async (req, res) => {
  try {
    let { id, startDate, endDate, valan, script, master, broker, client } = req.query;
    const userId = getEffectiveUserId(req);
    const level = req.user.accountType?.level;
    const isRequesterDemo = isDemoUser(req);

    // Fetch basic perspective user details
    const user = await getUser({ _id: new mongoose.Types.ObjectId(userId) }, { demoid: 1 });
    if (!user) {
      return res.status(404).json({ status: false, message: 'Perspective user not found' });
    }

    // Security: Perspective user must match requester's demo status
    if (!isRequesterDemo && user.demoid === true) {
      return res.status(403).json({ status: false, message: 'Cannot access demo report from real account' });
    }
    if (isRequesterDemo && user.demoid !== true) {
      return res.status(403).json({ status: false, message: 'Cannot access real report from demo account' });
    }


    if (startDate === 'undefined' || startDate === 'null') startDate = undefined;
    if (endDate === 'undefined' || endDate === 'null') endDate = undefined;

    const matchFilter = {
      marketId: '12',
      transactionStatus: 'COMPLETED'
    };

    // Override market if not passed, but specialized report should usually target '12'
    if (market && market !== 'undefined' && market !== 'null') {
      matchFilter.marketId = market;
    }
    if (valan && valan !== 'undefined' && valan !== 'null') {
      matchFilter.valanId = new mongoose.Types.ObjectId(valan);
    } else if (!startDate && !endDate) {
      const { _id: activeValanId } = await getActiveWeekValan();
      matchFilter.valanId = activeValanId;
    }
    if (startDate || endDate) {
      matchFilter.createdAt = {};
      if (startDate) matchFilter.createdAt.$gte = new Date(`${startDate}T00:00:00.000+05:30`);
      if (endDate) matchFilter.createdAt.$lte = new Date(`${endDate}T23:59:59.999+05:30`);
    }
    if (script && script !== 'undefined' && script !== 'null') {
      matchFilter.scriptName = { $regex: new RegExp(`^${script}`, 'i') };
    }

    if (clientId && clientId !== 'undefined' && clientId !== 'null') {
      matchFilter['userId'] = new mongoose.Types.ObjectId(clientId);
    } else {
      const filterKey = level == 7 ? 'userId' : level == 6 ? 'brokerIds' : 'parentIds';
      matchFilter['$or'] = [{ [filterKey]: new mongoose.Types.ObjectId(userId) }, { [filterKey]: userId.toString() }];
    }

    const reports = await getScriptSummaryReport(matchFilter, level, new mongoose.Types.ObjectId(userId), isRequesterDemo);

    // For script summary, we show interest per user if it's a specific client drill-down
    let totalInterest = 0;
    if (clientId) {
      let interestStart = startDate;
      let interestEnd = endDate;

      // Ensure interest period matches valan if dates are missing
      if (!interestStart && !interestEnd) {
        if (valan && valan !== 'undefined' && valan !== 'null') {
          const v = await WeekValanModel.findById(valan).lean();
          if (v) {
            // Include Saturday and Sunday before the valan week
            const valanStartDate = moment(v.startDate);
            const saturday = valanStartDate.clone().subtract(2, 'days');
            interestStart = saturday.format('YYYY-MM-DD');
            interestEnd = moment(v.endDate).format('YYYY-MM-DD');
          }
        } else {
          const activeValan = await getActiveWeekValan();
          interestStart = moment(activeValan.startDate).format('YYYY-MM-DD');
          interestEnd = moment(activeValan.endDate).format('YYYY-MM-DD');
        }
      }

      const interestMap = await getNseEqInterestMap([clientId], interestStart, interestEnd);
      totalInterest = interestMap.get(clientId) || 0;
    }

    res.status(200).json({
      status: true,
      data: {
        reports,
        totalInterest
      }
    });
  } catch (error) {
    console.error('[getNseEqScriptSummaryReport] error:', error);
    res.status(500).json({ status: false, message: error.message });
  }
};

/**
 * NSE-EQ Loan Interest Report.
 * Groups daily interest records by user and provides total amount and days.
 */
exports.getNseEqInterestReport = async (req, res) => {
  try {
    const userId = getEffectiveUserId(req);
    const level = req.user.accountType?.level;
    let { startDate, endDate, client, market, script, valan, broker, master, daywise } = req.query;


    if (startDate === 'undefined' || startDate === 'null' || startDate === '') startDate = undefined;
    if (endDate === 'undefined' || endDate === 'null' || endDate === '') endDate = undefined;

    const matchFilter = {};

    // 1. Date / Valan Filters
    if (startDate || endDate) {
      matchFilter.date = {};
      if (startDate) matchFilter.date.$gte = startDate;
      if (endDate) matchFilter.date.$lte = endDate;
    } else if (valan && valan !== 'undefined' && valan !== 'null') {
      const v = await WeekValanModel.findById(valan).lean();
      if (v) {
        // Include Saturday and Sunday before the valan week
        // Saturday = startDate - 2 days, Sunday = startDate - 1 day
        const valanStartDate = moment(v.startDate);
        const saturday = valanStartDate.clone().subtract(2, 'days').format('YYYY-MM-DD');
        const friday = moment(v.endDate).format('YYYY-MM-DD');

        matchFilter.date = {
          $gte: saturday,  // Start from Saturday
          $lte: friday     // End on Friday
        };

      }
    }

    // 2. Hierarchy Filter (Perspective)
    let targetId = userId;
    if (client && client !== 'undefined' && client !== 'null' && client !== '') {
      targetId = client;
    } else if (broker && broker !== 'undefined' && broker !== 'null' && broker !== '') {
      targetId = broker;
    } else if (master && master !== 'undefined' && master !== 'null' && master !== '') {
      targetId = master;
    }

    const targetObjectId = mongoose.Types.ObjectId.isValid(targetId) ? new mongoose.Types.ObjectId(targetId) : targetId;

    // DAYWISE MODE: Return raw daily documents without aggregation
    if (daywise === 'true' || daywise === true) {
      // For daywise, we need a specific user (client/broker/master) or use logged-in user
      matchFilter.userId = targetObjectId;

      const daywiseData = await NseEqInterestModel.find(matchFilter)
        .populate('userId', 'accountName accountCode')
        .sort({ date: 1 })
        .lean();

      return res.status(200).json({
        status: true,
        data: daywiseData
      });
    }

    // DEFAULT MODE: Aggregated report (original behavior)
    if (level === 1 && !client && !broker && !master) {
      // Super Admin viewing everything: no hierarchy filter needed if no sub-user selected
    } else {
      // Everyone else (or Super Admin viewing a target) needs inclusive filter
      matchFilter.$or = [
        { userId: targetObjectId },
        { parentIds: targetObjectId }
      ];
    }

    // 3. Aggregate
    const pipeline = [
      { $match: matchFilter },
      {
        $group: {
          _id: '$userId',
          totalInterest: { $sum: '$interestAmount' },
          totalDays: { $count: {} },
          lastAnnualRate: { $last: '$annualInterestPer' },
          lastMaxLimit: { $last: '$maxLimit' },
          lastMarginPer: { $last: '$marginPer' },
          firstDate: { $first: '$date' },
          lastDate: { $last: '$date' },
          isLinkedWithLedger: { $last: '$isLinkedWithLedger' },
          avgHoldingWorth: { $avg: '$holdingWorth' },
          avgBookedPnl: { $avg: '$bookedPnl' },
          avgInterestableAmount: { $avg: '$interestableAmount' }
        }
      },
      {
        $lookup: {
          from: 'users',
          localField: '_id',
          foreignField: '_id',
          as: 'userInfo'
        }
      },
      { $unwind: '$userInfo' },
      {
        $project: {
          userId: '$_id',
          accountName: '$userInfo.accountName',
          accountCode: '$userInfo.accountCode',
          totalInterest: 1,
          totalDays: 1,
          lastAnnualRate: 1,
          lastMaxLimit: 1,
          marginPer: '$lastMarginPer',
          firstDate: 1,
          lastDate: 1,
          isLinkedWithLedger: 1,
          avgHoldingWorth: 1,
          avgBookedPnl: 1,
          avgInterestableAmount: 1
        }
      },
      { $sort: { accountName: 1 } }
    ];

    const data = await NseEqInterestModel.aggregate(pipeline);

    res.status(200).json({
      status: true,
      data
    });
  } catch (error) {
    console.error('[getNseEqInterestReport] error:', error);
    res.status(500).json({ status: false, message: error.message });
  }
};


exports.recalculateUserPositions = async (req, res) => {
  try {
    const { userId, valanId } = req.body;

    if (!userId) {
      return res.status(400).json({ status: false, message: 'userId is required' });
    }

    if (!valanId) {
      return res.status(400).json({ status: false, message: 'valanId is required' });
    }

    const result = await recalculateUserPositions(userId, valanId);

    res.status(200).json({
      status: true,
      message: result.message,
      data: result
    });
  } catch (error) {
    console.error('Error in recalculateUserPositions controller:', error);
    res.status(500).json({ status: false, message: error.message });
  }
};

/**
 * Transaction Analysis API Controller
 * Analyzes stock transactions based on date ranges or valan IDs
 * Priority: dates > valan IDs > active valan
 * Required: scriptName, marketId
 * Optional: userId (client/user filter - must be within downline)
 * Filters: Shows only downline + self transactions
 */
exports.getTransactionAnalysis = async (req, res) => {
  try {
    const {
      startDate,
      endDate,
      valanId,
      valanIds,
      scriptName,
      marketId,
      userId
    } = req.body;

    // Validate required fields
    if (!scriptName) {
      return res.status(400).json({
        status: false,
        message: 'scriptName is required'
      });
    }

    if (!marketId) {
      return res.status(400).json({
        status: false,
        message: 'marketId is required'
      });
    }

    // Get effective user ID and level from request
    const { getEffectiveUserId } = require('../utils/contextHelpers');
    const effectiveUserId = getEffectiveUserId(req);
    const level = req.user?.accountType?.level;

    if (!level) {
      return res.status(400).json({
        status: false,
        message: 'User account level not found'
      });
    }

    // Call service layer
    const { getTransactionAnalysis } = require('../services/StockService');
    const data = await getTransactionAnalysis({
      startDate,
      endDate,
      valanId,
      valanIds,
      scriptName,
      marketId,
      effectiveUserId,
      level,
      userId
    });

    res.status(200).json({
      status: true,
      data
    });

  } catch (error) {
    console.error('Error in getTransactionAnalysis controller:', error);
    res.status(500).json({
      status: false,
      message: error.message
    });
  }
};
