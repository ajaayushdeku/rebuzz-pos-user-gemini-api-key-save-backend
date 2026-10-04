const express = require("express");
const router = express.Router();

const requireBusiness = require("../../middlewares/requireBusiness");
const requireAdmin = require("../../middlewares/requireAdmin");
const {
  periodInsightsController: controller,
} = require("../../controller/periodInsightsController");

/**
 * Insights about completed analytics periods.
 *
 * Mounted beside the day-scoped `/ai-insights`, which is left exactly as it was:
 * the sales forecast and the offer scheduler still use it, and they really are
 * about current data.
 *
 * The split that matters here is read against write. Reading stored insights
 * costs nothing, so any staff member may; generating spends the merchant's
 * provider quota, so only the business's admin may — which is what `requireAdmin`
 * is doing on the one route that can reach a provider.
 *
 * No rate limiter. It was an hourly quota on a page that now mostly reads from
 * storage; the duplicate-spend problem it was really solving is handled by the
 * in-flight lock in the controller, which also serves the second caller the same
 * answer instead of refusing it.
 */

/** Which periods exist, and which already have insights. */
router.get("/periods", requireBusiness, controller.listPeriods);

/**
 * Everything stored for one period — the AI Insights page's whole read.
 *
 * `latest` as the id means the most recent completed period, so the caller does
 * not have to reimplement the calendar to ask for the default.
 */
router.get("/:kind/:id", requireBusiness, controller.resolvePeriod, controller.readPeriod);

/**
 * Generate one section for one period: `ensure`, `regenerate` or `more`.
 *
 * `ensure` is the only one a page sends on its own, and it is a no-op when the
 * answer already exists — which is the normal case for a closed period.
 */
router.post(
  "/:kind/:id/:section",
  requireBusiness,
  requireAdmin,
  controller.resolvePeriod,
  controller.prepare,
  controller.generate,
);

module.exports = router;
