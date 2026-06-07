const express = require("express");
const router = express.Router();

const {
  getmarkets,
  getscripts,
  getexpiry,
  getstrike,
} = require("../controllers/ApiController");

router.get("/getmarkets", getmarkets);
router.get("/getscripts/:marketId", getscripts);
router.get("/getexpiry/:scriptId", getexpiry);
router.get("/getstrike", getstrike);

module.exports = router;
