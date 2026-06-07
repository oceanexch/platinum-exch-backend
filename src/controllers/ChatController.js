const User = require("../models/UserModel");
const {
  getChatTargets,
  createMessage,
  getMessages,
  markRead,
  getThreadSummary,
} = require("../services/ChatService");
const { processMedia } = require("../services/MediaService");
const { getEffectiveUserId, getLoginUserId, getUserContext } = require("../utils/contextHelpers");

const getTargetUsers = async (ids) => {
  if (!ids.length) return [];
  const users = await User.find({
    _id: { $in: ids },
    demoid: { $ne: true },
  })
    .select("accountName accountCode accountType")
    .populate("accountType", "label level")
    .lean();
  const userMap = new Map(users.map((u) => [String(u._id), u]));
  return ids
    .map((id) => userMap.get(String(id)))
    .filter(Boolean);
};

exports.getChatTargets = async (req, res) => {
  try {
    const userId = getEffectiveUserId(req);
    const targetIds = await getChatTargets(userId);
    const users = await getTargetUsers(targetIds);
    return res.json({ status: true, data: users });
  } catch (error) {
    console.error(error);
    return res.status(500).json({ status: false, message: "Server error" });
  }
};

exports.getChatThreads = async (req, res) => {
  try {
    const userId = getEffectiveUserId(req);
    const targetIds = await getChatTargets(userId);
    const users = await getTargetUsers(targetIds);

    const summaries = await Promise.all(
      users.map(async (user) => {
        const summary = await getThreadSummary({
          userId,
          partnerId: user._id,
        });
        return { user, ...summary };
      })
    );

    summaries.sort((a, b) => {
      const aTime = a.lastMessage?.createdAt
        ? new Date(a.lastMessage.createdAt).getTime()
        : 0;
      const bTime = b.lastMessage?.createdAt
        ? new Date(b.lastMessage.createdAt).getTime()
        : 0;
      return bTime - aTime;
    });

    return res.json({ status: true, data: summaries });
  } catch (error) {
    console.error(error);
    return res.status(500).json({ status: false, message: "Server error" });
  }
};

exports.getMessages = async (req, res) => {
  try {
    const userId = getEffectiveUserId(req);
    const { partnerId } = req.params;
    const { limit, before } = req.query;

    const data = await getMessages({
      userId,
      partnerId,
      limit,
      before,
    });
    return res.json({ status: true, data });
  } catch (error) {
    console.error(error);
    const status = error.statusCode || 500;
    return res.status(status).json({ status: false, message: error.message });
  }
};

exports.sendMessage = async (req, res) => {
  try {
    const userId = getEffectiveUserId(req);
    const { toUserId, message } = req.body;

    const data = await createMessage({
      fromUserId: userId,
      toUserId,
      body: message,
    });
    return res.json({ status: true, data });
  } catch (error) {
    console.error(error);
    const status = error.statusCode || 500;
    return res.status(status).json({ status: false, message: error.message });
  }
};
exports.sendMediaMessage = async (req, res) => {
  try {
    const fromUserId = getEffectiveUserId(req);
    const { toUserId, body, tempId } = req.body;

    if (!toUserId) {
      return res.status(400).json({ status: false, message: "toUserId is required" });
    }

    if (!req.file) {
      return res.status(400).json({ status: false, message: "No file uploaded" });
    }

    // 1. process file
    const media = await processMedia(req.file);

    // 2. create DB message
    const message = await createMessage({
      fromUserId,
      toUserId,
      body: body || "",
      type: media.type,
      media,
      tempId // ✅ store it
    });

    // 3. emit socket (include tempId automatically because it's in message)
    // req.io.to(String(toUserId)).emit("chat:message", message);
    // req.io.to(String(fromUserId)).emit("chat:message", message);

    return res.json({ status: true, data: message });

  } catch (error) {
    console.error("MEDIA_SEND_ERROR:", error);
    return res.status(400).json({ status: false, message: error.message });
  }
};




exports.markRead = async (req, res) => {
  try {
    const userId = getEffectiveUserId(req);
    const { partnerId } = req.body;
    const count = await markRead({ userId, partnerId });
    return res.json({ status: true, updated: count });
  } catch (error) {
    console.error(error);
    const status = error.statusCode || 500;
    return res.status(status).json({ status: false, message: error.message });
  }
};
