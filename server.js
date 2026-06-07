/**
 * =================================================================================
 * METRO BACKEND WEBSOCKET DOCUMENTATION (Socket.IO v4)
 * =================================================================================
 *
 * 1. RAW COMMAND CHAIN (FOR POSTMAN / RAW WEBSOCKET TESTING)
 *    Connect URL: ws://your-domain.com/socket.io/?EIO=4&transport=websocket
 *    
 *    Step 1: Connection Kickoff (Send '40' to initialize Socket.IO)
 *    >> 40
 *
 *    Step 2: Authenticate (Implicit via URL params or Handshake)
 *    If using Postman/Raw WS, set 'token' in the 'auth' object or query params.
 *
 *    Step 3: Subscribe to Live Price (Example: ALUMINIUM-II)
 *    >> 42["addSymbol","ALUMINIUM-II"]
 *
 *    Step 4: Subscribe to System Notifications
 *    >> 42["subscribeNotifications"]
 *
 *    Step 5: Fetch Data with Acknowledgment (Structure: 42[id, "event", data])
 *    >> 421["fetchHeadlines", {"limit": 5}]
 *
 * ---------------------------------------------------------------------------------
 * 2. EMITTERS (FRONTEND -> BACKEND)
 * ---------------------------------------------------------------------------------
 *
 * EVENT: "addSymbol" 
 * - Payload: "SYMBOL_NAME" (String)
 * - Result: Joins room for symbol. Updates arrive on "stock-data".
 *
 * EVENT: "subscribeHeadlines"
 * - Payload: null
 * - Result: Joins global "headlines" room.
 *
 * EVENT: "fetchNotifications"
 * - Payload: { "filter": "unread" } (Object)
 * - Callback/Result: { ok: true, notifications: [...] }
 *
 * ---------------------------------------------------------------------------------
 * 3. LISTENERS (BACKEND -> FRONTEND)
 * ---------------------------------------------------------------------------------
 *
 * EVENT: "stock-data"
 * - Structure: { "Symbol": "...", "Ltp": 0.0, "High": 0.0, "Low": 0.0, ... }
 *
 * EVENT: "new-notification"
 * - Structure: { "title": "...", "message": "...", "type": "..." }
 *
 * EVENT: "order-completed"
 * - Structure: { "status": true, "message": "...", "scriptId": "...", "transactionType": "BUY|SELL" }
 *
 * EVENT: "m2m-event"
 * - Structure: { "type": "...", "userId": "...", "parentIds": [...], "data": { "side": "PROFIT|LOSS", "percentage": 0.0, ... } }
 *
 * ---------------------------------------------------------------------------------
 * 4. STEP-BY-STEP IMPLEMENTATION FLOW
 * ---------------------------------------------------------------------------------
 * Step 1: Connect with JWT: const socket = io(URL, { auth: { token } });
 * Step 2: On 'connect', emit 'subscribeNotifications' and 'subscribeHeadlines'.
 * Step 3: Listen for 'stock-data' to update UI prices.
 * Step 4: Page level: emit 'addSymbol' for visible stocks, 'removeSymbol' for hidden ones.
 * =================================================================================
 */

require("dotenv").config();
const cluster = require("cluster");
const os = require("os");
const http = require("http");
const { Server } = require("socket.io");
const { createAdapter } = require("@socket.io/redis-adapter");
const app = require("./src/app");
const reconnectWebSocket = require("./src/wsClient");
const MonitorService = require("./src/services/MonitorService");
const express = require("express");
const appp = express();
const jwt = require("jsonwebtoken");
const mongoose = require("mongoose"); // ✅ for ObjectId checks
const notificationSetting = require("./src/models/NotificationModel"); // your schema
const RedisService = require("./src/services/RedisService");
const LogModel = require("./src/models/LogModel"); // Add this at the top
// const { updateNSEBanData } = require("./src/services/NSEBanService");
const OnlineHistory = require("./src/models/OnlineHistoryModel");
const ChatService = require("./src/services/ChatService");
const DailyHighLowService = require("./src/services/DailyHighLowService");
appp.use(express.urlencoded({ extended: true }));

const {
  redisClient,
  redisPublisher,
  redisSubscriber,
} = require("./src/config/redis");
const M2MWatcher = require("./src/M2MWatcher");
const { HEADER_INDICES } = require("./src/config/marketConstants");
// NEW Trading API WebSocket URL
const WS_SERVER_URL = process.env.NEW_WS_URL || "wss://feed.apollo.in.net/test/ws/";

const PORT = process.env.PORT || 4001;

const NUM_WORKERS = process.env.WORKERS
  ? parseInt(process.env.WORKERS, 10)
  : os.cpus().length;
const isPrimary = cluster.isPrimary || cluster.isMaster;

if (isPrimary) {
  // ===== MASTER PROCESS =====
  // Fork worker processes
  for (let i = 0; i < NUM_WORKERS; i++) {
    cluster.fork();
  }

  // Restart a worker if it dies
  cluster.on("exit", (worker, code, signal) => {
    console.error(`Worker ${worker.process.pid} died. Restarting...`);
    cluster.fork();
  });

  // Create a dedicated Redis subscriber in the master process
  const externalSubscriber = redisSubscriber.duplicate();
  const systemChannels = [
    "notifications",
    "headlines",
    "logs",
    "SCRIPT_EVENTS",
    "stock-transaction",
    "SYMBOL_SUBSCRIPTION",
    "USER_EVENTS",
    "dashboard-stock-event",
    "header-stock-data",
    "M2M_EVENTS",
    "SOCKET_FORCE_LOGOUT",
    "DAILY_HIGH_LOW",
    "limit-order-executed"
  ];

  // Subscribe to system channels (Async)
  (async () => {
    try {
      // 1. We ONLY subscribe to system-level channels in the Master.
      // Individual stock price updates are handled by the wsClient and relayed to workers.
      externalSubscriber.subscribe(...systemChannels, (err, count) => {
        if (err) {
          console.error("Master subscription error:", err);
        } else {
          console.log(`Master initialized (Subscribed to ${count} system channels).`);
        }
      });
    } catch (err) {
      console.error("❌ Master initial subscription failed:", err.message);
    }
  })();

  // Connect to NEW Trading API WebSocket
  // Use a callback to relay data directly to workers for performance

  const relayToWorkers = (channel, message) => {
    // Forward to all workers
    for (const id in cluster.workers) {
      const worker = cluster.workers[id];
      if (worker && worker.isConnected()) {
        try {
          worker.send({ channel, message });
        } catch (err) {
          // console.error(`❌ Failed to relay to worker ${id}:`, err.message);
        }
      }
    }
  };

  console.log("🔌 Connecting to NEW Trading API WebSocket...");
  const externalWs = reconnectWebSocket(WS_SERVER_URL, relayToWorkers, false);

  // Register WebSocket client with Symbol Management Service for dynamic resubscription
  const SymbolManagementService = require("./src/services/SymbolManagementService");
  SymbolManagementService.setWebSocketClient(externalWs);
  console.log("✓ WebSocket client registered with Symbol Management Service");

  // Listen for WebSocket symbol management signals from market operations
  externalSubscriber.subscribe('ws:remove-market-symbols');
  externalSubscriber.subscribe('ws:add-market-symbols');
  externalSubscriber.subscribe('ws:batch-add-market-symbols');
  externalSubscriber.subscribe('ws:batch-remove-market-symbols');

  // On receiving a message from Redis, forward it to all workers
  externalSubscriber.on("message", async (channel, message) => {
    // Handle FAST WebSocket symbol removal and reconnection
    if (channel === 'ws:remove-market-symbols') {
      const startTime = Date.now();
      try {
        const signal = JSON.parse(message);
        console.log(`[Master] ⚡ Received symbol removal signal for market ${signal.marketName} (ID: ${signal.marketId})`);
        console.log(`[Master] Symbols to remove: ${signal.symbolsToRemove.length}`);

        // Call the FAST removal function
        const success = await SymbolManagementService.removeMarketSymbolsAndReconnect(signal.marketId);

        const totalTime = Date.now() - startTime;
        if (success) {
          console.log(`[Master] ✓ WebSocket reconnected successfully (${totalTime}ms)`);
        } else {
          console.warn(`[Master] ⚠️ WebSocket reconnection failed (${totalTime}ms)`);
        }
      } catch (err) {
        const totalTime = Date.now() - startTime;
        console.error(`[Master] ✗ Error handling symbol removal (${totalTime}ms):`, err.message);
      }
      return;
    }

    // Handle FAST WebSocket symbol addition and reconnection
    if (channel === 'ws:add-market-symbols') {
      const startTime = Date.now();
      try {
        const signal = JSON.parse(message);
        console.log(`[Master] ⚡ Received symbol addition signal for market ${signal.marketName} (ID: ${signal.marketId})`);
        console.log(`[Master] Symbols to add: ${signal.symbolsToAdd.length}`);

        // Call the FAST addition function
        const success = await SymbolManagementService.addMarketSymbolsAndReconnect(signal.marketId);

        const totalTime = Date.now() - startTime;
        if (success) {
          console.log(`[Master] ✓ WebSocket reconnected with added symbols (${totalTime}ms)`);
        } else {
          console.warn(`[Master] ⚠️ WebSocket reconnection with added symbols failed (${totalTime}ms)`);
        }
      } catch (err) {
        const totalTime = Date.now() - startTime;
        console.error(`[Master] ✗ Error handling symbol addition (${totalTime}ms):`, err.message);
      }
      return;
    }

    // Handle BATCH WebSocket symbol addition (multiple markets at once)
    if (channel === 'ws:batch-add-market-symbols') {
      const startTime = Date.now();
      try {
        const signal = JSON.parse(message);
        console.log(`[Master] ═══════════════════════════════════════════════════`);
        console.log(`[Master] ⚡ Received BATCH symbol addition for ${signal.markets.length} market(s)`);
        console.log(`[Master] Markets: ${signal.markets.map(m => m.marketName).join(', ')}`);
        console.log(`[Master] ═══════════════════════════════════════════════════`);
        
        // Collect all symbols from all markets
        const allSymbols = new Set();
        
        for (const market of signal.markets) {
          try {
            const marketSymbols = await SymbolManagementService.getSymbolsForMarket(market.marketId);
            console.log(`[Master] Market ${market.marketName}: ${marketSymbols.length} symbols`);
            marketSymbols.forEach(s => allSymbols.add(s));
          } catch (err) {
            console.error(`[Master] Error fetching symbols for market ${market.marketName}:`, err.message);
          }
        }
        
        console.log(`[Master] Total unique symbols to add: ${allSymbols.size}`);
        
        // Get current symbols from Redis
        const currentSymbolsJson = await RedisService.getData('symbols');
        const currentSymbols = currentSymbolsJson ? JSON.parse(currentSymbolsJson) : [];
        const currentSet = new Set(currentSymbols);
        
        console.log(`[Master] Current symbols in Redis: ${currentSet.size}`);
        
        // Merge all symbols
        let addedCount = 0;
        allSymbols.forEach(s => {
          if (!currentSet.has(s)) {
            currentSet.add(s);
            addedCount++;
          }
        });
        
        console.log(`[Master] New symbols added: ${addedCount}`);
        console.log(`[Master] Final symbol count: ${currentSet.size}`);
        
        // Single Redis update
        const finalSymbols = Array.from(currentSet);
        await RedisService.setData('symbols', JSON.stringify(finalSymbols));
        console.log(`[Master] ✓ Updated Redis with ${finalSymbols.length} symbols`);
        
        // Single WebSocket reconnection
        if (externalWs && externalWs.reconnect) {
          await externalWs.reconnect();
          const totalTime = Date.now() - startTime;
          console.log(`[Master] ✓ WebSocket reconnected with batch symbols (${totalTime}ms)`);
          console.log(`[Master] ═══════════════════════════════════════════════════\n`);
        } else {
          console.warn('[Master] ⚠️ WebSocket client not available');
        }
      } catch (err) {
        const totalTime = Date.now() - startTime;
        console.error(`[Master] ✗ Error handling batch addition (${totalTime}ms):`, err.message);
        console.error(err.stack);
      }
      return;
    }

    // Handle BATCH WebSocket symbol removal (multiple markets at once)
    if (channel === 'ws:batch-remove-market-symbols') {
      const startTime = Date.now();
      try {
        const signal = JSON.parse(message);
        console.log(`[Master] ═══════════════════════════════════════════════════`);
        console.log(`[Master] ⚡ Received BATCH symbol removal for ${signal.markets.length} market(s)`);
        console.log(`[Master] Markets: ${signal.markets.map(m => m.marketName).join(', ')}`);
        console.log(`[Master] ═══════════════════════════════════════════════════`);
        
        // Get current symbols from Redis
        const currentSymbolsJson = await RedisService.getData('symbols');
        if (!currentSymbolsJson) {
          console.warn(`[Master] ⚠️ No symbols in Redis - skipping removal`);
          return;
        }
        
        const currentSymbols = JSON.parse(currentSymbolsJson);
        const currentSet = new Set(currentSymbols);
        
        console.log(`[Master] Current symbols in Redis: ${currentSet.size}`);
        
        // Collect all symbols to remove from all markets
        const allSymbolsToRemove = new Set();
        
        for (const market of signal.markets) {
          try {
            const marketSymbols = await SymbolManagementService.getSymbolsForMarket(market.marketId);
            console.log(`[Master] Market ${market.marketName}: ${marketSymbols.length} symbols to remove`);
            marketSymbols.forEach(s => allSymbolsToRemove.add(s));
          } catch (err) {
            console.error(`[Master] Error fetching symbols for market ${market.marketName}:`, err.message);
          }
        }
        
        console.log(`[Master] Total unique symbols to remove: ${allSymbolsToRemove.size}`);
        
        // Remove symbols
        let removedCount = 0;
        allSymbolsToRemove.forEach(s => {
          if (currentSet.has(s)) {
            currentSet.delete(s);
            removedCount++;
          }
        });
        
        console.log(`[Master] Symbols removed: ${removedCount}`);
        console.log(`[Master] Final symbol count: ${currentSet.size}`);
        
        if (removedCount === 0) {
          console.log(`[Master] ℹ️ No symbols were removed`);
          return;
        }
        
        // Single Redis update
        const finalSymbols = Array.from(currentSet);
        await RedisService.setData('symbols', JSON.stringify(finalSymbols));
        console.log(`[Master] ✓ Updated Redis with ${finalSymbols.length} symbols`);
        
        // Single WebSocket reconnection
        if (externalWs && externalWs.reconnect) {
          await externalWs.reconnect();
          const totalTime = Date.now() - startTime;
          console.log(`[Master] ✓ WebSocket reconnected with updated symbols (${totalTime}ms)`);
          console.log(`[Master] ═══════════════════════════════════════════════════\n`);
        } else {
          console.warn('[Master] ⚠️ WebSocket client not available');
        }
      } catch (err) {
        const totalTime = Date.now() - startTime;
        console.error(`[Master] ✗ Error handling batch removal (${totalTime}ms):`, err.message);
        console.error(err.stack);
      }
      return;
    }

    // Forward other messages to all workers safely
    for (const id in cluster.workers) {
      const worker = cluster.workers[id];
      if (worker && worker.isConnected()) {
        try {
          worker.send({ channel, message });
        } catch (err) {
          console.error(`❌ Failed to send message to worker ${id}:`, err.message);
        }
      }
    }
  });



  // Load additional modules
  require("./src/scheduler");
  require("./src/limit"); // Already loaded above for processTick
  // require("./src/scrapper"); // DEPRECATED: Using new sync syncSymbolsFromFile instead


  // Initial data sync on startup
  (async () => {
    try {
      // Check if symbols already exist in Redis to avoid wiping DB on every restart
      const cachedSymbols = await RedisService.getData("symbols");

      if (cachedSymbols) {
        console.log("✅ [Master] Symbols found in Redis. Skipping initial file sync.");
      } else {
        const { syncSymbolsFromFile } = require("./src/cron/dailySymbolSync");
        console.log("🚀 [Master] No symbols in Redis. Starting initial symbol sync from JSON...");
        await syncSymbolsFromFile();
        console.log("✅ [Master] Initial symbol sync complete.");
      }

      // 🚀 Initialize M2M Watcher
      M2MWatcher.initM2MWatcher(2000);

    } catch (err) {
      console.error("❌ [Master] Initial startup tasks failed:", err.message);
    }
  })();

  // Graceful shutdown for master
  const shutdownMaster = () => {
    console.log("Master received shutdown signal. Shutting down workers...");
    for (const id in cluster.workers) {
      cluster.workers[id].kill();
    }
    externalSubscriber.quit();
    redisClient.quit();
    redisPublisher.quit();
    redisSubscriber.quit();
    process.exit(0);
  };

  process.on("SIGTERM", shutdownMaster);
  process.on("SIGINT", shutdownMaster);
  process.on("uncaughtException", (err) => {
    console.error("Master uncaught exception:", err);
    process.exit(1);
  });
  process.on("unhandledRejection", (err) => {
    // console.error("Master unhandled rejection:", err);
    process.exit(1);
  });
} else {
  // ===== WORKER PROCESS =====
  const server = http.createServer(app);

  const corsOption = {
    origin: ["*"
      // "https://oceanexch.org/",
      // "www://oceanexch.org/",
      // "www.oceanexch.org/",
      // "http://150.107.238.224",
      // "http://localhost",
      // "http://192.168.0.160",
      // "http://172.236.176.175",
    ],
    methods: ["GET", "PUT", "POST", "DELETE", "OPTIONS"],
    preflightContinue: false,
    optionsSuccessStatus: 204,
    credentials: true,
  };

  // Set up Socket.IO with CORS enabled
  const io = new Server(server, {
    cors: corsOption,
    // cors: corsOption
  });

  // Configure the Socket.IO Redis adapter for scaling across workers
  io.adapter(createAdapter(redisPublisher, redisSubscriber.duplicate()));

  // --- ADD THIS BLOCK INSIDE YOUR WORKER LOGIC ---
  const tickSubscriber = redisSubscriber.duplicate(); // Create a dedicated subscriber for this worker

  tickSubscriber.on('pmessage', (pattern, channel, message) => {
    try {
      const cleanChannel = channel.startsWith('stock:') ? channel.substring(6) : channel;
      const data = JSON.parse(message);

      // This sends the data ONLY to clients connected to THIS specific PM2 worker
      // who are joined to that specific symbol's room.
      io.local.to(cleanChannel).emit("stock-data", data);
    } catch (err) {
      // console.error("Redis Message Error:", err);
    }
  });

  tickSubscriber.psubscribe('stock:*');
  // ----------

  function buildUserVisibilityConditions({ userId, accountType, parentIds }) {
    const orConditions = [];

    if (userId) {
      orConditions.push({ userType: "User Wise", selectedUser: userId });
    }

    if (
      accountType &&
      mongoose.Types.ObjectId.isValid(accountType.toString())
    ) {
      orConditions.push({
        userType: "User Type Wise",
        selectedUserType: new mongoose.Types.ObjectId(accountType),
      });
    }

    if (parentIds?.length) {
      orConditions.push({
        isParentShow: true,
        parentIds: { $in: parentIds },
      });
    }

    return orConditions;
  }
  // const { startCron } = require('./src/cron/analyticsCaptureCron');
  // const Config = require('./src/config/config');

  // if (Config?.analytics?.enabled) {
  //   startCron();
  // }

  // ---------------- Notifications: worker side message handler ----------------
  process.on("message", (msg) => {

    if (!msg || !msg.channel || !msg.message) return;

    // SCRIPT EVENTS (script add/remove/bulk)
    if (msg.channel === "SCRIPT_EVENTS") {
      try {
        const payload = JSON.parse(msg.message);
        const { type, meta, data } = payload;

        const targetUser = meta?.targetUser;
        if (!targetUser) return;

        const room = `user:${targetUser}`;

        switch (type) {
          case "SCRIPT_ADDED":
            io.local.to(room).emit("script-added", data);
            break;

          case "SCRIPT_REMOVED":
            io.local.to(room).emit("script-removed", data);
            break;

          case "SCRIPT_REMOVED_ALL":
            io.local.to(room).emit("script-removed-all", data);
            break;

          case "SCRIPT_ADDED_BULK":
            io.local.to(room).emit("script-added-bulk", data);
            break;
        }
      } catch (err) {
        console.error(`SCRIPT_EVENTS error`, err);
      }
      return;
    }
    // LOGS (dedicated channel)
    if (msg.channel === "logs") {
      try {
        const payload = JSON.parse(msg.message);
        const data = payload.data || payload;
        const meta = payload.meta || {};

        const emittedRooms = new Set();   // 👈 track where we already emitted

        // 1️⃣ target user
        if (meta.targetUser) {
          const room = `user:${meta.targetUser}`;
          if (io.sockets.adapter.rooms.has(room)) {
            io.local.to(room).emit("new-log", {
              ...data,
              _emittedByPid: process.pid,
              _emittedAt: Date.now(),
            });
          }

        }

        // 2️⃣ parents
        if (Array.isArray(meta.parentIds) && meta.parentIds.length) {
          const pids = [...new Set(meta.parentIds.map(p => p.toString?.() ?? p))];

          pids.forEach(pid => {
            const room = `user:${pid}`;

            if (!emittedRooms.has(room)) {
              emittedRooms.add(room);
              io.local
                .to(room)
                .emit("new-log-parent", { ...data, _emittedByPid: process.pid, _emittedAt: Date.now() });
            }
          });
        }
      } catch (err) {
        console.error(`Worker ${process.pid} error parsing LOGS message:`, err);
      }
      return;
    }

    // ---------------- STOCK SAVE EVENTS ----------------
    if (msg.channel === "stock-transaction") {
      try {
        const payload = JSON.parse(msg.message);
        const { type, data, meta = {} } = payload;

        const emittedRooms = new Set();

        // 1. Notify the target user (the client) that their order is completed
        if (meta.targetUser) {
          const clientRoom = `user:${meta.targetUser}`;
          if (!emittedRooms.has(clientRoom)) {
            emittedRooms.add(clientRoom);
            io.local.to(clientRoom).emit("order-completed", {
              status: true,
              orderType: meta.orderType,
              message: `Order ${meta.transactionType === "BUY" ? "Purchased" : "Sold"} successfully: ${meta.label || meta.scriptId}`,
              ...meta,
              _emittedAt: Date.now(),
            });
          }
        }

        if (Array.isArray(data)) {
          data.forEach((record) => {
            if (!record?.targetUser) return;   // avoid crashes

            const room = `user:${record.targetUser}`;

            if (!emittedRooms.has(room)) {
              emittedRooms.add(room);

              io.local.to(room).emit("stock-transaction", {
                ...(record.scriptSummary?.[0] || {}),
                ...meta,
                targetUser: record.targetUser,
                _emittedByPid: process.pid,
                _emittedAt: Date.now(),
              });
            }
          });
        }
      } catch (err) {
        console.error(`Worker ${process.pid} STOCKS error:`, err);
      }

      return;
    }



    // HEADLINES (dedicated channel) — broadcast as headline events to all sockets
    if (msg.channel === "headlines") {
      try {
        const payload = JSON.parse(msg.message);
        broadcastNotification(payload);
      } catch (err) {
        console.error(`Worker ${process.pid} error parsing HEADLINES message:`, err);
      }
      return;
    }

    if (msg.channel === "dashboard-stock-event") {
      try {
        const payload = JSON.parse(msg.message);
        const { data } = payload;

        if (data && data.userId) {
          // Emit to user himself
          io.local.to(`user:${data.userId}`).emit("dashboard-stock-event", payload);

          // Emit to all parents
          if (Array.isArray(data.parentIds)) {
            data.parentIds.forEach(pid => {
              io.local.to(`user:${pid}`).emit("dashboard-stock-event", payload);
            });
          }
        }
      } catch (err) {
        console.error("Dashboard stock event error:", err);
      }
      return;
    }

    if (msg.channel === "USER_EVENTS") {
      try {
        const payload = JSON.parse(msg.message);

        // Handle user events
        if (payload.userId) {
          io.local.to(`user:${payload.userId}`).emit("user-event", payload);
        }
      } catch (err) {
        console.error("User event error:", err);
      }
      return;
    }

    if (msg.channel === "M2M_EVENTS") {
      try {
        const payload = JSON.parse(msg.message);
        if (payload.userId) {
          io.local.to(`user:${payload.userId}`).emit("m2m-event", { ...payload, isParent: false });

          // Also emit to all parents
          if (Array.isArray(payload.parentIds)) {
            payload.parentIds.forEach(pid => {
              io.local.to(`user:${pid}`).emit("m2m-event", { ...payload, isParent: true });
            });
          }
        }
      } catch (err) {
        console.error("M2M event error:", err);
      }
      return;
    }

    if (msg.channel === "SOCKET_FORCE_LOGOUT") {
      try {
        const payload = JSON.parse(msg.message);
        const { userId, socketId } = payload;

        // Find the socket by ID on this worker
        const targetSocket = io.sockets.sockets.get(socketId);

        if (targetSocket && targetSocket.user?.userId === userId) {
          targetSocket.emit("force-logout", {
            message: "Another device has logged in. You have been logged out.",
            timestamp: payload.timestamp
          });

          // Disconnect the socket after a brief delay
          setTimeout(() => {
            targetSocket.disconnect(true);
          }, 1000);
        }
      } catch (err) {
        console.error("Socket force logout error:", err);
      }
      return;
    }

    // LIMIT ORDER EXECUTED events
    if (msg.channel === "limit-order-executed") {
      try {
        const payload = JSON.parse(msg.message);
        const { userId, parentIds, ...tradeInfo } = payload;

        if (userId) {
          io.local.to(`user:${userId}`).emit("limit-order-executed", {
            ...tradeInfo,
            userId,
            isParent: false,
            _emittedByPid: process.pid,
            _emittedAt: Date.now(),
          });
        }

        if (Array.isArray(parentIds)) {
          const emittedParents = new Set();
          parentIds.forEach(pid => {
            const key = pid.toString();
            if (!emittedParents.has(key)) {
              emittedParents.add(key);
              io.local.to(`user:${pid}`).emit("limit-order-executed", {
                ...tradeInfo,
                userId,
                isParent: true,
                _emittedByPid: process.pid,
                _emittedAt: Date.now(),
              });
            }
          });
        }
      } catch (err) {
        console.error(`Worker ${process.pid} limit-order-executed error:`, err);
      }
      return;
    }

    // DAILY HIGH LOW events
    if (msg.channel === "DAILY_HIGH_LOW") {
      try {
        const payload = JSON.parse(msg.message);
        const { data } = payload;

        if (data) {
          // Emit only to unauthenticated (no-token) sockets
          io.local.to("without-token").emit("daily-high-low", data);
        }
      } catch (err) {
        console.error("Daily high/low event error:", err);
      }
      return;
    }
    // existing notifications handling
    if (msg.channel === "notifications") {
      try {
        const payload = JSON.parse(msg.message);
        broadcastNotification(payload);
      } catch (err) {
        console.error(`Worker ${process.pid} error parsing notification:`, err);
      }
      return;
    }

    // header/top data

    if (msg.channel.includes("-TOP")) {
      try {
        const data = JSON.parse(msg.message);
        const symbol = (data.Symbol || data.symbol || "").trim();

        // Find if this symbol is in our HEADER_INDICES enum
        const headerConfig = HEADER_INDICES.find(idx => idx.symbol.trim() === symbol);

        if (headerConfig) {
          const emitData = { ...data };
          // Apply specific mapping for NIFTYBANK
          if (symbol === "NIFTYBANK") {
            emitData.name = "BANKNIFTY";
            emitData.Name = "BANKNIFTY";
          }
          // LOCAL emit: only sockets attached to this worker get this
          io.local.to("without-token").emit("header-stock-data", emitData);
        }
      } catch (err) {
        console.error(`Worker ${process.pid} error parsing TOP message:`, err);
      }
      return;
    }

    // stock channels — emit to room (only on this worker)
    try {
      const data = JSON.parse(msg.message);
      // Validate essential fields - Symbol is the most important
      if (!data || !data.Symbol) return;

      // Emit to sockets on this worker only (local emission)
      io.local.to(msg.channel).emit("stock-data", data);

      // Also relay to header stock data if it's one of the indices
      const symbol = (data.Symbol || "").trim();
      const headerConfig = HEADER_INDICES.find(idx => idx.symbol.trim() === symbol);

      if (headerConfig) {
        const emitData = { ...data };
        emitData.name = headerConfig.name;
        emitData.Name = headerConfig.name;
        emitData.exchange = headerConfig.exchange;
        emitData.Exchange = headerConfig.exchange;

        io.local.to("without-token").emit("header-stock-data", emitData);
      }
    } catch (err) {
      console.error(`Worker ${process.pid} error parsing stock message:`, err);
    }
  });


  // ---------------- Room-based notification broadcaster ----------------
  function broadcastNotification(payload) {
    const { type, data, id } = payload;
    try {
      const now = Date.now();
      if (data && typeof data === "object") {
        if (data.startDate != null && data.endDate != null) {
          const s = typeof data.startDate === "number" ? data.startDate : new Date(data.startDate).getTime();
          const e = typeof data.endDate === "number" ? data.endDate : new Date(data.endDate).getTime();
          if (isNaN(s) || isNaN(e) || s > now || e < now) {
            return;
          }
        }
      }
    } catch (e) {
      console.error("Error in date guard for notification:", e);
      return;
    }

    // helper: attach debug metadata
    const attachDebug = (p) => ({ ...p, _emittedByPid: process.pid, _emittedAt: Date.now() });

    // helper: emit to all sockets connected to this worker
    const localEmitAll = (ev, payloadObj) => {
      try { io.local.emit(ev, attachDebug(payloadObj)); } catch (e) { io.emit(ev, attachDebug(payloadObj)); }
    };

    // helper: emit to a specific room on this worker (if room exists)
    const localEmitToRoom = (room, ev, payloadObj) => {
      try {
        // rooms is a Map in socket.io v4
        if (io.sockets && io.sockets.adapter && io.sockets.adapter.rooms && io.sockets.adapter.rooms.has(room)) {
          io.local.to(room).emit(ev, attachDebug(payloadObj));
        } else {
          // room not present in this worker: emit anyway locally (no-op if no sockets)
          io.local.to(room).emit(ev, attachDebug(payloadObj));
        }
      } catch (e) {
        // fallback (older socket.io versions)
        io.local.to(room).emit(ev, attachDebug(payloadObj));
      }
    };


    // HEADLINE (broadcast)
    if (type === "ADD" && data && data.type === "Headline") {
      localEmitAll("new-headline", data);
      return;
    }
    // 🔹 HEADLINE → GLOBAL DELETE
    if (type === "DELETE" && data.type === "Headline") {
      localEmitAll("delete-headline", { id: data._id });
      return;
    }

    // DELETE (broadcast)
    // DELETE
    if (type === "DELETE" && data) {
      // 🔹 NOTIFICATION → SCOPED DELETE
      const deleteEvent = "delete-notification";

      // 1️⃣ USER WISE
      if (data.userType === "User Wise" && data.selectedUser) {
        const uid =
          typeof data.selectedUser === "string"
            ? data.selectedUser
            : data.selectedUser?.toString?.();

        if (uid) {
          localEmitToRoom(`user:${uid}`, deleteEvent, { id });
        }
        return;
      }

      // 2️⃣ USER TYPE WISE
      if (data.userType === "User Type Wise" && data.selectedUserType) {
        const acct =
          typeof data.selectedUserType === "string"
            ? data.selectedUserType
            : data.selectedUserType?.toString?.();

        if (acct) {
          localEmitToRoom(`accountType:${acct}`, deleteEvent, { id });
        }
        return;
      }

      // 3️⃣ PARENT SHOW
      if (data.isParentShow && data.parentIds) {
        if (Array.isArray(data.parentIds)) {
          const pids = [...new Set(data.parentIds.map(p => p.toString()))];
          pids.forEach(pid =>
            localEmitToRoom(`parent:${pid}`, deleteEvent, { id })
          );
        } else {
          localEmitToRoom(
            `parent:${data.parentIds.toString()}`,
            deleteEvent,
            { id }
          );
        }
        return;
      }
    }


    // ADD (targeted)
    if (type === "ADD" && data) {


      // 1) USER WISE: emit only to selectedUser

      if (data.userType === "User Wise") {
        if (!data.selectedUser) {
          return;
        }
        // selectedUser expected as single string id
        const uid = typeof data.selectedUser === "string" ? data.selectedUser : data.selectedUser?.toString?.();
        if (!uid) {
          return;
        }
        localEmitToRoom(`user:${uid}`, "new-notification", data);
        return;
      }

      // 2) USER TYPE WISE: emit only to accountType:<selectedUserType>
      if (data.userType === "User Type Wise") {
        if (!data.selectedUserType) {
          return;
        }
        const acct = typeof data.selectedUserType === "string" ? data.selectedUserType : data.selectedUserType?.toString?.();
        if (!acct) {
          return;
        }
        localEmitToRoom(`accountType:${acct}`, "new-notification", data);
        return;
      }

      // 3) PARENT SHOW: emit to parent rooms if present
      if (data.isParentShow && data.parentIds) {
        if (Array.isArray(data.parentIds)) {
          const pids = [...new Set(data.parentIds.map((p) => p.toString()))];
          pids.forEach((pid) => localEmitToRoom(`parent:${pid}`, "new-notification", data));
        } else {
          localEmitToRoom(`parent:${data.parentIds.toString()}`, "new-notification", data);
        }
        return;
      }

      // Fallback: nothing matched — skip broadcast (be explicit)
    }
  }



  // ---------------- Attach user info on socket connection & join rooms ----------------
  io.use((socket, next) => {
    try {
      const token =
        socket.handshake?.auth?.token || socket.handshake?.query?.token;
      if (!token) {
        socket.join("without-token");
        return next(); // allow anonymous if you want
      }

      const decoded = jwt.verify(token, process.env.JWT_SECRET);

      const userId = (
        decoded.userId ||
        decoded._id ||
        decoded.id
      )?.toString();

      let accountType = decoded.accountType || decoded.role || decoded.accountTypeId;

      // Keep the full accountType object if it has level, otherwise just store the ID
      // We need the level property for socket connection limits
      if (accountType && typeof accountType === "object") {
        if (accountType.level !== undefined) {
          // Keep the full object since it has the level we need
        } else if (accountType._id) {
          // Only has _id, extract it
          accountType = accountType._id;
        }
      }

      const parentIds = Array.isArray(decoded.parentIds)
        ? decoded.parentIds.map((p) => p.toString())
        : [];

      socket.user = { userId, accountType, parentIds };

      // join rooms immediately
      if (userId) socket.join(`user:${userId}`);
      if (accountType) {
        const accountTypeId = typeof accountType === 'object' ? accountType._id : accountType;
        socket.join(`accountType:${accountTypeId.toString()}`);
      }
      parentIds.forEach((pid) => socket.join(`parent:${pid}`));

      return next();
    } catch (err) {
      console.error("Socket auth error:", err);
      socket.user = null; // still allow connection
      socket.join("without-token");
      return next();
    }
  });
  const saveOnlineHistory = async (data) => {
    try {
      await OnlineHistory.create(data);
    } catch (err) {
      console.log(err)
    }
  }

  // ---------------- Socket.IO connections ----------------
  io.on("connection", async (socket) => {

    const ip = socket.handshake.headers['x-forwarded-for']?.split(',')[0] ||
      socket.handshake.headers['x-real-ip'] ||
      socket.handshake.address;

    // Handle socket connection management for authenticated users
    if (socket.user?.userId) {
      const userId = socket.user.userId;
      const userLevel = socket.user.accountType?.level || 7; // Default to level 7 if not found

      try {
        const { addSocketConnection, publishForceLogout } = require("./src/services/RedisService");

        const connectionResult = await addSocketConnection(
          userId,
          socket.id,
          userLevel,
          process.pid.toString()
        );

        // Handle multiple force logouts
        if (connectionResult.forceLogoutSocketIds && connectionResult.forceLogoutSocketIds.length > 0) {
          // Send force logout to multiple old connections
          for (const socketIdToLogout of connectionResult.forceLogoutSocketIds) {
            await publishForceLogout(userId, socketIdToLogout);
          }
        } else if (connectionResult.forceLogoutSocketId) {
          // Backward compatibility for single socket logout
          await publishForceLogout(userId, connectionResult.forceLogoutSocketId);
        }

      } catch (err) {
        console.error("Error managing socket connection:", err);
      }
    }

    // Emit initial header stock data for unauthenticated sockets
    if (!socket.user || !socket.user.userId) {
      (async () => {
        try {
          const symbols = HEADER_INDICES.map(idx => idx.symbol);
          const currentData = await RedisService.getMultipleStockData(symbols);

          currentData.forEach((data, index) => {
            if (data) {
              const config = HEADER_INDICES[index];
              const emitData = { ...data };
              emitData.name = config.name;
              emitData.Name = config.name;
              emitData.exchange = config.exchange;
              emitData.Exchange = config.exchange;
              socket.emit("header-stock-data", emitData);
            }
          });
        } catch (err) {
          console.error("Error emitting initial header stock data:", err);
        }
      })();
    }

    // DEBUG: Log all headers to see what's availabl
    if (socket.user?.userId) {
      saveOnlineHistory({ userId: socket.user.userId, type: 'online', time: new Date(), ip })

      RedisService.hset("onlineStatus", socket.user.userId, "online");
    }
    (async () => {
      try {
        const userId = socket.user?.userId;
        if (!userId) return;

        const accountType = socket.user?.accountType;
        const parentIds = socket.user?.parentIds || [];
        const now = Date.now();

        // only match notifications specifically addressed to this user
        const orConditions = [
          { userType: "User Wise", selectedUser: userId },
        ];

        // Add User Type Wise condition only if accountType looks like an ObjectId
        if (accountType && mongoose.Types.ObjectId.isValid(accountType.toString())) {
          orConditions.push({
            userType: "User Type Wise",
            selectedUserType: new mongoose.Types.ObjectId(accountType),
          });
        }

        // Parent-based condition
        if (parentIds.length) {
          orConditions.push({
            isParentShow: true,
            parentIds: { $in: parentIds },
          });
        }

        const conditions = {
          startDate: { $lte: now },
          endDate: { $gte: now },
          $or: orConditions,
          readBy: { $ne: userId }, // unread for this user
        };

        const unread = await notificationSetting
          .find(conditions)
          .sort({ createdAt: -1 })
          .lean();

        if (unread && unread.length) {
          socket.emit("notifications-list", {
            type: "unread",
            notifications: unread,
          });
        }
      } catch (err) {
        console.error("Error sending unread on connect", err);
      }
    })();
    // ---------------- Subscribe to script events (user-scoped) ----------------
    socket.on("subscribeScripts", (cb) => {
      try {
        const userId = socket.user?.userId;
        if (!userId) {
          return cb?.({ ok: false, error: "unauthenticated" });
        }

        const room = `user:${userId}`;
        socket.join(room);

        cb?.({ ok: true, room });
      } catch (err) {
        console.error("subscribeScripts error:", err);
        cb?.({ ok: false, error: err.message });
      }
    });

    // Client 
    // requests logs (with optional filter: 'all'|'unread'|'recent', etc.)
    socket.on("fetchLogs", async (opts = {}, cb) => {
      try {
        const userId = socket.user?.userId;
        const parentIds = socket.user?.parentIds || [];
        const now = Date.now();

        // By default fetch logs relevant to the user: either target user or parents
        const orConditions = [];

        if (userId) {
          orConditions.push({ "rejectionLog.clientId": mongoose.Types.ObjectId.isValid(userId) ? new mongoose.Types.ObjectId(userId) : userId });
          // Also allow string matching if stored as string
          orConditions.push({ "rejectionLog.clientId": userId });
        }

        if (parentIds.length) {
          orConditions.push({ "rejectionLog.parentIds": { $in: parentIds.map(p => (mongoose.Types.ObjectId.isValid(p) ? new mongoose.Types.ObjectId(p) : p)) } });
        }

        // If none found (unauthenticated), return empty
        if (!orConditions.length) {
          const res = [];
          if (typeof cb === "function") return cb({ ok: true, logs: res });
          return socket.emit("logs-list", { type: "personal", logs: res });
        }

        const base = { $or: orConditions };
        const startOfToday = new Date();
        startOfToday.setHours(0, 0, 0, 0);

        const endOfToday = new Date();
        endOfToday.setHours(23, 59, 59, 999)


        let query = LogModel.find({
          ...base,
          type: "rejection",
          createdAt: {
            $gte: startOfToday,
            $lte: endOfToday,
          },
        }).sort({ createdAt: -1 });

        if (opts.limit) query = query.limit(Number(opts.limit));
        if (opts.since) query = query.where("createdAt").gte(new Date(Number(opts.since)));

        const results = await query.lean();

        if (typeof cb === "function") return cb({ ok: true, logs: results });
        socket.emit("logs-list", { type: opts.filter || "personal", logs: results });
      } catch (err) {
        console.error("fetchLogs error", err);
        if (typeof cb === "function") return cb({ ok: false, error: err.message });
        socket.emit("logs-error", { error: err.message });
      }
    });

    // Admin/event to fetch ALL logs (only allow if user appears admin — you must adapt this check)
    socket.on("fetchAllLogs", async (opts = {}, cb) => {
      try {
        const isAdmin = (() => {
          // adapt this to your role system: e.g., accountType === 'admin' or roles array
          const acct = socket.user?.accountType;
          if (!acct) return false;
          // basic check: if accountType equals 'admin' string — change as needed
          return acct.toString && acct.toString().toLowerCase() === "admin";
        })();

        if (!isAdmin) {
          const err = "unauthorized";
          if (cb) return cb({ ok: false, error: err });
          return socket.emit("logs-error", { error: err });
        }

        let query = LogModel.find({}).sort({ createdAt: -1 });
        if (opts.limit) query = query.limit(Number(opts.limit));
        if (opts.since) query = query.where("createdAt").gte(new Date(Number(opts.since)));

        const results = await query.lean();
        if (typeof cb === "function") return cb({ ok: true, logs: results });
        socket.emit("logs-list", { type: "all", logs: results });
      } catch (err) {
        console.error("fetchAllLogs error", err);
        if (cb) return cb({ ok: false, error: err.message });
        socket.emit("logs-error", { error: err.message });
      }
    });
    socket.on("fetchHeadlines", async (opts = {}, cb) => {

      try {
        const now = Date.now();
        // console.log("Current timestamp:", now);

        const conditions = {
          type: "Headline",
          startDate: { $lte: now },
          endDate: { $gte: now },
        };

        // console.log("Query conditions:", JSON.stringify(conditions));

        let query = notificationSetting
          .find(conditions)
          .sort({ createdAt: -1 });

        if (opts.limit) {
          query = query.limit(Number(opts.limit));
        }

        const results = await query.lean();
        // console.log("Results found:", results.length);
        // console.log("First result:", results[0]);

        if (typeof cb === 'function') {
          // console.log("Calling callback with results");
          cb({ ok: true, headlines: results });
        } else {
          // console.log("Emitting headlines-list event");
          socket.emit('headlines-list', { ok: true, headlines: results });
        }
        // console.log("=== FETCH HEADLINES END ===");
      } catch (err) {
        console.error("fetchHeadlines error:", err);
        console.error("Error stack:", err.stack);
        if (typeof cb === 'function') {
          cb({ ok: false, error: err.message });
        } else {
          socket.emit('headlines-error', { error: err.message });
        }
      }
    });

    // 2) Client requests notifications via socket
    socket.on("fetchNotifications", async (opts = {}, cb) => {

      try {
        const userId = socket.user?.userId;
        const accountType = socket.user?.accountType;
        const parentIds = socket.user?.parentIds || [];
        const now = Date.now();

        const orConditions = buildUserVisibilityConditions({
          userId,
          accountType,
          parentIds,
        });

        if (!orConditions.length) {
          return cb?.({ ok: true, notifications: [] });
        }

        const conditions = {
          type: "Notification", // ✅ IMPORTANT
          startDate: { $lte: now },
          endDate: { $gte: now },
          $or: orConditions,
        };

        let query = notificationSetting
          .find(conditions)
          .sort({ createdAt: -1 });

        if (opts.filter === "unread" && userId) {
          query = query.where("readBy").ne(userId);
        }

        if (opts.limit) query = query.limit(Number(opts.limit));

        const results = await query.lean();

        cb
          ? cb({ ok: true, notifications: results })
          : socket.emit("notifications-list", {
            type: opts.filter || "all",
            notifications: results,
          });
      } catch (err) {
        console.error("fetchNotifications error", err);
        cb
          ? cb({ ok: false, error: err.message })
          : socket.emit("notifications-error", { error: err.message });
      }
    });
    // 3) Mark notifications as read
    socket.on("markAsRead", async ({ notifIds = [] }, cb) => {
      try {
        const userId = socket.user?.userId;
        if (!userId) {
          const err = "unauthenticated";
          if (cb) return cb({ ok: false, error: err });
          return socket.emit("notifications-error", { error: err });
        }

        let ids = notifIds;
        if (!Array.isArray(ids)) ids = [ids];

        await notificationSetting.updateMany(
          { _id: { $in: ids } },
          { $addToSet: { readBy: userId } }
        );

        socket
          .to(`user:${userId}`)
          .emit("notifications-marked-read", { notifIds: ids, userId });

        if (cb) return cb({ ok: true });
        socket.emit("markAsRead:ok");
      } catch (err) {
        console.error("markAsRead error", err);
        if (cb) return cb({ ok: false, error: err.message });
        socket.emit("notifications-error", { error: err.message });
      }
    });


    // ---------------- Chat events ----------------
    socket.on("chat:send", async ({ toUserId, message, tempId }, cb) => {
      try {
        const fromUserId = socket.user?.userId;
        if (!fromUserId || !toUserId) {
          const err = new Error("Missing user id");
          if (typeof cb === "function") cb({ ok: false, error: err.message });
          socket.emit("chat:error", { error: err.message });
          return;
        }
        const data = await ChatService.createMessage({
          fromUserId,
          toUserId,
          body: message,
        });
        const payload = { ...data, tempId };
        if (fromUserId) io.to(`user:${fromUserId}`).emit("chat:new", payload);
        if (toUserId) io.to(`user:${toUserId}`).emit("chat:new", payload);
        if (typeof cb === "function") cb({ ok: true, data: payload });
      } catch (err) {
        console.error("chat:send error", err);
        if (typeof cb === "function") cb({ ok: false, error: err.message });
        socket.emit("chat:error", { error: err.message });
      }
    });

    socket.on("chat:read", async ({ partnerId }, cb) => {
      try {
        const readerId = socket.user?.userId;
        if (!readerId || !partnerId) {
          const err = new Error("Missing user id");
          if (typeof cb === "function") cb({ ok: false, error: err.message });
          socket.emit("chat:error", { error: err.message });
          return;
        }
        const updated = await ChatService.markRead({
          userId: readerId,
          partnerId,
        });
        if (typeof cb === "function") cb({ ok: true, updated });
        io.to(`user:${partnerId}`).emit("chat:read", {
          partnerId: readerId,
          updated,
        });
      } catch (err) {
        console.error("chat:read error", err);
        if (typeof cb === "function") cb({ ok: false, error: err.message });
        socket.emit("chat:error", { error: err.message });
      }
    });
    socket.on("chat:media:emit", async ({ messageId, toUserId }, cb) => {
      try {
        const fromUserId = socket.user?.userId;
        if (!fromUserId || !toUserId || !messageId) return;

        const msg = await ChatService.getMessageById(messageId);

        if (!msg) return;

        if (fromUserId) io.to(`user:${fromUserId}`).emit("chat:new", msg);
        if (toUserId) io.to(`user:${toUserId}`).emit("chat:new", msg);

        if (cb) cb({ ok: true });
      } catch (err) {
        console.error("chat:media:emit error", err);
        if (cb) cb({ ok: false, error: err.message });
      }
    });

    // 🔔 Subscribe to headline stream (GLOBAL)
    socket.on("subscribeHeadlines", (cb) => {
      try {
        socket.join("headlines"); // global room
        cb?.({ ok: true });
      } catch (err) {
        cb?.({ ok: false, error: err.message });
      }
    });

    // 4) Optional: explicit subscribe to notifications room
    socket.on("subscribeNotifications", (cb) => {

      const userId = socket.user?.userId;
      if (userId) {
        socket.join(`user:${userId}`);
      }
      cb && cb({ ok: true });
    });

    // 5) register event (manual room join)
    socket.on("register", (payload, cb) => {
      try {
        const userId = payload?.userId?.toString();
        const accountType = payload?.accountType?.toString();
        const parentIds = payload?.parentIds || [];

        if (userId) {
          socket.join(`user:${userId}`);
          // console.log(`Socket ${socket.id} joined room user:${userId}`);
        }
        if (accountType) {
          socket.join(`accountType:${accountType}`);
          // console.log(
          //   `Socket ${socket.id} joined room accountType:${accountType}`
          // );
        }
        if (Array.isArray(parentIds)) {
          parentIds.forEach((pid) => {
            socket.join(`parent:${pid.toString()}`);
            // console.log(
            //   `Socket ${socket.id} joined room parent:${pid.toString()}`
            // );
          });
        }

        cb && cb({ ok: true });
      } catch (e) {
        console.error("register handler error", e);
        cb && cb({ ok: false, e: e.message });
      }
    });

    // Subscribe to symbol updates (for NEW Trading API WebSocket)
    // Join both requested symbol and base symbol (strip -I/-II) so client gets updates from feed (which often uses base symbol)
    const handleAddSymbol = async (symbol) => {
      if (!symbol || typeof symbol !== "string") return;
      const sym = String(symbol).trim().toUpperCase();
      const baseSymbol = sym.replace(/-I+$/, "").replace(/-II+$/, "");

      try {
        const { getSingleStockData } = require("./src/services/RedisService");
        let cachedData = await getSingleStockData(sym);
        let targetRoom = sym;
        if (cachedData) {
          try {
            const stockData = typeof cachedData === "string" ? JSON.parse(cachedData) : cachedData;
            targetRoom = stockData.Symbol || stockData.InstrumentIdentifier || sym;
            socket.join(sym);
            if (baseSymbol && baseSymbol !== sym) socket.join(baseSymbol);
            if (targetRoom !== sym) socket.join(targetRoom);
            socket.emit("stock-data", stockData);
          } catch (e) {
            socket.join(sym);
            if (baseSymbol && baseSymbol !== sym) socket.join(baseSymbol);
          }
        } else {
          cachedData = baseSymbol !== sym ? await getSingleStockData(baseSymbol) : null;
          socket.join(sym);
          if (baseSymbol && baseSymbol !== sym) socket.join(baseSymbol);
          if (cachedData) {
            try {
              const stockData = typeof cachedData === "string" ? JSON.parse(cachedData) : cachedData;
              socket.emit("stock-data", stockData);
            } catch (e) { }
          }
        }
      } catch (err) {
        console.error(`❌ Error in addSymbol handler:`, err.message);
      }
    };

    const handleRemoveSymbol = (symbol) => {
      if (!symbol || typeof symbol !== "string") return;
      const sym = String(symbol).trim().toUpperCase();
      const baseSymbol = sym.replace(/-I+$/, "").replace(/-II+$/, "");
      socket.leave(sym);
      if (baseSymbol && baseSymbol !== sym) socket.leave(baseSymbol);
    };

    socket.on("addSymbol", handleAddSymbol);
    socket.on("addsymball", handleAddSymbol);

    socket.on("removeSymbol", handleRemoveSymbol);
    socket.on("removesymball", handleRemoveSymbol);

    // Real-time summary report P&L: recalc on price update request and push to client
    socket.on("summaryReportRefresh", async (payload, cb) => {
      try {
        const userId = socket.user?.userId;
        if (!userId) {
          if (typeof cb === "function") cb({ ok: false, error: "Unauthenticated" });
          return;
        }
        const { getUser } = require("./src/services/UserService");
        const user = await getUser({ _id: userId }, { accountType: 1 });
        const level = user?.accountType?.level;
        if (level == null) {
          if (typeof cb === "function") cb({ ok: false, error: "User level not found" });
          return;
        }
        const { getSummaryReportData } = require("./src/controllers/StockController");
        const result = await getSummaryReportData(payload || {}, userId, level);
        socket.emit("summary-pnl", {
          data: result.data,
          reportsTotal: result.reportsTotal,
          scriptNameToSymbol: result.scriptNameToSymbol || {},
        });
        if (typeof cb === "function") cb({ ok: true });
      } catch (err) {
        console.error("summaryReportRefresh error:", err);
        if (typeof cb === "function") cb({ ok: false, error: err.message });
        socket.emit("summary-pnl-error", { error: err.message });
      }
    });

    socket.on("unsubscribe", () => {
      socket.leaveAll();
    });

    // Debug endpoint to check user's current socket connections
    socket.on("getMyConnections", async (cb) => {
      try {
        const userId = socket.user?.userId;
        if (!userId) {
          return cb?.({ ok: false, error: "unauthenticated" });
        }

        const { getUserSocketConnections } = require("./src/services/RedisService");
        const connections = await getUserSocketConnections(userId);

        cb?.({
          ok: true,
          connections: connections,
          currentSocketId: socket.id,
          userLevel: socket.user?.accountType?.level || 7
        });
      } catch (err) {
        console.error("getMyConnections error:", err);
        cb?.({ ok: false, error: err.message });
      }
    });

    // Fetch high/low data for a script
    socket.on("fetchHighLow", async ({ scriptId }, cb) => {
      try {
        if (!scriptId) {
          return cb?.({ ok: false, error: "scriptId required" });
        }

        const DailyHighLowService = require("./src/services/DailyHighLowService");
        const DailyHighLow = require("./src/models/DailyHighLowModel");

        // Get current high/low from Redis
        const data = await DailyHighLowService.getHighLow(scriptId);

        // Filter data created within last 2 hours from database
        const twoHoursAgo = new Date(Date.now() - 2 * 60 * 60 * 1000);
        const recentRecords = await DailyHighLow.find({
          createdAt: { $gte: twoHoursAgo }
        })
          .sort({ createdAt: -1 })
          .lean();

        cb?.({ ok: true, data, recentRecords });
      } catch (err) {
        console.error("fetchHighLow error:", err);
        cb?.({ ok: false, error: err.message });
      }
    });

    // Fetch historical high/low data
    socket.on("fetchHistoricalHighLow", async ({ scriptId, period = 'DAILY', limit = 10, marketIds = [] }, cb) => {
      try {
        const DailyHighLow = require("./src/models/DailyHighLowModel");

        // Build query conditions
        const twoHoursAgo = new Date(Date.now() - 2 * 60 * 60 * 1000);
        const queryConditions = {
          createdAt: { $gte: twoHoursAgo }
        };
        let recentRecords;
        // Add marketId filter if provided
        if (Array.isArray(marketIds) && marketIds.length > 0) {
          queryConditions.marketId = { $in: marketIds };
          
          recentRecords = await DailyHighLow.find(queryConditions)
            // Fetch filtered records
            .sort({ createdAt: -1 })
            .lean();
        }
        // console.log("recentRecords :", recentRecords)
        cb?.({ ok: true, recentRecords });
      } catch (err) {
        console.error("fetchHistoricalHighLow error:", err);
        cb?.({ ok: false, error: err.message });
      }
    });
    socket.on("disconnect", async () => {
      const ip = socket.handshake.headers['x-forwarded-for']?.split(',')[0] ||
        socket.handshake.headers['x-real-ip'] ||
        socket.handshake.address;

      if (socket.user?.userId) {
        const userId = socket.user.userId;

        // Remove socket connection from tracking
        try {
          const { removeSocketConnection } = require("./src/services/RedisService");
          await removeSocketConnection(userId, socket.id);
        } catch (err) {
          console.error("Error removing socket connection:", err);
        }

        // Save offline history and update status
        saveOnlineHistory({ userId: userId, type: 'offline', time: new Date(), ip });
        RedisService.hset("onlineStatus", userId, "offline");

        // 🔔 Monitor: notify watchers of offline (fire-and-forget)
        MonitorService.notifyWatchers(
          userId,
          'OFFLINE',
          {
            loginUserId: userId,
            ip,
            device: socket.handshake.headers['user-agent'] || 'Unknown',
            parentIds: socket.user.parentIds || [],
            time: new Date()
          }
        ).catch(() => { });
      }
    });
  });


  // Start the HTTP server
  server.listen(PORT, "127.0.0.1", () => {
    // console.log(`Worker ${process.pid} listening on port ${PORT}`);
  });

  // Graceful shutdown for worker
  const shutdownWorker = () => {
    server.close(() => {
      console.log(`Worker ${process.pid} HTTP server closed.`);
      redisClient.quit();
      redisPublisher.quit();
      redisSubscriber.quit();
      process.exit(0);
    });
  };

  process.on("SIGTERM", shutdownWorker);
  process.on("SIGINT", shutdownWorker);
  process.on("uncaughtException", (err) => {
    console.error(`Worker ${process.pid} uncaught exception:`, err);
    shutdownWorker();
  });
  process.on("unhandledRejection", (err) => {
    console.error(`Worker ${process.pid} unhandled rejection:`, err);
    shutdownWorker();
  });
}
