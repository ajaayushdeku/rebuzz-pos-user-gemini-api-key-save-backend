import { Router } from "express";

import AISettings from "../models/AISettings.js";
import requireBusiness from "../middleware/requireBusiness.js";
import { decrypt, encrypt, maskKey } from "../lib/crypto.js";
// verifyGeminiKey backs both the save-time check in POST / and POST /test.
// suggestFlashModels is reachable only through the save-time check, which is
// the one place a model can be found to be unavailable before it is stored.
import { suggestFlashModels, verifyGeminiKey } from "../services/gemini.js";
import { verifyRateLimit } from "../lib/rateLimit.js";

const router = Router();

// Every route below is scoped to one business. No exceptions.
router.use(requireBusiness);

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
router.post("/", async (req, res) => {
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

/** Toggle `enabled` or change the model. Deliberately cannot set the key. */
router.patch("/", async (req, res) => {
  const update = {};

  if (typeof req.body?.enabled === "boolean") {
    update["gemini.enabled"] = req.body.enabled;
  }
  if (typeof req.body?.model === "string" && req.body.model.trim()) {
    update["gemini.model"] = req.body.model.trim();
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
router.post("/test", verifyRateLimit(), async (req, res) => {
  const provided =
    typeof req.body?.apiKey === "string" ? req.body.apiKey.trim() : "";
  let apiKey = provided;

  if (!apiKey) {
    const settings = await AISettings.findOne({ businessId: req.businessId });
    if (!settings?.gemini?.apiKey) {
      return res.status(404).json({ error: "NOT_CONFIGURED" });
    }
    apiKey = decrypt(settings.gemini.apiKey);
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

export default router;
