const router = require("express").Router();

// Paths are the contract the frontend's Next.js proxy calls
// (rebuzz-pos/app/api/settings/ai, lib/ai-insights/askAiService.server.ts).
router.use("/settings/ai", require("../api/business/aiSettings"));
router.use("/ai-insights", require("../api/business/aiInsights"));

// Period insights.
router.use("/period-insights", require("../api/business/periodInsights"));

// Festival Prep offer completion.
router.use(
  "/festival-prep-actions",
  require("../api/business/festivalPrepActions"),
);

// Customer Retention Radar feedback.
router.use(
  "/customer-retention-feedback",
  require("../api/business/customerRetentionFeedback"),
);

router.use("/ai-design/settings", require("../api/business/aiDesignSettings"));
router.use("/ai-design", require("../api/business/aiDesign"));

module.exports = router;
