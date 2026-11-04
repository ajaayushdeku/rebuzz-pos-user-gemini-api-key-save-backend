const express = require("express");
const router = express.Router();

const requireBusiness = require("../../middlewares/requireBusiness");
const { verifyRateLimit } = require("../../middlewares/aiRateLimit");

const {
  aiDesignSettingsController,
} = require("../../controller/aiDesignSettingsController");

// Independent verification rate limit for Cloudflare Workers AI credentials.
const verifyGuard = verifyRateLimit();

// Retrieve masked Cloudflare settings.
router.get("/", requireBusiness, aiDesignSettingsController.getSettings);

// Verify and save Cloudflare credentials.
router.post(
  "/",
  requireBusiness,
  verifyGuard,
  aiDesignSettingsController.saveKey,
);

// Verify supplied credentials or test the saved credentials.
router.post(
  "/verify",
  requireBusiness,
  verifyGuard,
  aiDesignSettingsController.verifyKey,
);

// Enable or disable Cloudflare AI.
router.patch("/", requireBusiness, aiDesignSettingsController.updateSettings);

// Remove saved Cloudflare credentials.
router.delete("/", requireBusiness, aiDesignSettingsController.deleteKey);

module.exports = router;
