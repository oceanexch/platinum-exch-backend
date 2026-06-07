// require("dotenv").config({
//     path: "/var/www/html/manish/metro_backend-main/.env",
// });

// const { updateNSEBanData } = require("../services/NSEBanService");
// const { redisClient } = require("../config/redis");

// (async () => {
//     try {
//         console.log("NSE Ban update cron started at", new Date().toLocaleString());

//         const result = await updateNSEBanData();

//         console.log("NSE Ban update successful. Symbols found:", result.data.length);

//         // Disconnect from Redis to allow the process to exit
//         await redisClient.quit();
//         console.log("Redis connection closed. Cron job finished.");
//         process.exit(0);
//     } catch (err) {
//         console.error("NSE Ban update cron failed:", err);
//         // Ensure redis connection is closed even on error if possible
//         try {
//             await redisClient.quit();
//         } catch (e) {
//             await redisClient.quit();
//             console.error("Failed to close Redis connection:", e);
//             process.exit(0);
//         }

//         process.exit(0);
//     } finally {
//         await redisClient.quit();
//         process.exit(0);
//     }
// })();


const fs = require("fs");
const { updateNSEBanData } = require("../services/NSEBanService");
const { redisClient } = require("../config/redis");

/* ---------- HARD SAFETY ---------- */
setTimeout(() => {
  console.error("⛔ NSE cron force exited (timeout)");
  process.exit(1);
}, 2 * 60 * 1000); // 2 minutes max

/* ---------- LOCK ---------- */
const LOCK = "/tmp/nseban.lock";
if (fs.existsSync(LOCK)) {
  console.log("⚠ NSE cron already running. Skipping.");
  process.exit(0);
}
fs.writeFileSync(LOCK, process.pid.toString());
process.on("exit", () => {
  if (fs.existsSync(LOCK)) fs.unlinkSync(LOCK);
});

/* ---------- ERROR GUARDS ---------- */
process.on("unhandledRejection", err => {
  console.error("Unhandled rejection:", err);
  process.exit(1);
});
process.on("uncaughtException", err => {
  console.error("Uncaught exception:", err);
  process.exit(1);
});

/* ---------- MAIN ---------- */
(async function main() {
  try {
    console.log("NSE Ban update cron started at", new Date().toLocaleString());

    const result = await updateNSEBanData();

    console.log("NSE Ban update successful. Symbols:", result?.data?.length || 0);
  } catch (err) {
    console.error("NSE Ban update cron failed:", err);
  } finally {
    try {
      if (redisClient?.isOpen) {
        await redisClient.quit();
        console.log("Redis closed");
      }
    } catch (e) {
      console.error("Redis close error:", e);
    }

    console.log("✅ NSE cron finished. Exiting.");
    process.exit(0);
  }
})();