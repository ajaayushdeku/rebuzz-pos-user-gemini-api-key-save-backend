import { Router } from "express";

import AISettings from "../models/AISettings.js";
import requireBusiness from "../middleware/requireBusiness.js";
import { decrypt } from "../lib/crypto.js";
import { generateInsights } from "../services/gemini.js";

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

router.post("/", async (req, res) => {
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
});

export default router;
