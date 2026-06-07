const mongoose = require("mongoose");
const CashLedger = require("../models/CashLedgerModel");
const JVLedger = require("../models/JVLedgerModel");
const Ledger = require("../models/LedgerModel");

// --- helper (use 'new' and validate) ---
function toObjectIdArray(ids = []) {
  return ids
    .map((i) => {
      if (!i) return null;
      if (i instanceof mongoose.Types.ObjectId) return i;
      const s = String(i).trim();
      if (mongoose.isValidObjectId(s)) return new mongoose.Types.ObjectId(s);
      return null;
    })
    .filter(Boolean);
}

/**
 * Compute net cash balance per user from CashLedger.
 * positive = net credit, negative = net debit
 * @param {String[]|ObjectId[]} ids
 * @returns [{ _id: ObjectId, amount: Number }]
 */
exports.computeCashBalances = async (ids) => {
  try {
    const objIds = toObjectIdArray(ids);
    if (!objIds.length) return [];
    const res = await CashLedger.aggregate([
      {
        $match: {
          userId: { $in: objIds }
        }
      },
      {
        $group: {
          _id: "$userId",

          // Total money in
          receipt: {
            $sum: {
              $cond: [
                { $eq: ["$transactionType", "RECEIPT"] },
                "$amount",
                0
              ]
            }
          },

          // Total money out
          payment: {
            $sum: {
              $cond: [
                { $eq: ["$transactionType", "PAYMENT"] },
                "$amount",
                0
              ]
            }
          }
        }
      },
      {
        $project: {
          _id: 1,
          receipt: 1,
          payment: 1,

          // Net wallet balance
          amount: { $subtract: ["$receipt", "$payment"] }
        }
      }
    ]);

   
    return res; // [{ _id: userId, amount: net }]
  } catch (err) {
    console.error("computeCashBalances err", err);
    throw err;
  }
};

/**
 * Compute net JV balance per user from JVLedger.
 * We consider credit (creditAccount) as positive, debit as negative (matching your getCombineLedger).
 */
exports.computeJVBalances = async (ids) => {
  try {
    const objIds = toObjectIdArray(ids);
    if (!objIds.length) return [];

    const jv = await JVLedger.aggregate([
      {
        $match: {
          $or: [{ debitAccount: { $in: objIds } }, { creditAccount: { $in: objIds } }],
        },
      },
      {
        $project: {
          // produce an array of possible txns per doc
          txns: {
            $concatArrays: [
              {
                $cond: [
                  { $in: ["$creditAccount", objIds] },
                  [{ user: "$creditAccount", typ: "CR", amount: "$amount" }],
                  [],
                ],
              },
              {
                $cond: [
                  { $in: ["$debitAccount", objIds] },
                  [{ user: "$debitAccount", typ: "DR", amount: "$amount" }],
                  [],
                ],
              },
            ],
          },
        },
      },
      { $unwind: "$txns" },
      {
        $group: {
          _id: "$txns.user",
          net: {
            $sum: {
              $cond: [{ $eq: ["$txns.typ", "CR"] }, "$txns.amount", { $multiply: ["$txns.amount", -1] }],
            },
          },
        },
      },
    ]);

    // normalize to same shape as cash result
    return jv.map((r) => ({ _id: r._id, amount: r.net }));
  } catch (err) {
    console.error("computeJVBalances err", err);
    throw err;
  }
};

/**
 * Optional: compute Ledger balances (if Ledger.amount is always positive or already signed)
 * We'll sum `amount` as-is (adjust if you need sign logic).
 */
exports.computeLedgerBalances = async (ids) => {
  try {
    const objIds = toObjectIdArray(ids);
    if (!objIds.length) return [];

    const res = await Ledger.aggregate([
      { $match: { userId: { $in: objIds } } },
      {
        $group: {
          _id: "$userId",
          amount: { $sum: "$amount" },
        },
      },
    ]);
    return res;
  } catch (err) {
    console.error("computeLedgerBalances err", err);
    throw err;
  }
};

/**
 * Given array of userIds, compute combined balance from cash + jv + ledger.
 * Returns map { userIdString: { cash: x, jv: y, ledger: z, balance: total } }
 */
exports.computeCombinedBalances = async (ids) => {
  // ensure unique ids
  const uniq = Array.from(new Set(ids.map((i) => i.toString())));

  // run in parallel
  const [cash, jv, ledger] = await Promise.all([
    this.computeCashBalances(uniq).catch(() => []),
    this.computeJVBalances(uniq).catch(() => []),
    this.computeLedgerBalances(uniq).catch(() => []),
  ]);

  const map = new Map();
  const setVal = (id, key, val) => {
    const sid = id.toString();
    const cur = map.get(sid) || { userId: sid, cash: 0, jv: 0, ledger: 0 };
    cur[key] = val;
    cur.balance = (cur.cash || 0) + (cur.jv || 0) + (cur.ledger || 0);
    map.set(sid, cur);
  };

  cash.forEach((r) => setVal(r._id, "cash", r.amount || 0));
  jv.forEach((r) => setVal(r._id, "jv", r.amount || 0));
  ledger.forEach((r) => setVal(r._id, "ledger", r.amount || 0));

  // ensure every requested id present in map
  uniq.forEach((id) => {
    if (!map.has(id)) map.set(id, { userId: id, cash: 0, jv: 0, ledger: 0, balance: 0 });
  });

  // return as array or Map; here array:
  return Array.from(map.values());
};
