const mongoose = require("mongoose");

const retentionStyleSchema = new mongoose.Schema(
  {
    tone: String,
    length: String,
    personalization: String,
    approach: String,
  },
  { _id: false },
);

const customerRetentionFeedbackSchema = new mongoose.Schema(
  {
    // Business that owns this feedback.
    businessId: {
      type: String,
      required: true,
    },

    // Administrator who most recently submitted or updated the decision.
    adminId: {
      type: String,
      required: true,
    },

    // Stable ID assigned to the generated message.
    messageId: {
      type: String,
      required: true,
      trim: true,
    },

    // Original Customer Retention Radar recommendation.
    retentionItemId: {
      type: String,
      required: true,
      trim: true,
    },

    // Style used to generate the message.
    styleId: {
      type: String,
      required: true,
    },

    styleTitle: {
      type: String,
      required: true,
    },

    // Zero-based index of the message within its style.
    optionIndex: {
      type: Number,
      required: true,
      min: 0,
    },

    // Snapshot of the message when feedback was submitted.
    message: {
      type: String,
      required: true,
      trim: true,
    },

    // Current decision for this message.
    decision: {
      type: String,
      enum: ["approved", "disapproved"],
      required: true,
    },

    // Optional explanation for rejecting a message.
    rejectionReason: {
      type: String,
      default: null,
      trim: true,
    },

    // Snapshot of the style characteristics at feedback time.
    style: {
      type: retentionStyleSchema,
      default: null,
    },

    // Period in which this message was generated.
    // Retained for historical tracking, not global learning restrictions.
    periodKind: {
      type: String,
      required: true,
    },

    periodId: {
      type: String,
      required: true,
    },
  },
  {
    timestamps: true,
  },
);

/**
 * One current decision per generated message,
 * per business and reporting period.
 *
 * Historical records from different periods remain separate,
 * allowing business-wide feedback preference generation.
 */
customerRetentionFeedbackSchema.index(
  {
    businessId: 1,
    periodKind: 1,
    periodId: 1,
    messageId: 1,
  },
  {
    unique: true,
  },
);

/**
 * Retrieve approved/disapproved feedback across all periods
 * belonging to a business.
 */
customerRetentionFeedbackSchema.index({
  businessId: 1,
  decision: 1,
  updatedAt: -1,
});

module.exports = mongoose.model(
  "CustomerRetentionFeedback",
  customerRetentionFeedbackSchema,
);
