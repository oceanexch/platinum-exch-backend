/**
 * Backfill user behavior analysis for all past closed valans.
 *
 * Usage:
 *   node scripts/backfillUserBehavior.js
 *   node scripts/backfillUserBehavior.js --valanId <id>          # single valan only
 *   node scripts/backfillUserBehavior.js --limit 4               # last N valans
 *   node scripts/backfillUserBehavior.js --userId <id>           # single user all valans
 *   node scripts/backfillUserBehavior.js --dryRun                # print counts, no writes
 *
 * Safe to re-run — all writes are upserts.
 */

require("dotenv").config();
const mongoose = require("mongoose");

const MONGO_URI = process.env.MONGODB_URI || process.env.MONGO_URI || process.env.DB_URL;
if (!MONGO_URI) {
  console.error("No MONGODB_URI / MONGO_URI / DB_URL in environment. Set it in .env");
  process.exit(1);
}

// ─── Parse CLI args ───────────────────────────────────────────────────────────
const args = process.argv.slice(2);
const getArg = (flag) => {
  const idx = args.indexOf(flag);
  return idx !== -1 ? args[idx + 1] : null;
};
const hasFlag = (flag) => args.includes(flag);

const TARGET_VALAN_ID = getArg("--valanId");
const TARGET_USER_ID = getArg("--userId");
const LIMIT = getArg("--limit") ? parseInt(getArg("--limit"), 10) : 0;
const DRY_RUN = hasFlag("--dryRun");
const BATCH_SIZE = 20;

// ─── Main ─────────────────────────────────────────────────────────────────────
async function main() {
  await mongoose.connect(MONGO_URI, { serverSelectionTimeoutMS: 15000 });
  console.log("[Backfill] Connected to MongoDB");

  const WeekValan = require("../src/models/WeekValanModel");
  const UserModel = require("../src/models/UserModel");
  const { computeAndStore } = require("../src/services/UserBehaviorService");

  // ── Resolve valans ──────────────────────────────────────────────────────────
  let valans;
  if (TARGET_VALAN_ID) {
    const v = await WeekValan.findById(TARGET_VALAN_ID).lean();
    if (!v) { console.error("Valan not found:", TARGET_VALAN_ID); process.exit(1); }
    valans = [v];
  } else {
    let query = WeekValan.find({ status: false }).sort({ endDate: -1 });
    if (LIMIT > 0) query = query.limit(LIMIT);
    valans = await query.lean();
  }

  if (!valans.length) {
    console.log("[Backfill] No closed valans found. Nothing to do.");
    await mongoose.disconnect();
    return;
  }

  console.log(`[Backfill] Valans to process: ${valans.length}`);
  valans.forEach((v) =>
    console.log(`  - ${v.keyidentifier} (${v._id}) | ${v.startDate?.toISOString?.() ?? v.startDate} → ${v.endDate?.toISOString?.() ?? v.endDate}`)
  );

  // ── Resolve users ───────────────────────────────────────────────────────────
  let users;
  if (TARGET_USER_ID) {
    const u = await UserModel.findById(TARGET_USER_ID, { _id: 1 }).lean();
    if (!u) { console.error("User not found:", TARGET_USER_ID); process.exit(1); }
    users = [u];
  } else {
    users = await UserModel.find(
      { isDeleted: { $ne: true }, demoid: { $ne: true } },
      { _id: 1 }
    ).lean();
  }

  console.log(`[Backfill] Users to process: ${users.length}`);
  if (DRY_RUN) {
    console.log("[Backfill] DRY RUN — no writes will happen");
    console.log(`[Backfill] Would process: ${valans.length} valans × ${users.length} users = ${valans.length * users.length} total records`);
    await mongoose.disconnect();
    return;
  }

  // ── Process each valan ──────────────────────────────────────────────────────
  let grandTotal = 0;
  let grandSucceeded = 0;

  for (const valan of valans) {
    console.log(`\n[Backfill] Starting valan: ${valan.keyidentifier}`);
    let valanSucceeded = 0;
    let valanProcessed = 0;

    for (let i = 0; i < users.length; i += BATCH_SIZE) {
      const batch = users.slice(i, i + BATCH_SIZE);
      const results = await Promise.all(
        batch.map((u) => computeAndStore(u._id, valan))
      );
      valanSucceeded += results.filter(Boolean).length;
      valanProcessed += batch.length;

      if (valanProcessed % 200 === 0 || valanProcessed === users.length) {
        process.stdout.write(
          `\r[Backfill] ${valan.keyidentifier}: ${valanProcessed}/${users.length} processed, ${valanSucceeded} succeeded`
        );
      }
    }

    grandTotal += valanProcessed;
    grandSucceeded += valanSucceeded;
    console.log(`\n[Backfill] Valan ${valan.keyidentifier} done. Succeeded: ${valanSucceeded}/${users.length}`);
  }

  console.log(`\n[Backfill] All done. Total: ${grandSucceeded}/${grandTotal} succeeded`);
  await mongoose.disconnect();
}

main().catch((err) => {
  console.error("[Backfill] Fatal error:", err);
  process.exit(1);
});
