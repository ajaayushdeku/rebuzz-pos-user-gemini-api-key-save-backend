const { aiFail, aiSuccess, aiInternalError } = require("../helpers/aiResponse");

const { aiInsightsStore } = require("../data/aiInsightsStore");

const AISettings = require("../models/aiSettings");
const AIInsightCache = require("../models/aiInsightCache");

const { DEFAULT_PROVIDER } = require("../helpers/aiProviders");
const { generateWithFallback } = require("../helpers/aiProviders/fallback");

const { runOnce } = require("../helpers/inFlight");

const {
  DEFAULT_PERIOD_KIND,
  describePeriod,
  isPeriodKind,
  periodCatalogue,
  previousClosedPeriod,
  recentClosedPeriods,
} = require("../helpers/analyticsPeriods");

const {
  PERIOD_SECTIONS,
  isPeriodSection,
  isPromptVersion,
  isSectionName,
  supportsMore,
} = require("../helpers/insightSections");

const isValidMongoId = (value) =>
  typeof value === "string" && /^[a-f\d]{24}$/i.test(value);

/**
 * Insights about a completed analytics period, stored once and read back after.
 *
 * September's figures are final, so an answer about September is final too.
 * Reading costs nothing and is open to any staff member; generating spends
 * the merchant's provider quota and is the admin's decision alone.
 *
 * The caller builds the briefing from POS reports. This controller decides
 * whether an answer is needed, generates it, caches the raw answer, and stores
 * the finished cards when the caller sends them back.
 *
 * Provider generation uses automatic fallback when the selected provider
 * encounters an eligible quota, rate-limit, payment, model, or availability
 * failure and another explicitly enabled fallback provider is configured.
 */

/** Roughly four thousand tokens of input, as on the day-scoped route. */
const MAX_BRIEFING_CHARS = 16_000;
const MAX_INSTRUCTION_CHARS = 4_000;

/** Matches MAX_MORE_BATCHES in the frontend's sections/shared.ts. */
const MAX_BATCHES = 5;

/** A note of what the answer was based on, not a second briefing. */
const MAX_BASIS_KEYS = 24;

/**
 * How long a paid draft is kept while the caller joins it onto the figures.
 *
 * A day, not a few minutes: it is there so that the store half failing costs
 * a retry rather than another provider call.
 */
const DRAFT_TTL_MS = 26 * 60 * 60 * 1000;

const internalError = (res, err) => aiInternalError(res, err);

/**
 * Identifies the provider and model used for a generated answer.
 *
 * This is used to determine whether a cached draft still belongs to the
 * currently selected provider/model configuration.
 */
const signatureOf = (providerId, credentials) =>
  `${providerId}:${credentials?.model || ""}`;

/**
 * Split a parsed answer into the cards and everything else.
 *
 * `items` is stored as its own array so a further batch can be appended
 * atomically; the rest of whatever the section's schema asked for — `windows`,
 * `reason` — travels beside it untouched.
 */
const splitAnswer = (parsed) => {
  if (Array.isArray(parsed)) {
    return { items: parsed, extra: null };
  }

  if (parsed && typeof parsed === "object") {
    const { items, ...extra } = parsed;

    return {
      items: Array.isArray(items) ? items : [],
      extra: Object.keys(extra).length > 0 ? extra : null,
    };
  }

  // A section with no schema has no cards to store; keep the text as extra so
  // nothing is silently dropped.
  return {
    items: [],
    extra: parsed == null ? null : { text: parsed },
  };
};

const periodInsightsController = {
  /**
   * Turn `:kind/:id` into a period, or refuse.
   *
   * `latest` is accepted as the id and means "the most recent completed one".
   *
   * Only closed periods are allowed. An open one's figures are still moving,
   * so storing an answer permanently would make stale information permanent.
   */
  resolvePeriod(req, res, next) {
    const { kind, id } = req.params;

    if (!isPeriodKind(kind)) {
      return aiFail(res, 400, "INVALID_PERIOD_KIND");
    }

    const period =
      id === "latest" ? previousClosedPeriod(kind) : describePeriod(kind, id);

    if (!period) {
      return aiFail(res, 400, "INVALID_PERIOD");
    }

    if (!period.closed) {
      return aiFail(res, 400, "PERIOD_NOT_CLOSED", {
        detail: `${period.label} has not finished yet.`,
      });
    }

    req.period = period;
    next();
  },

  /**
   * The periods a business can look at, and which already have insights.
   *
   * Two things joined: what the calendar offers, and what has been generated.
   */
  async listPeriods(req, res) {
    try {
      const kind = isPeriodKind(req.query?.kind)
        ? req.query.kind
        : DEFAULT_PERIOD_KIND;

      // 12 months, 4 quarters, 2 years.
      const depth = { month: 12, quarter: 4, year: 2 }[kind] ?? 12;

      const [periods, stored] = await Promise.all([
        Promise.resolve(recentClosedPeriods(kind, depth)),
        aiInsightsStore.listPeriods(req.businessId, kind, depth),
      ]);

      const byId = new Map(stored.map((row) => [row.id, row]));

      aiSuccess(res, {
        kinds: periodCatalogue(),
        kind,
        default: previousClosedPeriod(kind).id,
        totalSections: PERIOD_SECTIONS.length,

        periods: periods.map((period) => {
          const row = byId.get(period.id);

          return {
            kind: period.kind,
            id: period.id,
            label: period.label,
            from: period.from,
            to: period.to,
            generatedSections: row?.sectionCount ?? 0,
            lastGeneratedAt: row?.lastGeneratedAt ?? null,
          };
        }),
      });
    } catch (err) {
      internalError(res, err);
    }
  },

  /**
   * List saved insights for the Saved Insights management page.
   *
   * Reading is free, so any authenticated business member can view this.
   * Each row represents one period + section, regardless of prompt versions.
   */
  async listSavedInsights(req, res) {
    try {
      const {
        kind,
        section,
        search,
        page: pageParam,
        limit: limitParam,
      } = req.query ?? {};

      // Optional period-kind filter.
      if (kind && !isPeriodKind(kind)) {
        return aiFail(res, 400, "INVALID_PERIOD_KIND");
      }

      // Optional section filter.
      if (section && (!isSectionName(section) || !isPeriodSection(section))) {
        return aiFail(res, 400, "INVALID_SECTION");
      }

      // Validate pagination rather than silently accepting malformed values.
      const page = pageParam === undefined ? 1 : Number(pageParam);
      const limit = limitParam === undefined ? 10 : Number(limitParam);

      if (!Number.isInteger(page) || page < 1) {
        return aiFail(res, 400, "INVALID_PAGE");
      }

      if (!Number.isInteger(limit) || limit < 1 || limit > 100) {
        return aiFail(res, 400, "INVALID_LIMIT");
      }

      if (
        search !== undefined &&
        (typeof search !== "string" || search.length > 100)
      ) {
        return aiFail(res, 400, "INVALID_SEARCH");
      }

      const result = await aiInsightsStore.listSavedInsights(req.businessId, {
        periodKind: kind,
        section,
        search,
        page,
        limit,
      });

      return aiSuccess(res, result);
    } catch (err) {
      return internalError(res, err);
    }
  },

  /**
   * Everything stored for one period.
   *
   * No AI call, no spend, whoever is asking.
   */
  async readPeriod(req, res) {
    try {
      const stored = await aiInsightsStore.readPeriod(
        req.businessId,
        req.period,
      );

      /**
       * One entry per section — the newest, when a section has answers under
       * more than one prompt version.
       */
      const sections = {};

      for (const document of stored) {
        const current = sections[document.section];

        if (current && new Date(current.generatedAt) > document.generatedAt) {
          continue;
        }

        sections[document.section] = document.formatted();
      }

      aiSuccess(res, {
        period: {
          kind: req.period.kind,
          id: req.period.id,
          label: req.period.label,
          from: req.period.from,
          to: req.period.to,

          // The caller fetches the POS reports, so it needs both windows.
          previous: req.period.previous,
        },

        sections,

        missing: PERIOD_SECTIONS.filter((name) => !sections[name]),

        totalSections: PERIOD_SECTIONS.length,
      });
    } catch (err) {
      internalError(res, err);
    }
  },

  async deleteSection(req, res) {
    try {
      const { section } = req.params;

      if (!isSectionName(section) || !isPeriodSection(section)) {
        return aiFail(res, 400, "INVALID_SECTION");
      }

      const result = await aiInsightsStore.deleteSection({
        businessId: req.businessId,
        period: req.period,
        section,
      });

      return aiSuccess(res, {
        success: true,
        deletedCount: result.deletedCount,
      });
    } catch (err) {
      return internalError(res, err);
    }
  },

  /**
   * Everything that can refuse a draft before anything is spent.
   *
   * Runs after requireAdmin: reading is for everyone, generating is not.
   */
  async prepareDraft(req, res, next) {
    try {
      const { section } = req.params;

      if (!isSectionName(section) || !isPeriodSection(section)) {
        return aiFail(res, 400, "INVALID_SECTION");
      }

      const promptVersion = req.body?.promptVersion;

      if (!isPromptVersion(promptVersion)) {
        return aiFail(res, 400, "INVALID_PROMPT_VERSION");
      }

      /**
       * The mode is checked here as well as at the save.
       *
       * This prevents paying for a further batch that the save would refuse.
       */
      const mode = req.body?.mode ?? "ensure";

      if (!["ensure", "regenerate", "more"].includes(mode)) {
        return aiFail(res, 400, "INVALID_MODE");
      }

      if (mode === "more") {
        if (!supportsMore(section)) {
          return aiFail(res, 400, "MORE_NOT_SUPPORTED");
        }

        const existing = await aiInsightsStore.readSection({
          businessId: req.businessId,
          period: req.period,
          section,
          promptVersion,
        });

        if (!existing) {
          return aiFail(res, 404, "NOTHING_TO_EXTEND");
        }

        if (existing.noMore) {
          return aiFail(res, 409, "NO_MORE_AVAILABLE");
        }

        if (existing.batches >= MAX_BATCHES) {
          return aiFail(res, 409, "BATCH_LIMIT_REACHED");
        }
      }

      const briefing =
        typeof req.body?.briefing === "string" ? req.body.briefing.trim() : "";

      if (!briefing) {
        return aiFail(res, 400, "BRIEFING_REQUIRED");
      }

      if (briefing.length > MAX_BRIEFING_CHARS) {
        return aiFail(res, 400, "BRIEFING_TOO_LONG");
      }

      const systemInstruction =
        typeof req.body?.systemInstruction === "string"
          ? req.body.systemInstruction.trim()
          : "";

      if (systemInstruction.length > MAX_INSTRUCTION_CHARS) {
        return aiFail(res, 400, "INSTRUCTION_TOO_LONG");
      }

      const responseSchema =
        req.body?.responseSchema && typeof req.body.responseSchema === "object"
          ? req.body.responseSchema
          : null;

      if (!responseSchema) {
        return aiFail(res, 400, "SCHEMA_REQUIRED");
      }

      /**
       * Load the complete settings document.
       *
       * The fallback helper needs access to the other configured providers
       * and their allowAutomaticFallback settings.
       */
      const settings = await AISettings.findOne({
        businessId: req.businessId,
      });

      const providerId = settings?.provider ?? DEFAULT_PROVIDER;
      const credentials = settings?.[providerId];

      if (!credentials?.apiKey) {
        return aiFail(res, 424, "NOT_CONFIGURED");
      }

      if (!credentials.enabled) {
        return aiFail(res, 424, "AI_DISABLED");
      }

      req.generation = {
        section,
        promptVersion,
        briefing,
        systemInstruction,
        responseSchema,

        // Primary provider and its credentials.
        providerId,
        credentials,

        // Complete settings are needed by generateWithFallback.
        settings,

        // Cards already on screen, so a further batch does not repeat them.
        exclude: Array.isArray(req.body?.exclude) ? req.body.exclude : [],
      };

      next();
    } catch (err) {
      internalError(res, err);
    }
  },

  /**
   * Ask the model, and return the answer without storing it.
   *
   * The caller joins the model's advice onto the period's own figures and
   * sends the finished cards to be stored.
   *
   * The raw paid answer is cached for a day, so a failure during the second
   * half of that process costs a retry rather than another provider call.
   */
  async draft(req, res) {
    const { section, promptVersion } = req.generation;
    const mode = req.body?.mode ?? "ensure";

    try {
      const cacheKey = `draft:${req.period.kind}:${req.period.id}:${section}:${promptVersion}`;

      const cached = await AIInsightCache.findOne({
        businessId: req.businessId,
        cacheKey,
        expiresAt: { $gt: new Date() },
      }).lean();

      /**
       * A cached draft is reusable only when it was generated under the
       * currently selected provider/model configuration.
       *
       * This matters after fallback: the fallback helper persists the
       * successfully used provider as the selected provider. The next request
       * therefore loads that provider and can safely reuse its cached answer.
       *
       * Older cache records without settingsModel are deliberately ignored.
       */
      const currentSettingsModel = signatureOf(
        req.generation.providerId,
        req.generation.credentials,
      );

      const cacheMatchesCurrentSettings =
        cached?.settingsModel === currentSettingsModel;

      // Regenerate always means ask again.
      if (cached && cacheMatchesCurrentSettings && mode === "ensure") {
        return aiSuccess(res, {
          answer: cached.insights,
          model: cached.model,
          provider: cached.provider ?? req.generation.providerId,
          settingsModel: cached.settingsModel,
          generatedAt: cached.generatedAt,
          spent: false,
          shared: false,
        });
      }

      const lockKey = [
        req.businessId,
        req.period.kind,
        req.period.id,
        section,
        promptVersion,
        mode,
      ].join("|");

      const { shared, result } = await runOnce(lockKey, async () => {
        const generated = await periodInsightsController.callProvider(req);

        if (!generated.ok) return generated;

        return {
          ...generated,
          generatedAt: new Date(),
        };
      });

      if (!result.ok) {
        console.warn(
          JSON.stringify({
            level: "warn",
            event: "period_insights.draft_failed",
            businessId: req.businessId,
            period: `${req.period.kind}:${req.period.id}`,
            section,
            provider: result.providerId ?? req.generation.providerId,
            model:
              result.credentials?.model ??
              req.generation.credentials?.model ??
              null,
            error: result.error,
          }),
        );

        if (result.error === "KEY_UNREADABLE") {
          return aiFail(res, 500, "KEY_UNREADABLE");
        }

        /**
         * Preserve provider details and retry information when available.
         */
        return aiFail(res, 502, result.error, {
          ...(result.detail ? { detail: result.detail } : {}),
          ...(result.retryAfter ? { retryAfter: result.retryAfter } : {}),
        });
      }

      /**
       * The fallback helper returns the provider and credentials that
       * actually succeeded.
       *
       * Do not use req.generation.providerId here: it may be the provider
       * that failed before fallback succeeded.
       */
      const actualProviderId = result.providerId ?? req.generation.providerId;

      const actualCredentials =
        result.credentials ?? req.generation.credentials;

      const actualSettingsModel = signatureOf(
        actualProviderId,
        actualCredentials,
      );

      const generatedAt = new Date();

      try {
        await AIInsightCache.findOneAndUpdate(
          {
            businessId: req.businessId,
            cacheKey,
          },
          {
            adminId: req.adminId,
            insights: result.insights,
            model: result.model,

            // Store the provider that actually generated this answer.
            provider: actualProviderId,

            // Store the provider/model signature used for this answer.
            settingsModel: actualSettingsModel,

            generatedAt,
            expiresAt: new Date(generatedAt.getTime() + DRAFT_TTL_MS),
          },
          { upsert: true },
        );
      } catch (error) {
        /**
         * A cache write failing must not lose the answer that was just paid
         * for. The generated answer is still returned to the caller.
         */
        console.warn(
          `[period-insights] draft cache write failed: ${error?.message}`,
        );
      }

      console.info(
        JSON.stringify({
          level: "info",
          event: "period_insights.drafted",
          businessId: req.businessId,
          period: `${req.period.kind}:${req.period.id}`,
          section,
          mode,
          provider: actualProviderId,
          model: result.model,
          usage: result.usage,
          fallback: result.fallback === true,
          fallbackFrom: result.fallbackFrom ?? null,
          providerPersisted:
            result.fallback === true ? result.providerPersisted === true : null,
          shared,
        }),
      );

      aiSuccess(res, {
        answer: result.insights,
        model: result.model,
        usage: result.usage,

        // Report the provider that actually answered.
        provider: actualProviderId,
        settingsModel: actualSettingsModel,
        generatedAt,
        // Additional fallback information for the frontend if needed.
        fallback: result.fallback === true,
        ...(result.fallback
          ? {
              fallbackFrom: result.fallbackFrom,
              providerPersisted: result.providerPersisted,
            }
          : {}),

        spent: !shared,
        shared,
      });
    } catch (err) {
      if (res.headersSent) {
        console.error("[error]", err?.message ?? err);
        return;
      }

      internalError(res, err);
    }
  },

  /**
   * Keep the finished cards — the second half of a generation.
   *
   * `items` are the cards as the caller resolved them, never the model's raw
   * answer. A period with no sales is stored with `empty: true`, and no
   * provider is called for it.
   */
  async save(req, res) {
    try {
      const { section } = req.params;

      if (!isSectionName(section) || !isPeriodSection(section)) {
        return aiFail(res, 400, "INVALID_SECTION");
      }

      const promptVersion = req.body?.promptVersion;

      if (!isPromptVersion(promptVersion)) {
        return aiFail(res, 400, "INVALID_PROMPT_VERSION");
      }

      const mode = req.body?.mode ?? "ensure";

      if (!["ensure", "regenerate", "more"].includes(mode)) {
        return aiFail(res, 400, "INVALID_MODE");
      }

      if (mode === "more" && !supportsMore(section)) {
        return aiFail(res, 400, "MORE_NOT_SUPPORTED");
      }

      /**
       * A period with nothing in it.
       *
       * Stored as an answer so the page can say "no sales in September"
       * and never ask again. Nothing is paid for.
       */
      const empty = req.body?.empty === true;

      const items = Array.isArray(req.body?.items) ? req.body.items : null;

      if (!empty && !items) {
        return aiFail(res, 400, "ITEMS_REQUIRED");
      }

      const extra =
        req.body?.extra && typeof req.body.extra === "object"
          ? req.body.extra
          : null;

      const basis =
        req.body?.basis && typeof req.body.basis === "object"
          ? Object.fromEntries(
              Object.entries(req.body.basis).slice(0, MAX_BASIS_KEYS),
            )
          : null;

      const key = {
        businessId: req.businessId,
        period: req.period,
        section,
        promptVersion,
      };

      const existing = await aiInsightsStore.readSection(key);

      if (mode === "more") {
        if (!existing) {
          return aiFail(res, 404, "NOTHING_TO_EXTEND");
        }

        if (existing.noMore) {
          return aiFail(res, 409, "NO_MORE_AVAILABLE");
        }

        if (existing.batches >= MAX_BATCHES) {
          return aiFail(res, 409, "BATCH_LIMIT_REACHED");
        }

        // Cards already present are dropped rather than shown twice.
        const seen = new Set(
          existing.items.map((item) => item?.id).filter(Boolean),
        );

        const fresh = items.filter((item) => !item?.id || !seen.has(item.id));

        const appended = await aiInsightsStore.appendItems(key, {
          items: fresh,
          model: req.body?.model ?? existing.model,
          generatedAt: new Date(),

          // Nothing new means the model has run out.
          noMore: fresh.length === 0,
        });

        return aiSuccess(res, appended.formatted());
      }

      const written = {
        items: empty ? [] : items,

        extra: empty
          ? {
              reason: req.body?.reason ?? "NO_SALES",
              ...(extra ?? {}),
            }
          : extra,

        basis,

        model: empty ? null : (req.body?.model ?? null),
        provider: empty ? null : (req.body?.provider ?? null),
        settingsModel: empty ? null : (req.body?.settingsModel ?? null),

        generatedAt: new Date(),
      };

      const stored =
        existing && mode === "regenerate"
          ? await aiInsightsStore.replace(key, written)
          : await aiInsightsStore.store(key, {
              adminId: req.adminId,
              periodStart: req.period.start,
              periodEnd: req.period.end,
              ...written,
            });

      console.info(
        JSON.stringify({
          level: "info",
          event: "period_insights.saved",
          businessId: req.businessId,
          period: `${req.period.kind}:${req.period.id}`,
          section,
          mode,
          empty,
          items: stored.items.length,
          revision: stored.revision,
        }),
      );

      aiSuccess(res, stored.formatted());
    } catch (err) {
      internalError(res, err);
    }
  },

  /**
   * Associate a generated menu suggestion with a product or add-on
   * created through the existing POS API.
   *
   * This service stores the association only. It does not create either.
   */
  async markItemAdded(req, res) {
    try {
      const { section, promptVersion, suggestionId } = req.params;
      const { productId, addonId } = req.body ?? {};

      if (section !== "menu-suggestions" || !isPeriodSection(section)) {
        return aiFail(res, 400, "INVALID_SECTION");
      }

      if (!isPromptVersion(promptVersion)) {
        return aiFail(res, 400, "INVALID_PROMPT_VERSION");
      }

      if (
        typeof suggestionId !== "string" ||
        !suggestionId.trim() ||
        suggestionId.length > 200
      ) {
        return aiFail(res, 400, "INVALID_SUGGESTION_ID");
      }

      // Exactly one association must be supplied.
      if (Boolean(productId) === Boolean(addonId)) {
        return aiFail(res, 400, "PRODUCT_OR_ADDON_REQUIRED");
      }

      if (productId && !isValidMongoId(productId)) {
        return aiFail(res, 400, "INVALID_PRODUCT_ID");
      }

      if (addonId && !isValidMongoId(addonId)) {
        return aiFail(res, 400, "INVALID_ADDON_ID");
      }

      const result = await aiInsightsStore.markItemAdded(
        {
          businessId: req.businessId,
          period: req.period,
          section,
          promptVersion,
        },
        {
          suggestionId,
          ...(productId ? { productId } : { addonId }),
        },
      );

      if (!result.document) {
        return aiFail(res, 404, "SUGGESTION_NOT_FOUND");
      }

      if (result.alreadyAdded && !result.sameAssociation) {
        return aiFail(res, 409, "SUGGESTION_ALREADY_ADDED", {
          data: result.document.formatted(),
        });
      }

      return aiSuccess(res, {
        data: result.document.formatted(),
        alreadyAdded: result.alreadyAdded,
      });
    } catch (err) {
      return internalError(res, err);
    }
  },

  /**
   * Dismiss a generated suggestion without deleting it.
   */
  async dismissItem(req, res) {
    try {
      const { section, promptVersion, suggestionId } = req.params;

      if (section !== "menu-suggestions" || !isPeriodSection(section)) {
        return aiFail(res, 400, "INVALID_SECTION");
      }

      if (!isPromptVersion(promptVersion)) {
        return aiFail(res, 400, "INVALID_PROMPT_VERSION");
      }

      if (
        typeof suggestionId !== "string" ||
        !suggestionId.trim() ||
        suggestionId.length > 200
      ) {
        return aiFail(res, 400, "INVALID_SUGGESTION_ID");
      }

      const document = await aiInsightsStore.dismissItem(
        {
          businessId: req.businessId,
          period: req.period,
          section,
          promptVersion,
        },
        { suggestionId },
      );

      if (!document) {
        return aiFail(res, 404, "SUGGESTION_NOT_FOUND");
      }

      const status = document.itemStatuses.find(
        (entry) => entry.suggestionId === suggestionId,
      );

      // Dismissal must never override an existing product association.
      if (status?.status === "added") {
        return aiFail(res, 409, "SUGGESTION_ALREADY_ADDED", {
          data: document.formatted(),
        });
      }

      return aiSuccess(res, {
        data: document.formatted(),
      });
    } catch (err) {
      return internalError(res, err);
    }
  },

  /**
   * Record a successfully applied Pricing Opportunities action.
   *
   * The actual product update happens through the POS API.
   * This endpoint only records the completed action.
   */
  async applyPricingAction(req, res) {
    try {
      const { section, promptVersion, suggestionId } = req.params;

      const { actionType, productId, variantId, previousValue, appliedValue } =
        req.body ?? {};

      if (section !== "pricing" || !isPeriodSection(section)) {
        return aiFail(res, 400, "INVALID_SECTION");
      }

      if (!isPromptVersion(promptVersion)) {
        return aiFail(res, 400, "INVALID_PROMPT_VERSION");
      }

      if (
        typeof suggestionId !== "string" ||
        !suggestionId.trim() ||
        suggestionId.length > 200
      ) {
        return aiFail(res, 400, "INVALID_SUGGESTION_ID");
      }

      if (!["price-updated", "discount-removed"].includes(actionType)) {
        return aiFail(res, 400, "INVALID_ACTION_TYPE");
      }

      if (!isValidMongoId(productId)) {
        return aiFail(res, 400, "INVALID_PRODUCT_ID");
      }

      if (variantId != null && !isValidMongoId(variantId)) {
        return aiFail(res, 400, "INVALID_VARIANT_ID");
      }

      if (
        previousValue !== null &&
        previousValue !== undefined &&
        (typeof previousValue !== "number" || !Number.isFinite(previousValue))
      ) {
        return aiFail(res, 400, "INVALID_PREVIOUS_VALUE");
      }

      if (
        appliedValue !== null &&
        appliedValue !== undefined &&
        (typeof appliedValue !== "number" || !Number.isFinite(appliedValue))
      ) {
        return aiFail(res, 400, "INVALID_APPLIED_VALUE");
      }

      if (
        actionType === "price-updated" &&
        (typeof previousValue !== "number" ||
          typeof appliedValue !== "number" ||
          appliedValue <= 0)
      ) {
        return aiFail(res, 400, "INVALID_PRICE_VALUES");
      }

      const result = await aiInsightsStore.applyPricingAction(
        {
          businessId: req.businessId,
          period: req.period,
          section,
          promptVersion,
        },
        {
          suggestionId,
          actionType,
          productId,
          variantId: variantId ?? null,
          previousValue: previousValue ?? null,
          appliedValue: appliedValue ?? null,
        },
      );

      if (!result.document) {
        return aiFail(res, 404, "SUGGESTION_NOT_FOUND");
      }

      if (result.alreadyApplied && !result.sameAction) {
        return aiFail(res, 409, "SUGGESTION_ALREADY_APPLIED", {
          data: result.document.formatted(),
        });
      }

      return aiSuccess(res, {
        data: result.document.formatted(),
        alreadyApplied: result.alreadyApplied,
      });
    } catch (err) {
      return internalError(res, err);
    }
  },

  async completeSlowItemAction(req, res) {
    try {
      const { promptVersion, suggestionId } = req.params;

      const { actionType, productId, variantId, discountId, offerId } =
        req.body ?? {};

      if (!isPromptVersion(promptVersion)) {
        return aiFail(res, 400, "INVALID_PROMPT_VERSION");
      }

      if (
        typeof suggestionId !== "string" ||
        !suggestionId.trim() ||
        suggestionId.length > 200
      ) {
        return aiFail(res, 400, "INVALID_SUGGESTION_ID");
      }

      if (!["discount-applied", "freebie-created"].includes(actionType)) {
        return aiFail(res, 400, "INVALID_ACTION_TYPE");
      }

      if (!isValidMongoId(productId)) {
        return aiFail(res, 400, "INVALID_PRODUCT_ID");
      }

      if (variantId != null && !isValidMongoId(variantId)) {
        return aiFail(res, 400, "INVALID_VARIANT_ID");
      }

      if (actionType === "discount-applied" && !isValidMongoId(discountId)) {
        return aiFail(res, 400, "INVALID_DISCOUNT_ID");
      }

      if (actionType === "freebie-created" && !isValidMongoId(offerId)) {
        return aiFail(res, 400, "INVALID_OFFER_ID");
      }

      const key = {
        businessId: req.businessId,
        period: req.period,
        section: "slow-items",
        promptVersion,
      };

      const result = await aiInsightsStore.completeSlowItemAction(key, {
        suggestionId,
        actionType,
        productId,
        variantId: variantId ?? null,
        discountId: actionType === "discount-applied" ? discountId : null,
        offerId: actionType === "freebie-created" ? offerId : null,
      });

      if (!result.document) {
        return aiFail(res, 404, "SUGGESTION_NOT_FOUND");
      }

      if (result.alreadyApplied && !result.sameAction) {
        return aiFail(res, 409, "SUGGESTION_ALREADY_APPLIED", {
          data: result.document.formatted(),
        });
      }

      return aiSuccess(res, {
        data: result.document.formatted(),
        alreadyApplied: result.alreadyApplied,
      });
    } catch (err) {
      return internalError(res, err);
    }
  },

  /**
   * Dismiss a Pricing Opportunities suggestion.
   *
   * An applied pricing action cannot be dismissed.
   */
  async dismissPricingItem(req, res) {
    try {
      const { section, promptVersion, suggestionId } = req.params;

      if (section !== "pricing" || !isPeriodSection(section)) {
        return aiFail(res, 400, "INVALID_SECTION");
      }

      if (!isPromptVersion(promptVersion)) {
        return aiFail(res, 400, "INVALID_PROMPT_VERSION");
      }

      if (
        typeof suggestionId !== "string" ||
        !suggestionId.trim() ||
        suggestionId.length > 200
      ) {
        return aiFail(res, 400, "INVALID_SUGGESTION_ID");
      }

      const document = await aiInsightsStore.dismissPricingItem(
        {
          businessId: req.businessId,
          period: req.period,
          section,
          promptVersion,
        },
        { suggestionId },
      );

      if (!document) {
        return aiFail(res, 404, "SUGGESTION_NOT_FOUND");
      }

      const status = document.itemStatuses.find(
        (entry) => entry.suggestionId === suggestionId,
      );

      if (status?.status === "applied") {
        return aiFail(res, 409, "SUGGESTION_ALREADY_APPLIED", {
          data: document.formatted(),
        });
      }

      return aiSuccess(res, {
        data: document.formatted(),
      });
    } catch (err) {
      return internalError(res, err);
    }
  },

  /**
   * The provider call itself.
   *
   * The fallback helper handles:
   * - Decrypting the selected provider's key.
   * - Calling the selected provider first.
   * - Checking whether the failure is eligible for fallback.
   * - Trying explicitly enabled fallback providers.
   * - Persisting the successful fallback provider selection.
   *
   * This controller then parses the JSON answer and returns it in the format
   * expected by the period-insights workflow.
   */
  async callProvider(req) {
    const {
      briefing,
      systemInstruction,
      responseSchema,
      providerId,
      credentials,
      settings,
      exclude,
    } = req.generation;

    const instruction = exclude.length
      ? `${systemInstruction}\n\nAlready shown, do not repeat:\n${exclude
          .slice(0, 50)
          .map((line) => `- ${String(line).slice(0, 200)}`)
          .join("\n")}`
      : systemInstruction;

    /**
     * generateWithFallback returns the actual successful provider and its
     * credentials, not necessarily the originally selected provider.
     */
    const result = await generateWithFallback({
      businessId: req.businessId,
      settings: req.generation.settings,
      providerId,
      credentials,
      options: {
        briefing,
        systemInstruction: instruction || undefined,
        responseSchema: responseSchema || undefined,
      },
    });

    if (!result.ok) {
      return result;
    }

    /**
     * The fallback helper checks JSON validity before permanently switching
     * to an alternate provider when a response schema is supplied.
     *
     * Keep this final parse here because the controller needs the parsed
     * object as `insights`, not just the provider's raw text.
     */
    try {
      return {
        ...result,
        insights: JSON.parse(result.text),
      };
    } catch {
      return {
        ...result,
        ok: false,
        error: "AI_MALFORMED_RESPONSE",
        detail: String(result.text ?? "").slice(0, 200),
      };
    }
  },
};

module.exports = {
  periodInsightsController,
  MAX_BATCHES,
};
