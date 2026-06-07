const UserModel = require("../models/UserModel");
const WeekValan = require("../models/WeekValanModel");
const { computeAndStore } = require("../services/UserBehaviorService");

/**
 * Runs every Sunday: compute and store behavior analysis for all
 * non-deleted, non-demo users for the most recently closed valan.
 *
 * Processes users in batches to avoid memory pressure.
 */
const runUserBehaviorCron = async () => {
  console.log("[UserBehaviorCron] Started at", new Date().toISOString());

  // Find the most recently closed valan (status=false, ordered by endDate desc)
  const lastClosedValan = await WeekValan.findOne({ status: false })
    .sort({ endDate: -1 })
    .lean();

  if (!lastClosedValan) {
    console.log("[UserBehaviorCron] No closed valan found. Skipping.");
    return;
  }

  console.log(
    `[UserBehaviorCron] Analyzing valan: ${lastClosedValan.keyidentifier} (${lastClosedValan._id})`
  );

  // Fetch all eligible users — non-deleted, non-demo
  const users = await UserModel.find(
    { isDeleted: { $ne: true }, demoid: { $ne: true } },
    { _id: 1 }
  ).lean();

  console.log(`[UserBehaviorCron] Processing ${users.length} users`);

  const BATCH_SIZE = 20;
  let processed = 0;
  let succeeded = 0;

  for (let i = 0; i < users.length; i += BATCH_SIZE) {
    const batch = users.slice(i, i + BATCH_SIZE);
    const results = await Promise.all(
      batch.map((u) => computeAndStore(u._id, lastClosedValan))
    );
    succeeded += results.filter(Boolean).length;
    processed += batch.length;

    if (processed % 100 === 0) {
      console.log(`[UserBehaviorCron] Progress: ${processed}/${users.length}`);
    }
  }

  console.log(
    `[UserBehaviorCron] Completed. Succeeded: ${succeeded}/${users.length} at`,
    new Date().toISOString()
  );
};

module.exports = { runUserBehaviorCron };
