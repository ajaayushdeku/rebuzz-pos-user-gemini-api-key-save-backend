const FestivalPrepAction = require("../models/festivalPrepAction");

const festivalPrepActionStore = {
  async complete(
    { businessId, date, promptVersion, recommendationId },
    { adminId, actionType, offerId },
  ) {
    const identity = {
      businessId,
      date,
      promptVersion,
      recommendationId,
    };

    const existing = await FestivalPrepAction.findOne(identity);

    if (existing) {
      const sameAction =
        existing.actionType === actionType &&
        String(existing.offerId) === String(offerId);

      return {
        document: existing,
        alreadyCompleted: true,
        sameAction,
      };
    }

    try {
      const document = await FestivalPrepAction.create({
        ...identity,
        adminId,
        actionType,
        offerId,
        completedAt: new Date(),
      });

      return {
        document,
        alreadyCompleted: false,
        sameAction: true,
      };
    } catch (error) {
      if (error.code !== 11000) {
        throw error;
      }

      const document = await FestivalPrepAction.findOne(identity);

      if (!document) {
        throw new Error(
          "Duplicate completion detected, but the existing record could not be retrieved",
        );
      }

      return {
        document,
        alreadyCompleted: true,
        sameAction:
          document.actionType === actionType &&
          String(document.offerId) === String(offerId),
      };
    }
  },

  async get({ businessId, date, promptVersion, recommendationId }) {
    return FestivalPrepAction.findOne({
      businessId,
      date,
      promptVersion,
      recommendationId,
    }).lean();
  },
};

module.exports = { festivalPrepActionStore };
