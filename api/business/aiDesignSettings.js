
const express = require("express");
const router = express.Router();

const requireBusiness = require("../../middlewares/requireBusiness");
const { verifyRateLimit } = require("../../middlewares/aiRateLimit");

const {
  aiDesignSettingsController,
} = require("../../controller/aiDesignSettingsController");

// Independent verification budget for OpenAI credentials.
const verifyGuard = verifyRateLimit();

// Retrieve masked settings.
router.get(
  "/",
  requireBusiness,
  aiDesignSettingsController.getSettings,
);

// Save and verify a new key.
router.post(
  "/",
  requireBusiness,
  verifyGuard,
  aiDesignSettingsController.saveKey,
);

// Verify a supplied key or test the saved key.
router.post(
  "/verify",
  requireBusiness,
  verifyGuard,
  aiDesignSettingsController.verifyKey,
);

// Enable or disable image generation.
router.patch(
  "/",
  requireBusiness,
  aiDesignSettingsController.updateSettings,
);

// Remove the saved key.
router.delete(
  "/",
  requireBusiness,
  aiDesignSettingsController.deleteKey,
);

module.exports = router;
