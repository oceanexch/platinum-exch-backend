const mongoose = require('mongoose');
require('dotenv').config();

const UserModel = require('../src/models/UserModel');
const FinalBillModel = require('../src/models/FinalBillModel');
const CashLedgerModel = require('../src/models/CashLedgerModel');
const JVLedgerModel = require('../src/models/JVLedgerModel');

// Simulate the getLedgers logic
async function simulateGetLedgers(parentId, clientId = null) {
  try {
    const parentIdStr = parentId.toString();
    
    // Get direct children
    const directChildren = await UserModel.find({
      'createdBy.userId': new mongoose.Types.ObjectId(parentId),
      isDeleted: false
    })
      .select('_id parentIds accountType accountCode accountName createdBy')
      .populate('accountType', 'level label')
      .lean();

    console.log(`\nParent ${parentIdStr} has ${directChildren.length} direct children`);

    const targetUsers = clientId
      ? directChildren.filter(c => c._id.toString() === clientId.toString())
      : directChildren;

    const monthStart = new Date('2026-04-01');
    const monthEnd = new Date('2026-04-30');

    for (const targetUser of targetUsers) {
      const tId = targetUser._id.toString();
      console.log(`\n--- ${targetUser.accountName} (${targetUser.accountCode}) - Level ${targetUser.accountType?.level} ---`);

      // Get bills created by this parent for this user
      const bills = await FinalBillModel.find({
        createdBy: new mongoose.Types.ObjectId(parentIdStr),
        userId: new mongoose.Types.ObjectId(tId),
        createdAt: { $gte: monthStart, $lte: monthEnd },
        marketId: '1'
      }).lean();

      console.log(`Found ${bills.length} bills`);

      let billTotal = 0;
      for (const bill of bills) {
        // Check if this user is the immediate parent of the bill owner
        const billOwner = await UserModel.findById(bill.userId).select('createdBy parentIds').lean();
        const isImmediateParent = billOwner?.createdBy?.userId?.toString() === parentIdStr;
        
        console.log(`  Bill totalM2M: ${bill.totalM2M}, isImmediateParent: ${isImmediateParent}`);
        
        if (isImmediateParent) {
          // Immediate parent sees FULL client M2M
          billTotal += Number(bill.totalM2M || 0);
          console.log(`    Using full M2M: ${bill.totalM2M}`);
        } else {
          // For non-immediate parents, use partnership share
          if (Array.isArray(bill.partnershipBreakdown)) {
            const parentShare = bill.partnershipBreakdown.find(
              pb => pb.userId && pb.userId.toString() === parentIdStr
            );
            if (parentShare) {
              billTotal += Number(parentShare.amount || 0);
              console.log(`    Using partnership share: ${parentShare.amount}`);
            }
          }
        }
      }

      console.log(`  Final billTotal for ledger: ${billTotal}`);
    }

  } catch (error) {
    console.error('Error:', error);
  }
}

async function testLedgerAPI() {
  try {
    await mongoose.connect(process.env.MONGODB_URI);
    console.log('Connected to MongoDB');

    // Test with JAYMADI's hierarchy
    // Find JAYMADI
    const jaymadi = await UserModel.findOne({ accountCode: '645324' }).select('_id createdBy parentIds').lean();
    
    if (jaymadi && jaymadi.createdBy?.userId) {
      console.log(`\n=== TESTING LEDGER API LOGIC ===`);
      console.log(`JAYMADI ID: ${jaymadi._id}`);
      console.log(`JAYMADI's immediate parent: ${jaymadi.createdBy.userId}`);
      
      // Test immediate parent's view
      await simulateGetLedgers(jaymadi.createdBy.userId, jaymadi._id);
      
      // Test higher level parent's view if exists
      if (jaymadi.parentIds && jaymadi.parentIds.length > 1) {
        const higherParent = jaymadi.parentIds[jaymadi.parentIds.length - 2];
        console.log(`\n=== HIGHER LEVEL PARENT VIEW ===`);
        await simulateGetLedgers(higherParent, jaymadi._id);
      }
    }

  } catch (error) {
    console.error('Error:', error);
  } finally {
    await mongoose.disconnect();
  }
}

testLedgerAPI();