const express = require("express");
const router = express.Router();
const {
  addScript,
  getUserScripts,
  removeScript,
  bulkRemoveScript,
  removeAllScript,
  addMultipleScript,
  getMarkets,
  getSquareOffList,
  getDataKeyByLabel,
  updateScriptData
} = require("../controllers/ScriptController");
const authenticateJWT = require("../middlewares/authenticateJWT");

router.get("/getMarkets", authenticateJWT, getMarkets);

router.post("/addScript", authenticateJWT, addScript);
router.post("/getUserScripts", authenticateJWT, getUserScripts);
router.put("/removeScript", authenticateJWT, removeScript);
router.post("/bulkRemoveScript", authenticateJWT, bulkRemoveScript);
router.put("/removeAllScript", authenticateJWT, removeAllScript);
router.post("/addMultipleScript", authenticateJWT, addMultipleScript);
router.get("/getSquareOffList", authenticateJWT, getSquareOffList);
router.post("/getDataKeyByLabel", authenticateJWT, getDataKeyByLabel);
router.post("/updateScriptData", authenticateJWT, updateScriptData);

module.exports = router;
