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
   * The card count resets with it: the new answer is a whole answer, so batches
   * added to the old one are gone rather than appended to something that no
   * longer says the same thing.
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
          itemStatuses: [],
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
   * Mark a suggestion as added to the product catalogue.
   *
   * Uses conditional atomic updates:
   * 1. Update an existing non-added status.
   * 2. If no status exists, atomically append one.
   * 3. If another request won the race, read and return its result.
   *
   * An existing added association can never be reassigned.
   */
  async markItemAdded(key, { suggestionId, productId }) {
    const identity = keyOf(key);
    const now = new Date();

    const itemFilter = {
      ...identity,
      items: {
        $elemMatch: { id: suggestionId },
      },
    };

    // Case 1: A status already exists, but it is not "added".
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
          "itemStatuses.$[entry].addedProductId": productId,
          "itemStatuses.$[entry].addedAt": now,
          "itemStatuses.$[entry].dismissedAt": null,
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
        sameProduct: true,
      };
    }

    // Case 2: No status exists yet.
    // The conditional filter prevents concurrent requests from inserting
    // multiple status entries for the same suggestion.
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
            addedProductId: productId,
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
        sameProduct: true,
      };
    }

    // Case 3: Another request may have updated the status first.
    // Read its result instead of trying to overwrite it.
    document = await AIInsights.findOne(identity);

    if (!hasSuggestion(document, suggestionId)) {
      return {
        document: null,
        alreadyAdded: false,
        sameProduct: false,
      };
    }

    const existingStatus = findItemStatus(document, suggestionId);

    if (existingStatus?.status === "added") {
      return {
        document,
        alreadyAdded: true,
        sameProduct:
          String(existingStatus.addedProductId) === String(productId),
      };
    }

    return {
      document,
      alreadyAdded: false,
      sameProduct: false,
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
};

module.exports = { aiInsightsStore };
