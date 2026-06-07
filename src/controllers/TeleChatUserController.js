const TeleChatUserService = require("../services/TeleChatUserService");
const { hgetall } = require("../services/RedisService");
const { getLastSeen } = require("../services/UserService");

exports.addTeleChatUser = async (req, res) => {
  try {
    const { userId } = req.body;
    if (!userId) {
      return res.status(400).json({ status: false, message: "userId is required" });
    }

    await TeleChatUserService.addTeleChatUser(userId);
    res.status(200).json({ status: true, message: "User added to tele-chat successfully" });
  } catch (err) {
    console.error("addTeleChatUser error:", err);
    res.status(400).json({ status: false, message: err.message });
  }
};

exports.deleteTeleChatUser = async (req, res) => {
  try {
    const { userId } = req.body;
    if (!userId) {
      return res.status(400).json({ status: false, message: "userId is required" });
    }

    await TeleChatUserService.deleteTeleChatUser(userId);
    res.status(200).json({ status: true, message: "User removed from tele-chat successfully" });
  } catch (err) {
    console.error("deleteTeleChatUser error:", err);
    res.status(400).json({ status: false, message: err.message });
  }
};


exports.getTeleChatUsers = async (req, res) => {
  try {
    const data = await TeleChatUserService.getTeleChatUsers();

    // 🔹 fetch redis online status once
    const onlineStatusHash = (await hgetall("onlineStatus")) || {};

    let totalOnlineUsers = 0;
    let totalOfflineUsers = 0;

    const formattedData = (await Promise.all(
      data.map(async (item) => {
        const user = item.userId;
        if (!user) {
          return null; // Handle null user
        }
        const uId = String(user._id);
        // console.log("Online hash match :",onlineStatusHash[uId]);
        const isOnline =
          String(onlineStatusHash[uId] || "").toLowerCase() === "online";

        if (isOnline) totalOnlineUsers++;
        else totalOfflineUsers++;

        return {
          ...item,
          onlineStatus: isOnline ? "online" : "offline",
          isOnline,
          lastSeen: await getLastSeen(user._id, isOnline),
        };
      })
    )).filter(item => item !== null);

    res.status(200).json({
      status: true,
      data: formattedData,
      usermeta: {
        totalOnlineUsers,
        totalOfflineUsers,
      },
    });
  } catch (err) {
    console.error("getTeleChatUsers error:", err);
    res.status(500).json({ status: false, message: err.message });
  }
};
