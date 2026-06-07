require("dotenv").config();
const connectDB = require("./src//config/database");
connectDB();
const http = require('http');
const socketIo = require('socket.io');
const TokenService = require("./src/services/TokenService");
const RedisService = require("./src/services/RedisService");
const OnlineHistory = require("./src/models/OnlineHistoryModel");
const ChatService = require("./src/services/ChatService");
const DailyHighLowService = require("./src/services/DailyHighLowService");
const MonitorService = require("./src/services/MonitorService");
const server = http.createServer();
const { redisSubscriber } = require('./src/config/redis');
const io = socketIo(server);

process.on("uncaughtException", (err) => {
  console.error("Uncaught Exception:", err);
});

process.on("unhandledRejection", (reason, promise) => {
  console.error("Unhandled Rejection at:", promise, "reason:", reason);
});

RedisService.del('onlineStatus');
io.use((socket, next) => {
  try {
    const token = socket.handshake.query.token;
    socket.user = TokenService.verifyAccessToken(token)
    next();
  } catch (err) {
    //console.log(err)
    next(new Error(err));
  }
});

io.on('connection', async (socket) => {
  const ip = socket.handshake.headers['x-forwarded-for']?.split(',')[0] ||
    socket.handshake.headers['x-real-ip'] ||
    socket.handshake.address;

  // DEBUG: Log all headers to see what's available
 
  const userTypeId = socket.user.accountType;
  // user-specific room
  const userId = socket.user?.userId;
  if (userId) {
    socket.join(`user:${userId}`);
  }
  RedisService.hset('onlineStatus', socket.user.userId, 'online') // set user online on ws connect
  // saveOnlineHistory({ userId: socket.user.userId, type: 'online', time: new Date().toISOString(), ip })

  // 🔹 userType room (for “User Type Wise” realtime filters)
  if (userTypeId) {
    socket.join(`userType:${userTypeId}`);
  }
  try {
    const userId = socket.user?.userId;
    if (userId) {
      // fetch unread notifications for this user (and relevant accountType/parent)
      const accountType = socket.user.accountType;
      // compute parent ids if available in socket.user (or decode from token)
      const parentIds = socket.user.parentIds || [];
      const now = Date.now();
      const conditions = {
        startDate: { $lte: now },
        endDate: { $gte: now },
        $or: [
          { userType: 'User Wise', selectedUser: 'All' },
          { userType: 'User Wise', selectedUser: userId },
          { userType: 'User Wise', selectedUser: { $in: [userId] } },
          { userType: 'User Type Wise', selectedUserType: accountType },
          { isParentShow: true, parentIds: { $in: parentIds } },
        ],
        isReadBy: { $ne: userId }
      };
      const unread = await Notification.find(conditions).sort({ createdAt: -1 }).lean();
      if (unread && unread.length) {
        socket.emit('notifications-list', { type: 'unread', notifications: unread });
      }
    }
  } catch (err) {
    console.error('Error sending unread on connect', err);
  }
  socket.on('disconnect', () => {
    RedisService.hset('onlineStatus', socket.user.userId, 'offline');
    MonitorService.notifyWatchers(
      socket.user.userId,
      'OFFLINE',
      {
        loginUserId: socket.user.userId,
        ip,
        device: socket.handshake.headers['user-agent'] || 'Unknown',
        parentIds: socket.user.parentIds || [],
        time: new Date()
      }
    ).catch(() => {});
  });

  // ------------------ CHAT EVENTS ------------------
  socket.on('chat:send', async ({ toUserId, message, tempId }, cb) => {
    try {
      const fromUserId = socket.user?.userId;
      if (!fromUserId || !toUserId) {
        const err = new Error("Missing user id");
        if (typeof cb === 'function') cb({ ok: false, error: err.message });
        socket.emit('chat:error', { error: err.message });
        return;
      }
      const data = await ChatService.createMessage({
        fromUserId,
        toUserId,
        body: message,
      });

      const payload = { ...data, tempId };
      if (fromUserId) io.to(`user:${fromUserId}`).emit('chat:new', payload);
      if (toUserId) io.to(`user:${toUserId}`).emit('chat:new', payload);
      if (typeof cb === 'function') cb({ ok: true, data: payload });
    } catch (err) {
      console.error('chat:send error', err);
      if (typeof cb === 'function') cb({ ok: false, error: err.message });
      socket.emit('chat:error', { error: err.message });
    }
  });

  socket.on('chat:read', async ({ partnerId }, cb) => {
    try {
      const readerId = socket.user?.userId;
      const updated = await ChatService.markRead({
        userId: readerId,
        partnerId,
      });
      if (typeof cb === 'function') cb({ ok: true, updated });
      if (readerId && partnerId) {
        io.to(`user:${partnerId}`).emit('chat:read', {
          partnerId: readerId,
          updated,
        });
      }
    } catch (err) {
      console.error('chat:read error', err);
      if (typeof cb === 'function') cb({ ok: false, error: err.message });
      socket.emit('chat:error', { error: err.message });
    }
  });
})();
socket.on("fetchHeadlines", async (opts = {}, cb) => {
  try {
    console.lo("FETCH HEADLINES CALLED");
    const now = Date.now();
    const conditions = {
      type: "Headline",
      startDate: { $lte: now },
      endDate: { $gte: now },
    };

    let query = notificationSetting
      .find(conditions)
      .sort({ createdAt: -1 });

    if (opts.limit) {
      query = query.limit(Number(opts.limit));
    }

    const results = await query.lean();

    // ✅ FIX: Use explicit type check instead of optional chaining
    if (typeof cb === 'function') {
      cb({ ok: true, headlines: results });
    } else {
      // Fallback for when callback isn't available
      socket.emit('headlines-list', { ok: true, headlines: results });
    }
  } catch (err) {
    console.error("fetchHeadlines error", err);
    if (typeof cb === 'function') {
      cb({ ok: false, error: err.message });
    } else {
      socket.emit('headlines-error', { error: err.message });
    }
  }
});
// 2) Client requests all notifications (socket-only fetch)
socket.on('fetchNotifications', async (opts = {}, cb) => {
  // opts: { filter: 'all'|'unread'|'latest', limit: 20 }
  try {
    const userId = socket.user?.userId;
    const accountType = socket.user?.accountType;
    const parentIds = socket.user?.parentIds || [];
    const now = Date.now();
    const baseConditions = {
      startDate: { $lte: now },
      endDate: { $gte: now },
      $or: [
        { userType: 'User Wise', selectedUser: 'All' },
        { userType: 'User Wise', selectedUser: userId },
        { userType: 'User Wise', selectedUser: { $in: [userId] } },
        { userType: 'User Type Wise', selectedUserType: accountType },
        { isParentShow: true, parentIds: { $in: parentIds } },
      ],
    };
    let query = Notification.find(baseConditions).sort({ createdAt: -1 });
    if (opts.filter === 'unread' && userId) {
      query = query.where('isReadBy').ne(userId);
    }
    if (opts.limit) query = query.limit(Number(opts.limit));
    const results = await query.lean();
    // respond via callback or event
    if (typeof cb === 'function') return cb({ ok: true, notifications: results });
    socket.emit('notifications-list', { type: opts.filter || 'all', notifications: results });
  } catch (err) {
    console.error('fetchNotifications error', err);
    if (typeof cb === 'function') return cb({ ok: false, error: err.message });
    socket.emit('notifications-error', { error: err.message });
  }
});
// 3) Mark notification(s) as read (socket-only)
socket.on('markAsRead', async ({ notifIds = [] }, cb) => {
  try {
    const userId = socket.user?.userId;
    if (!userId) {
      const err = 'unauthenticated';
      if (cb) return cb({ ok: false, error: err });
      return socket.emit('notifications-error', { error: err });
    }
    if (!Array.isArray(notifIds)) notifIds = [notifIds];
    await Notification.updateMany(
      { _id: { $in: notifIds } },
      { $addToSet: { isReadBy: userId } }
    );
    // Optionally inform other sockets of this same user to update UI
    socket.to(`user:${userId}`).emit('notifications-marked-read', { notifIds, userId });
    if (cb) return cb({ ok: true });
    socket.emit('markAsRead:ok');
  } catch (err) {
    console.error('markAsRead error', err);
    if (cb) return cb({ ok: false, error: err.message });
    socket.emit('notifications-error', { error: err.message });
  }
});
// (Optional) Client asks to subscribe to live notifications specifically
socket.on('subscribeNotifications', (cb) => {
  // join a room for live personal notifications - mostly redundant if JWT auto-joined
  const userId = socket.user?.userId;
  if (userId) {
    socket.join(`user:${userId}`);
  }
  cb && cb({ ok: true });
});

const saveOnlineHistory = async (data) => {
  try {
    await OnlineHistory.create(data);
  } catch (err) {
    console.log(err)
  }
}

redisSubscriber.on("message", (channel, message) => {
  if (channel === "notifications") {
    try {
      const parsed = JSON.parse(message);
      broadcastNotification(parsed);
    } catch (err) {
      console.error("Error parsing notification message:", err);
    }
  }
});


// channel name: "notifications"
redisSubscriber.subscribe("notifications", (err, count) => {
  if (err) {
    console.error(
      "Failed to subscribe to notifications channel:",
      err.message
    );
  } else {
  }
});

redisSubscriber.on("message", (channel, message) => {
  if (channel !== "notifications") return;

  try {
    const parsed = JSON.parse(message);
    broadcastNotification(parsed);
  } catch (err) {
    console.error("Error parsing notification message:", err);
  }
});

/**
 * payload shape expected:
 * {
 *   type: 'ADD' | 'DELETE',
 *   data: <notificationObject>,  // for ADD
 *   id: '<notificationId>'       // for DELETE
 * }
 */
function broadcastNotification(payload) {
  const { type, data, id } = payload;
  const connectedSockets = io.sockets.sockets;

  for (const [socketId, socket] of connectedSockets) {
    if (!socket.user) continue;

    if (type === "DELETE") {
      // tell clients to delete this notification
      socket.emit("delete-notification", id);
    } else if (type === "ADD") {
      // only send if this user should see it
      if (shouldReceive(socket.user, data)) {
        socket.emit("new-notification", data);
      }
    }
  }
}

redisSubscriber.subscribe("notifications_all", (err, count) => {
  if (err) {
    console.error(
      "Failed to subscribe to notifications_all channel:",
      err.message
    );
  } else {
  }
});

redisSubscriber.on("message", (channel, message) => {
  try {
    const parsed = JSON.parse(message);

    // 1) Filtered notifications (your existing logic)
    if (channel === "notifications") {
      broadcastNotification(parsed);
      return;
    }

    // 2) Broadcast to *everyone* (new logic)
    if (channel === "notifications_all") {
      broadcastToAll(parsed);
      return;
    }
  } catch (err) {
    console.error("Error parsing notification message:", err);
  }
});

/**
 * Match logic similar to your GET /getUserNotification:
 * - type === 'Headline' -> all
 * - userType === 'User Wise' -> selectedUser / All
 * - userType === 'User Type Wise' -> selectedUserType === accountType
 * - isParentShow && parentIds contains user -> true
 * - date window with startDate/endDate
 */
function shouldReceive(user, notification) {
  try {
    const currentUserId = user.userId;
    const currentUserAccountType = user.accountType;
    const currentTime = Date.now();

    // optional date validity
    if (notification.startDate && notification.endDate) {
      if (
        notification.startDate > currentTime ||
        notification.endDate < currentTime
      )
        return false;
    }

    // Headlines go to everyone
    if (notification.type === "Headline") {
      return true;
    }

    // User wise
    if (notification.userType === "User Wise") {
      if (notification.selectedUser === "All") return true;
      return notification.selectedUser == currentUserId;
    }

    // User type wise
    if (notification.userType === "User Type Wise") {
      return notification.selectedUserType == currentUserAccountType;
    }

    // parent-based
    if (notification.isParentShow && notification.parentIds) {
      if (
        notification.parentIds.some(
          (pid) => pid.toString() == currentUserId
        )
      ) {
        return true;
      }
    }

    return false;
  } catch (e) {
    console.error("Error in shouldReceive:", e);
    return false;
  }
}


server.listen(5000, () => console.log('Server is running on port 5000'));