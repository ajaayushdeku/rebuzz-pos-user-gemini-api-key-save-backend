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
 * Ask the model for one section, and get the answer back without it being kept.
 *
 * Generating and storing are two routes because what a card finally shows is the
 * answer joined onto the period's own figures — the item name and the numbers
 * come from the data, the model supplies the advice against an anonymised
 * reference. Only the caller holds both halves, so only the caller can finish the
 * join, and what gets stored is the finished cards.
 *
 * The draft is cached for a day, so finishing the pair after a failure is free.
 */
router.post(
  "/:kind/:id/:section/draft",
  requireBusiness,
  requireAdmin,
  controller.resolvePeriod,
  controller.prepareDraft,
  controller.draft,
);

/**
 * Keep the finished cards: `ensure`, `regenerate` or `more`.
 *
 * Also the route for a period with no sales (`empty: true`), which stores the
 * fact without any provider being involved.
 */
router.post(
  "/:kind/:id/:section",
  requireBusiness,
  requireAdmin,
  controller.resolvePeriod,
  controller.save,
);

module.exports = router;
