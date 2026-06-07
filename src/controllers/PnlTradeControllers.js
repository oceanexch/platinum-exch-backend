const PnlTrade = require("../models/PnlTradeModel");
const mongoose = require("mongoose");

exports.savePnlTrade = async (req, res) => {
  try {
    const { userId, price, profit_loss, timestamp } = req.body;

    if (!userId || profit_loss === undefined) {
      return res.status(400).json({ status: false, message: "Missing required fields" });
    }

    const newPnlData = new PnlTrade({
      userId,
      price: price || 0,
      profit_loss,
      timestamp: timestamp ? new Date(timestamp) : new Date(),
    });

    await newPnlData.save();

    res.status(200).json({ status: true, message: "P&L data saved successfully" });
  } catch (error) {
    console.error("savePnlTrade error:", error);
    res.status(500).json({ status: false, message: "Internal Server Error" });
  }
};

exports.getPnlHistory = async (req, res) => {
  try {
    const { userId, interval } = req.query; // interval in minutes: 1, 5, 15, 60, 1440

    if (!userId) {
      return res.status(400).json({ status: false, message: "userId is required" });
    }

    const intervalMin = parseInt(interval) || 1;
    const intervalMs = intervalMin * 60 * 1000;

    const data = await PnlTrade.find({ userId })
      .sort({ timestamp: 1 })
      .lean();

    if (!data.length) {
      return res.status(200).json({ status: true, data: [] });
    }

    // Convert to Candlestick format
    const candlesticks = [];
    let currentBucket = null;

    data.forEach((item) => {
      const time = new Date(item.timestamp).getTime();
      const bucketTime = Math.floor(time / intervalMs) * intervalMs;
      const val = item.profit_loss;

      if (!currentBucket || bucketTime !== currentBucket.time) {
        if (currentBucket) {
          candlesticks.push(currentBucket);
        }
        const bDate = new Date(bucketTime);
        currentBucket = {
          time: bucketTime,
          open: val,
          high: val,
          low: val,
          close: val,
          timestamp: bDate.toISOString(),
          displayTime: bDate.getHours().toString().padStart(2, '0') + ':' + bDate.getMinutes().toString().padStart(2, '0')
        };
      } else {
        currentBucket.high = Math.max(currentBucket.high, val);
        currentBucket.low = Math.min(currentBucket.low, val);
        currentBucket.close = val;
      }
    });

    if (currentBucket) {
      candlesticks.push(currentBucket);
    }

    res.status(200).json({ status: true, data: candlesticks });
  } catch (error) {
    console.error("getPnlHistory error:", error);
    res.status(500).json({ status: false, message: "Internal Server Error" });
  }
};

exports.getPnlTrend = async (req, res) => {
  try {
    const { userId } = req.query;

    if (!userId) {
      return res.status(400).json({ status: false, message: "userId is required" });
    }

    // Cumulative P&L over time (raw snapshots)
    const data = await PnlTrade.find({ userId })
      .sort({ timestamp: 1 })
      .select("profit_loss timestamp")
      .lean();

    const trend = data.map((item) => ({
      x: new Date(item.timestamp).getTime(),
      y: item.profit_loss,
    }));

    res.status(200).json({ status: true, data: trend });
  } catch (error) {
    console.error("getPnlTrend error:", error);
    res.status(500).json({ status: false, message: "Internal Server Error" });
  }
};
