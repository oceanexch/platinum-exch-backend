const express = require("express");
const router = express.Router();
const pnlTradeController = require("../controllers/PnlTradeControllers");
// Assuming there's an auth middleware

router.post("/save",  pnlTradeController.savePnlTrade);
router.get("/history",  pnlTradeController.getPnlHistory);
router.get("/pnl-trend",  pnlTradeController.getPnlTrend);

module.exports = router;
