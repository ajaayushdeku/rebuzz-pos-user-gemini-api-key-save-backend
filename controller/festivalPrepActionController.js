const mongoose = require("mongoose");

const { festivalPrepActionStore } = require("../data/festivalPrepActionStore");

const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;
const OBJECT_ID_PATTERN = /^[a-f\d]{24}$/i;

function isValidDate(date) {
  if (!DATE_PATTERN.test(date ?? "")) return false;

  const parsed = new Date(`${date}T00:00:00.000Z`);

  return (
    !Number.isNaN(parsed.getTime()) &&
    parsed.toISOString().slice(0, 10) === date
  );
}

const festivalPrepActionController = {
  /**
   * Record a successfully created Festival Prep offer.
   *
   * This endpoint does not create the offer. The POS offer-creation API
   * must succeed first, and the frontend then sends its returned offerId.
   */
  async complete(req, res) {
    try {
      const { date, promptVersion, recommendationId } = req.params;
      const { offerId } = req.body ?? {};

      if (!isValidDate(date)) {
        return res.status(400).json({ error: "INVALID_DATE" });
      }

      if (
        typeof promptVersion !== "string" ||
        !promptVersion.trim() ||
        promptVersion.length > 50
      ) {
        return res.status(400).json({
          error: "INVALID_PROMPT_VERSION",
        });
      }

      if (
        typeof recommendationId !== "string" ||
        !recommendationId.startsWith("festival-") ||
        recommendationId.length > 150
      ) {
        return res.status(400).json({
          error: "INVALID_RECOMMENDATION_ID",
        });
      }

      if (typeof offerId !== "string" || !OBJECT_ID_PATTERN.test(offerId)) {
        return res.status(400).json({
          error: "INVALID_OFFER_ID",
        });
      }

      if (!req.businessId || !req.adminId) {
        return res.status(401).json({
          error: "BUSINESS_REQUIRED",
        });
      }

      const result = await festivalPrepActionStore.complete(
        {
          businessId: req.businessId,
          date,
          promptVersion,
          recommendationId,
        },
        {
          adminId: req.adminId,
          actionType: "offer-created",
          offerId: new mongoose.Types.ObjectId(offerId),
        },
      );

      if (!result.document) {
        throw new Error(
          "Festival Prep completion record could not be retrieved",
        );
      }

      // The recommendation was already completed using a different offer.
      if (!result.sameAction) {
        return res.status(409).json({
          error: "RECOMMENDATION_ALREADY_COMPLETED",
          alreadyCompleted: true,
          offerId: String(result.document.offerId),
          completedAt: result.document.completedAt,
        });
      }

      return res.status(result.alreadyCompleted ? 200 : 201).json({
        success: true,
        alreadyCompleted: result.alreadyCompleted,
        action: {
          date: result.document.date,
          promptVersion: result.document.promptVersion,
          recommendationId: result.document.recommendationId,
          actionType: result.document.actionType,
          offerId: String(result.document.offerId),
          completedAt: result.document.completedAt,
        },
      });
    } catch (error) {
      console.error(
        "[festival-prep-action] Failed to record completion:",
        error?.message ?? error,
      );

      return res.status(500).json({
        error: "FESTIVAL_PREP_COMPLETION_FAILED",
      });
    }
  },

  /**
   * Retrieve the completion status of a Festival Prep recommendation.
   */
  async get(req, res) {
    try {
      const { date, promptVersion, recommendationId } = req.params;

      if (!isValidDate(date)) {
        return res.status(400).json({
          error: "INVALID_DATE",
        });
      }

      if (
        typeof promptVersion !== "string" ||
        !promptVersion.trim() ||
        promptVersion.length > 50
      ) {
        return res.status(400).json({
          error: "INVALID_PROMPT_VERSION",
        });
      }

      if (
        typeof recommendationId !== "string" ||
        !recommendationId.startsWith("festival-") ||
        recommendationId.length > 150
      ) {
        return res.status(400).json({
          error: "INVALID_RECOMMENDATION_ID",
        });
      }

      if (!req.businessId) {
        return res.status(401).json({
          error: "BUSINESS_REQUIRED",
        });
      }

      const document = await festivalPrepActionStore.get({
        businessId: req.businessId,
        date,
        promptVersion,
        recommendationId,
      });

      return res.status(200).json({
        success: true,
        completed: Boolean(document),
        action: document
          ? {
              date: document.date,
              promptVersion: document.promptVersion,
              recommendationId: document.recommendationId,
              actionType: document.actionType,
              offerId: String(document.offerId),
              completedAt: document.completedAt,
            }
          : null,
      });
    } catch (error) {
      console.error(
        "[festival-prep-action] Failed to retrieve completion:",
        error?.message ?? error,
      );

      return res.status(500).json({
        error: "FESTIVAL_PREP_COMPLETION_FETCH_FAILED",
      });
    }
  },
};

module.exports = { festivalPrepActionController };
