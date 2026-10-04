const express = require("express");
const router = express.Router();
const requireBusiness = require("../../middlewares/requireBusiness");
const { aiInsightsController } = require("../../controller/aiInsightsController");

/**
 * The hourly limiter and `GET /quota` are gone.
 *
 * The limiter was a cost guard for a page that generated on every visit. That
 * page now reads stored answers instead, and the one thing worth guarding —
 * paying twice for the same generation — is handled by the in-flight lock in
 * `helpers/inFlight.js`, which serves the second caller the same answer rather
 * than refusing it.
 *
 * `/quota` went with it: it only ever reported this limiter's buckets, so with
 * no limiter there is nothing for it to report. A provider's own limits are
 * reported where they happen, on the failure itself, with `detail` and
 * `retryAfter`.
 */
router.post(
  "/",
  requireBusiness,
  aiInsightsController.prepare,
  aiInsightsController.serveCached,
  aiInsightsController.generate,
);

module.exports = router;
