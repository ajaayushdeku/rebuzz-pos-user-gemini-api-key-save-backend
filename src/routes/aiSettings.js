import { Router } from "express";

import AISettings from "../models/AISettings.js";
import requireBusiness from "../middleware/requireBusiness.js";
import { decrypt, encrypt, maskKey } from "../lib/crypto.js";
// verifyGeminiKey / suggestFlashModels are used by POST /test below, and by
// the paused verification block in POST /.
import { verifyGeminiKey } from "../services/gemini.js";

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

  // ── Gemini verification, paused ──────────────────────────────────────────
  // Deliberately skipped for now: the key is stored without asking Google
  // whether it works. That means an unusable key saves cleanly and only fails
  // when a real AI feature runs, so `lastVerifiedAt` stays null below — the
  // record should not claim a check that never happened.
  //
  // Restore this block, and the lastVerifiedAt line, to turn validation back
  // on. `POST /test` still verifies on demand in the meantime.
  //
  // const check = await verifyGeminiKey(apiKey, model || undefined);
  // if (!check.ok) {
  //   // A missing model is otherwise a dead end — the key is fine and the
  //   // user has no way to know what to put instead. Ask Google what this key
  //   // can actually use and hand the names back.
  //   if (check.error === "GEMINI_MODEL_UNAVAILABLE") {
  //     const available = await suggestFlashModels(apiKey);
  //     return res.status(400).json({ error: check.error, available });
  //   }
  //   return res.status(400).json({ error: check.error });
  // }

  const settings = await AISettings.findOneAndUpdate(
    { businessId: req.businessId },
    {
      businessId: req.businessId,
      "gemini.apiKey": encrypt(apiKey),
      "gemini.maskedKey": maskKey(apiKey),
      "gemini.enabled": true,
      // Null while verification is paused — see the block above. Stamping a
      // date here would record a check that did not happen.
      "gemini.lastVerifiedAt": null,
      ...(model ? { "gemini.model": model } : {}),
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
 */
router.post("/test", async (req, res) => {
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
