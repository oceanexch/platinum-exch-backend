const Redis = require("ioredis");
const { REDIS_HOST, REDIS_PORT } = require("./config");

const redisUrl = {
  host: REDIS_HOST,
  port: REDIS_PORT,
};

const options = {
  connectTimeout: 30000,
  maxRetriesPerRequest: null,
};

// Create a general-purpose client (if needed)
const redisClient = new Redis(redisUrl, options);

// Create a dedicated publisher and subscriber.
const redisPublisher = new Redis(redisUrl, options);
const redisSubscriber = new Redis(redisUrl, options);

redisClient.on("connect", () => {
  //console.log("Redis connected:", REDIS_HOST, REDIS_PORT);
});

redisClient.on("error", (err) => {
  console.error("Redis connection error:", err);
});

redisPublisher.on("connect", () => {
  console.log("Redis subscriber connected:", REDIS_HOST, REDIS_PORT);
});

redisPublisher.on("error", (err) => {
  console.error("Redis connection error:", err);
});

redisSubscriber.on("connect", () => {
  //console.log("Redis subscriber connected:", REDIS_HOST, REDIS_PORT);
});

redisSubscriber.on("error", (err) => {
  console.error("Redis connection error:", err);
});

module.exports = { redisClient, redisPublisher, redisSubscriber };
