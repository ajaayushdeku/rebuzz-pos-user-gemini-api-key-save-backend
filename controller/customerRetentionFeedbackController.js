const CustomerRetentionFeedback = require("../models/customerRetentionFeedback");

const MAX_MESSAGE_LENGTH = 2000;
const MAX_REASON_LENGTH = 500;

/**
 * Resolve the canonical period identity.
 *
 * Never persist "latest" as the period ID. resolvePeriod should have
 * already converted it into the actual completed period.
 */
function getPeriodIdentity(req) {
  const period = req.period;

  if (!period?.kind || !period?.id) {
    return null;
  }

  return {
    periodKind: period.kind,
    periodId: period.id,
  };
}

function getBusinessId(req) {
  return req.businessId ? String(req.businessId) : null;
}

function getAdminId(req) {
  return req.adminId ? String(req.adminId) : null;
}

function sanitizeStyle(style) {
  if (style == null) return null;

  if (typeof style !== "object" || Array.isArray(style)) {
    return null;
  }

  const fields = ["tone", "length", "personalization", "approach"];
  const sanitized = {};

  for (const field of fields) {
    if (style[field] == null) continue;

    if (typeof style[field] !== "string" || style[field].length > 100) {
      throw new Error("INVALID_STYLE");
    }

    sanitized[field] = style[field].trim();
  }

  return sanitized;
}

function validateFeedbackBody(body) {
  const {
    retentionItemId,
    styleId,
    styleTitle,
    optionIndex,
    message,
    decision,
    rejectionReason,
  } = body || {};

  if (typeof retentionItemId !== "string" || !retentionItemId.trim()) {
    return "INVALID_RETENTION_ITEM_ID";
  }

  if (typeof styleId !== "string" || !styleId.trim()) {
    return "INVALID_STYLE_ID";
  }

  if (typeof styleTitle !== "string" || !styleTitle.trim()) {
    return "INVALID_STYLE_TITLE";
  }

  if (!Number.isInteger(optionIndex) || optionIndex < 0) {
    return "INVALID_OPTION_INDEX";
  }

  if (
    typeof message !== "string" ||
    !message.trim() ||
    message.trim().length > MAX_MESSAGE_LENGTH
  ) {
    return "INVALID_MESSAGE";
  }

  if (!["approved", "disapproved"].includes(decision)) {
    return "INVALID_DECISION";
  }

  if (
    rejectionReason != null &&
    (typeof rejectionReason !== "string" ||
      rejectionReason.length > MAX_REASON_LENGTH)
  ) {
    return "INVALID_REJECTION_REASON";
  }

  return null;
}

const customerRetentionFeedbackController = {
  /**
   * GET /customer-retention-feedback/:kind/:id
   *
   * Retrieve decisions for one completed period.
   * Used by the frontend to restore message approval states.
   */
  async listPeriodFeedback(req, res, next) {
    try {
      const businessId = getBusinessId(req);
      const periodIdentity = getPeriodIdentity(req);

      if (!businessId) {
        return res.status(401).json({
          error: "BUSINESS_CONTEXT_REQUIRED",
        });
      }

      if (!periodIdentity) {
        return res.status(400).json({
          error: "INVALID_PERIOD_IDENTITY",
        });
      }

      const feedback = await CustomerRetentionFeedback.find({
        businessId,
        ...periodIdentity,
      })
        .sort({ updatedAt: -1 })
        .lean();

      return res.json({
        feedback,
      });
    } catch (error) {
      next(error);
    }
  },

  /**
   * GET /customer-retention-feedback/preferences
   *
   * Retrieve business-wide feedback across all periods.
   *
   * This is the input for the future AI feedback preference builder.
   */
  async getPreferences(req, res, next) {
    try {
      const businessId = getBusinessId(req);

      if (!businessId) {
        return res.status(401).json({
          error: "BUSINESS_CONTEXT_REQUIRED",
        });
      }

      const [
        approvedExamples,
        disapprovedExamples,
        styleStats,
        approvedCount,
        disapprovedCount,
      ] = await Promise.all([
        CustomerRetentionFeedback.find({
          businessId,
          decision: "approved",
        })
          .sort({ updatedAt: -1 })
          .limit(8)
          .select(
            "message styleId styleTitle style periodKind periodId updatedAt",
          )
          .lean(),

        CustomerRetentionFeedback.find({
          businessId,
          decision: "disapproved",
        })
          .sort({ updatedAt: -1 })
          .limit(8)
          .select(
            "message styleId styleTitle style rejectionReason periodKind periodId updatedAt",
          )
          .lean(),

        CustomerRetentionFeedback.aggregate([
          { $match: { businessId } },
          {
            $group: {
              _id: {
                styleId: "$styleId",
                styleTitle: "$styleTitle",
              },
              approved: {
                $sum: {
                  $cond: [{ $eq: ["$decision", "approved"] }, 1, 0],
                },
              },
              disapproved: {
                $sum: {
                  $cond: [{ $eq: ["$decision", "disapproved"] }, 1, 0],
                },
              },
            },
          },
          { $sort: { approved: -1, disapproved: 1 } },
        ]),

        CustomerRetentionFeedback.countDocuments({
          businessId,
          decision: "approved",
        }),

        CustomerRetentionFeedback.countDocuments({
          businessId,
          decision: "disapproved",
        }),
      ]);

      const preferredStyles = styleStats
        .filter((item) => item.approved > item.disapproved)
        .map((item) => ({
          styleId: item._id.styleId,
          styleTitle: item._id.styleTitle,
          approved: item.approved,
          disapproved: item.disapproved,
        }));

      const avoidStyles = styleStats
        .filter((item) => item.disapproved > item.approved)
        .map((item) => ({
          styleId: item._id.styleId,
          styleTitle: item._id.styleTitle,
          approved: item.approved,
          disapproved: item.disapproved,
        }));

      return res.json({
        approvedExamples,
        disapprovedExamples,
        preferredStyles,
        avoidStyles,
        styleStats: styleStats.map((item) => ({
          styleId: item._id.styleId,
          styleTitle: item._id.styleTitle,
          approved: item.approved,
          disapproved: item.disapproved,
        })),
        totalFeedback: {
          approved: approvedCount,
          disapproved: disapprovedCount,
          total: approvedCount + disapprovedCount,
        },
      });
    } catch (error) {
      next(error);
    }
  },

  /**
   * GET /customer-retention-feedback/history
   *
   * Retrieve business-wide feedback history with pagination,
   * decision filtering, style filtering and message search.
   */
  async listFeedbackHistory(req, res, next) {
    try {
      const businessId = getBusinessId(req);

      if (!businessId) {
        return res.status(401).json({
          error: "BUSINESS_CONTEXT_REQUIRED",
        });
      }

      const page = Math.max(1, Number.parseInt(req.query.page, 10) || 1);

      const limit = Math.min(
        50,
        Math.max(1, Number.parseInt(req.query.limit, 10) || 10),
      );

      const { decision, styleId, search } = req.query;

      const filter = { businessId };

      // Filter by approval decision.
      if (decision && decision !== "all") {
        if (!["approved", "disapproved"].includes(decision)) {
          return res.status(400).json({
            error: "INVALID_DECISION_FILTER",
          });
        }

        filter.decision = decision;
      }

      // Filter by writing style.
      if (styleId && styleId !== "all") {
        filter.styleId = styleId;
      }

      // Search within the generated message.
      if (search && search.trim()) {
        const escapedSearch = search
          .trim()
          .replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

        filter.message = {
          $regex: escapedSearch,
          $options: "i",
        };
      }

      const skip = (page - 1) * limit;

      const [items, total] = await Promise.all([
        CustomerRetentionFeedback.find(filter)
          .sort({ updatedAt: -1, _id: -1 })
          .skip(skip)
          .limit(limit)
          .select(
            "messageId message decision rejectionReason styleId styleTitle style periodKind periodId updatedAt createdAt",
          )
          .lean(),

        CustomerRetentionFeedback.countDocuments(filter),
      ]);

      return res.json({
        items,
        pagination: {
          page,
          limit,
          total,
          totalPages: Math.ceil(total / limit),
        },
      });
    } catch (error) {
      next(error);
    }
  },

  /**
   * PUT /customer-retention-feedback/:kind/:id/:messageId
   *
   * Create or update the current decision for a message.
   */
  async saveFeedback(req, res, next) {
    try {
      const businessId = getBusinessId(req);
      const adminId = getAdminId(req);
      const periodIdentity = getPeriodIdentity(req);
      const messageId = req.params.messageId?.trim();

      if (!businessId) {
        return res.status(401).json({
          error: "BUSINESS_CONTEXT_REQUIRED",
        });
      }

      if (!adminId) {
        return res.status(403).json({
          error: "ADMIN_CONTEXT_REQUIRED",
        });
      }

      if (!periodIdentity) {
        return res.status(400).json({
          error: "INVALID_PERIOD_IDENTITY",
        });
      }

      if (
        !messageId ||
        !/^retmsg_[a-z0-9]+$/i.test(messageId) ||
        messageId.length > 200
      ) {
        return res.status(400).json({
          error: "INVALID_MESSAGE_ID",
        });
      }

      const validationError = validateFeedbackBody(req.body);

      if (validationError) {
        return res.status(400).json({
          error: validationError,
        });
      }

      const {
        retentionItemId,
        styleId,
        styleTitle,
        optionIndex,
        message,
        decision,
        rejectionReason,
        style,
      } = req.body;

      let sanitizedStyle;

      try {
        sanitizedStyle = sanitizeStyle(style);
      } catch {
        return res.status(400).json({
          error: "INVALID_STYLE",
        });
      }

      const feedback = await CustomerRetentionFeedback.findOneAndUpdate(
        {
          businessId,
          ...periodIdentity,
          messageId,
        },
        {
          $set: {
            adminId,
            retentionItemId: retentionItemId.trim(),
            styleId: styleId.trim(),
            styleTitle: styleTitle.trim(),
            optionIndex,
            message: message.trim(),
            decision,
            rejectionReason:
              decision === "disapproved"
                ? rejectionReason?.trim() || null
                : null,
            style: sanitizedStyle,
          },
        },
        {
          new: true,
          upsert: true,
          runValidators: true,
          setDefaultsOnInsert: true,
        },
      ).lean();

      return res.json({
        success: true,
        feedback,
      });
    } catch (error) {
      next(error);
    }
  },

  /**
   * DELETE /customer-retention-feedback/:kind/:id/:messageId
   *
   * Remove a decision for one message in one period.
   */
  async deleteFeedback(req, res, next) {
    try {
      const businessId = getBusinessId(req);
      const periodIdentity = getPeriodIdentity(req);
      const messageId = req.params.messageId?.trim();

      if (!businessId) {
        return res.status(401).json({
          error: "BUSINESS_CONTEXT_REQUIRED",
        });
      }

      if (!periodIdentity) {
        return res.status(400).json({
          error: "INVALID_PERIOD_IDENTITY",
        });
      }

      if (!messageId) {
        return res.status(400).json({
          error: "INVALID_MESSAGE_ID",
        });
      }

      const deleted = await CustomerRetentionFeedback.findOneAndDelete({
        businessId,
        ...periodIdentity,
        messageId,
      });

      if (!deleted) {
        return res.status(404).json({
          error: "FEEDBACK_NOT_FOUND",
        });
      }

      return res.json({
        success: true,
        messageId,
      });
    } catch (error) {
      next(error);
    }
  },
};

module.exports = customerRetentionFeedbackController;
