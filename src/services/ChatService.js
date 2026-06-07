const mongoose = require("mongoose");
const User = require("../models/UserModel");
const ChatMessage = require("../models/ChatMessageModel");

const normalizeId = (id) => {
  if (!id) return "";
  if (typeof id === "string") return id;
  if (typeof id === "number") return String(id);
  if (id._id) return String(id._id);
  if (id.id) return String(id.id);
  if (id.$oid) return String(id.$oid);
  return String(id);
};

const toObjectId = (id) => {
  try {
    const value = normalizeId(id);
    if (!value) return null;
    return new mongoose.Types.ObjectId(value);
  } catch (err) {
    return null;
  }
};

const buildIdVariants = (id) => {
  const variants = [];
  const idStr = normalizeId(id);
  if (idStr) variants.push(idStr);
  const objId = toObjectId(idStr);
  if (objId) variants.push(objId);
  return variants;
};

const conversationIdFor = (a, b) => {
  const aStr = normalizeId(a);
  const bStr = normalizeId(b);
  return [aStr, bStr].sort().join(":");
};

const assertDirectRelation = async (userId, otherId) => {
  const userIdStr = normalizeId(userId);
  const otherIdStr = normalizeId(otherId);
  const userObjId = toObjectId(userIdStr);
  const otherObjId = toObjectId(otherIdStr);

  if (!userIdStr || !otherIdStr || userIdStr === otherIdStr) {
    const err = new Error("Invalid chat target");
    err.statusCode = 400;
    throw err;
  }
  if (!userObjId || !otherObjId) {
    const err = new Error("Invalid user id");
    err.statusCode = 400;
    throw err;
  }

  const userIdVariants = buildIdVariants(userIdStr);
  const otherIdVariants = buildIdVariants(otherIdStr);

  const [isParent, isChild] = await Promise.all([
    User.exists({ _id: otherObjId, "createdBy.userId": { $in: userIdVariants } }),
    User.exists({ _id: userObjId, "createdBy.userId": { $in: otherIdVariants } }),
  ]);

  if (!isParent && !isChild) {
    const err = new Error("Chat allowed only with direct parent/child");
    err.statusCode = 403;
    throw err;
  }
};

const getDirectParentId = async (userId) => {
  const user = await User.findById(userId).select("createdBy").lean();
  const parentId = user?.createdBy?.userId;
  if (!parentId) return null;
  const parent = await User.findById(parentId).select("_id demoid").lean();
  if (!parent || parent.demoid) return null;
  return normalizeId(parent._id);
};

const getDirectChildrenIds = async (userId) => {
  const idVariants = buildIdVariants(userId);
  if (!idVariants.length) return [];
  const children = await User.find({
    "createdBy.userId": { $in: idVariants },
    demoid: { $ne: true },
  })
    .select("_id")
    .lean();
  return children.map((child) => normalizeId(child._id)).filter(Boolean);
};

const getChatTargets = async (userId) => {
  const [parentId, childrenIds] = await Promise.all([
    getDirectParentId(userId),
    getDirectChildrenIds(userId),
  ]);

  const ids = new Set();
  if (parentId) ids.add(parentId);
  (childrenIds || []).forEach((id) => ids.add(id));

  return Array.from(ids);
};


const createMessage = async ({
  fromUserId,
  toUserId,
  body,
  type = "text",
  media = null
}) => {

  if (type === "text") {
    const message = String(body || "").trim();
    if (!message) {
      const err = new Error("Message cannot be empty");
      err.statusCode = 400;
      throw err;
    }
    if (message.length > 2000) {
      const err = new Error("Message too long");
      err.statusCode = 400;
      throw err;
    }
  }

  const fromId = toObjectId(fromUserId);
  const toId = toObjectId(toUserId);
  if (!fromId || !toId) {
    const err = new Error("Invalid user id");
    err.statusCode = 400;
    throw err;
  }

  await assertDirectRelation(fromUserId, toUserId);

  const conversationId = conversationIdFor(fromUserId, toUserId);

  const doc = await ChatMessage.create({
    conversationId,
    from: fromId,
    to: toId,
    type,
    body: body || "",
    media
  });

  return doc.toObject();
};

const getMessages = async ({
  userId,
  partnerId,
  limit = 50,
  before,
}) => {
  await assertDirectRelation(userId, partnerId);
  const conversationId = conversationIdFor(userId, partnerId);

  const query = { conversationId };
  if (before) {
    const beforeDate = new Date(before);
    if (!Number.isNaN(beforeDate.getTime())) {
      query.createdAt = { $lt: beforeDate };
    }
  }

  const messages = await ChatMessage.find(query)
    .sort({ createdAt: -1 })
    .limit(Math.min(Number(limit) || 50, 200))
    .lean();

  return messages.reverse();
};

const markRead = async ({ userId, partnerId }) => {
  await assertDirectRelation(userId, partnerId);
  const result = await ChatMessage.updateMany(
    {
      from: toObjectId(partnerId),
      to: toObjectId(userId),
      readAt: null,
    },
    { $set: { readAt: new Date() } }
  );
  return result.modifiedCount || 0;
};

const getThreadSummary = async ({ userId, partnerId }) => {
  const conversationId = conversationIdFor(userId, partnerId);
  const [lastMessage, unreadCount] = await Promise.all([
    ChatMessage.findOne({ conversationId })
      .sort({ createdAt: -1 })
      .lean(),
    ChatMessage.countDocuments({
      conversationId,
      to: toObjectId(userId),
      readAt: null,
    }),
  ]);

  return { conversationId, lastMessage, unreadCount };
};

module.exports = {
  normalizeId,
  conversationIdFor,
  assertDirectRelation,
  getChatTargets,
  createMessage,
  getMessages,
  markRead,
  getThreadSummary,
};
