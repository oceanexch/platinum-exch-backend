// redisClient.js
const { redisClient } = require("../config/redis");
const { JWT_REFRESH_EXPIRATION_IN_SECONDS } = require("../config/config");
const { getMaxConnections } = require("../config/socketConnectionConfig");
/**
 * Store refresh token with TTL
 */
async function storeRefreshTokenInRedis(userId, refreshToken) {
  try {
    // ioredis syntax for setEx: set(key, value, "EX", seconds)
    await redisClient.set(
      `refreshToken:${userId}`,
      refreshToken,
      "EX",
      JWT_REFRESH_EXPIRATION_IN_SECONDS
    );
  } catch (err) {
    console.error("Error storing refresh token:", err);
  }
}
// ---------------- SCRIPT SOCKET EVENTS ----------------
const SCRIPT_EVENTS_CHANNEL = "SCRIPT_EVENTS";

/**
 * Publish script-related socket events (add/remove/bulk)
 * This is consumed by socket workers only
 */
async function publishScriptEvent({ type, userId, data }) {
  if (!userId || !type) return;

  const payload = {
    type, // SCRIPT_ADDED | SCRIPT_REMOVED | SCRIPT_REMOVED_ALL | SCRIPT_ADDED_BULK
    meta: {
      targetUser: userId.toString(),
    },
    data,
    ts: Date.now(),
  };

  try {
    await redisClient.publish(
      SCRIPT_EVENTS_CHANNEL,
      JSON.stringify(payload)
    );
  } catch (err) {
    console.error("❌ Error publishing SCRIPT_EVENTS:", err);
  }
}
/**
 * Verify refresh token
 */
async function verifyRefreshTokenInRedis(userId, refreshToken) {
  try {
    const storedRefreshToken = await redisClient.get(`refreshToken:${userId}`);
    return storedRefreshToken === refreshToken;
  } catch (err) {
    console.error("Error verifying refresh token:", err);
    return false;
  }
}

/**
 * Remove refresh token (logout/invalidate)
 */
async function removeRefreshTokenFromRedis(userId) {
  try {
    await redisClient.del(`refreshToken:${userId}`);
  } catch (err) {
    console.error("Error removing refresh token:", err);
  }
}


async function storeStockData(redisKey, parsedData) {
  try {

    // Always store & broadcast tick using the raw symbol
    await redisClient.hset("stocks", redisKey, parsedData);
    await redisClient.publish(redisKey, parsedData);

    const { BuyPrice, SellPrice } = JSON.parse(parsedData);

    const priceKey = `last_price:${redisKey}`;
    const lastPriceRaw = await redisClient.get(priceKey);

    let priceChanged = false;

    if (!lastPriceRaw) {
      priceChanged = true;
    } else {
      const last = JSON.parse(lastPriceRaw);
      if (last.BuyPrice !== BuyPrice || last.SellPrice !== SellPrice) {
        priceChanged = true;
      }
    }

    // 🔥 Only update last_tick when price actually moves
    if (priceChanged) {
      await redisClient.set(
        priceKey,
        JSON.stringify({ BuyPrice, SellPrice })
      );

      await redisClient.set(`last_tick:${redisKey}`, Date.now());
    }

  } catch (err) {
    console.error("Error storing stock data:", err);
  }
}

/**
 * Get a single stock entry from the "stocks" hash
 */
async function getSingleStockData(redisKey) {
  try {
    // console.log("Single stock data:", redisKey, await redisClient.hget("stocks", redisKey));
    return await redisClient.hget("stocks", redisKey);
  } catch (err) {
    console.error("Error getting single stock data:", err);
    return null;
  }
}

/**
 * Get multiple stock entries from the "stocks" hash
 * Expects an array of keys
 */
async function getMultipleStockData(redisKeys = []) {
  try {
    // hmget("hashName", key1, key2, ...)
    const stocks = await redisClient.hmget("stocks", ...redisKeys);

    // Convert each value from JSON
    return stocks.map((s) => {
      if (s == null || s === "") return null;
      try {
        return typeof s === "string" ? JSON.parse(s) : s;
      } catch (err) {
        return null;
      }
    });
  } catch (err) {
    console.error("Error getting multiple stock data:", err);
    return [];
  }
}


/**
 * Get all fields in a hash
 */
async function getStockData(redisKey) {
  try {
    return await redisClient.hgetall(redisKey);
  } catch (err) {
    console.error("Error getting stock data:", err);
    return null;
  }
}

/**
 * Get all keys and parsed values from the "stocks" hash.
 * Returns Map<upperKey, { BuyPrice, SellPrice, Ltp, ... }> so we can match script names flexibly.
 */
async function getAllStocksHash() {
  try {
    const raw = await redisClient.hgetall("stocks");
    if (!raw || typeof raw !== "object") return new Map();
    const map = new Map();
    for (const [key, val] of Object.entries(raw)) {
      if (!key || val == null) continue;
      try {
        const parsed = typeof val === "string" ? JSON.parse(val) : val;
        if (parsed && (parsed.BuyPrice != null || parsed.SellPrice != null || parsed.Ltp != null)) {
          map.set(String(key).toUpperCase(), parsed);
          map.set(String(key), parsed);
        }
      } catch (_) { }
    }
    return map;
  } catch (err) {
    console.error("Error getAllStocksHash:", err);
    return new Map();
  }
}

//Set data in redis hash
async function hset(key, subkey, value) {
  try {
    await redisClient.hset(key, subkey, value);
  } catch (err) {
    console.error("Error storing data:", err);
  }
}

//Get data from redis hash
async function hget(key, subkey) {
  try {
    return await redisClient.hget(key, subkey)
  } catch (err) {
    console.error("Error getting single stock data:", err);
    return null;
  }
}

//Set multi data in redis hash
async function hmset(key, values) {
  try {
    await redisClient.hmset(key, values);
  } catch (err) {
    console.error("Error storing data:", err);
  }
}

//Get multi data from redis hash
async function hmget(key, subkeys = []) {
  try {
    return await redisClient.hmget(key, ...subkeys)
  } catch (err) {
    console.error("Error getting single stock data:", err);
    return null;
  }
}

//Get all hash data
async function hgetall(key) {
  try {
    return await redisClient.hgetall(key);
  } catch (err) {
    console.error("Error getting data:", err);
    return null;
  }
}

//Delete data
async function del(key) {
  try {
    return await redisClient.del(key);
  } catch (err) {
    console.error("Error getting data:", err);
    return null;
  }
}

async function publishData(redisKey, parsedData) {
  try {
    await redisClient.publish(redisKey, parsedData);
  } catch (err) {
    console.error("Error storing stock data:", err);
  }
}

async function setData(key, data) {
  try {
    return await redisClient.set(key, data);
  } catch (err) {
    console.error("Error getting data:", err);
    return null;
  }
}

async function getData(key) {
  try {
    return await redisClient.get(key);
  } catch (err) {
    console.error("Error getting data:", err);
    return null;
  }
}

// ---------------- SOCKET CONNECTION MANAGEMENT ----------------

/**
 * Add a socket connection for a user
 * @param {string} userId - User ID
 * @param {string} socketId - Socket ID
 * @param {number} userLevel - User account type level
 * @param {string} workerId - Worker process ID
 * @returns {Object} - { allowed: boolean, forceLogoutSocketId?: string }
 */
async function addSocketConnection(userId, socketId, userLevel, workerId) {
  try {
    const connectionKey = `user_connections:${userId}`;
    
    // Get max connections from configuration
    const maxConnections = getMaxConnections(userLevel);
    
    // Get current connections
    const currentConnections = await redisClient.hgetall(connectionKey);
    const connectionCount = Object.keys(currentConnections).length;
    
    const connectionData = {
      timestamp: Date.now(),
      workerId: workerId,
      userLevel: userLevel
    };
    
    // If unlimited connections (-1) or under limit, just add the connection
    if (maxConnections === -1 || connectionCount < maxConnections) {
      await redisClient.hset(connectionKey, socketId, JSON.stringify(connectionData));
      await redisClient.expire(connectionKey, 86400); // 24 hours TTL
      
      return { allowed: true, maxConnections, currentCount: connectionCount + 1 };
    }
    
    // If at limit, need to remove excess connections to get down to the limit
    const excessConnections = connectionCount - maxConnections + 1; // +1 for the new connection
    const connectionsToRemove = [];
    
    // Sort connections by timestamp to find oldest ones
    const sortedConnections = Object.entries(currentConnections)
      .map(([socketId, data]) => {
        try {
          const parsed = JSON.parse(data);
          return { socketId, timestamp: parsed.timestamp, data };
        } catch (err) {
          // Invalid data, mark for removal
          return { socketId, timestamp: 0, data, invalid: true };
        }
      })
      .sort((a, b) => a.timestamp - b.timestamp);
    
    // Remove the oldest connections (including invalid ones)
    for (let i = 0; i < excessConnections && i < sortedConnections.length; i++) {
      const connectionToRemove = sortedConnections[i];
      connectionsToRemove.push(connectionToRemove.socketId);
      await redisClient.hdel(connectionKey, connectionToRemove.socketId);
    }
    
    await redisClient.hset(connectionKey, socketId, JSON.stringify(connectionData));
    await redisClient.expire(connectionKey, 86400); // 24 hours TTL
    
    return { 
      allowed: true, 
      forceLogoutSocketIds: connectionsToRemove, // Array of socket IDs to force logout
      maxConnections,
      currentCount: maxConnections
    };
    
  } catch (err) {
    console.error("Error managing socket connection:", err);
    return { allowed: true }; // Allow connection on error
  }
}

/**
 * Remove a socket connection for a user
 * @param {string} userId - User ID
 * @param {string} socketId - Socket ID
 */
async function removeSocketConnection(userId, socketId) {
  try {
    const connectionKey = `user_connections:${userId}`;
    await redisClient.hdel(connectionKey, socketId);
    
    // Check if any connections remain, if not, delete the key
    const remainingConnections = await redisClient.hgetall(connectionKey);
    if (Object.keys(remainingConnections).length === 0) {
      await redisClient.del(connectionKey);
    }
  } catch (err) {
    console.error("Error removing socket connection:", err);
  }
}

/**
 * Get all socket connections for a user
 * @param {string} userId - User ID
 * @returns {Object} - Connection data
 */
async function getUserSocketConnections(userId) {
  try {
    const connectionKey = `user_connections:${userId}`;
    const connections = await redisClient.hgetall(connectionKey);
    
    const parsed = {};
    for (const [socketId, data] of Object.entries(connections)) {
      try {
        parsed[socketId] = JSON.parse(data);
      } catch (err) {
        // Remove invalid data
        await redisClient.hdel(connectionKey, socketId);
      }
    }
    
    return parsed;
  } catch (err) {
    console.error("Error getting user socket connections:", err);
    return {};
  }
}

/**
 * Publish force logout event to specific socket across all workers
 * @param {string} userId - User ID
 * @param {string} socketId - Socket ID to force logout
 */
async function publishForceLogout(userId, socketId) {
  try {
    const payload = {
      type: "FORCE_LOGOUT_DIRECT",
      userId: userId,
      socketId: socketId,
      timestamp: Date.now()
    };
    
    // Use a dedicated channel for direct socket force logout
    await redisClient.publish("SOCKET_FORCE_LOGOUT", JSON.stringify(payload));
  } catch (err) {
    console.error("Error publishing force logout:", err);
  }
}

// ─── ATOMIC OPERATIONS WITH LOCKING ─────────────────────────────────────────

/**
 * Acquire a distributed lock in Redis
 * @param {string} lockKey - Key for the lock
 * @param {string} lockValue - Unique value for this lock holder
 * @param {number} ttlSeconds - Lock TTL in seconds
 * @returns {Promise<boolean>} - True if lock acquired, false otherwise
 */
async function acquireLock(lockKey, lockValue, ttlSeconds = 5) {
  try {
    // Use SET with NX (only if not exists) and EX (expiry)
    const result = await redisClient.set(lockKey, lockValue, "NX", "EX", ttlSeconds);
    return result === "OK";
  } catch (err) {
    console.error("Error acquiring lock:", err);
    return false;
  }
}

/**
 * Release a distributed lock in Redis
 * @param {string} lockKey - Key for the lock
 * @param {string} lockValue - Expected lock value (for safety)
 * @returns {Promise<boolean>} - True if lock released, false otherwise
 */
async function releaseLock(lockKey, lockValue) {
  try {
    // Use Lua script to ensure we only delete if value matches (atomic)
    const script = `
      if redis.call("get", KEYS[1]) == ARGV[1] then
        return redis.call("del", KEYS[1])
      else
        return 0
      end
    `;
    const result = await redisClient.eval(script, 1, lockKey, lockValue);
    return result === 1;
  } catch (err) {
    console.error("Error releasing lock:", err);
    return false;
  }
}

/**
 * Set data with expiry
 * @param {string} key - Redis key
 * @param {string} data - Data to store
 * @param {number} ttlSeconds - TTL in seconds
 * @returns {Promise<boolean>} - Success status
 */
async function setDataWithExpiry(key, data, ttlSeconds = 3600) {
  try {
    const result = await redisClient.set(key, data, "EX", ttlSeconds);
    return result === "OK";
  } catch (err) {
    console.error("Error setting data with expiry:", err);
    return false;
  }
}

/**
 * Delete data from Redis
 * @param {string} key - Redis key
 * @returns {Promise<number>} - Number of keys deleted
 */
async function deleteData(key) {
  try {
    return await redisClient.del(key);
  } catch (err) {
    console.error("Error deleting data:", err);
    return 0;
  }
}

module.exports = {
  redisClient,
  storeRefreshTokenInRedis,
  verifyRefreshTokenInRedis,
  removeRefreshTokenFromRedis,
  storeStockData,
  getSingleStockData,
  getMultipleStockData,
  getAllStocksHash,
  getStockData,
  hget,
  hset,
  hmset,
  hmget,
  hgetall,
  del,
  publishData,
  setData,
  getData,
  publishScriptEvent,
  addSocketConnection,
  removeSocketConnection,
  getUserSocketConnections,
  publishForceLogout,
  acquireLock,
  releaseLock,
  setDataWithExpiry,
  deleteData,
};
