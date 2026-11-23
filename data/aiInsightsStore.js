const AIInsights = require("../models/aiInsights");

/**
 * Every read and write of stored period insights, behind one small interface.
 *
 * The controller talks to this and never to the model. That is not ceremony: the
 * plan is to move this collection to Firestore once the behaviour is settled
 * here, and with the call sites speaking in terms of `readPeriod`, `store`,
 * `replace` and `appendItems`, that move is a second implementation of this one
 * file rather than a change to the request path. The two would then be
 * interchangeable, and testable against each other.
 *
 * Nothing here decides *whether* to generate — that is the controller's
 * decision, because it is the one that costs money.
 */

/** The identity of a single stored answer. Every function takes this shape. */
const keyOf = ({ businessId, period, section, promptVersion }) => ({
  businessId,
  periodKind: period.kind,
  periodId: period.id,
  section,
  promptVersion,
});

const findItemStatus = (document, suggestionId) =>
  document?.itemStatuses?.find((entry) => entry.suggestionId === suggestionId);

const hasSuggestion = (document, suggestionId) =>
  document?.items?.some(
    (item) =>
      item &&
      typeof item === "object" &&
      !Array.isArray(item) &&
      String(item.id) === suggestionId,
  );

const aiInsightsStore = {
  /**
   * Every section stored for one business and period.
   *
   * The page's whole read, in one query, served by the prefix of the unique
   * index. Sections the business has never generated are simply absent — the
   * caller compares against the sections it knows about rather than this
   * promising a row per section.
   */
  async readPeriod(businessId, period) {
    return AIInsights.find({
      businessId,
      periodKind: period.kind,
      periodId: period.id,
    }).sort({ section: 1, generatedAt: 1 });
  },

  /** One stored answer, or null. */
  async readSection(key) {
    return AIInsights.findOne(keyOf(key));
  },

  /**
   * Delete every saved prompt version for one section of one period.
   *
   * Deleting all versions prevents an older answer from reappearing when
   * readPeriod() selects the newest remaining document for that section.
   *
   * Other sections and periods are not affected.
   */
  async deleteSection({ businessId, period, section }) {
    return AIInsights.deleteMany({
      businessId,
      periodKind: period.kind,
      periodId: period.id,
      section,
    });
  },

  /**
   * Keep a freshly generated answer.
   *
   * `upsert` rather than `create` so a retry after a timeout cannot fail on the
   * unique index, and `$setOnInsert` for `generatedAt` and `revision` so a
   * second attempt does not relabel the first answer as newer than it is.
   */
  async store(
    key,
    {
      periodStart,
      periodEnd,
      adminId,
      items,
      extra,
      basis,
      model,
      provider,
      settingsModel,
      generatedAt,
    },
  ) {
    return AIInsights.findOneAndUpdate(
      keyOf(key),
      {
        $set: {
          adminId,
          periodStart,
          periodEnd,
          items,
          extra,
          basis,
          model,
          provider,
          settingsModel,
        },
        $setOnInsert: {
          generatedAt,
          revision: 1,
          batches: 1,
          noMore: false,
        },
      },
      { new: true, upsert: true, setDefaultsOnInsert: true },
    );
  },

  /**
   * Replace an answer with a newly generated one — what Regenerate does.
   *
   * Generated cards and batches are replaced, but itemStatuses are preserved
   * so user actions remain recorded across regeneration.
   */
  async replace(
    key,
    { items, extra, basis, model, provider, settingsModel, generatedAt },
  ) {
    return AIInsights.findOneAndUpdate(
      keyOf(key),
      {
        $set: {
          items,
          extra,
          basis,
          model,
          provider,
          settingsModel,
          lastRegeneratedAt: generatedAt,
          batches: 1,
          noMore: false,
          // itemStatuses: [],
        },
        $inc: { revision: 1 },
      },
      { new: true },
    );
  },

  /**
   * Add a further batch of cards — what Generate more does.
   *
   * One atomic update: `$push` with `$each`, `$inc` on the batch count. Read,
   * merge and write would lose a batch when two tabs ask at once, and a
   * transaction is not available on a standalone mongod — this needs neither.
   *
   * `noMore` is set by the caller when the model returned nothing new, so the
   * button can stop offering a batch that would cost a call and add nothing.
   */
  async appendItems(key, { items, model, generatedAt, noMore = false }) {
    return AIInsights.findOneAndUpdate(
      keyOf(key),
      {
        $push: { items: { $each: items } },
        $inc: { batches: 1 },
        $set: { noMore, model, lastRegeneratedAt: generatedAt },
      },
      { new: true },
    );
  },

  /**
   * Which periods this business already has insights for, newest first.
   *
   * For the period picker, so it can mark the ones that are ready. Grouped in
   * the database rather than by loading every document: a business with two
   * years of monthly insights across eight sections has a couple of hundred,
   * and the picker only needs the dozen distinct periods.
   */
  async listPeriods(businessId, periodKind, limit = 24) {
    return AIInsights.aggregate([
      { $match: { businessId, periodKind } },
      {
        $group: {
          _id: "$periodId",
          periodStart: { $first: "$periodStart" },
          sections: { $addToSet: "$section" },
          lastGeneratedAt: { $max: "$generatedAt" },
        },
      },
      { $sort: { periodStart: -1 } },
      { $limit: limit },
      {
        $project: {
          _id: 0,
          id: "$_id",
          periodStart: 1,
          sections: 1,
          sectionCount: { $size: "$sections" },
          lastGeneratedAt: 1,
        },
      },
    ]);
  },

  /**
   * List saved insights for the management page.
   *
   * One row represents one period + section, even if multiple prompt versions
   * exist. The newest document supplies the displayed metadata.
   *
   * Pagination, filtering and searching happen in MongoDB.
   */
  async listSavedInsights(
    businessId,
    { periodKind, section, search, page = 1, limit = 10 } = {},
  ) {
    const match = { businessId };

    if (periodKind) {
      match.periodKind = periodKind;
    }

    if (section) {
      match.section = section;
    }

    if (search?.trim()) {
      const escapedSearch = search
        .trim()
        .replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      const searchRegex = new RegExp(escapedSearch, "i");

      match.$or = [{ periodId: searchRegex }, { section: searchRegex }];
    }

    const skip = (page - 1) * limit;

    const result = await AIInsights.aggregate([
      { $match: match },

      // Use the regeneration date when available, otherwise the original
      // generation date.
      {
        $addFields: {
          lastUpdatedAt: {
            $max: [
              "$generatedAt",
              { $ifNull: ["$lastRegeneratedAt", "$generatedAt"] },
            ],
          },
        },
      },

      // Ensure the newest prompt version/document is first in each group.
      {
        $sort: {
          lastUpdatedAt: -1,
          _id: -1,
        },
      },

      // One row per period + section, regardless of prompt version.
      {
        $group: {
          _id: {
            periodKind: "$periodKind",
            periodId: "$periodId",
            section: "$section",
          },
          latest: { $first: "$$ROOT" },
          lastUpdatedAt: { $max: "$lastUpdatedAt" },
          versionCount: { $sum: 1 },
          promptVersions: { $addToSet: "$promptVersion" },
        },
      },

      {
        $project: {
          _id: 0,
          periodKind: "$_id.periodKind",
          periodId: "$_id.periodId",
          periodStart: "$latest.periodStart",
          periodEnd: "$latest.periodEnd",
          section: "$_id.section",
          promptVersion: "$latest.promptVersion",
          promptVersions: 1,
          versionCount: 1,
          generatedAt: "$latest.generatedAt",
          lastRegeneratedAt: "$latest.lastRegeneratedAt",
          lastUpdatedAt: 1,
          provider: "$latest.provider",
          model: "$latest.model",
          settingsModel: "$latest.settingsModel",
          revision: "$latest.revision",
          batches: "$latest.batches",
          itemCount: { $size: { $ifNull: ["$latest.items", []] } },
        },
      },

      { $sort: { lastUpdatedAt: -1, periodStart: -1 } },

      // Return the page and total count from the same aggregation.
      {
        $facet: {
          items: [{ $skip: skip }, { $limit: limit }],
          metadata: [{ $count: "total" }],
        },
      },
    ]);

    const items = result[0]?.items ?? [];
    const total = result[0]?.metadata[0]?.total ?? 0;

    return {
      items,
      total,
      page,
      limit,
      totalPages: Math.ceil(total / limit),
    };
  },

  /**
   * Mark a suggestion as added to the POS catalogue.
   *
   * Exactly one association is accepted:
   * - productId -> addedProductId
   * - addonId   -> addedAddonId
   *
   * Conditional atomic updates prevent an existing association from being
   * reassigned, including when two requests arrive at the same time.
   */
  async markItemAdded(key, { suggestionId, productId, addonId }) {
    const identity = keyOf(key);
    const now = new Date();

    const hasProductId = Boolean(productId);
    const hasAddonId = Boolean(addonId);

    if (hasProductId === hasAddonId) {
      throw new Error("Exactly one of productId or addonId is required");
    }

    const isProduct = hasProductId;
    const associationField = isProduct ? "addedProductId" : "addedAddonId";
    const associationId = isProduct ? productId : addonId;

    const itemFilter = {
      ...identity,
      items: {
        $elemMatch: { id: suggestionId },
      },
    };

    // Case 1: A status exists, but is not yet "added".
    // This also allows dismissed -> added.
    let document = await AIInsights.findOneAndUpdate(
      {
        ...itemFilter,
        itemStatuses: {
          $elemMatch: {
            suggestionId,
            status: { $ne: "added" },
          },
        },
      },
      {
        $set: {
          "itemStatuses.$[entry].status": "added",
          [`itemStatuses.$[entry].${associationField}`]: associationId,
          "itemStatuses.$[entry].addedAt": now,
          "itemStatuses.$[entry].dismissedAt": null,
        },
        $unset: {
          [`itemStatuses.$[entry].${isProduct ? "addedAddonId" : "addedProductId"}`]: 1,
        },
      },
      {
        new: true,
        runValidators: true,
        arrayFilters: [
          {
            "entry.suggestionId": suggestionId,
            "entry.status": { $ne: "added" },
          },
        ],
      },
    );

    if (document) {
      return {
        document,
        alreadyAdded: false,
        sameAssociation: true,
      };
    }

    // Case 2: No status exists yet. Insert one atomically.
    document = await AIInsights.findOneAndUpdate(
      {
        ...itemFilter,
        itemStatuses: {
          $not: {
            $elemMatch: { suggestionId },
          },
        },
      },
      {
        $push: {
          itemStatuses: {
            suggestionId,
            status: "added",
            [associationField]: associationId,
            addedAt: now,
            dismissedAt: null,
          },
        },
      },
      {
        new: true,
        runValidators: true,
      },
    );

    if (document) {
      return {
        document,
        alreadyAdded: false,
        sameAssociation: true,
      };
    }

    // Case 3: Another request may have won the race.
    document = await AIInsights.findOne(identity);

    if (!hasSuggestion(document, suggestionId)) {
      return {
        document: null,
        alreadyAdded: false,
        sameAssociation: false,
      };
    }

    const existingStatus = findItemStatus(document, suggestionId);

    if (existingStatus?.status === "added") {
      const existingId = existingStatus[associationField];

      return {
        document,
        alreadyAdded: true,
        sameAssociation: String(existingId) === String(associationId),
      };
    }

    return {
      document,
      alreadyAdded: false,
      sameAssociation: false,
    };
  },

  /**
   * Dismiss a suggestion without removing its generated content.
   *
   * An added suggestion can never be dismissed.
   * Repeated dismiss requests are safe.
   */
  async dismissItem(key, { suggestionId }) {
    const identity = keyOf(key);

    const itemFilter = {
      ...identity,
      items: {
        $elemMatch: { id: suggestionId },
      },
    };

    const now = new Date();

    // Case 1: Update an existing non-added status.
    let document = await AIInsights.findOneAndUpdate(
      {
        ...itemFilter,
        itemStatuses: {
          $elemMatch: {
            suggestionId,
            status: { $ne: "added" },
          },
        },
      },
      {
        $set: {
          "itemStatuses.$[entry].status": "dismissed",
          "itemStatuses.$[entry].dismissedAt": now,
          "itemStatuses.$[entry].addedProductId": null,
          "itemStatuses.$[entry].addedAddonId": null,
          "itemStatuses.$[entry].addedAt": null,
        },
      },
      {
        new: true,
        runValidators: true,
        arrayFilters: [
          {
            "entry.suggestionId": suggestionId,
            "entry.status": { $ne: "added" },
          },
        ],
      },
    );

    if (document) return document;

    // Case 2: No status exists. Insert a dismissed status atomically.
    document = await AIInsights.findOneAndUpdate(
      {
        ...itemFilter,
        itemStatuses: {
          $not: {
            $elemMatch: { suggestionId },
          },
        },
      },
      {
        $push: {
          itemStatuses: {
            suggestionId,
            status: "dismissed",
            dismissedAt: now,
            addedProductId: null,
            addedAddonId: null,
            addedAt: null,
          },
        },
      },
      {
        new: true,
        runValidators: true,
      },
    );

    if (document) return document;

    // Case 3: Another request may have won the race.
    // Return the current document without overwriting its status.
    document = await AIInsights.findOne(identity);

    if (!hasSuggestion(document, suggestionId)) {
      return null;
    }

    return document;
  },

  /**
   * Record a successfully applied Pricing Opportunities action.
   *
   * Supports:
   * - price-updated
   * - discount-removed
   *
   * A dismissed suggestion can still be applied.
   * An already-applied suggestion cannot be applied again or overwritten.
   *
   * Conditional atomic updates prevent concurrent requests from creating
   * duplicate status entries or overwriting an existing applied action.
   */
  async applyPricingAction(
    key,
    {
      suggestionId,
      actionType,
      productId,
      variantId = null,
      previousValue = null,
      appliedValue = null,
    },
  ) {
    const identity = keyOf(key);
    const now = new Date();

    const itemFilter = {
      ...identity,
      items: {
        $elemMatch: { id: suggestionId },
      },
    };

    const actionStatus = {
      status: "applied",
      actionType,
      productId,
      variantId,
      previousValue,
      appliedValue,
      appliedAt: now,
      dismissedAt: null,
    };

    // Case 1: A dismissed status already exists.
    // Allow dismissed -> applied, but never overwrite an applied action.
    let document = await AIInsights.findOneAndUpdate(
      {
        ...itemFilter,
        itemStatuses: {
          $elemMatch: {
            suggestionId,
            status: "dismissed",
          },
        },
      },
      {
        $set: {
          "itemStatuses.$[entry].status": "applied",
          "itemStatuses.$[entry].actionType": actionType,
          "itemStatuses.$[entry].productId": productId,
          "itemStatuses.$[entry].variantId": variantId,
          "itemStatuses.$[entry].previousValue": previousValue,
          "itemStatuses.$[entry].appliedValue": appliedValue,
          "itemStatuses.$[entry].appliedAt": now,
          "itemStatuses.$[entry].dismissedAt": null,
        },
      },
      {
        new: true,
        runValidators: true,
        arrayFilters: [
          {
            "entry.suggestionId": suggestionId,
            "entry.status": "dismissed",
          },
        ],
      },
    );

    if (document) {
      return {
        document,
        alreadyApplied: false,
        sameAction: true,
      };
    }

    // Case 2: No status exists yet.
    // Insert the applied status atomically.
    document = await AIInsights.findOneAndUpdate(
      {
        ...itemFilter,
        itemStatuses: {
          $not: {
            $elemMatch: { suggestionId },
          },
        },
      },
      {
        $push: {
          itemStatuses: {
            suggestionId,
            ...actionStatus,
          },
        },
      },
      {
        new: true,
        runValidators: true,
      },
    );

    if (document) {
      return {
        document,
        alreadyApplied: false,
        sameAction: true,
      };
    }

    // Case 3: Another request may have won the race.
    // Read the existing status instead of overwriting it.
    document = await AIInsights.findOne(identity);

    if (!hasSuggestion(document, suggestionId)) {
      return {
        document: null,
        alreadyApplied: false,
        sameAction: false,
      };
    }

    const existingStatus = findItemStatus(document, suggestionId);

    if (existingStatus?.status === "applied") {
      const sameAction =
        existingStatus.actionType === actionType &&
        String(existingStatus.productId) === String(productId) &&
        String(existingStatus.variantId ?? "") === String(variantId ?? "") &&
        existingStatus.previousValue === previousValue &&
        existingStatus.appliedValue === appliedValue;

      return {
        document,
        alreadyApplied: true,
        sameAction,
      };
    }

    return {
      document,
      alreadyApplied: false,
      sameAction: false,
    };
  },

  /**
   * Record a successfully completed Slow-Moving Items action.
   *
   * Supports:
   * - discount-applied
   * - freebie-created
   *
   * A dismissed suggestion can still be completed.
   * An already-completed suggestion cannot be overwritten by another action.
   *
   * Conditional atomic updates prevent duplicate status entries and protect
   * against concurrent requests.
   */
  async completeSlowItemAction(
    key,
    {
      suggestionId,
      actionType,
      productId,
      variantId = null,
      discountId = null,
      offerId = null,
    },
  ) {
    const identity = keyOf(key);
    const now = new Date();

    const itemFilter = {
      ...identity,
      items: {
        $elemMatch: { id: suggestionId },
      },
    };

    // Only retain the identifier relevant to the selected action.
    const actionDetails = {
      actionType,
      productId,
      variantId,
      discountId: actionType === "discount-applied" ? discountId : null,
      offerId: actionType === "freebie-created" ? offerId : null,
    };

    const existingDocument = await AIInsights.findOne(identity).lean();

    console.log("[slow-item completion debug]", {
      identity,
      requestedSuggestionId: suggestionId,
      documentFound: Boolean(existingDocument),
      storedSuggestionIds: existingDocument?.items?.map((item) => ({
        id: item?.id,
        ref: item?.ref,
      })),
    });

    // Case 1: A dismissed status already exists.
    // Allow dismissed -> applied.
    let document = await AIInsights.findOneAndUpdate(
      {
        ...itemFilter,
        itemStatuses: {
          $elemMatch: {
            suggestionId,
            status: "dismissed",
          },
        },
      },
      {
        $set: {
          "itemStatuses.$[entry].status": "applied",
          "itemStatuses.$[entry].actionType": actionDetails.actionType,
          "itemStatuses.$[entry].productId": actionDetails.productId,
          "itemStatuses.$[entry].variantId": actionDetails.variantId,
          "itemStatuses.$[entry].discountId": actionDetails.discountId,
          "itemStatuses.$[entry].offerId": actionDetails.offerId,
          "itemStatuses.$[entry].previousValue": null,
          "itemStatuses.$[entry].appliedValue": null,
          "itemStatuses.$[entry].appliedAt": now,
          "itemStatuses.$[entry].dismissedAt": null,
        },
      },
      {
        new: true,
        runValidators: true,
        arrayFilters: [
          {
            "entry.suggestionId": suggestionId,
            "entry.status": "dismissed",
          },
        ],
      },
    );

    if (document) {
      return {
        document,
        alreadyApplied: false,
        sameAction: true,
      };
    }

    // Case 2: No status exists yet.
    // Insert the completed status atomically.
    document = await AIInsights.findOneAndUpdate(
      {
        ...itemFilter,
        itemStatuses: {
          $not: {
            $elemMatch: { suggestionId },
          },
        },
      },
      {
        $push: {
          itemStatuses: {
            suggestionId,
            status: "applied",
            ...actionDetails,
            previousValue: null,
            appliedValue: null,
            appliedAt: now,
            dismissedAt: null,
          },
        },
      },
      {
        new: true,
        runValidators: true,
      },
    );

    if (document) {
      return {
        document,
        alreadyApplied: false,
        sameAction: true,
      };
    }

    // Case 3: Another request may have won the race,
    // or this suggestion already has a different status.
    document = await AIInsights.findOne(identity);

    if (!hasSuggestion(document, suggestionId)) {
      return {
        document: null,
        alreadyApplied: false,
        sameAction: false,
      };
    }

    const existingStatus = findItemStatus(document, suggestionId);

    if (existingStatus?.status === "applied") {
      const sameAction =
        existingStatus.actionType === actionDetails.actionType &&
        String(existingStatus.productId ?? "") ===
          String(actionDetails.productId ?? "") &&
        String(existingStatus.variantId ?? "") ===
          String(actionDetails.variantId ?? "") &&
        String(existingStatus.discountId ?? "") ===
          String(actionDetails.discountId ?? "") &&
        String(existingStatus.offerId ?? "") ===
          String(actionDetails.offerId ?? "");

      return {
        document,
        alreadyApplied: true,
        sameAction,
      };
    }

    return {
      document,
      alreadyApplied: false,
      sameAction: false,
    };
  },

  /**
   * Dismiss a Pricing Opportunities suggestion.
   *
   * An applied suggestion can never be dismissed.
   * Repeated dismiss requests are safe.
   */
  async dismissPricingItem(key, { suggestionId }) {
    const identity = keyOf(key);

    const itemFilter = {
      ...identity,
      items: {
        $elemMatch: { id: suggestionId },
      },
    };

    const now = new Date();

    // Case 1: A dismissed status already exists.
    // Refresh its timestamp without changing any applied action.
    let document = await AIInsights.findOneAndUpdate(
      {
        ...itemFilter,
        itemStatuses: {
          $elemMatch: {
            suggestionId,
            status: "dismissed",
          },
        },
      },
      {
        $set: {
          "itemStatuses.$[entry].dismissedAt": now,
        },
      },
      {
        new: true,
        arrayFilters: [
          {
            "entry.suggestionId": suggestionId,
            "entry.status": "dismissed",
          },
        ],
      },
    );

    if (document) return document;

    // Case 2: No status exists yet.
    // Insert a dismissed status atomically.
    document = await AIInsights.findOneAndUpdate(
      {
        ...itemFilter,
        itemStatuses: {
          $not: {
            $elemMatch: { suggestionId },
          },
        },
      },
      {
        $push: {
          itemStatuses: {
            suggestionId,
            status: "dismissed",
            dismissedAt: now,
          },
        },
      },
      {
        new: true,
        runValidators: true,
      },
    );

    if (document) return document;

    // Case 3: Another request may have won the race.
    // Return the current document without overwriting its status.
    document = await AIInsights.findOne(identity);

    if (!hasSuggestion(document, suggestionId)) {
      return null;
    }

    return document;
  },
};

module.exports = { aiInsightsStore };
