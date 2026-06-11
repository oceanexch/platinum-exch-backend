const { getCachedM2MUsers, checkM2MLimitStatus, MARKET_GROUPS, calculateUserM2M, getM2MLimits } = require("./services/M2MService");
const UserPosition = require("./models/UserPositionModel");
const UserModel = require("./models/UserModel");
const { getActiveWeekValan } = require("./services/StockService");
const AutoSquareService = require("./services/AutoSquareService");
const { redisClient } = require("./config/redis");
const Squareoff = require("./models/SquareoffModel");
const { publishM2MEvent } = require("./services/RedisStockService");
const { getHolidayByFilter, getTimeByMarket } = require("./services/SettingService");
const moment = require("moment");

console.log("📂 [M2M-WATCHER] Module file loaded");
let isWatcherRunning = false;

// Cache the per-group "is the market tradeable now" decision so we don't hit the
// DB for holiday/time settings on every 2s cycle.
let activeGroupsCache = { ts: 0, data: null };

/**
 * Is a single marketId tradeable right now? (NOT on holiday AND within market hours)
 */
const isMarketIdActiveNow = async (marketId) => {
    const now = moment().valueOf();

    // Holiday check — a holiday row whose date range covers the current time
    const holiday = await getHolidayByFilter({
        marketId,
        startDate: { $lte: now },
        endDate: { $gte: now }
    });
    if (holiday) return false;

    // Market-hours check
    const t = await getTimeByMarket(marketId);
    if (!t) return true; // no setting at all → assume open
    const currentDate = moment().format("YYYY-MM-DD");
    const open = moment(`${currentDate} ${t.marketStartTime}`, "YYYY-MM-DD HH:mm:ss").valueOf();
    const close = moment(`${currentDate} ${t.marketEndTime}`, "YYYY-MM-DD HH:mm:ss").valueOf();
    return now >= open && now <= close;
};

/**
 * Returns { GROUP: bool } indicating whether each market group is active
 * (any of its markets open and not on holiday). When a group is inactive we
 * skip M2M square-off AND alert/notification for that group entirely.
 * Cached for 30s to limit DB load.
 */
const getActiveMarketGroups = async () => {
    if (activeGroupsCache.data && Date.now() - activeGroupsCache.ts < 30000) {
        return activeGroupsCache.data;
    }
    const active = {};
    for (const group of Object.keys(MARKET_GROUPS)) {
        let anyOpen = false;
        for (const marketId of MARKET_GROUPS[group]) {
            try {
                if (await isMarketIdActiveNow(marketId)) { anyOpen = true; break; }
            } catch (e) {
                // Treat lookup failure as closed for safety
            }
        }
        active[group] = anyOpen;
    }
    activeGroupsCache = { ts: Date.now(), data: active };
    return active;
};

/**
 * Handle M2M Alert Logic
 * Ensures alerts are only sent when threshold is first crossed,
 * and resets when it drops below threshold.
 */
const handleAlertsState = async (user, valan, status) => {
    const { userId, marketGroup, alertHit, isHit } = status;
    // CRITICAL: Use separate keys that StockService.js does NOT delete
    // StockService deletes: m2m_alert_state and m2m_breach_state
    // We use: m2m_watcher_lock (immune to StockService deletions)
    const stateKey = `m2m_watcher_lock:alert:${userId}:${marketGroup}`;
    const breachKey = `m2m_watcher_lock:breach:${userId}:${marketGroup}`;

    // Markers store the DATE they fired so each alert is sent ONCE PER DAY.
    // We deliberately do NOT delete them on recovery. Deleting on recovery was
    // the cause of constant upline alerts: an upline also appears in the Phase 1
    // self-cache, so Phase 1 (self m2m within limits) deleted the marker every
    // loop and Phase 2 (aggregated breach) re-set it → a fresh alert every cycle.
    // Markers reset only when (a) a new day starts, or (b) limits change
    // (resetM2MBreachState clears them), which re-enables fresh alerts.
    const today = new Date().toLocaleDateString("en-CA"); // YYYY-MM-DD, server tz

    let isNewBreach = false;
    let isNewThresholdAlert = false;

    // 1. Breach Check (100%) — fire once per day
    if (isHit) {
        const lastBreach = await redisClient.get(breachKey);
        if (lastBreach !== today) {
            isNewBreach = true;
            await redisClient.set(breachKey, today, "EX", 86400);
            // Mark threshold alert as sent too, so it doesn't fire redundantly today
            await redisClient.set(stateKey, today, "EX", 86400);
        }
    }

    // 2. Threshold Check (alert%) — fire once per day, only while not breached
    const lastState = await redisClient.get(stateKey);
    const alertedToday = lastState === today;

    if (alertHit && !alertedToday && !isHit) {
        isNewThresholdAlert = true;
        await redisClient.set(stateKey, today, "EX", 86400);
    }

    return { isNewBreach, isNewThresholdAlert };
};

/**
 * M2M Watcher Engine
 */
const runM2MWatcher = async () => {
    // console.log("[M2M-WATCHER] Checking loop health...");
    if (isWatcherRunning) return;
    isWatcherRunning = true;
    //     console.log("[M2M-WATCHER] >>> CYCLE STARTING <<<");

    try {
        const valan = await getActiveWeekValan();
        if (!valan) {
            console.warn("[M2M-WATCHER] Skipping cycle - No active week valan found");
            isWatcherRunning = false;
            return;
        }

        // Log valan once in a while or on change could be better, but for debugging let's log it
        //         console.log(`[M2M-WATCHER] Current Valan: ${valan.label || valan._id}`);

        const users = await getCachedM2MUsers();
        if (!users || users.length === 0) {
            //             console.log("[M2M-WATCHER] No users found with M2M limits configured.");
            isWatcherRunning = false;
            return;
        }

        //         console.log(`[M2M-WATCHER] Processing ${users.length} users...`);

        // Determine which market groups are tradeable right now. Groups whose
        // markets are closed or on holiday are skipped entirely below — no
        // square-off and no alert/notification fire for them.
        const activeGroups = await getActiveMarketGroups();

        // Map to track aggregated P&L for Uplines: { uplineId: { marketGroup: totalSharedPnL } }
        const uplinePnLMap = new Map();
        const processedClientIds = new Set();

        // Phase 1: Individual M2M Check & Upline Aggregation
        for (const user of users) {
            try {
                processedClientIds.add(user._id.toString());
                const groups = Object.keys(MARKET_GROUPS);

                for (const group of groups) {
                    // Skip closed / holiday market groups (no square-off, no alert)
                    if (!activeGroups[group]) continue;

                    const marketIds = MARKET_GROUPS[group];
                    const status = await checkM2MLimitStatus(
                        user._id,
                        valan._id,
                        marketIds,
                        user.accountDetails
                    );

                    // Debug Log for specific user (can be filtered by accountCode)
                    //                     if (status.m2m !== 0 || status.isHit || status.alertHit) {
                    //                         console.log(`[M2M-WATCHER] User: ${user.accountCode}, Group: ${group}, M2M: ${status.m2m}, Limits: L=${status.limits?.loss}/P=${status.limits?.profit}, Hit: ${status.isHit}, Alert: ${status.alertHit}`);
                    //                     }

                    // 1. Accumulate RAW M2M for Uplines
                    // We store the RAW total (not weighted by admin's partnership %).
                    // In Phase 2, we multiply by the direct parent's partnership %
                    // so the limit is checked against the CREATOR'S personal exposure.
                    // e.g. creator has 1% in admin → alert fires when admin total = -10L
                    // (creator's 1% = -10k = 10% of 1L limit)
                    if (user.parentIds && user.parentIds.length > 0) {
                        for (const parentId of user.parentIds) {
                            const pid = parentId.toString();
                            if (!uplinePnLMap.has(pid)) uplinePnLMap.set(pid, {});
                            const pg = uplinePnLMap.get(pid);
                            pg[group] = (pg[group] || 0) + (status.m2m || 0);
                        }
                    }

                    // 2. Individual Limit Enforcement
                    // IMPORTANT: Call handleAlertsState on EVERY cycle, not just when breached.
                    // This ensures that when M2M recovers (e.g. -1L back to -8k), the breach
                    // lock is deleted immediately so the user can trade again.
                    const { isNewBreach, isNewThresholdAlert } = await handleAlertsState(
                        user, valan, { ...status, userId: user._id, marketGroup: group }
                    );

                    if (status.isHit || status.alertHit) {
                        if (isNewBreach) {
                            await Squareoff.create({
                                label: `M2M ${status.type === 'loss' ? 'Loss' : 'Profit'} Breach - ${group}`,
                                valanId: valan._id,
                                accountCode: user.accountCode,
                                accountName: user.accountName,
                                userId: user._id,
                                m2m: status.m2m,
                                ledgerAmount: 0,
                                alertPercent: 100,
                                type: status.type === 'loss' ? "LOSS" : "PROFIT",
                                maxLoss: status.limits.loss,
                                squaredOff: !!status.autoSquare,
                                parentIds: user.parentIds || []
                            });

                            //                             console.log(`[M2M-WATCHER] !!! BREACH RECORDED !!! User: ${user.accountCode}, Type: ${status.type}, M2M: ${status.m2m}, AutoSquare: ${status.autoSquare}`);

                            await cancelPendingOrdersInGroups(user._id, [group]);
                            if (status.autoSquare) {
                                await AutoSquareService.executeAutoSquareOff(user._id, valan._id, group, status.type);
                            }

                            publishM2MEvent({
                                userId: user._id,
                                parentIds: user.parentIds,
                                type: "M2M_ALERT",
                                data: {
                                    type: "ALERT",
                                    accountCode: user.accountCode,
                                    accountName: user.accountName,
                                    m2m: status.m2m,
                                    marketGroup: group,
                                    squaredOff: !!status.autoSquare,
                                    percentage: 100,
                                    side: status.type === 'loss' ? 'LOSS' : 'PROFIT',
                                    message: status.message + (status.autoSquare ? " (Auto squared off)" : "")
                                }
                            });
                        } else if (status.isHit) {
                            await cancelPendingOrdersInGroups(user._id, [group]);
                            if (status.autoSquare) {
                                await AutoSquareService.executeAutoSquareOff(user._id, valan._id, group, status.type);
                            }
                        } else if (isNewThresholdAlert) {
                            await Squareoff.create({
                                label: `M2M Alert - ${group}`,
                                valanId: valan._id,
                                userId: user._id,
                                m2m: status.m2m,
                                ledgerAmount: 0,
                                alertPercent: status.limits.alertPercent,
                                type: "ALERT",
                                maxLoss: status.limits.loss,
                                squaredOff: false,
                                parentIds: user.parentIds || []
                            });

                            publishM2MEvent({
                                userId: user._id,
                                parentIds: user.parentIds,
                                type: "M2M_ALERT",
                                data: {
                                    type: "ALERT",
                                    accountCode: user.accountCode,
                                    accountName: user.accountName,
                                    m2m: status.m2m,
                                    marketGroup: group,
                                    squaredOff: false,
                                    alertPercent: status.limits.alertPercent,
                                    percentage: (Math.abs(status.m2m) / (status.m2m < 0 ? status.limits.loss || 1 : status.limits.profit || 1)) * 100,
                                    side: status.m2m < 0 ? 'LOSS' : 'PROFIT',
                                    message: `M2M Alert: Your ${status.m2m < 0 ? 'loss' : 'profit'} has reached ${status.limits.alertPercent}% of your limit.`
                                }
                            });
                        }
                    }
                }
            } catch (userError) {
                console.error(`[M2M-WATCHER] Error processing user ${user._id}:`, userError);
            }
        }

        // ─────────────────────────────────────────────────────────────────────
        // Phase 1.5: Accumulate M2M for ALL active position holders to uplines
        // The m2mUserCache ONLY contains users with their own M2M limits set.
        // Regular clients (no personal limit) are NOT in the cache, so their
        // P&L was never flowing up to their broker/upline. This phase fixes that.
        // ─────────────────────────────────────────────────────────────────────
        try {
            const allPositionUserIds = await UserPosition.distinct("userId", { valanId: valan._id });
            const unprocessedIds = allPositionUserIds
                .map(id => id.toString())
                .filter(id => !processedClientIds.has(id));

            if (unprocessedIds.length > 0) {
                //                 console.log(`[M2M-WATCHER] Phase 1.5: Accumulating M2M for ${unprocessedIds.length} additional active users to uplines...`);

                const activeDownlines = await UserModel.find({
                    _id: { $in: unprocessedIds },
                    parentIds: { $exists: true, $not: { $size: 0 } },
                    isDeleted: false,
                    status: true
                }).select({ _id: 1, accountCode: 1, parentIds: 1, partnership: 1 }).lean();

                for (const user of activeDownlines) {
                    if (!user.parentIds?.length) continue;

                    for (const group of Object.keys(MARKET_GROUPS)) {
                        // Skip closed / holiday market groups
                        if (!activeGroups[group]) continue;

                        try {
                            const m2mData = await calculateUserM2M(user._id, valan._id, group);
                            const m2m = m2mData.totalM2M;

                            if (m2m === 0) continue;

                            // Store raw M2M (same as Phase 1 - Phase 2 applies creator's partnership %)
                            for (const parentId of user.parentIds) {
                                const pid = parentId.toString();
                                if (!uplinePnLMap.has(pid)) uplinePnLMap.set(pid, {});
                                const pg = uplinePnLMap.get(pid);
                                pg[group] = (pg[group] || 0) + m2m;
                            }
                        } catch (groupErr) {
                            // Non-fatal - skip this group for this user
                        }
                    }
                }
            }
        } catch (phase15Err) {
            console.error("[M2M-WATCHER] Phase 1.5 error (non-fatal):", phase15Err);
        }

        // Phase 2: Upline M2M Check
        // Fetch all Uplines who are in our uplinePnLMap (now populated from ALL downlines)
        if (uplinePnLMap.size > 0) {
            const uplines = await UserModel.find({
                _id: { $in: Array.from(uplinePnLMap.keys()) },
                isDeleted: false,
                status: true
            }).select({
                _id: 1,
                accountCode: 1,
                accountName: 1,
                accountDetails: 1,
                parentIds: 1,
                partnership: 1   // needed to compute direct parent's share
            }).lean();

            for (const upline of uplines) {
                const groupPnLs = uplinePnLMap.get(upline._id.toString());
                const groups = Object.keys(groupPnLs);

                for (const group of groups) {
                    // Skip closed / holiday market groups (no square-off, no alert)
                    if (!activeGroups[group]) continue;

                    const rawTotalM2M = groupPnLs[group];

                    // Get limits for this upline in this market group
                    const limits = getM2MLimits(upline.accountDetails, group);

                    if (!limits.loss && !limits.profit) continue;

                    // Compute the DIRECT PARENT'S personal exposure:
                    // directParentPartnership = the % the direct parent (creator) takes
                    // from this upline's total downline business.
                    // Stored at upline.partnership[ parentIds.length - 1 ] since parentIds
                    // are ordered level-1 → level-N and the last entry is the creator.
                    const directParentIdx = (upline.parentIds?.length || 1) - 1;
                    const directParentPartnership = upline.partnership?.[directParentIdx] ?? 100;

                    // effectivePnL = what the creator is actually exposed to
                    const effectivePnL = rawTotalM2M * (directParentPartnership / 100);

                    // Always log so we can trace upline evaluations
                    //                     console.log(`[M2M-UPLINE] ${upline.accountCode || upline._id}, Group: ${group}, RawTotal: ${rawTotalM2M?.toFixed(2)}, CreatorShare: ${directParentPartnership}%, EffectivePnL: ${effectivePnL?.toFixed(2)}, Limits: L=${limits.loss}/P=${limits.profit}, Alert%: ${limits.alertPercent}`);

                    // Replace sharedPnL with effectivePnL for all limit checks below
                    const sharedPnL = effectivePnL;

                    let hitType = null;
                    let isHit = false;
                    let alertHit = false;

                    if (limits.loss && sharedPnL <= -Math.abs(limits.loss)) {
                        isHit = true;
                        hitType = 'loss';
                    } else if (limits.profit && sharedPnL >= Math.abs(limits.profit)) {
                        isHit = true;
                        hitType = 'profit';
                    } else if (limits.alertPercent > 0) {
                        const threshold = (Math.abs(limits.loss || limits.profit || 0) * limits.alertPercent) / 100;
                        if (Math.abs(sharedPnL) >= threshold) {
                            alertHit = true;
                        }
                    }

                    if (isHit || alertHit) {
                        const status = {
                            userId: upline._id,
                            marketGroup: group,
                            m2m: sharedPnL,
                            limits,
                            isHit,
                            alertHit,
                            type: hitType,
                            autoSquare: upline.accountDetails?.m2m_square_off === 1
                        };

                        const { isNewBreach, isNewThresholdAlert } = await handleAlertsState(upline, valan, status);

                        if (isNewBreach) {
                            // 1. Block the Upline in Redis
                            await redisClient.set(`m2m_blocked:${upline._id}`, "true", "EX", 86400);

                            // 2. Record Breach
                            await Squareoff.create({
                                label: `Upline M2M ${hitType === 'loss' ? 'Loss' : 'Profit'} Breach - ${group}`,
                                valanId: valan._id,
                                accountCode: upline.accountCode,
                                accountName: upline.accountName,
                                userId: upline._id,
                                m2m: sharedPnL,
                                ledgerAmount: 0,
                                alertPercent: 100,
                                type: hitType === 'loss' ? "LOSS" : "PROFIT",
                                maxLoss: limits.loss,
                                squaredOff: status.autoSquare,
                                parentIds: upline.parentIds || []
                            });

                            // 3. Cancel all pending orders for downline
                            await cancelPendingOrdersForDownline(upline._id);

                            // 4. Square-off all downlines if enabled
                            if (status.autoSquare) {
                                await squareOffAllDownlines(upline._id, valan._id, group, hitType);
                            }

                            // 5. Notify
                            publishM2MEvent({
                                userId: upline._id,
                                parentIds: upline.parentIds,
                                type: "M2M_ALERT",
                                data: {
                                    type: "ALERT",
                                    accountCode: upline.accountCode,
                                    accountName: upline.accountName,
                                    m2m: sharedPnL,
                                    marketGroup: group,
                                    squaredOff: status.autoSquare,
                                    percentage: 100,
                                    side: hitType === 'loss' ? 'LOSS' : 'PROFIT',
                                    message: `Upline M2M ${hitType} limit reached: ₹${sharedPnL.toFixed(2)}. ${status.autoSquare ? "All downline positions squared off." : "Trade blocked."}`
                                }
                            });
                        } else if (isNewThresholdAlert) {
                            // Alert only
                            publishM2MEvent({
                                userId: upline._id,
                                parentIds: upline.parentIds,
                                type: "M2M_ALERT",
                                data: {
                                    type: "ALERT",
                                    accountCode: upline.accountCode,
                                    accountName: upline.accountName,
                                    m2m: sharedPnL,
                                    marketGroup: group,
                                    squaredOff: false,
                                    alertPercent: limits.alertPercent,
                                    percentage: (Math.abs(sharedPnL) / (sharedPnL < 0 ? limits.loss || 1 : limits.profit || 1)) * 100,
                                    side: sharedPnL < 0 ? 'LOSS' : 'PROFIT',
                                    message: `Upline M2M Alert: Your shared ${sharedPnL < 0 ? 'loss' : 'profit'} has reached ${limits.alertPercent}% of your limit.`
                                }
                            });
                        } else if (isHit && status.autoSquare) {
                            // Enforce square-off if already breached
                            await squareOffAllDownlines(upline._id, valan._id, group, hitType);
                        }
                    } else if (!isHit) {
                        // M2M has recovered back within limits (even if still in alert territory) 
                        // — clear the trading block so user can trade again.
                        const wasBlocked = await redisClient.del(`m2m_blocked:${upline._id}`);
                        //                         if (wasBlocked) {
                        //                             console.log(`[M2M-WATCHER] Upline ${upline.accountCode} M2M within limits. Trading block REMOVED.`);
                        //                         }
                    }
                }
            }
        }
    } catch (error) {
        console.error("❌ M2MWatcher engine error:", error);
    } finally {
        isWatcherRunning = false;
    }
};

/**
 * Initialize M2M Watcher
 */
const initM2MWatcher = (intervalMs = 2000) => {
    console.log(`🚀 [M2M-WATCHER] Initialized with ${intervalMs}ms interval`);
    // Use a controlled recursion instead of simple setInterval to prevent overlaps
    const scheduleNext = () => {
        runM2MWatcher().finally(() => {
            setTimeout(scheduleNext, intervalMs);
        });
    };
    scheduleNext();
};

/**
 * Cancel all PENDING orders for a user in specific market groups
 */
const cancelPendingOrdersInGroups = async (userId, groups) => {
    try {
        const StockTransaction = require("./models/StockTransactionModel");
        const marketIds = [];
        groups.forEach(g => {
            if (MARKET_GROUPS[g]) marketIds.push(...MARKET_GROUPS[g]);
        });

        const result = await StockTransaction.updateMany(
            {
                userId,
                marketId: { $in: marketIds },
                transactionStatus: "PENDING"
            },
            {
                $set: {
                    transactionStatus: "DELETED",
                    prevStatus: "PENDING",
                    message: "Cancelled due to M2M breach"
                }
            }
        );
        if (result.modifiedCount > 0) {
            //             console.log(`[M2M-WATCHER] Cancelled ${result.modifiedCount} pending orders for user ${userId}`);
        }
    } catch (error) {
        console.error(`[M2M-WATCHER] Error cancelling pending orders for user ${userId}:`, error);
    }
};

/**
 * Cancel all PENDING orders for all downlines of an Upline
 */
const cancelPendingOrdersForDownline = async (uplineId) => {
    try {
        const StockTransaction = require("./models/StockTransactionModel");
        const result = await StockTransaction.updateMany(
            {
                parentIds: uplineId,
                transactionStatus: "PENDING"
            },
            {
                $set: {
                    transactionStatus: "DELETED",
                    prevStatus: "PENDING",
                    message: "Cancelled due to Upline M2M breach"
                }
            }
        );
        if (result.modifiedCount > 0) {
            //             console.log(`[M2M-WATCHER] Cancelled ${result.modifiedCount} pending orders for downline of ${uplineId}`);
        }
    } catch (error) {
        console.error(`[M2M-WATCHER] Error cancelling downline orders for ${uplineId}:`, error);
    }
};

/**
 * Square off all downline positions for an Upline in a specific group
 */
const squareOffAllDownlines = async (uplineId, valanId, group, reason) => {
    try {
        const UserPosition = require("./models/UserPositionModel");
        const marketIds = MARKET_GROUPS[group];

        // Find all users who have positions in these markets and have this upline as a parent
        const activeUsers = await UserPosition.distinct("userId", {
            valanId,
            marketId: { $in: marketIds },
            parentIds: uplineId
        });

        if (!activeUsers || activeUsers.length === 0) return;

        //         console.log(`[M2M-WATCHER] Squaring off ${activeUsers.length} downline users for Upline ${uplineId} in ${group}`);

        for (const userId of activeUsers) {
            await AutoSquareService.executeAutoSquareOff(userId, valanId, group, `Upline ${reason}`);
        }
    } catch (error) {
        console.error(`[M2M-WATCHER] Error in squareOffAllDownlines for ${uplineId}:`, error);
    }
};

module.exports = {
    initM2MWatcher,
    runM2MWatcher
};
