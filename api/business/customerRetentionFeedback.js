const express = require("express");
const router = express.Router();

const requireBusiness = require("../../middlewares/requireBusiness");
const requireAdmin = require("../../middlewares/requireAdmin");

const {
  periodInsightsController: periodController,
} = require("../../controller/periodInsightsController");

const controller = require("../../controller/customerRetentionFeedbackController");
/**
 * Business-wide feedback preferences.
 *
 * Reads approved/disapproved examples across every period
 * for the authenticated business.
 */
router.get(
  "/preferences",
  // JWT.sessionRequired,
  requireBusiness,
  controller.getPreferences,
);

/**
 * Business-wide feedback history.
 *
 * Retrieves approved/disapproved messages across all periods
 * with pagination and optional filters.
 */
router.get("/history", requireBusiness, controller.listFeedbackHistory);

/**
 * Feedback for one completed period.
 *
 * Used to restore the feedback state of individual messages.
 */
router.get(
  "/:kind/:id",
  // JWT.sessionRequired,
  requireBusiness,
  periodController.resolvePeriod,
  controller.listPeriodFeedback,
);

/**
 * Create or update a message decision.
 *
 * Only administrators can change feedback.
 */
router.put(
  "/:kind/:id/:messageId",
  // JWT.sessionRequired,
  requireBusiness,
  // allowFor(["admin", "basic"]),
  requireAdmin,
  periodController.resolvePeriod,
  controller.saveFeedback,
);

/**
 * Remove a message decision.
 *
 * Only administrators can remove feedback.
 */
router.delete(
  "/:kind/:id/:messageId",
  // JWT.sessionRequired,
  requireBusiness,
  // allowFor(["admin", "basic"]),
  requireAdmin,
  periodController.resolvePeriod,
  controller.deleteFeedback,
);

module.exports = router;
