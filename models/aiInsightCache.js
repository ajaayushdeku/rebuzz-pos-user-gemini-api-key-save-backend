import mongoose from "mongoose";

/**
 * A generated insight, kept so the same question is not paid for twice.
 *
 * The AI Insights page gives planning advice ("what to do this week"), not a
 * live readout. Asking Gemini again on every visit spends the merchant's own
 * quota for an answer that would barely change, and the in-memory cache in
 * the browser is lost on every reload. So the caller names the answer with a
 * `cacheKey` — which section, and which day — and a second request for the
 * same key is served from here without reaching Google.
 *
 * Freshness is the caller's job, through the key: a key that carries the date
 * turns over at midnight on its own. `expiresAt` is only housekeeping, so old
 * answers do not pile up.
 */
const aiInsightCacheSchema = new mongoose.Schema(
  {
    // String, as in AISettings: the id comes from another system's token.
    businessId: { type: String, required: true },
    cacheKey: { type: String, required: true },

    // The parsed answer, whatever shape the caller's schema asked for.
    insights: { type: mongoose.Schema.Types.Mixed, required: true },
    // The model that wrote it, as reported back by Gemini.
    model: { type: String, default: null },
    /**
     * The model saved in settings when this was generated.
     *
     * Compared on the way out: after a merchant picks another model, they
     * expect to see that model's answer, not one kept from before the change.
     */
    settingsModel: { type: String, default: null },
    generatedAt: { type: Date, required: true },

    // TTL index: MongoDB deletes the document once this passes.
    expiresAt: { type: Date, required: true, index: { expireAfterSeconds: 0 } },
  },
  { timestamps: false },
);

// One answer per business per key. Also the lookup path.
aiInsightCacheSchema.index({ businessId: 1, cacheKey: 1 }, { unique: true });

export default mongoose.model("AIInsightCache", aiInsightCacheSchema);
