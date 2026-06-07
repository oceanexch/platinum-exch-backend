require('dotenv').config();
const mongoose = require('mongoose');
const connectDB = require('../config/database');
const WeekValanModel = require('../models/WeekValanModel');
const userModel = require('../models/UserModel');
const FinalBillModel = require('../models/FinalBillModel');
const StockService = require('../services/StockService');

/**
 * Script to generate Final Bills for ALL non-deleted, non-demo users.
 * This runs for the current active Valan across all its segments (markets).
 */
async function generateAllFinalBills() {
    try {
        console.log("--------------------------------------------------");
        console.log("Final Bill Generator: starting for past Valans.");
        console.log("--------------------------------------------------");

        // 1. Connect to Database
        await connectDB();

        // 2. Identify the Super Admin (Level 1)
        const UserTypeModel = require('../models/UserTypeModel');
        const superAdminType = await UserTypeModel.findOne({ level: 1 }).lean();
        const superAdmin = await userModel.findOne({ accountType: superAdminType._id }).lean();

        if (!superAdmin) {
            console.error("❌ ERROR: No Super Admin (Level 1) found.");
            process.exit(1);
        }
        const superAdminId = superAdmin._id.toString();

        // 3. Fetch all Valans, sorted by start date
        const allValans = await WeekValanModel.find({}).sort({ startDate: 1 }).lean();

        if (allValans.length === 0) {
            console.error("❌ ERROR: No Valans found in database.");
            process.exit(1);
        }

        // 4. Process Valans (excluding the active one)
        for (const valan of allValans) {
            if (valan.status === true) {
                console.log(`⏩ Skipping current ACTIVE Valan: ${valan.label} (${valan._id})`);
                continue;
            }

            console.log(`\n==================================================`);
            console.log(`📂 Processing Valan: ${valan.label} (${valan._id})`);
            console.log(`==================================================`);

            const markets = valan.segment || [];
            for (const mkt of markets) {
                const marketId = String(mkt.id);
                console.log(`🔹 Running bill generation for Market: ${mkt.name} (ID: ${marketId})`);
                await StockService.generateFinalBills(valan._id, marketId, { force: true });
            }

            // 5. Tabular Summary: All Direct Clients of Super Admin
            console.log(`\n📊 BILLED SUMMARY: All Direct Clients of ${superAdmin.accountName} - ${valan.label}`);

            // A. Identify all users who are direct children of the Super Admin.
            // These would have only the Super Admin as a parent or were explicitly created by him.
            const directClients = await userModel.find({
                $or: [
                    { parentIds: { $size: 1, $eq: new mongoose.Types.ObjectId(superAdminId) } },
                    { "createdBy.userId": new mongoose.Types.ObjectId(superAdminId) }
                ],
                isDeleted: false,
                demoid: { $ne: true }
            }).lean();

            if (directClients.length === 0) {
                console.log("   (No direct clients found with activity in this Valan)");
                continue;
            }

            const directClientIds = directClients.map(u => u._id.toString());
            const dcMap = new Map();
            directClients.forEach(u => {
                dcMap.set(u._id.toString(), {
                    accountCode: u.accountCode,
                    accountName: u.accountName,
                    gross: 0,
                    brokerage: 0,
                    bill: 0,
                    m2m: 0
                });
            });

            // B. Fetch ALL billed data for this valan
            const valanBills = await FinalBillModel.find({
                valanId: new mongoose.Types.ObjectId(valan._id)
            }).lean();

            if (valanBills.length === 0) {
                console.log("   (No billed data found for this Valan)");
                continue;
            }

            // C. Map each user to their highest-level Direct Child of the Super Admin
            const allUsers = await userModel.find({ isDeleted: false, demoid: { $ne: true } }).select('_id parentIds').lean();
            const userToDirectChild = new Map();

            allUsers.forEach(u => {
                let matchingDC = null;
                // If the user itself is a direct client, they are their own direct child (DC)
                if (directClientIds.includes(u._id.toString())) {
                    matchingDC = u._id.toString();
                } else if (u.parentIds && u.parentIds.length > 0) {
                    // Start checking from the highest levels (index 1 is the first child of L1)
                    for (let i = 1; i < u.parentIds.length; i++) {
                        const pid = u.parentIds[i].toString();
                        if (directClientIds.includes(pid)) {
                            matchingDC = pid;
                            break;
                        }
                    }
                }
                if (matchingDC) userToDirectChild.set(u._id.toString(), matchingDC);
            });

            // D. Aggregate branch bills under the respective direct client
            valanBills.forEach(bill => {
                const dcId = userToDirectChild.get(bill.userId.toString());
                if (dcId && dcMap.has(dcId)) {
                    const acc = dcMap.get(dcId);
                    acc.gross += (Number(bill.grossTotal) || 0);
                    acc.brokerage += (Number(bill.clientBrokerage) || 0);
                    acc.bill += (Number(bill.billAmount) || 0);
                    acc.m2m += (Number(bill.totalM2M) || 0);
                }
            });

            // E. Map to table and sort
            const tableData = Array.from(dcMap.values())
                .filter(row => row.gross !== 0 || row.brokerage !== 0 || row.bill !== 0 || row.m2m !== 0)
                .sort((a, b) => a.accountCode.localeCompare(b.accountCode))
                .map(row => ({
                    "Account Code": row.accountCode || "-",
                    "Account Name": row.accountName || "-",
                    "Gross Total": row.gross.toLocaleString('en-IN', { maximumFractionDigits: 2 }),
                    "Brokerage": row.brokerage.toLocaleString('en-IN', { maximumFractionDigits: 2 }),
                    "Bill Amount": row.bill.toLocaleString('en-IN', { maximumFractionDigits: 2 }),
                    "M2M": row.m2m.toLocaleString('en-IN', { maximumFractionDigits: 2 })
                }));

            if (tableData.length > 0) {
                console.table(tableData);
            } else {
                console.log("   (No direct clients had active branch trades for this Valan)");
            }
        }

        console.log("\n--------------------------------------------------");
        console.log("✅ SUCCESS: Past Valans billed and summarized.");
        console.log("--------------------------------------------------");
        process.exit(0);

    } catch (error) {
        console.error("\n❌ FATAL ERROR in generateAllFinalBills script:", error);
        process.exit(1);
    }
}

// Start the process
generateAllFinalBills();
