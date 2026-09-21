const express = require("express");
const router = express.Router();
const requireBusiness = require("../../middlewares/requireBusiness");
const { insightsRateLimit } = require("../../middlewares/aiRateLimit");
const { aiInsightsController } = require("../../controller/aiInsightsController");

/**
 * One limiter for the route, created once. Built per request, every call would
 * get a fresh empty bucket and nothing would ever be limited. A refused
 * request is answered with the last insight there is, where there is one.
 */
const quotaGuard = insightsRateLimit((req, res) =>
  aiInsightsController.serveLastAnswer(req, res, "INSIGHTS_RATE_LIMIT"),
);

/**
 * In order: refuse what costs nothing, answer from the cache, then count
 * against the hour. Only a request that gets past all three reaches the
 * provider.
 */
router.post(
  "/",
  requireBusiness,
  aiInsightsController.prepare,
  aiInsightsController.serveCached,
  quotaGuard,
  aiInsightsController.generate,
);

module.exports = router;
