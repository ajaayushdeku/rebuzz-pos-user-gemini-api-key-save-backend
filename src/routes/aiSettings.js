import { Router } from "express";

import AISettings from "../models/AISettings.js";
import requireBusiness from "../middleware/requireBusiness.js";
import { decrypt, encrypt, maskKey } from "../lib/crypto.js";
// verifyGeminiKey backs every check before a key or model is stored — save,
// a model change through PATCH — and POST /test. suggestFlashModels runs when
// one of those checks finds the model unavailable, so the refusal can name
// what the key can use instead.
import {
  listAvailableModels,
  suggestFlashModels,
  verifyGeminiKey,
} from "../services/gemini.js";
import { verifyRateLimit } from "../lib/rateLimit.js";

const router = Router();

// Every route below is scoped to one business. No exceptions.
router.use(requireBusiness);

/**
 * One budget for every live call these routes make to Google.
 *
 * Created once and shared. Calling `verifyRateLimit()` separately on each route
 * built an independent bucket per route, so a business had ten checks a minute
 * on /test, another ten on /models, and no limit at all on save — which is the
 * button a double-click actually lands on.
 */
const verifyGuard = verifyRateLimit();

/**
 * PATCH only reaches Google when it changes the model; toggling `enabled` is a
 * database write and should not spend the budget.
 */
const guardModelChange = (req, res, next) =>
  typeof req.body?.model === "string" && req.body.model.trim()
    ? verifyGuard(req, res, next)
    : next();

/** Safe metadata only — never the key, never the ciphertext. */
router.get("/", async (req, res) => {
  const settings = await AISettings.findOne({ businessId: req.businessId });

  // Never having configured AI is a normal state, not a 404.
  if (!settings) {
    return res.json({
      data: { configured: false, enabled: false, model: null, maskedKey: null },
    });
  }

  res.json({ data: settings.toSafeJSON() });
});

/** Set or replace the key. */
router.post("/", verifyGuard, async (req, res) => {
  const apiKey =
    typeof req.body?.apiKey === "string" ? req.body.apiKey.trim() : "";
  const model =
    typeof req.body?.model === "string" ? req.body.model.trim() : "";

  if (!apiKey) {
    return res.status(400).json({ error: "API_KEY_REQUIRED" });
  }

  // ── Ask Google before storing ────────────────────────────────────────────
  // A key that cannot make a call is worse than no key at all: it saves
  // cleanly, and the failure only surfaces later inside a feature that then
  // looks broken for some unrelated reason. One cheap call here costs a second
  // and turns that into a sentence next to the field the user just typed in.
  const check = await verifyGeminiKey(apiKey, model || undefined);
  if (!check.ok) {
    // A missing model is otherwise a dead end — the key is fine and the user
    // has no way to know what to put instead. Ask Google what this key can
    // actually use and hand the names back.
    if (check.error === "GEMINI_MODEL_UNAVAILABLE") {
      const available = await suggestFlashModels(apiKey);
      return res.status(400).json({ error: check.error, available });
    }
    return res.status(400).json({ error: check.error });
  }

  const settings = await AISettings.findOneAndUpdate(
    { businessId: req.businessId },
    {
      businessId: req.businessId,
      "gemini.apiKey": encrypt(apiKey),
      "gemini.maskedKey": maskKey(apiKey),
      "gemini.enabled": true,
      // Records a check that actually happened: this line is only reached
      // after the block above returned ok.
      "gemini.lastVerifiedAt": new Date(),
      // The model that was just verified, not the one requested. When no model
      // is supplied these are the same, but pinning it here means the stored
      // model can never drift from the one the key was tested against — which
      // is the failure mode that passes at save and breaks in production.
      "gemini.model": check.model,
    },
    { new: true, upsert: true, setDefaultsOnInsert: true },
  );

  res.json({ data: settings.toSafeJSON() });
});

/**
 * Toggle `enabled` or change the model. Deliberately cannot set the key.
 *
 * A model change is checked against the stored key before it is written. Save
 * already refuses to store a model the key cannot call — it pins "the model
 * that was just verified" for exactly that reason — and without the same check
 * here, PATCH was a side door around it: any string was accepted, reported as
 * "Model updated", and left `lastVerifiedAt` still claiming a check the new
 * model never had. The failure then surfaced later, inside an insight card, as
 * an error about a model the merchant had just been told was fine.
 */
router.patch("/", guardModelChange, async (req, res) => {
  const update = {};
  const model =
    typeof req.body?.model === "string" ? req.body.model.trim() : "";

  if (typeof req.body?.enabled === "boolean") {
    update["gemini.enabled"] = req.body.enabled;
  }

  if (model) {
    const current = await AISettings.findOne({ businessId: req.businessId });
    if (!current?.gemini?.apiKey) {
      return res.status(404).json({ error: "NOT_CONFIGURED" });
    }

    let apiKey;
    try {
      apiKey = decrypt(current.gemini.apiKey);
    } catch {
      return res.status(500).json({ error: "KEY_UNREADABLE" });
    }

    const check = await verifyGeminiKey(apiKey, model);
    if (!check.ok) {
      if (check.error === "GEMINI_MODEL_UNAVAILABLE") {
        const available = await suggestFlashModels(apiKey);
        return res.status(400).json({ error: check.error, available });
      }
      return res.status(400).json({ error: check.error });
    }

    update["gemini.model"] = check.model;
    // The check above just happened, against this model and this key.
    update["gemini.lastVerifiedAt"] = new Date();
  }

  if (Object.keys(update).length === 0) {
    return res.status(400).json({ error: "NOTHING_TO_UPDATE" });
  }

  const settings = await AISettings.findOneAndUpdate(
    { businessId: req.businessId },
    update,
    { new: true },
  );

  if (!settings) {
    return res.status(404).json({ error: "NOT_CONFIGURED" });
  }

  res.json({ data: settings.toSafeJSON() });
});

/** Forget the key and turn Gemini off. */
router.delete("/", async (req, res) => {
  await AISettings.findOneAndUpdate(
    { businessId: req.businessId },
    {
      "gemini.apiKey": null,
      "gemini.maskedKey": null,
      "gemini.enabled": false,
      "gemini.lastVerifiedAt": null,
    },
  );

  // Idempotent: deleting a key that was never there is a success.
  res.json({ data: { configured: false, enabled: false } });
});

/**
 * Test a key without committing it — or re-test the stored one.
 *
 * Authenticated like everything else. An open version of this would be a free
 * oracle for checking whether stolen Gemini keys are still live.
 *
 * Rate-limited per business: verifying is a live Google call, and the settings
 * form is exactly where a double-click or impatient retry happens.
 */
router.post("/test", verifyGuard, async (req, res) => {
  const provided =
    typeof req.body?.apiKey === "string" ? req.body.apiKey.trim() : "";
  let apiKey = provided;

  if (!apiKey) {
    const settings = await AISettings.findOne({ businessId: req.businessId });
    if (!settings?.gemini?.apiKey) {
      return res.status(404).json({ error: "NOT_CONFIGURED" });
    }
    try {
      apiKey = decrypt(settings.gemini.apiKey);
    } catch {
      // Uncaught, this fell through to the generic 500 handler and the form
      // could only say "something went wrong".
      return res.status(500).json({ error: "KEY_UNREADABLE" });
    }
  }

  const model =
    typeof req.body?.model === "string" && req.body.model.trim()
      ? req.body.model.trim()
      : undefined;

  const check = await verifyGeminiKey(apiKey, model);
  if (!check.ok) {
    return res.status(400).json({ error: check.error });
  }

  res.json({ data: { ok: true, model: check.model } });
});

/**
 * The models the stored key can actually call.
 *
 * Only offered for a saved key: the list is fetched from Google using the
 * stored credential, so without one there is nothing to ask about — and that
 * 404 is what gates the model selector in the settings UI. Rate-limited like
 * /test, because listing models is a live Google call and the settings form
 * is exactly where a retry loop happens.
 */
router.get("/models", verifyGuard, async (req, res) => {
  const settings = await AISettings.findOne({ businessId: req.businessId });
  if (!settings?.gemini?.apiKey) {
    return res.status(404).json({ error: "NOT_CONFIGURED" });
  }

  let apiKey;
  try {
    apiKey = decrypt(settings.gemini.apiKey);
  } catch {
    // The ciphertext no longer verifies — the record was altered or the
    // encryption key rotated. KEY_UNREADABLE, the same code the insights route
    // uses: GEMINI_KEY_INVALID told the merchant Google had rejected a key that
    // Google never saw, and sent them to check a key that was fine.
    return res.status(500).json({ error: "KEY_UNREADABLE" });
  }

  const list = await listAvailableModels(apiKey);
  if (!list.ok) {
    return res.status(400).json({ error: list.error });
  }

  res.json({
    data: {
      models: list.models,
      current: settings.gemini.model ?? null,
    },
  });
});

export default router;
