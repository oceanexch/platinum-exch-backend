const axios = require('axios');
const http = require('http');
const https = require('https');
const RedisService = require('./RedisService');

const SMARTFEED_BASE_URL = process.env.SMARTFEED_BASE_URL || 'https://smartfeed.getlivefeed.xyz/api/v1';

// Force IPv4
const httpAgent = new http.Agent({ family: 4 });
const httpsAgent = new https.Agent({ family: 4 });

/**
 * Service to handle SmartFeed Authentication
 */
class SmartFeedAuthService {
    constructor() {
        this.tokenKey = 'smartfeed_access_token';
    }

    /**
     * Get active access token from Redis or perform login
     */
    async getAccessToken() {
        try {
            // 1. Try to get from Redis
            let token = await RedisService.getData(this.tokenKey);
            if (token) return token;

            // 2. Perform Login if no token
            return await this.login();
        } catch (error) {
            console.error('❌ [SmartFeedAuth] Error getting access token:', error.message);
            throw error;
        }
    }

    /**
     * Perform login to SmartFeed API
     */
    async login() {
        const clientcode = process.env.SMARTFEED_CLIENT_CODE;
        const password = process.env.SMARTFEED_PASSWORD;

        if (!clientcode || !password) {
            throw new Error('SmartFeed credentials (clientcode/password) not found in environment');
        }

        try {
            console.log('🔐 [SmartFeedAuth] Logging in to SmartFeed...');
            const response = await axios.post(`${SMARTFEED_BASE_URL}/Account/authenticate`, {
                clientcode,
                password
            }, {
                headers: {
                    'Content-Type': 'application/json',
                    'X-IP-Version': 'IPv4'
                },
                httpAgent,
                httpsAgent
            });

            if (response.data && response.data.succeeded && response.data.data.accessToken) {
                const token = response.data.data.accessToken;
                
                // Store in Redis. 
                // Documentation says expires 03:00 AM next day. 
                // To be safe, we'll refresh every 2 hours if not already fetched.
                await RedisService.setData(this.tokenKey, token);
                console.log('✅ [SmartFeedAuth] Login successful. Token cached.');
                return token;
            } else {
                throw new Error(response.data.message || 'Login failed');
            }
        } catch (error) {
            const errorMsg = error.response?.data?.message || error.message;
            console.error('❌ [SmartFeedAuth] Login error:', errorMsg);
            throw new Error(`SmartFeed Login failed: ${errorMsg}`);
        }
    }

    /**
     * Clear cached token (use when API returns 401)
     */
    async clearToken() {
        await RedisService.del(this.tokenKey);
    }
}

module.exports = new SmartFeedAuthService();
