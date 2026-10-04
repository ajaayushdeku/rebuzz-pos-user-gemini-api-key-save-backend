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
  async store(key, { periodStart, periodEnd, adminId, items, extra, basis, model, provider, settingsModel, generatedAt }) {
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
  async replace(key, { items, extra, basis, model, provider, settingsModel, generatedAt }) {
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
};

module.exports = { aiInsightsStore };
