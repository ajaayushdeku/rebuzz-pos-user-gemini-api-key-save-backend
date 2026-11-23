const express = require("express");
const router = express.Router();

const requireBusiness = require("../../middlewares/requireBusiness");
const requireAdmin = require("../../middlewares/requireAdmin");

const {
  festivalPrepActionController: controller,
} = require("../../controller/festivalPrepActionController");

/**
 * Durable completion records for day-scoped Festival Prep recommendations.
 *
 * An offer must already have been created successfully by the POS API.
 * This route only records that completed action.
 */
router.patch(
  "/:date/:promptVersion/:recommendationId/complete",
  requireBusiness,
  requireAdmin,
  controller.complete,
);

router.get(
  "/:date/:promptVersion/:recommendationId",
  requireBusiness,
  requireAdmin,
  controller.get,
);

module.exports = router;
