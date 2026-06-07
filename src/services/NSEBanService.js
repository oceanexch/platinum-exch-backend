const axios = require('axios');
const { redisClient } = require('../config/redis');

const NSE_BAN_URL = 'https://nsearchives.nseindia.com/content/fo/fo_secban.csv';

const updateNSEBanData = async () => {
    try {
        const response = await axios.get(NSE_BAN_URL, {
            headers: {
                'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.124 Safari/537.36',
                'Accept': 'text/csv'
            }
        });

        const csvData = response.data;
        // The NSE CSV usually has a title line, then a comma separated list.
        // Format: 
        // Securities in Ban For Trade Date 06-JAN-2026:
        // 1,SAIL
        // 2,SAMMAANCAP

        const lines = csvData.split('\n');
        let symbols = [];

        for (let i = 0; i < lines.length; i++) {
            const line = lines[i].trim();
            if (!line) continue;

            // Skip the title line (it usually contains "Securities in Ban" or ":" and doesn't have a comma early on)
            if (line.includes(':') && !line.includes(',')) continue;

            const parts = line.split(',');
            if (parts.length >= 2) {
                const symbol = parts[1].trim();
                if (symbol && symbol !== 'SYMBOL') { // 'SYMBOL' might be a header in some cases
                    symbols.push(symbol);
                }
            }
        }


        // Replace the data in Redis
        // We use a simple SET to overwrite the previous value
        await redisClient.set('nse_ban_scripts', JSON.stringify(symbols));
        return { status: true, data: symbols };
    } catch (error) {
        console.error('Error updating NSE Ban data:', error);
        throw error;
    } finally {

    }
};

const isScriptBanned = async (scriptName) => {
    try {
        if (!scriptName) return false;

        // Fetch ban list from Redis
        const data = await redisClient.get('nse_ban_scripts');
        if (!data) return false;

        const bannedSymbols = JSON.parse(data);
        if (!Array.isArray(bannedSymbols) || bannedSymbols.length === 0) return false;

        // Extract symbol from scriptName
        // Assumption: scriptName format is like "SYMBOL-I", "SYMBOL-24JAN-FUT" or "SYMBOL"
        // We split by '-' and take the first part.
        const symbol = scriptName.split('-')[0];

        // Check if the symbol is in the banned list
        return bannedSymbols.includes(symbol);
    } catch (error) {
        console.error("Error checking script ban status:", error);
        return false;
    }
};

module.exports = {
    updateNSEBanData,
    isScriptBanned
};
