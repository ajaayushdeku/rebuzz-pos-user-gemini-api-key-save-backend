const express = require("express");
const router = express.Router();
const requireBusiness = require("../../middlewares/requireBusiness");
const { verifyRateLimit } = require("../../middlewares/aiRateLimit");
const { aiSettingsController } = require("../../controller/aiSettingsController");

/**
 * One budget for every live call these routes make to a provider.
 *
 * Created once and shared. Calling `verifyRateLimit()` separately on each route
 * built an independent bucket per route, so a business had ten checks a minute
 * on /test, another ten on /models, and no limit at all on save — which is the
 * button a double-click actually lands on.
 */
const verifyGuard = verifyRateLimit();

/**
 * PATCH only reaches the provider when it changes the model or provider;
 * toggling `enabled` is a database write and should not spend the budget.
 */
const guardModelChange = (req, res, next) =>
  (typeof req.body?.model === "string" && req.body.model.trim()) ||
  typeof req.body?.provider === "string"
    ? verifyGuard(req, res, next)
    : next();

// Every route below is scoped to one business. No exceptions.
router.get("/", requireBusiness, aiSettingsController.getSettings);
router.post("/", requireBusiness, verifyGuard, aiSettingsController.saveKey);
router.patch(
  "/",
  requireBusiness,
  guardModelChange,
  aiSettingsController.updateSettings,
);
router.delete("/", requireBusiness, aiSettingsController.deleteKey);
router.post("/test", requireBusiness, verifyGuard, aiSettingsController.testKey);
router.get(
  "/models",
  requireBusiness,
  verifyGuard,
  aiSettingsController.listModels,
);

module.exports = router;
