const mongoose = require("mongoose");

const festivalPrepActionSchema = new mongoose.Schema(
  {
    businessId: {
      type: String,
      required: true,
      index: true,
    },

    adminId: {
      type: String,
      required: true,
    },

    // Nepal-local date supplied by the Festival Prep route.
    date: {
      type: String,
      required: true,
    },

    promptVersion: {
      type: String,
      required: true,
    },

    // FestivalPrep.id, e.g. "festival-dashain".
    recommendationId: {
      type: String,
      required: true,
    },

    actionType: {
      type: String,
      enum: ["offer-created"],
      required: true,
    },

    offerId: {
      type: mongoose.Schema.Types.ObjectId,
      required: true,
    },

    completedAt: {
      type: Date,
      required: true,
      default: Date.now,
    },
  },
  {
    timestamps: true,
  },
);

// One completion per recommendation, per business, per day and prompt version.
festivalPrepActionSchema.index(
  {
    businessId: 1,
    date: 1,
    promptVersion: 1,
    recommendationId: 1,
  },
  { unique: true },
);

module.exports = mongoose.model("FestivalPrepAction", festivalPrepActionSchema);
