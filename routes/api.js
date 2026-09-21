const router = require("express").Router();

// Paths are the contract the frontend's Next.js proxy calls
// (rebuzz-pos/app/api/settings/ai, lib/ai-insights/askAiService.server.ts).
router.use("/settings/ai", require("../api/business/aiSettings"));
router.use("/ai-insights", require("../api/business/aiInsights"));

module.exports = router;
