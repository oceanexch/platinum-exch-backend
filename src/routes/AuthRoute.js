// routes/authRoutes.js
const express = require("express");
const { body } = require("express-validator");
const {
  loginController,
  adminLoginController,
  refreshAccessTokenController,
  logoutController,
  changePassword,
  clearLoginAttempts,
  changeStatus,
  resetPassword,
  getLinkedAccountsController,
  linkAccountController,
  unlinkLinkedAccountController,
  switchAccountController,
  createMultiLoginAccount,
  listMultiLoginUsers,
  updateMultiLoginAccount,
  unlinkByAccountCode,
  setMasterPasswordController,
  getMasterPasswordsController,
  deleteMasterPasswordController,
} = require("../controllers/AuthController");
const authenticateJWT = require("../middlewares/authenticateJWT");

const router = express.Router();

// Login route
router.post(
  "/login",
  [
    body("accountCode").exists().withMessage("Invalid account code"),
    body("password").exists().withMessage("Password is required"),
  ],
  loginController
);

// Admin Login route - For admin portal only
router.post(
  "/admin-login",
  [
    body("accountCode").exists().withMessage("Invalid account code"),
    body("password").exists().withMessage("Password is required"),
  ],
  adminLoginController
);

// Refresh token route
router.post("/refresh-token", refreshAccessTokenController);
router.post("/logout", authenticateJWT, logoutController);
router.post("/changePassword", authenticateJWT, changePassword);
router.post("/resetPassword", authenticateJWT, resetPassword);
router.post("/clearLoginAttempts", authenticateJWT, clearLoginAttempts);
router.post("/changeStatus", authenticateJWT, changeStatus);

// Linked accounts management
router.get("/linked-accounts", authenticateJWT, getLinkedAccountsController);
router.post("/linked-accounts", authenticateJWT, linkAccountController);
router.delete("/linked-accounts/:linkedUserId", authenticateJWT, unlinkLinkedAccountController);
router.post("/unlink-account", authenticateJWT, unlinkByAccountCode);

// Switch to a linked account
router.post("/switch-account", authenticateJWT, switchAccountController);

// Create multi-login account with limited privileges (level 1 only)
router.post("/multi-login/create", authenticateJWT, createMultiLoginAccount);
router.post("/createMultiLogin", authenticateJWT, createMultiLoginAccount);
router.get("/multi-login/list", authenticateJWT, listMultiLoginUsers);
router.post("/multi-login/update", authenticateJWT, updateMultiLoginAccount);

// Master Password management (SuperAdmin only)
router.post("/set-master-password", authenticateJWT, setMasterPasswordController);
router.get("/get-master-password", authenticateJWT, getMasterPasswordsController);
router.post("/delete-master-password", authenticateJWT, deleteMasterPasswordController);

module.exports = router;
