const { getProfitLossReport } = require("./StockService");
const { updateReport, updateLedger } = require("./ProfitLossService");
const UserModel = require("../models/UserModel");
const ProfitLossModel = require("../models/ProfitLossReport");
const mongoose = require("mongoose");
const BrokerageRefreshModel = require("../models/BrokerageRefreshModel");

exports.getClientProfitLossReport = async (
  getValan,
  marketId,
  parentIds,
  brokerIds
) => {
  try {
    const match = {
      transactionStatus: "COMPLETED",
      valanId: getValan._id,
      marketId,
    };
    const response = await getProfitLossReport(match);

    response.forEach((doc) => {
      const brokerwiseNetBrokerage = {};
      doc.allOtherBrokerage.forEach((ob) => {
        for (const [key, val] of Object.entries(ob)) {
          if (
            key === "totalOrderBrokerage" ||
            key === "totalBrokerPercentage" ||
            key === "brockersBrokerage"
          )
            continue;
          const net = val?.netBrokerage || 0;
          const partnership = val?.partnership || 0;
          if (!brokerwiseNetBrokerage[key]) {
            brokerwiseNetBrokerage[key] = { brokerage: 0, myShare: 0 };
          }
          brokerwiseNetBrokerage[key].brokerage += net;
          if (brokerwiseNetBrokerage[key].myShare === 0) {
            brokerwiseNetBrokerage[key].myShare +=
              (doc.m2m * partnership * -1) / 100;
          }
        }
      });
      doc.otherBrokerShare = brokerwiseNetBrokerage;
      delete doc.allOtherBrokerage;
    });

    const newResponse = response.map((item) => ({
      ...item,
      valanId: getValan._id,
      valanName: getValan.label,
    }));

    const ledgerResponse = newResponse.map(
      ({
        parentIds,
        brokerIds,
        scriptId,
        scriptName,
        marketId,
        marketName,
        label,
        valanId,
        valanName,
        m2m,
        otherBrokerShare,
        userId,
      }) => ({
        parentIds,
        brokerIds,
        scriptId,
        scriptName,
        marketId,
        marketName,
        label,
        valanId,
        valanName,
        amount: m2m,
        uplineAmount: -m2m,
        downlineAmount: 0,
        otherBrokerShare,
        userId,
        transactionType: "BILL",
        level: 7,
      })
    );

    await updateReport(newResponse);
    await updateLedger(ledgerResponse);

    await generateMasterReport(getValan._id, marketId, parentIds);
    await generateBrokerReport(getValan._id, marketId, brokerIds);
    return;
  } catch (error) {
    console.error("Error in getClientProfitLossReport:", error);
    return;
  }
};

const generateMasterReport = async (valanId, marketId, parentIds) => {
  try {
    const reports = await ProfitLossModel.find({ valanId, marketId }).lean();
    if (reports.length == 0) {
      return;
    }

    const masters = await UserModel.find({ _id: { $in: parentIds } })
      .populate("accountType", "label level")
      .select({ accountName: 1, accountCode: 1, accountType: 1, parentIds: 1 })
      .lean();

    for (let master of masters) {
      const level = master.accountType.level;
      const getReport = reports.filter((rep) =>
        rep.parentIds.some((id) => areObjectIdsEqual(id, master._id))
      );
      const groupedData = getReport.reduce((acc, record) => {
        const {
          scriptId,
          scriptName,
          marketId,
          marketName,
          label,
          valanId,
          valanName,
          uplineM2M,
          otherBrokerShare,
        } = record;
        const value = uplineM2M[level - 1] || 0;
        if (!acc[marketId]) {
          acc[marketId] = {
            scriptId,
            scriptName,
            marketId,
            marketName,
            label,
            valanId,
            valanName,
            amount: 0,
            uplineAmount: 0,
            downlineAmount: 0,
            userId: master._id,
            transactionType: "BILL",
            level,
            parentIds: master.parentIds,
            otherBrokerShare: {},
            brokerIds: [],
          };
        }
        acc[marketId].amount += value;
        acc[marketId].uplineAmount += sumFirstN(uplineM2M, 0, level - 1);
        acc[marketId].downlineAmount += sumFirstN(
          uplineM2M,
          level,
          uplineM2M.length
        );
        for (let bkg in otherBrokerShare) {
          if (!acc[marketId].otherBrokerShare[bkg]) {
            acc[marketId].otherBrokerShare[bkg] = { brokerage: 0, myShare: 0 };
            acc[marketId].brokerIds.push(new mongoose.Types.ObjectId(bkg));
          }
          acc[marketId].otherBrokerShare[bkg].brokerage +=
            otherBrokerShare[bkg].brokerage;
          acc[marketId].otherBrokerShare[bkg].myShare +=
            otherBrokerShare[bkg].myShare;
        }
        acc[marketId].brokerIds = [...new Set(acc[marketId].brokerIds)];
        return acc;
      }, {});
      const ledger = Object.values(groupedData);
      await updateLedger(ledger);
    }
  } catch (error) {
    console.error("Error in generateMasterReport:", error);
  }
};

const generateBrokerReport = async (valanId, marketId, brokerIds) => {
  try {
    const reports = await ProfitLossModel.find({
      valanId,
      marketId,
      brokerIds: { $in: brokerIds },
    }).lean();
    if (reports.length == 0) {
      return;
    }

    const brokers = await UserModel.find({ _id: { $in: brokerIds } })
      .populate("accountType", "label level")
      .select({ accountName: 1, accountCode: 1, accountType: 1, parentIds: 1 })
      .lean();

    for (let broker of brokers) {
      const level = broker.accountType.level;
      const getReport = reports.filter((rep) =>
        rep.brokerIds.some((id) => areObjectIdsEqual(id, broker._id))
      );
      const groupedData = getReport.reduce((acc, record) => {
        const {
          scriptId,
          scriptName,
          marketId,
          marketName,
          label,
          valanId,
          valanName,
          uplineM2M,
          otherBrokerShare,
        } = record;
        const value = uplineM2M[level - 1] || 0;
        if (!acc[marketId]) {
          acc[marketId] = {
            scriptId,
            scriptName,
            marketId,
            marketName,
            label,
            valanId,
            valanName,
            amount: 0,
            uplineAmount: 0,
            downlineAmount: 0,
            userId: broker._id,
            transactionType: "BILL",
            level,
            parentIds: broker.parentIds,
            otherBrokerShare: {},
            brokerIds: [broker._id],
          };
        }
        if (otherBrokerShare[broker._id.toString()]) {
          acc[marketId].amount +=
            otherBrokerShare[broker._id.toString()].myShare;
        }
        acc[marketId].uplineAmount += sumFirstN(uplineM2M, 0, level - 1);
        acc[marketId].downlineAmount += sumFirstN(
          uplineM2M,
          level,
          uplineM2M.length
        );
        for (let bkg in otherBrokerShare) {
          if (bkg === broker._id.toString()) {
            if (!acc[marketId].otherBrokerShare[bkg]) {
              acc[marketId].otherBrokerShare[bkg] = {
                brokerage: 0,
                myShare: 0,
              };
              acc[marketId].brokerIds.push(new mongoose.Types.ObjectId(bkg));
            }
            acc[marketId].otherBrokerShare[bkg].brokerage +=
              otherBrokerShare[bkg].brokerage;
            acc[marketId].otherBrokerShare[bkg].myShare +=
              otherBrokerShare[bkg].myShare;
          }
        }
        return acc;
      }, {});
      const ledger = Object.values(groupedData);
      await updateLedger(ledger);
    }
  } catch (error) {
    console.error("Error in generateBrokerReport:", error);
  }
};

const areObjectIdsEqual = (id1, id2) => id1.toString() === id2.toString();

function sumFirstN(arr, start, end) {
  return arr.slice(start, end).reduce((acc, val) => acc + val, 0);
}

exports.getBrokerageRefresh = async (createdBy) => {
  try {
    return await BrokerageRefreshModel.find({ createdBy })
      .populate("userId", "accountName accountCode")
      .populate("createdBy", "accountName accountCode")
      .sort({ createdAt: -1 })
      .lean();
  } catch (error) {
    console.error("Error in fetching getBrokerageRefresh:", error);
    return;
  }
};
