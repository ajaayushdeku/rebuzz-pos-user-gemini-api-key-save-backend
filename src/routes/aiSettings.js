import { Router } from "express";

import AISettings from "../models/AISettings.js";
import requireBusiness from "../middleware/requireBusiness.js";
import { decrypt, encrypt, maskKey } from "../lib/crypto.js";
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

  // Verified before it is stored. A typo'd key accepted silently surfaces
  // days later as a broken dashboard nobody can explain.
  const check = await verifyGeminiKey(apiKey, model || undefined);
  if (!check.ok) {
    return res.status(400).json({ error: check.error });
  }

  const settings = await AISettings.findOneAndUpdate(
    { businessId: req.businessId },
    {
      businessId: req.businessId,
      "gemini.apiKey": encrypt(apiKey),
      "gemini.maskedKey": maskKey(apiKey),
      "gemini.enabled": true,
      "gemini.lastVerifiedAt": new Date(),
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
