const express = require("express");
const router = express.Router();
const requireBusiness = require("../../middlewares/requireBusiness");
const {
  aiInsightsController,
} = require("../../controller/aiInsightsController");
const requireAdmin = require("../../middlewares/requireAdmin");

router.get("/overview", requireBusiness, aiInsightsController.getOverviewCache);

router.post(
  "/",
  requireBusiness,
  requireAdmin,
  aiInsightsController.prepare,
  aiInsightsController.serveCached,
  aiInsightsController.generate,
);

module.exports = router;
