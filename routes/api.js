const router = require("express").Router();

// Paths are the contract the frontend's Next.js proxy calls
// (rebuzz-pos/app/api/settings/ai, lib/ai-insights/askAiService.server.ts).
router.use("/settings/ai", require("../api/business/aiSettings"));
router.use("/ai-insights", require("../api/business/aiInsights"));
// Period insights: own prefix, so the day-scoped route above keeps its exact
// contract for the sales forecast and the offer scheduler.
router.use("/period-insights", require("../api/business/periodInsights"));

module.exports = router;
