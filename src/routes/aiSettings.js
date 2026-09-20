import { Router } from "express";

import AISettings from "../models/AISettings.js";
import requireBusiness from "../middleware/requireBusiness.js";
import { decrypt, encrypt, maskKey } from "../lib/crypto.js";
// Providers are reached through the registry, never imported directly, so
// these routes read the same whichever one a business uses. `verifyKey` backs
// every check before a key or model is stored — save, a model change through
// PATCH — and POST /test. `suggestModels` runs when one of those checks finds
// the model unavailable, so the refusal can name what the key can use instead.
import {
  DEFAULT_PROVIDER,
  getProvider,
  isProviderId,
  providerCatalogue,
} from "../services/providers.js";
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
  (typeof req.body?.model === "string" && req.body.model.trim()) ||
  typeof req.body?.provider === "string"
    ? verifyGuard(req, res, next)
    : next();

/**
 * Which provider a request is about.
 *
 * The body wins when it names a valid one — that is how a business switches —
 * and the stored choice otherwise. An unknown name is ignored rather than
 * refused: it can only come from a client newer than this service, and
 * falling back to the configured provider is the harmless reading.
 */
const providerIdFor = (req, settings) =>
  isProviderId(req.body?.provider)
    ? req.body.provider
    : (settings?.provider ?? DEFAULT_PROVIDER);

/** The stored credentials for one provider, or null when there are none. */
const credentialsFor = (settings, providerId) =>
  settings?.[providerId]?.apiKey ? settings[providerId] : null;

/** Safe metadata only — never the key, never the ciphertext. */
router.get("/", async (req, res) => {
  const settings = await AISettings.findOne({ businessId: req.businessId });

  // Never having configured AI is a normal state, not a 404.
  if (!settings) {
    return res.json({
      data: {
        provider: DEFAULT_PROVIDER,
        configured: false,
        enabled: false,
        model: null,
        maskedKey: null,
        providers: providerCatalogue(),
      },
    });
  }

  res.json({
    data: {
      ...settings.toSafeJSON(),
      // Sent with the settings so the form can offer the choices without a
      // second request. Names and links only — never a credential.
      providers: providerCatalogue(),
      // Which other providers already hold a key, so switching can say
      // whether it will need one.
      configuredProviders: providerCatalogue()
        .map((p) => p.id)
        .filter((id) => Boolean(settings[id]?.apiKey)),
    },
  });
});

/** Set or replace the key, for the provider named in the body or in use. */
router.post("/", verifyGuard, async (req, res) => {
  const apiKey =
    typeof req.body?.apiKey === "string" ? req.body.apiKey.trim() : "";
  const model =
    typeof req.body?.model === "string" ? req.body.model.trim() : "";

  if (!apiKey) {
    return res.status(400).json({ error: "API_KEY_REQUIRED" });
  }

  const existing = await AISettings.findOne({ businessId: req.businessId });
  const providerId = providerIdFor(req, existing);
  const provider = getProvider(providerId);

  // ── Ask the provider before storing ──────────────────────────────────────
  // A key that cannot make a call is worse than no key at all: it saves
  // cleanly, and the failure only surfaces later inside a feature that then
  // looks broken for some unrelated reason. One cheap call here costs a second
  // and turns that into a sentence next to the field the user just typed in.
  const check = await provider.verifyKey(apiKey, model || undefined);
  if (!check.ok) {
    // A missing model is otherwise a dead end — the key is fine and the user
    // has no way to know what to put instead. Ask the provider what this key
    // can actually use and hand the names back.
    if (check.error === "AI_MODEL_UNAVAILABLE") {
      const available = await provider.suggestModels(apiKey);
      return res.status(400).json({ error: check.error, available });
    }
    // `detail` is the provider's own sentence, when it gave one: "no quota
    // left" is a kind of problem, and only they can say which plan or limit.
    return res.status(400).json({ error: check.error, detail: check.detail });
  }

  const settings = await AISettings.findOneAndUpdate(
    { businessId: req.businessId },
    {
      businessId: req.businessId,
      // Saving a key also selects that provider: nobody adds a key for a
      // provider they did not mean to start using.
      provider: providerId,
      [`${providerId}.apiKey`]: encrypt(apiKey),
      [`${providerId}.maskedKey`]: maskKey(apiKey),
      [`${providerId}.enabled`]: true,
      // Records a check that actually happened: this line is only reached
      // after the block above returned ok.
      [`${providerId}.lastVerifiedAt`]: new Date(),
      // The model that was just verified, not the one requested. When no model
      // is supplied these are the same, but pinning it here means the stored
      // model can never drift from the one the key was tested against — which
      // is the failure mode that passes at save and breaks in production.
      [`${providerId}.model`]: check.model,
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

  const current = await AISettings.findOne({ businessId: req.businessId });
  const providerId = providerIdFor(req, current);

  /**
   * Switching provider is only allowed to one that already holds a key.
   *
   * Otherwise the switch would leave the business "configured" with nothing
   * to call, and every insight would fail with a code that sounds like the
   * provider's fault. Add the key first; saving it selects the provider.
   */
  if (isProviderId(req.body?.provider) && req.body.provider !== current?.provider) {
    if (!credentialsFor(current, providerId)) {
      return res.status(400).json({ error: "PROVIDER_NOT_CONFIGURED" });
    }
    update.provider = providerId;
  }

  if (typeof req.body?.enabled === "boolean") {
    update[`${providerId}.enabled`] = req.body.enabled;
  }

  if (model) {
    if (!credentialsFor(current, providerId)) {
      return res.status(404).json({ error: "NOT_CONFIGURED" });
    }

    let apiKey;
    try {
      apiKey = decrypt(current[providerId].apiKey);
    } catch {
      return res.status(500).json({ error: "KEY_UNREADABLE" });
    }

    const provider = getProvider(providerId);
    const check = await provider.verifyKey(apiKey, model);
    if (!check.ok) {
      if (check.error === "AI_MODEL_UNAVAILABLE") {
        const available = await provider.suggestModels(apiKey);
        return res.status(400).json({ error: check.error, available });
      }
      return res.status(400).json({ error: check.error, detail: check.detail });
    }

    update[`${providerId}.model`] = check.model;
    // The check above just happened, against this model and this key.
    update[`${providerId}.lastVerifiedAt`] = new Date();
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

/** Forget the key for the provider in use, and turn it off. */
router.delete("/", async (req, res) => {
  const current = await AISettings.findOne({ businessId: req.businessId });
  const providerId = providerIdFor(req, current);

  await AISettings.findOneAndUpdate(
    { businessId: req.businessId },
    {
      [`${providerId}.apiKey`]: null,
      [`${providerId}.maskedKey`]: null,
      [`${providerId}.enabled`]: false,
      [`${providerId}.lastVerifiedAt`]: null,
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

  const settings = await AISettings.findOne({ businessId: req.businessId });
  const providerId = providerIdFor(req, settings);

  if (!apiKey) {
    if (!credentialsFor(settings, providerId)) {
      return res.status(404).json({ error: "NOT_CONFIGURED" });
    }
    try {
      apiKey = decrypt(settings[providerId].apiKey);
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

  const check = await getProvider(providerId).verifyKey(apiKey, model);
  if (!check.ok) {
    return res.status(400).json({ error: check.error, detail: check.detail });
  }

  res.json({ data: { ok: true, model: check.model } });
});

/**
 * The models the stored key can actually call.
 *
 * Only offered for a saved key: the list is fetched from the provider using
 * the stored credential, so without one there is nothing to ask about — and
 * that 404 is what gates the model selector in the settings UI. Rate-limited
 * like /test, because listing models is a live upstream call and the settings
 * form is exactly where a retry loop happens.
 */
router.get("/models", verifyGuard, async (req, res) => {
  const settings = await AISettings.findOne({ businessId: req.businessId });
  const providerId = isProviderId(req.query?.provider)
    ? req.query.provider
    : (settings?.provider ?? DEFAULT_PROVIDER);

  if (!credentialsFor(settings, providerId)) {
    return res.status(404).json({ error: "NOT_CONFIGURED" });
  }

  let apiKey;
  try {
    apiKey = decrypt(settings[providerId].apiKey);
  } catch {
    // The ciphertext no longer verifies — the record was altered or the
    // encryption key rotated. KEY_UNREADABLE, the same code the insights route
    // uses: AI_KEY_INVALID told the merchant the provider had rejected a key
    // it never saw, and sent them to check a key that was fine.
    return res.status(500).json({ error: "KEY_UNREADABLE" });
  }

  const list = await getProvider(providerId).listModels(apiKey);
  if (!list.ok) {
    return res.status(400).json({ error: list.error });
  }

  res.json({
    data: {
      provider: providerId,
      models: list.models,
      current: settings[providerId]?.model ?? null,
    },
  });
});

export default router;
