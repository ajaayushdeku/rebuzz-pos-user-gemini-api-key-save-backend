import { Router } from "express";

import AISettings from "../models/AISettings.js";
import requireBusiness from "../middleware/requireBusiness.js";
import { decrypt } from "../lib/crypto.js";
import { generateInsights } from "../services/gemini.js";
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
 * One limiter for the route, created once. Built per request, every call would
 * get a fresh empty bucket and nothing would ever be limited.
 */
const quotaGuard = insightsRateLimit();

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

  const settings = await AISettings.findOne({ businessId: req.businessId });

  /**
   * 424 for both "no key" and "switched off".
   *
   * Failed Dependency, because nothing is wrong with the request: a
   * precondition the merchant controls is missing. The frontend can treat the
   * status alone as "send them to settings" while the code decides which
   * sentence to show, so neither case reads as a crash.
   */
  if (!settings?.gemini?.apiKey) {
    return res.status(424).json({ error: "NOT_CONFIGURED" });
  }
  if (!settings.gemini.enabled) {
    return res.status(424).json({ error: "AI_DISABLED" });
  }

  req.insight = { briefing, systemInstruction, responseSchema, settings };
  next();
}

router.post("/", prepareInsightRequest, quotaGuard, async (req, res) => {
  // Paired with the success log at the end: without a start time, a slow
  // success and a stalled call are indistinguishable from the dashboard.
  const startedAt = Date.now();
  const { briefing, systemInstruction, responseSchema, settings } =
    req.insight;

  let apiKey;
  try {
    apiKey = decrypt(settings.gemini.apiKey);
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

  const result = await generateInsights(apiKey, {
    briefing,
    systemInstruction: systemInstruction || undefined,
    responseSchema: responseSchema || undefined,
    model: settings.gemini.model || undefined,
  });

  if (!result.ok) {
    /**
     * 502, not 500. The failure is upstream at Google, and the codes are the
     * same vocabulary the settings route already speaks, so the frontend's
     * existing error messages cover this route for free.
     */
    // One structured line per failed insight call: which tenant, which model,
    // which failure, and how long it took. The briefing is never logged — it
    // is merchant sales data, and logs are the wrong place for it.
    console.warn(
      JSON.stringify({
        level: "warn",
        event: "insights.failed",
        businessId: req.businessId,
        model: settings.gemini.model || null,
        error: result.error,
        durationMs: Date.now() - startedAt,
      }),
    );
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
      return res.status(502).json({
        error: "GEMINI_MALFORMED_RESPONSE",
        raw: result.text.slice(0, 500),
      });
    }
  }

  res.json({
    data: {
      insights,
      model: result.model,
      usage: result.usage,
      generatedAt: new Date().toISOString(),
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
