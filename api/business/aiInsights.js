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
 * What is left of the hour, without spending any of it.
 *
 * The settings screen shows the allowance before anything is generated, and
 * nothing else on the page would tell it — the headers below only ride along
 * with an insights request.
 */
router.get("/quota", requireBusiness, (req, res) => {
  res.json({ status: "success", data: quotaGuard.snapshot(req) });
});

/**
 * In order: report the allowance, refuse what costs nothing, answer from the
 * cache, then count against the hour. Only a request that gets past all of it
 * reaches the provider.
 *
 * `peek` runs before the cache so every answer carries the rate-limit headers,
 * including the cached ones that cost no quota at all.
 */
router.post(
  "/",
  requireBusiness,
  quotaGuard.peek,
  aiInsightsController.prepare,
  aiInsightsController.serveCached,
  quotaGuard,
  aiInsightsController.generate,
);

module.exports = router;
