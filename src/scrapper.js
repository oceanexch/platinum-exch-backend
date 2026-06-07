const axios = require("axios");
const moment = require('moment');
const { API_END_POINT } = require("./config/config");
let pLimit;
let limit;
const { MarketType, Script } = require("./models/MarketTypeModel");
const Expiry = require('./models/ExpiryModel');
const Stock = require("./models/StockModel");
const { getStockData } = require("./services/RedisService");

let scriptIdMap;
let existingExp;
const scriptDataKey = ['I', 'II'];

(async () => { //auto executing function

})();

const marketTypes = {
  "INDEX": "10",
  "NSE": "2",
  "MCX": "1",
  "NOPT": "3",
  "GLOBAL": "4",
  "COMEX": "7",
}

// Function to fetch all markets
async function fetchAllMarkets() {
  try {
    const response = await axios.get(`${API_END_POINT}/getmarkets`);
    return response.data.data; // Assuming the response is an array of markets
  } catch (error) {
    console.error("Error fetching markets:", error.message);
    throw error;
  }
}

// Function to fetch scripts for a given market ID
async function fetchScriptsByMarket(marketId) {
  try {
    const response = await axios.get(`${API_END_POINT}/getscripts/${marketId}`);
    return response.data.data; // Assuming the response is an array of scripts
  } catch (error) {
    console.error(
      `Error fetching scripts for Market ID ${marketId}:`,
      error.message
    );
    throw error;
  }
}

// Function to fetch expiry information for a given script ID
async function fetchExpiryByScript(scriptId) {
  try {
    const response = await axios.get(`${API_END_POINT}/getexpiry/${scriptId}`);
    const expiry = response?.data?.data || []
    return expiry.map((m, i) => ({ ...m, script_data_key: scriptDataKey[i] })); // Assuming the response contains expiry information
  } catch (error) {
    console.error(
      `Error fetching expiry for Script ID ${scriptId}:`,
      error.message
    );
    throw error;
  }
}

// Main function to orchestrate the data fetching
async function fetchAllMarketsData() {
  try {
    const markets = await fetchAllMarkets();
    const marketsWithScripts = await Promise.all(
      markets.map(async (market) => {
        const scripts = await fetchScriptsByMarket(market.id);
        // console.log(
        //   `Fetched ${scripts.length} scripts for Market ID ${market.id}.`
        // );

        const scriptsWithExpiry = await Promise.all(
          scripts.map((script) =>
            limit(async () => {
              const expiry = await fetchExpiryByScript(script.script_id);
              return { ...script, expiry };
            })
          )
        );

        return { ...market, scripts: scriptsWithExpiry };
      })
    );

    return marketsWithScripts;
  } catch (error) {
    console.error(
      "An error occurred while fetching all markets data:",
      error.message
    );
  }
}

const fetchMarkets = async () => {
  try {
    const pLimitModule = await import("p-limit");
    pLimit = pLimitModule.default || pLimitModule;
    limit = pLimit(5);

    await MarketType.deleteMany();
    await Script.deleteMany();
    const markets = await fetchAllMarketsData();
    for (let mkt of markets) {
      const insertedScripts = await Script.insertMany(mkt.scripts);
      mkt.scripts = insertedScripts.map((script) => script._id);
      const market = new MarketType(mkt);
      await market.save();
    }

    console.log("SAVING DATA DONE");
  } catch (error) {
    console.error("Failed to load p-limit:", error);
  }
};

const saveStocks = async () => {
  const getStocks = await getStockData("stocks");

  let stockArray = [];
  Object.keys(getStocks).forEach((key) => {
    const parse = JSON.parse(getStocks[key]);
    parse && stockArray.push(parse);
  });

  const bulkOps = stockArray.map((stock) => {
    return {
      updateOne: {
        filter: { InstrumentIdentifier: stock.InstrumentIdentifier },
        update: { $set: stock },
        upsert: true,
      },
    };
  });

  await Stock.bulkWrite(bulkOps);
};

async function fetchAllExpiries() {
  try {
    const response = await Script.find().select("market_type_id script_name script_id");
    scriptIdMap = new Map(response.map(m => [`${m.market_type_id}-${m.script_name}`, m.script_id]));
    const response2 = await Expiry.find().lean();
    existingExp = new Map(response2.map(m => [`${m.marketId}-${m.scriptId}-${m.expiryDate}`, m]));

    const { data } = await axios.get(`http://192.46.212.194:3000/getallexpiry`);
    const formateddata = data.data.map(m => m.slice(0, 5).map((mm, i) => i != 1 ? mm.split(" ")[0] : mm));

    const expiries = formateddata.map(m => {
      return {
        marketId: marketTypes[m[0]],
        marketName: m[0],
        scriptId: m[1] == 'All' ? '999' : scriptIdMap.get(`${marketTypes[m[0]]}-${m[1]}`),
        scriptName: m[1],
        tradeStartDate: moment(m[2], 'DD-MM-YYYY').format('YYYY-MM-DD'),
        tradeEndDate: moment(m[3], 'DD-MM-YYYY').format('YYYY-MM-DD'),
        expiryDate: moment(m[4], 'DD-MM-YYYY').format('YYYY-MM-DD'),
        ip: "auto"
      }
    }).filter(f => f.scriptId && !existingExp.has(`${f.marketId}-${f.scriptId}-${f.expiryDate}`))

    const insert = await Expiry.insertMany(expiries, { ordered: false });
    console.log("Inserted Expiries:", insert.length);

    // To delete expired expiries
    const expiredExpiries = [];
    const currentDate = moment().format('YYYY-MM-DD');
    for (const exp of existingExp.values()) {
      if (moment(exp.expiryDate).isBefore(currentDate)) {
        expiredExpiries.push(exp._id);
      }
    }
    //console.log("Expired Expiries to delete:", expiredExpiries);
    if (expiredExpiries.length > 0) {
      await Expiry.deleteMany({ _id: { $in: expiredExpiries } });
      console.log("Deleted Expiries:", expiredExpiries.length);
    }
  } catch (error) {
    console.error("Error fetching markets:", error.message);
    throw error;
  }
}
