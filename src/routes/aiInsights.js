import { Router } from "express";

import AISettings from "../models/AISettings.js";
import AIInsightCache from "../models/AIInsightCache.js";
import requireBusiness from "../middleware/requireBusiness.js";
import { decrypt } from "../lib/crypto.js";
import { DEFAULT_PROVIDER, getProvider } from "../services/providers.js";
import { insightsRateLimit } from "../lib/rateLimit.js";

/**
 * The one place a stored key is ever used.
 *
 * The key is written once through the settings route and can never be read
 * back. This route is how it earns its keep: the caller posts the facts, this
 * decrypts the key, calls Gemini on the business's own quota, and returns only
 * the answer. The credential never leaves the process.
 *
 * The caller supplies the briefing rather than this service fetching it. That
 * is the contract the README documents, and it has one property worth keeping:
 * the card and the chart above it are then built from the same numbers, so
 * they cannot disagree. The middleware still stashes the caller's POS token,
 * which this route does not use — it is there for the day that decision is
 * revisited.
 */

const router = Router();

router.use(requireBusiness);

/**
 * Roughly four thousand tokens of input.
 *
 * A cap belongs here rather than only on the body parser because it is the
 * merchant's quota being spent. A briefing that grows without anyone noticing
 * turns into a bill nobody chose, and a summary this long has usually stopped
 * being a summary.
 */
const MAX_BRIEFING_CHARS = 16_000;

/** A system instruction is a job description, not a second briefing. */
const MAX_INSTRUCTION_CHARS = 4_000;

/**
 * What a cache key may look like, e.g. "sales-recommendations:v1:2026-09-17".
 *
 * Restricted to a plain alphabet so a key can never be an object or an
 * operator by the time it reaches a MongoDB query.
 */
const CACHE_KEY_PATTERN = /^[A-Za-z0-9:._-]{1,120}$/;

/**
 * How long a cached answer is kept before MongoDB removes it.
 *
 * Housekeeping only. Keys that carry the date already stop matching at
 * midnight; the extra two hours cover the gap between the business's day and
 * the server's clock.
 */
const CACHE_TTL_MS = 26 * 60 * 60 * 1000;

/**
 * One limiter for the route, created once. Built per request, every call would
 * get a fresh empty bucket and nothing would ever be limited.
 */
const quotaGuard = insightsRateLimit((req, res) =>
  serveLastAnswer(req, res, "INSIGHTS_RATE_LIMIT"),
);

/**
 * Everything that can refuse a request without spending anything.
 *
 * Runs before the rate limit, not after it. The limit exists to bound Gemini
 * spend, so it should only count requests that are about to reach Gemini. When
 * it ran first, every refusal here was charged against the hour: the overview
 * page asks for insights on each visit, so a merchant without a key who opened
 * it twenty times — each one a 424 that cost nothing — then saved a key and
 * was still told "too many requests" for up to an hour.
 *
 * The decrypted key is deliberately not stashed on the request. Only the
 * stored record travels onward, and decryption happens in the handler that
 * uses it, so the plaintext never sits on an object other middleware can see.
 */
async function prepareInsightRequest(req, res, next) {
  const briefing =
    typeof req.body?.briefing === "string" ? req.body.briefing.trim() : "";
  const systemInstruction =
    typeof req.body?.systemInstruction === "string"
      ? req.body.systemInstruction.trim()
      : "";
  const responseSchema =
    req.body?.responseSchema && typeof req.body.responseSchema === "object"
      ? req.body.responseSchema
      : null;

  if (!briefing) {
    return res.status(400).json({ error: "BRIEFING_REQUIRED" });
  }
  if (briefing.length > MAX_BRIEFING_CHARS) {
    return res.status(400).json({ error: "BRIEFING_TOO_LONG" });
  }
  if (systemInstruction.length > MAX_INSTRUCTION_CHARS) {
    return res.status(400).json({ error: "INSTRUCTION_TOO_LONG" });
  }

  const cacheKey = req.body?.cacheKey;
  if (
    cacheKey !== undefined &&
    (typeof cacheKey !== "string" || !CACHE_KEY_PATTERN.test(cacheKey))
  ) {
    return res.status(400).json({ error: "INVALID_CACHE_KEY" });
  }
  // A cache key only means something with a schema: only parsed answers are
  // stored, so without one there would be nothing to serve back.
  if (cacheKey && !responseSchema) {
    return res.status(400).json({ error: "CACHE_NEEDS_SCHEMA" });
  }

  const settings = await AISettings.findOne({ businessId: req.businessId });

  /**
   * 424 for both "no key" and "switched off".
   *
   * Failed Dependency, because nothing is wrong with the request: a
   * precondition the merchant controls is missing. The frontend can treat the
   * status alone as "send them to settings" while the code decides which
   * sentence to show, so neither case reads as a crash.
   */
  // Whichever provider this business chose; Gemini for every record written
  // before there was a choice.
  const providerId = settings?.provider ?? DEFAULT_PROVIDER;
  const credentials = settings?.[providerId];

  if (!credentials?.apiKey) {
    return res.status(424).json({ error: "NOT_CONFIGURED" });
  }
  if (!credentials.enabled) {
    return res.status(424).json({ error: "AI_DISABLED" });
  }

  req.insight = {
    briefing,
    systemInstruction,
    responseSchema,
    settings,
    providerId,
    credentials,
    cacheKey: cacheKey ?? null,
    // Strictly `true`: a stray "false" string must not skip the cache and
    // spend a call nobody asked for.
    refresh: req.body?.refresh === true,
  };
  next();
}

/**
 * Answer from the cache when the same question was already paid for.
 *
 * Runs after the checks above and before the rate limit. After the checks, so
 * a merchant who removed their key or switched AI off stops seeing answers
 * straight away rather than when the cache runs out. Before the rate limit,
 * because a cached answer costs nothing and must not use up the hour.
 *
 * Any trouble reading the cache falls through to a normal call. The cache
 * saves money; it must never be the reason an insight fails.
 */
/**
 * What the answer was generated under: provider and model together.
 *
 * The provider belongs in it because two providers can be asked for the same
 * model name, and because switching provider is a deliberate change of who
 * answers — served from the old provider's cache, the switch would look like
 * it had done nothing.
 */
const settingsSignature = ({ providerId, credentials }) =>
  `${providerId}:${credentials?.model || ""}`;

async function serveCached(req, res, next) {
  const { cacheKey, refresh } = req.insight;
  if (!cacheKey || refresh) return next();

  try {
    const hit = await AIInsightCache.findOne({
      businessId: req.businessId,
      cacheKey,
      expiresAt: { $gt: new Date() },
    }).lean();

    // An answer from before a provider or model change is treated as a miss.
    if (!hit || hit.settingsModel !== settingsSignature(req.insight)) {
      return next();
    }

    console.info(
      JSON.stringify({
        level: "info",
        event: "insights.cache_hit",
        businessId: req.businessId,
        cacheKey,
      }),
    );

    return res.json({
      data: {
        insights: hit.insights,
        model: hit.model,
        // Nothing was spent on this request.
        usage: null,
        generatedAt: hit.generatedAt.toISOString(),
        cached: true,
      },
    });
  } catch (error) {
    console.warn(
      `[insights] cache read failed for business=${req.businessId}: ${error?.message}`,
    );
    return next();
  }
}

/**
 * The newest answer this business still has for this section, whoever wrote it.
 *
 * Deliberately looser than the cache hit above: it ignores the provider, the
 * model and the date, and keeps only the section and the prompt version (the
 * key is "section:version:date", so everything up to the last colon). A card
 * written by the previous model, or yesterday, still describes this business's
 * own sales — an empty panel describes nothing.
 */
async function findLastAnswer(req) {
  const { cacheKey } = req.insight;
  if (!cacheKey) return null;

  const prefix = cacheKey.slice(0, cacheKey.lastIndexOf(":") + 1);
  if (!prefix) return null;

  return AIInsightCache.findOne({
    businessId: req.businessId,
    // The key's alphabet is validated on the way in, so it holds no regex
    // metacharacters; anchored so one section cannot match another's rows.
    cacheKey: { $regex: `^${prefix}` },
    expiresAt: { $gt: new Date() },
  })
    .sort({ generatedAt: -1 })
    .lean();
}

/**
 * Answer with the last thing we have, when a fresh answer cannot be had.
 *
 * Used where the alternative is an error panel: the hourly limit is spent, or
 * the model returned nothing this app could use. Says so in the reply — the
 * card is marked stale with the reason — so the UI can show the insight and
 * the problem at once rather than pretending the answer is current.
 *
 * Returns whether it answered. Any trouble reading the cache means it did not,
 * and the caller falls back to its own error.
 */
async function serveLastAnswer(req, res, reason) {
  try {
    const hit = await findLastAnswer(req);
    if (!hit) return false;

    console.info(
      JSON.stringify({
        level: "info",
        event: "insights.served_stale",
        businessId: req.businessId,
        cacheKey: req.insight.cacheKey,
        servedFrom: hit.cacheKey,
        model: hit.model,
        reason,
      }),
    );

    res.json({
      data: {
        insights: hit.insights,
        model: hit.model,
        usage: null,
        generatedAt: hit.generatedAt.toISOString(),
        cached: true,
        /** Not today's answer, or not from the model now in use. */
        stale: true,
        /** Why a fresh one could not be had, in the usual vocabulary. */
        staleReason: reason,
      },
    });
    return true;
  } catch (error) {
    console.warn(
      `[insights] stale read failed for business=${req.businessId}: ${error?.message}`,
    );
    return false;
  }
}

/** Keep a fresh answer under its key. Failures are logged, never thrown. */
async function storeInCache(req, { insights, model, generatedAt }) {
  const { cacheKey } = req.insight;
  if (!cacheKey) return;

  try {
    await AIInsightCache.findOneAndUpdate(
      { businessId: req.businessId, cacheKey },
      {
        insights,
        model,
        settingsModel: settingsSignature(req.insight),
        generatedAt,
        expiresAt: new Date(generatedAt.getTime() + CACHE_TTL_MS),
      },
      { upsert: true },
    );
  } catch (error) {
    console.warn(
      `[insights] cache write failed for business=${req.businessId}: ${error?.message}`,
    );
  }
}

/**
 * What is left of this business's hour, and what has already been written
 * today. For the meter on the insights page.
 *
 * Costs nothing and spends nothing: the hour is read from the limiter without
 * charging it, and the day's sections come from the cache this service
 * already keeps. Deliberately says nothing about the provider's own quota —
 * Gemini publishes no such number, and inventing one would be worse than
 * showing none.
 *
 * `date` is the business's own day (the caller knows its timezone; this
 * service does not), and it is only ever matched against a cache key, never
 * stored, so an odd value returns an empty day rather than an error.
 */
router.get("/quota", async (req, res) => {
  const date =
    typeof req.query?.date === "string" && DATE_PATTERN.test(req.query.date)
      ? req.query.date
      : new Date().toISOString().slice(0, 10);

  let sections = [];
  try {
    const rows = await AIInsightCache.find({
      businessId: req.businessId,
      // The key is "section:version:date"; anchored on the date it ends with.
      cacheKey: { $regex: `:${date}$` },
      expiresAt: { $gt: new Date() },
    })
      .select("cacheKey model generatedAt")
      .lean();

    sections = rows.map((row) => ({
      // The section's own name, without the prompt version or the date.
      section: String(row.cacheKey).split(":")[0],
      model: row.model ?? null,
      generatedAt: row.generatedAt?.toISOString() ?? null,
    }));
  } catch (error) {
    // A meter is not worth failing a page over.
    console.warn(
      `[insights] quota read failed for business=${req.businessId}: ${error?.message}`,
    );
  }

  res.json({
    data: {
      hour: quotaGuard.peek(req.businessId),
      today: { date, sections },
    },
  });
});

/** YYYY-MM-DD, and nothing else, before it reaches a query. */
const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

/**
 * In order: refuse what costs nothing, answer from the cache, then count
 * against the hour. Only a request that gets past all three reaches Google.
 */
const beforeGenerating = [prepareInsightRequest, serveCached, quotaGuard];

router.post("/", beforeGenerating, async (req, res) => {
  // Paired with the success log at the end: without a start time, a slow
  // success and a stalled call are indistinguishable from the dashboard.
  const startedAt = Date.now();
  const { briefing, systemInstruction, responseSchema, providerId, credentials } =
    req.insight;

  let apiKey;
  try {
    apiKey = decrypt(credentials.apiKey);
  } catch {
    // decrypt throws when the auth tag does not verify: the record was altered,
    // or it was written under a different AI_ENCRYPTION_KEY. Neither is
    // recoverable here, and re-entering the key is the only fix — so say that
    // rather than letting it surface as a generic 500.
    console.error(
      `[insights] could not decrypt key for business=${req.businessId}`,
    );
    return res.status(500).json({ error: "KEY_UNREADABLE" });
  }

  const result = await getProvider(providerId).generateInsights(apiKey, {
    briefing,
    systemInstruction: systemInstruction || undefined,
    responseSchema: responseSchema || undefined,
    model: credentials.model || undefined,
  });

  if (!result.ok) {
    // One structured line per failed insight call: which tenant, which model,
    // which failure, and how long it took. The briefing is never logged — it
    // is merchant sales data, and logs are the wrong place for it.
    console.warn(
      JSON.stringify({
        level: "warn",
        event: "insights.failed",
        businessId: req.businessId,
        provider: providerId,
        model: credentials.model || null,
        error: result.error,
        durationMs: Date.now() - startedAt,
      }),
    );

    /**
     * The model said nothing usable — so show the last thing that did.
     *
     * Small free models answer empty, truncated or malformed more often than
     * Gemini does, and a merchant who has just switched to one would see eight
     * error panels where there were eight cards a minute ago. The answer is
     * marked stale, so the card can say the current model did not answer.
     */
    if (await serveLastAnswer(req, res, result.error)) return;

    /**
     * 502, not 500. The failure is upstream at the provider, and the codes are
     * the same vocabulary the settings route already speaks, so the frontend's
     * existing error messages cover this route for free.
     */
    return res.status(502).json({ error: result.error });
  }

  /**
   * Parsed when a schema was asked for, raw text otherwise.
   *
   * The model is told to return JSON, not trusted to. A malformed body is
   * reported as its own failure rather than handed to the UI as a string that
   * will not render — and the raw text goes back with it, so the cause is
   * visible without re-running the call and spending the quota twice.
   */
  let insights = result.text;

  if (responseSchema) {
    try {
      insights = JSON.parse(result.text);
    } catch {
      // Logged like any other failure. The call succeeded and was paid for,
      // so a malformed answer is spend with nothing to show — the one failure
      // most worth seeing in the logs, and it was the only silent one.
      console.warn(
        JSON.stringify({
          level: "warn",
          event: "insights.malformed",
          businessId: req.businessId,
          model: result.model,
          usage: result.usage,
          durationMs: Date.now() - startedAt,
        }),
      );
      // Same reasoning as an upstream failure: the merchant is better served
      // by the last answer that parsed than by an error panel.
      if (await serveLastAnswer(req, res, "AI_MALFORMED_RESPONSE")) return;

      return res.status(502).json({
        error: "AI_MALFORMED_RESPONSE",
        raw: result.text.slice(0, 500),
      });
    }
  }

  const generatedAt = new Date();

  // Stored before answering, not after. A reload straight after this reply
  // then finds the answer waiting, instead of racing the write and paying for
  // a second call.
  if (responseSchema) {
    await storeInCache(req, { insights, model: result.model, generatedAt });
  }

  res.json({
    data: {
      insights,
      model: result.model,
      usage: result.usage,
      generatedAt: generatedAt.toISOString(),
      cached: false,
    },
  });

  // The success counterpart to the failure log above: per-call token
  // accounting, so quota spend per tenant is visible without asking Google.
  // `usage` can be all nulls when the provider omits it — still worth logging,
  // because the call itself cost something even when the accounting is missing.
  // `durationMs` pairs with it: a slow success and a failed call look the same
  // from the dashboard, and only this line tells them apart.
  console.info(
    JSON.stringify({
      level: "info",
      event: "insights.generated",
      businessId: req.businessId,
      model: result.model,
      usage: result.usage,
      durationMs: Date.now() - startedAt,
    }),
  );
});

export default router;
