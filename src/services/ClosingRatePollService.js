const {
  fetchClosingRates,
  applyClosingRatesToRedis,
} = require("./ClosingRateService");

const NSE_MARKETS = ["2", "3", "10", "12"];
const GLOBAL_MARKETS = ["1", "4", "6", "7", "8", "9", "11"];

const CLOSING_RATE_POLL_MS = 60 * 60 * 1000; // 1 hour

let nseClosingRateInterval = null;
let globalClosingRateInterval = null;
let _nseHadUpdates = false;
let _globalHadUpdates = false;

const stopNseClosingRatePoll = () => {
  if (nseClosingRateInterval) {
    clearInterval(nseClosingRateInterval);
    nseClosingRateInterval = null;
    console.log("[ClosingRates] NSE closing rate poll stopped.");
  }
};

const stopGlobalClosingRatePoll = () => {
  if (globalClosingRateInterval) {
    clearInterval(globalClosingRateInterval);
    globalClosingRateInterval = null;
    console.log("[ClosingRates] Global closing rate poll stopped.");
  }
};

/**
 * STOP CONDITION:
 *   updatedCount > 0  → official closing prices arrived, set hadUpdates, keep polling
 *   updatedCount === 0 AND hadUpdates === true  → all symbols at closing price, STOP
 *   updatedCount === 0 AND hadUpdates === false → API not pushed yet, keep polling
 */
const runClosingRatePoll = async (label, stopFn, hadUpdates) => {
  try {
    console.log(`[ClosingRates] [${label}] Polling closing rates API...`);
    const rates = await fetchClosingRates();

    if (!rates || rates.length === 0) {
      console.log(`[ClosingRates] [${label}] No rates returned from API.`);
      return;
    }

    console.log(`[ClosingRates] [${label}] Received ${rates.length} symbols from API.`);

    const updatedCount = await applyClosingRatesToRedis(rates);
    console.log(`[ClosingRates] [${label}] Applied closing prices for ${updatedCount} symbols this pass.`);

    if (updatedCount > 0) {
      hadUpdates.value = true;
    }

    if (hadUpdates.value && updatedCount === 0) {
      console.log(`[ClosingRates] [${label}] All symbols confirmed at closing price. Stopping poll.`);
      stopFn();
    }
  } catch (err) {
    console.error(`[ClosingRates] [${label}] Poll error:`, err.message);
  }
};

const startNseClosingRatePoll = async () => {
  console.log("[ClosingRates] NSE market closed. Starting hourly closing-rate poll...");
  stopNseClosingRatePoll();

  _nseHadUpdates = false;
  const nseHadUpdates = { value: false };

  let nseFirstPollDone = false;
  const nseFirstStopFn = () => { nseFirstPollDone = true; stopNseClosingRatePoll(); };
  await runClosingRatePoll("NSE", nseFirstStopFn, nseHadUpdates);

  if (nseHadUpdates.value) _nseHadUpdates = true;

  if (nseFirstPollDone) {
    console.log("[ClosingRates] NSE: Confirmed on first poll. No interval scheduled.");
    return;
  }

  nseClosingRateInterval = setInterval(async () => {
    if (_nseHadUpdates) nseHadUpdates.value = true;
    await runClosingRatePoll("NSE", stopNseClosingRatePoll, nseHadUpdates);
    _nseHadUpdates = nseHadUpdates.value;
  }, CLOSING_RATE_POLL_MS);
};

const startGlobalClosingRatePoll = async () => {
  console.log("[ClosingRates] Global market closed. Starting hourly closing-rate poll...");
  stopGlobalClosingRatePoll();

  _globalHadUpdates = false;
  const globalHadUpdates = { value: false };

  let globalFirstPollDone = false;
  const globalFirstStopFn = () => { globalFirstPollDone = true; stopGlobalClosingRatePoll(); };
  await runClosingRatePoll("GLOBAL", globalFirstStopFn, globalHadUpdates);

  if (globalHadUpdates.value) _globalHadUpdates = true;

  if (globalFirstPollDone) {
    console.log("[ClosingRates] Global: Confirmed on first poll. No interval scheduled.");
    return;
  }

  globalClosingRateInterval = setInterval(async () => {
    if (_globalHadUpdates) globalHadUpdates.value = true;
    await runClosingRatePoll("GLOBAL", stopGlobalClosingRatePoll, globalHadUpdates);
    _globalHadUpdates = globalHadUpdates.value;
  }, CLOSING_RATE_POLL_MS);
};

module.exports = {
  NSE_MARKETS,
  GLOBAL_MARKETS,
  startNseClosingRatePoll,
  startGlobalClosingRatePoll,
  stopNseClosingRatePoll,
  stopGlobalClosingRatePoll,
};
