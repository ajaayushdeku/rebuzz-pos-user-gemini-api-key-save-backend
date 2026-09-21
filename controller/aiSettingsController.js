const { AISettings } = require("../models");
const { decrypt, encrypt, maskKey } = require("../helpers/aiCrypto");
// Providers are reached through the registry, never imported directly, so
// these handlers read the same whichever one a business uses. `verifyKey`
// backs every check before a key or model is stored — save, a model change
// through PATCH — and POST /test. `suggestModels` runs when one of those
// checks finds the model unavailable, so the refusal can name what the key can
// use instead.
const {
  DEFAULT_PROVIDER,
  getProvider,
  isProviderId,
  providerCatalogue,
} = require("../helpers/aiProviders");

/**
 * Message only. Provider SDK error objects can echo the request back, key
 * included, and two of these routes carry a raw key in their body.
 */
const internalError = (res, err) => {
  console.error("[error]", err?.message ?? err);
  return res.status(500).json({ error: "INTERNAL_ERROR" });
};

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

/**
 * Refusals that mean "not in your plan" when they arrive on a first request:
 * a per-minute limit, or a spent quota. Anything else is a real answer about
 * the key and is reported as it is.
 */
const PLAN_LIMIT_CODES = new Set(["AI_RATE_LIMIT", "AI_QUOTA_EXCEEDED"]);

/** How many other models to try before concluding the plan allows none. */
const FALLBACK_ATTEMPTS = 3;

/**
 * The first model this key can actually call, other than the one that failed.
 *
 * Asks the provider for its list rather than guessing names, and stops after a
 * few: every attempt is a real request against a key that may genuinely be
 * limited, and a merchant waiting on a save button should not wait through a
 * provider's whole catalogue.
 */
const firstWorkingModel = async (provider, apiKey, failedModel) => {
  const candidates = (await provider.suggestModels(apiKey))
    .filter((name) => name && name !== failedModel)
    .slice(0, FALLBACK_ATTEMPTS);

  for (const name of candidates) {
    const attempt = await provider.verifyKey(apiKey, name);
    if (attempt.ok) return attempt;
  }
  return null;
};

const aiSettingsController = {
  /** Safe metadata only — never the key, never the ciphertext. */
  async getSettings(req, res) {
    try {
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
          ...settings.formatted(req),
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
    } catch (err) {
      internalError(res, err);
    }
  },

  /** Set or replace the key, for the provider named in the body or in use. */
  async saveKey(req, res) {
    try {
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

      // ── Ask the provider before storing ────────────────────────────────────
      // A key that cannot make a call is worse than no key at all: it saves
      // cleanly, and the failure only surfaces later inside a feature that then
      // looks broken for some unrelated reason. One cheap call here costs a
      // second and turns that into a sentence next to the field the user just
      // typed in.
      let check = await provider.verifyKey(apiKey, model || undefined);

      /**
       * A limit on the very first request is the plan, not traffic.
       *
       * A key that was just created has made no calls, so "rate limit
       * exceeded" on its first one cannot mean it made too many. It means the
       * model tried has no allowance on this account — Mistral, for one, sets
       * limits per model, and its free plan leaves some models at zero. The key
       * itself is fine; the default model just is not in the plan. So try the
       * models the key can see before giving up, and keep the first that
       * answers.
       *
       * Only when the merchant did not name a model: if they chose one,
       * telling them it is refused is the answer, not quietly swapping it for
       * another.
       */
      let fellBackFrom = null;
      if (!check.ok && !model && PLAN_LIMIT_CODES.has(check.error)) {
        const fallback = await firstWorkingModel(
          provider,
          apiKey,
          check.model ?? provider.defaultModel,
        );
        if (fallback) {
          fellBackFrom = provider.defaultModel;
          check = fallback;
        } else {
          // Every model refused the same way. Said as what it almost certainly
          // is, since "try again shortly" would send them to wait for nothing.
          return res.status(400).json({
            error: "AI_PLAN_LIMIT",
            detail: check.detail,
          });
        }
      }

      if (!check.ok) {
        // A missing model is otherwise a dead end — the key is fine and the
        // user has no way to know what to put instead. Ask the provider what
        // this key can actually use and hand the names back.
        if (check.error === "AI_MODEL_UNAVAILABLE") {
          const available = await provider.suggestModels(apiKey);
          return res.status(400).json({ error: check.error, available });
        }
        // `detail` is the provider's own sentence, when it gave one: "no quota
        // left" is a kind of problem, and only they can say which plan or
        // limit.
        return res
          .status(400)
          .json({ error: check.error, detail: check.detail });
      }

      const settings = await AISettings.findOneAndUpdate(
        { businessId: req.businessId },
        {
          businessId: req.businessId,
          adminId: req.adminId,
          // Saving a key also selects that provider: nobody adds a key for a
          // provider they did not mean to start using.
          provider: providerId,
          [`${providerId}.apiKey`]: encrypt(apiKey),
          [`${providerId}.maskedKey`]: maskKey(apiKey),
          [`${providerId}.enabled`]: true,
          // Records a check that actually happened: this line is only reached
          // after the block above returned ok.
          [`${providerId}.lastVerifiedAt`]: new Date(),
          // The model that was just verified, not the one requested. When no
          // model is supplied these are the same, but pinning it here means the
          // stored model can never drift from the one the key was tested
          // against — which is the failure mode that passes at save and breaks
          // in production.
          [`${providerId}.model`]: check.model,
        },
        { new: true, upsert: true, setDefaultsOnInsert: true },
      );

      res.json({
        data: {
          ...settings.formatted(req),
          // Set when the default model was refused and another was kept, so
          // the form can say which — a merchant who later wonders why insights
          // come from a model they never picked should have been told when it
          // happened.
          ...(fellBackFrom ? { fellBackFrom } : {}),
        },
      });
    } catch (err) {
      internalError(res, err);
    }
  },

  /**
   * Toggle `enabled`, change the model, or switch provider. Deliberately
   * cannot set the key.
   *
   * A model change is checked against the stored key before it is written.
   * Save already refuses to store a model the key cannot call, and without the
   * same check here PATCH was a side door around it: any string was accepted,
   * reported as "Model updated", and left `lastVerifiedAt` still claiming a
   * check the new model never had.
   */
  async updateSettings(req, res) {
    try {
      const update = {};
      const model =
        typeof req.body?.model === "string" ? req.body.model.trim() : "";

      const current = await AISettings.findOne({ businessId: req.businessId });
      const providerId = providerIdFor(req, current);

      /**
       * Switching provider is only allowed to one that already holds a key.
       *
       * Otherwise the switch would leave the business "configured" with
       * nothing to call, and every insight would fail with a code that sounds
       * like the provider's fault. Add the key first; saving it selects the
       * provider.
       */
      if (
        isProviderId(req.body?.provider) &&
        req.body.provider !== current?.provider
      ) {
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
          return res
            .status(400)
            .json({ error: check.error, detail: check.detail });
        }

        update[`${providerId}.model`] = check.model;
        // The check above just happened, against this model and this key.
        update[`${providerId}.lastVerifiedAt`] = new Date();
      }

      if (Object.keys(update).length === 0) {
        return res.status(400).json({ error: "NOTHING_TO_UPDATE" });
      }

      // Records written before adminId existed pick it up on their next change.
      update.adminId = req.adminId;

      const settings = await AISettings.findOneAndUpdate(
        { businessId: req.businessId },
        update,
        { new: true },
      );

      if (!settings) {
        return res.status(404).json({ error: "NOT_CONFIGURED" });
      }

      res.json({ data: settings.formatted(req) });
    } catch (err) {
      internalError(res, err);
    }
  },

  /** Forget the key for the provider in use, and turn it off. */
  async deleteKey(req, res) {
    try {
      const current = await AISettings.findOne({ businessId: req.businessId });
      const providerId = providerIdFor(req, current);

      await AISettings.findOneAndUpdate(
        { businessId: req.businessId },
        {
          adminId: req.adminId,
          [`${providerId}.apiKey`]: null,
          [`${providerId}.maskedKey`]: null,
          [`${providerId}.enabled`]: false,
          [`${providerId}.lastVerifiedAt`]: null,
        },
      );

      // Idempotent: deleting a key that was never there is a success.
      res.json({ data: { configured: false, enabled: false } });
    } catch (err) {
      internalError(res, err);
    }
  },

  /**
   * Test a key without committing it — or re-test the stored one.
   *
   * Authenticated like everything else. An open version of this would be a
   * free oracle for checking whether stolen keys are still live.
   */
  async testKey(req, res) {
    try {
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
          // Uncaught, this fell through to the generic 500 and the form could
          // only say "something went wrong".
          return res.status(500).json({ error: "KEY_UNREADABLE" });
        }
      }

      const model =
        typeof req.body?.model === "string" && req.body.model.trim()
          ? req.body.model.trim()
          : undefined;

      const check = await getProvider(providerId).verifyKey(apiKey, model);
      if (!check.ok) {
        return res
          .status(400)
          .json({ error: check.error, detail: check.detail });
      }

      res.json({ data: { ok: true, model: check.model } });
    } catch (err) {
      internalError(res, err);
    }
  },

  /**
   * The models the stored key can actually call.
   *
   * Only offered for a saved key: the list is fetched from the provider using
   * the stored credential, so without one there is nothing to ask about — and
   * that 404 is what gates the model selector in the settings UI.
   */
  async listModels(req, res) {
    try {
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
        // encryption key rotated. KEY_UNREADABLE, the same code the insights
        // route uses: AI_KEY_INVALID told the merchant the provider had
        // rejected a key it never saw.
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
    } catch (err) {
      internalError(res, err);
    }
  },
};

module.exports = { aiSettingsController, firstWorkingModel };
