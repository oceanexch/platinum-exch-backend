const {
  getScriptDataKey,
  getKeyIdentifier,
  createScript,
  getUserScripts,
  getUserScriptsByMarket,
  removeScript,
  removeAllScript,
  createAllScript,
  getSquareOffList,
  getDataKeyByLabel,
  checkScriptExists,
  bulkRemoveScript,
  updateScriptData
} = require('../services/ScriptService');
const { publishScriptEvent } = require('../services/RedisService');

const { getMarketAccess } = require('../services/UserService');

const { getMarkets } = require('../services/MarketService');
const { getUser } = require('../services/UserService');
const { getLotSetting } = require('../services/SettingService');
const { getCurrentDateRange } = require('../services/StockService');
const mongoose = require('mongoose');
const { clientStockByMaster } = require('../controllers/StockController');
const { getEffectiveUserId, getLoginUserId, getUserContext } = require('../utils/contextHelpers');
const moment = require('moment');

exports.getMarkets = async (req, res) => {
  try {
    const userId = getEffectiveUserId(req);
    const { id } = req.query;
    // console.log("User to found ...", userId, id);
    const Id = id && id !== '' ? id : userId;

    if (!Id) {
      return res.status(400).json({ status: 'false', message: 'User ID is required' });
    }

    const userInfo = await getUser({ _id: Id }, { marketAccess: 1, accountType: 1, parentIds: 1 });
    // console.log("User info ...", userInfo);
    if (!userInfo) {
      return res.status(401).json({ status: 'false', message: 'User info not found' });
    }

    let marketAccess = userInfo.marketAccess;

    // If user is a broker (level 6) and has no marketAccess, inherit from direct parent
    if (userInfo.accountType?.level === 6 && (!marketAccess || marketAccess.length === 0)) {
      if (userInfo.parentIds && userInfo.parentIds.length > 0) {
        // Get direct parent (first in parentIds array is the immediate parent)
        const directParentId = userInfo.parentIds[0];
        const parentInfo = await getUser({ _id: directParentId }, { marketAccess: 1 });
        
        if (parentInfo && parentInfo.marketAccess) {
          console.log(`[GET MARKETS] Broker ${userInfo.accountCode || Id} (level 6) has no marketAccess, inheriting from parent ${directParentId}`);
          marketAccess = parentInfo.marketAccess;
        }
      }
    }

    // Remove duplicate market IDs to prevent duplicate markets in response
    const marketsIds = [...new Set(marketAccess.map((mkt) => mkt.marketId))];
    const response = await getMarkets(marketsIds);
    res.status(200).json({ status: true, data: response });
  } catch (error) {
    console.log(error);
    res.status(500).json({ status: 'false', message: error.message });
  }
};

exports.addScript = async (req, res) => {
  try {
    const userId = getEffectiveUserId(req);

    // 1. Normalize request body (normalize both formats)
    const scriptName = req.body.scriptName || req.body.script_name;
    const marketId = (req.body.marketId || req.body.market_type_id || '').toString();

    // Validation
    if (!scriptName) {
      return res.status(400).json({ status: 'false', message: 'Script Name is required' });
    }
    if (!marketId) {
      return res.status(400).json({ status: 'false', message: 'Market ID is required' });
    }
    const expiryInput = req.body.expiryDate || (req.body.expiry && req.body.expiry[0]?.expiry_date_orginal);
    const strikeInput = req.body.strike !== undefined ? req.body.strike : 0;
    const cepeRaw = req.body.cepe || req.body.instrument_type || req.body.option_type || '';

    // Normalize CE/PE mapping
    let cepeSearch = cepeRaw.toUpperCase().trim();
    if (cepeSearch === 'CALL') cepeSearch = 'CE';
    if (cepeSearch === 'PUT') cepeSearch = 'PE';

    // Normalize Expiry Date for DB lookup (DB uses ISO format YYYY-MM-DD)
    let normalizedExpiry = expiryInput;
    if (expiryInput && expiryInput !== 'NA') {
      const m = moment(expiryInput, ['DDMMMYYYY', 'YYYY-MM-DD', 'DD-MM-YYYY']);
      if (m.isValid()) {
        normalizedExpiry = m.format('YYYY-MM-DD');
      }
    }

    // 2. Mandatory DB Lookup and Data Enrichment
    // Include FUT in the lookup since they also have unique symbols/IDs per expiry
    if (cepeSearch && cepeSearch !== '') {
      const { Script } = require('../models/MarketTypeModel');
      const strikeValue = parseFloat(strikeInput) || 0;

      // Find the exact script group (name + strike + type + market)
      // Use case-insensitive regex for script_name to handle minor variations
      const dbScript = await Script.findOne({
        script_name: { $regex: new RegExp(`^${scriptName.trim()}$`, 'i') },
        strike: strikeValue,
        market_type_id: marketId,
        $or: [{ instrument_type: cepeSearch }, { option_type: cepeSearch }]
      }).lean();
      // console.log("dbScript", dbScript);
      if (!dbScript) {
        return res
          .status(404)
          .json({ status: 'false', message: `Specific script record (${scriptName} ${strikeValue} ${cepeSearch}) not found in database.` });
      }

      // Find the specific expiry record to get the correct symbol
      // Match by normalized date or original date stored in DB
      const matchExp = dbScript.expiry.find(
        (e) =>
          e.expiry_date === normalizedExpiry ||
          e.expiry_date_orginal === normalizedExpiry ||
          e.expiry_date === expiryInput ||
          e.expiry_date_orginal === expiryInput
      );

      if (!matchExp) {
        // If it is a script that is expected to have expiries (Options/FUT), return 404
        // Otherwise, if no expiries (like some base types), we might proceed with top-level data
        if (dbScript.expiry && dbScript.expiry.length > 0) {
          return res
            .status(404)
            .json({ status: 'false', message: `Matching expiry (${expiryInput}) not found in database for this script.` });
        }
      }

      // OVERWRITE body with DB info to ensure consistency
      // Ensure we use the specific symbol/scriptId from the matched expiry entry
      req.body.symbol = matchExp?.symbol || dbScript.symbol;
      req.body.scriptId = matchExp?.script_id || dbScript.script_id;
      req.body.expiryId = matchExp?.script_expiry_id || req.body.scriptId;
      req.body.strike = dbScript.strike;
      req.body.cepe = cepeSearch;
      req.body.scriptName = dbScript.script_name;
      req.body.marketId = dbScript.market_type_id;

      const isOption = ['CE', 'PE', 'OPTSTK', 'OPTIDX'].includes(cepeSearch);
      req.body.label = isOption
        ? `${dbScript.script_name} ${expiryInput} ${dbScript.strike} ${cepeSearch}`
        : `${dbScript.script_name} ${expiryInput}${cepeSearch ? ' ' + cepeSearch : ''}`;

      req.body.expiryDate = expiryInput;
    } else {
      // Fallback normalization for non-option scripts
      if (!req.body.scriptId) req.body.scriptId = req.body.script_id;
      if (!req.body.scriptName) req.body.scriptName = req.body.script_name;
      if (!req.body.marketId) req.body.marketId = req.body.market_type_id;
      if (!req.body.expiryDate) req.body.expiryDate = expiryInput;
      if (!req.body.symbol && req.body.expiry && req.body.expiry[0]?.symbol) req.body.symbol = req.body.expiry[0].symbol;
    }

    // 3. Ensure Market Name
    if (!req.body.marketName) {
      const { MarketType } = require('../models/MarketTypeModel');
      const mkt = await MarketType.findOne({ market_type_id: req.body.marketId?.toString() }).lean();
      if (mkt) req.body.marketName = mkt.name;
    }

    // Generate unique keyIdentifier to check for duplicates
    // Use normalizedExpiry for consistency across platforms (web vs mobile)
    const finalKeyIdentifier = getKeyIdentifier(
      req.body.marketId,
      req.body.scriptId,
      normalizedExpiry || req.body.expiryId || req.body.expiryDate || 'NA',
      parseFloat(req.body.strike) || 0,
      (req.body.cepe || '').toUpperCase()
    );

    // Check if script already exists
    const scriptExists = await checkScriptExists(userId, finalKeyIdentifier);
    if (scriptExists) {
      return res.status(400).json({ status: 'error', message: 'Script already added' });
    }

    const scriptDetails = {
      ...req.body,
      // dataKey: req.body.symbol || req.body.scriptId, // Removed dataKey dependency
      keyIdentifier: finalKeyIdentifier,
      createdBy: userId
    };
    // console.log("Creating script with details:", JSON.stringify(scriptDetails, null, 2));
    await createScript(scriptDetails, userId);

    await publishScriptEvent({ type: 'SCRIPT_ADDED', userId, data: scriptDetails });
    res.status(201).json({ status: true, message: 'Script added successfully', scriptDetails });
  } catch (error) {
    console.log(error);
    res.status(500).json({ status: 'false', message: error.message });
  }
};

exports.getUserScripts = async (req, res) => {
  try {
    const userId = getEffectiveUserId(req);
    let { marketIds } = req.body;
    if (!Array.isArray(marketIds)) {
      marketIds = ['1', '2', '3', '4', '10'];
    }
    const userMarkets = await getMarketAccess(userId);
    // console.log("response of getmarketaccess ", userMarkets)

    const filterMarketIds = userMarkets[0].marketAccess.map((m) => m.marketId).filter((marketId) => marketIds.includes(marketId));
    // console.log("filterMarketIds ", JSON.stringify(filterMarketIds))

    const response = await getUserScripts(userId, filterMarketIds);

    // Get all lot quantities with scriptName (matches unique index on {marketId, scriptName})
    const lotMatchPairs = response.map((scp) => ({
      marketId: String(scp.marketId),
      scriptName: String(scp.scriptName || '').toUpperCase()
    }));

    const lotQty = lotMatchPairs.length > 0
      ? await getLotSetting(
          { $or: lotMatchPairs },
          { _id: 0, quantity: 1, scriptName: 1, marketId: 1 }
        )
      : [];

    res.status(200).json({ status: true, data: response, lotQty });
  } catch (error) {
    console.log(error);
    res.status(500).json({ status: 'false', message: error.message });
  }
};

exports.removeScript = async (req, res) => {
  try {
    const userId = getEffectiveUserId(req);
    const { scriptId } = req.body;
    // const { keyIdentifier } = req.body;

    // console.log("Script Id log", scriptId);

    await removeScript(userId, scriptId);
    await publishScriptEvent({ type: 'SCRIPT_REMOVED', userId, data: { scriptId } });
    res.status(201).json({ status: true, message: 'Script removed successfully' });
  } catch (error) {
    console.log(error);
    res.status(500).json({ status: 'false', message: error.message });
  }
};

exports.bulkRemoveScript = async (req, res) => {
  try {
    const userId = getEffectiveUserId(req);
    const { scriptIds } = req.body;

    if (!Array.isArray(scriptIds) || scriptIds.length === 0) {
      return res.status(400).json({ status: 'false', message: 'scriptIds array is required' });
    }

    // Run delete and event publish in parallel for speed
    // and wait for them to finish before responding
    const [deleteResult] = await Promise.all([
      bulkRemoveScript(userId, scriptIds),
      publishScriptEvent({ type: 'SCRIPT_REMOVED_BULK', userId, data: { scriptIds } })
    ]);

    return res.status(200).json({
      status: true,
      message: 'Scripts removed successfully',
      deletedCount: deleteResult?.deletedCount || 0
    });
  } catch (error) {
    console.error('bulkRemoveScript error:', error);
    if (!res.headersSent) {
      return res.status(500).json({ status: 'false', message: error.message || 'Internal server error' });
    }
  }
};

exports.removeAllScript = async (req, res) => {
  try {
    const userId = getEffectiveUserId(req);
    const { marketId } = req.body;
    await removeAllScript(userId, marketId);
    await publishScriptEvent({ type: 'SCRIPT_REMOVED_ALL', userId, data: { marketId } });
    res.status(201).json({ status: true, message: 'Script removed successfully' });
  } catch (error) {
    console.log(error);
    res.status(500).json({ status: 'false', message: error.message });
  }
};

exports.addMultipleScript = async (req, res) => {
  try {
    const userId = getEffectiveUserId(req);
    const { scripts, marketId } = req.body;

    if (!scripts || !Array.isArray(scripts)) {
      return res.status(400).json({ status: 'false', message: 'scripts array is required' });
    }

    const existingMarket = (await getUserScriptsByMarket(userId, marketId)) || [];
    const newScript = scripts.filter((scpt) => {
      // Normalize expiry for lookup
      const expiryInput = scpt.expiryDate || (scpt.expiry && scpt.expiry[0]?.expiry_date_orginal);
      let nExp = expiryInput;
      if (expiryInput && expiryInput !== 'NA') {
        const m = moment(expiryInput, ['DDMMMYYYY', 'YYYY-MM-DD', 'DD-MM-YYYY']);
        if (m.isValid()) nExp = m.format('YYYY-MM-DD');
      }

      const key = getKeyIdentifier(
        scpt.marketId,
        scpt.scriptId,
        nExp || scpt.expiryId || scpt.expiryDate || 'NA',
        parseFloat(scpt.strike) || 0,
        (scpt.instrument_type || scpt.option_type || scpt.cepe || '').toUpperCase()
      );
      return !existingMarket.some((dt) => dt.keyIdentifier === key);
    });

    const allScript = await Promise.allSettled(
      newScript.map(async (dt) => {
        const symbol = dt.symbol || dt.scriptId;
        const strike = parseFloat(dt.strike) || 0;
        const cepe = (dt.instrument_type || dt.option_type || dt.cepe || '').toUpperCase();

        const expiryInput = dt.expiryDate || (dt.expiry && dt.expiry[0]?.expiry_date_orginal);
        let nExp = expiryInput;
        if (expiryInput && expiryInput !== 'NA') {
          const m = moment(expiryInput, ['DDMMMYYYY', 'YYYY-MM-DD', 'DD-MM-YYYY']);
          if (m.isValid()) nExp = m.format('YYYY-MM-DD');
        }

        const keyIdentifier = getKeyIdentifier(
          dt.marketId,
          dt.scriptId,
          nExp || dt.expiryId || dt.expiryDate || 'NA',
          strike,
          cepe
        );

        return {
          ...dt,
          // dataKey: symbol, // Removed dataKey dependency
          symbol: symbol,
          keyIdentifier,
          createdBy: userId,
          strike,
          cepe
        };
      })
    );
    await createAllScript(allScript.filter((f) => f.status == 'fulfilled').map((m) => m.value));
    const alluserscript = await getUserScripts(userId, marketId);
    publishScriptEvent({ type: 'SCRIPT_ADDED_BULK', userId, data: { marketId, scripts: alluserscript } });
    res.status(201).json({ status: true, message: 'Script Added successfully' });
  } catch (error) {
    console.log(error);
    res.status(500).json({ status: 'false', message: error.message });
  }
};

exports.getSquareOffList = async (req, res) => {
  try {
    const userId = getEffectiveUserId(req);
    const { date, clientId } = req.query;

    // Get user with broker market access inheritance
    const { getUserWithMarketAccess, getMarketIds } = require('../utils/brokerHelpers');
    const userInfo = await getUserWithMarketAccess(userId);

    let matchFilter = {};

    // 1. Hierarchy/User Filter
    if (clientId && clientId !== '') {
      const targetClientId = new mongoose.Types.ObjectId(clientId);
      if (targetClientId.equals(new mongoose.Types.ObjectId(userId))) {
        matchFilter.userId = targetClientId;
      } else {
        // Find squareoffs for this client where the current user is a parent
        matchFilter.userId = targetClientId;
        matchFilter.parentIds = new mongoose.Types.ObjectId(userId);
      }
    } else {
      // Default: show everything I'm allowed to see (my own + my downline's)
      matchFilter.$or = [
        { parentIds: new mongoose.Types.ObjectId(userId) },
        { userId: new mongoose.Types.ObjectId(userId) }
      ];
    }

    // 2. Date Filter
    if (date && date !== '') {
      const filterDate = new Date(date);
      if (!isNaN(filterDate.getTime())) {
        const { startOfDay } = getCurrentDateRange(filterDate);
        matchFilter.createdAt = { $gte: startOfDay };
      } else {
        // Invalid date provided, fallback to today
        const { startOfDay } = getCurrentDateRange(new Date());
        matchFilter.createdAt = { $gte: startOfDay };
      }
    } else {
      // Default to today if no date provided
      const { startOfDay } = getCurrentDateRange(new Date());
      matchFilter.createdAt = { $gte: startOfDay };
    }

    // 3. Market Filter for Brokers
    // If user is a broker with inherited marketAccess, filter by those markets
    if (userInfo && userInfo.accountType?.level === 6 && userInfo.marketAccess && userInfo.marketAccess.length > 0) {
      const marketIds = getMarketIds(userInfo.marketAccess);
      if (marketIds.length > 0) {
        matchFilter.marketId = { $in: marketIds };
      }
    }

    const project = {
      label: 1,
      ledgerAmount: 1,
      userId: 1,
      m2m: 1,
      type: 1,
      createdAt: 1,
      alertPercent: 1,
      squaredOff: 1,
      marketId: 1
    };

    const response = await getSquareOffList(matchFilter, project);
    res.status(200).json({ status: true, data: response });
  } catch (error) {
    console.error("error in getSquareOffList:", error);
    res.status(500).json({ status: 'false', message: error.message });
  }
};

exports.getDataKeyByLabel = async (req, res) => {
  try {
    const userId = getEffectiveUserId(req);
    const { labels } = req.body;
    const response = await getDataKeyByLabel(labels);
    res.status(200).json({ status: true, data: response });
  } catch (error) {
    console.log(error);
    res.status(500).json({ status: 'false', message: error.message });
  }
};

exports.updateScriptData = async (req, res) => {
  try {
    const { id } = req.body;
    let updateData = { ...req.body };
    delete updateData.id;

    if (!id) {
      return res.status(400).json({ status: 'false', message: 'ID is required' });
    }

    const updatedScript = await updateScriptData(id, updateData);

    if (!updatedScript) {
      return res.status(404).json({ status: 'false', message: 'Script not found' });
    }

    res.status(200).json({ status: true, message: 'Script updated successfully', data: updatedScript });
  } catch (error) {
    console.log(error);
    res.status(500).json({ status: 'false', message: error.message });
  }
};
