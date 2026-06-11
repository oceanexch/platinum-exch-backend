const axios = require('axios');
const { redisClient } = require('../config/redis');
const { saveLog } = require('../services/LogService');

const CACHE_TTL = 86400; // 24h
const REDIS_PREFIX = 'vpn_check:';

const PRIVATE_IP_RE = /^(10\.|172\.(1[6-9]|2\d|3[01])\.|192\.168\.|127\.|0\.0\.0\.0$|::1$)/;

const isVpnIp = async (ip) => {
  if (!ip || PRIVATE_IP_RE.test(ip)) return false;

  try {
    const cached = await redisClient.get(`${REDIS_PREFIX}${ip}`);
    if (cached !== null) return cached === '1';

    const { data } = await axios.get(
      `http://ip-api.com/json/${ip}?fields=status,proxy,hosting`,
      { timeout: 3000 }
    );

    const isVpn = data.status === 'success' && (data.proxy === true || data.hosting === true);
    await redisClient.set(`${REDIS_PREFIX}${ip}`, isVpn ? '1' : '0', 'EX', CACHE_TTL);
    return isVpn;
  } catch {
    return false; // fail open — don't block if API unreachable
  }
};

const logVpnRejection = async ({ ip, userId, parentIds }) => {
  try {
    await saveLog('rejection', {
      action: 'VPN_BLOCK',
      clientId: userId || null,
      parentIds: parentIds || [],
      ip,
      message: 'VPN/proxy access blocked',
      time: Date.now(),
    });
  } catch (err) {
    console.error('[VPN] log error:', err.message);
  }
};

module.exports = { isVpnIp, logVpnRejection };
