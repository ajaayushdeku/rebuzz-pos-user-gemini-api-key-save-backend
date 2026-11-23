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
 * The difference from `aiInsightsController` is what is being described, and it
 * changes everything downstream: September's figures are final, so an answer
 * about September is final too. Reading costs nothing and is open to any staff
 * member; generating spends the merchant's provider quota and is the admin's
 * decision alone.
 *
 * Who builds the briefing has not changed — the caller does, as it always has,
 * because it is the side with the POS reports. This controller decides whether
 * an answer is needed, stores it, and never regenerates one nobody asked for.
 *
 * See docs/period-insights.md for the decisions behind all of it.
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
 * A day, not a few minutes: it is there so that the store half failing costs a
 * retry rather than another provider call. Reuses the day-scoped cache
 * collection, which already expires its own documents.
 */
const DRAFT_TTL_MS = 26 * 60 * 60 * 1000;

const internalError = (res, err) => {
  // Message only: provider SDK errors can echo the request back, key included.
  console.error("[error]", err?.message ?? err);
  return res.status(500).json({ error: "INTERNAL_ERROR" });
};

/** What the answer was generated under: provider and model together. */
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
  if (Array.isArray(parsed)) return { items: parsed, extra: null };
  if (parsed && typeof parsed === "object") {
    const { items, ...extra } = parsed;
    return {
      items: Array.isArray(items) ? items : [],
      extra: Object.keys(extra).length > 0 ? extra : null,
    };
  }
  // A section with no schema has no cards to store; keep the text as extra so
  // nothing is silently dropped.
  return { items: [], extra: parsed == null ? null : { text: parsed } };
};

const periodInsightsController = {
  /**
   * Turn `:kind/:id` into a period, or refuse.
   *
   * `latest` is accepted as the id and means "the most recent completed one", so
   * a caller can ask for the default without reimplementing the calendar.
   *
   * Only closed periods are allowed. An open one's figures are still moving, so
   * an answer about it would be stale within the hour — and storing it
   * permanently, which is what this path does, would make that permanent too.
   */
  resolvePeriod(req, res, next) {
    const { kind, id } = req.params;

    if (!isPeriodKind(kind)) {
      return res.status(400).json({ error: "INVALID_PERIOD_KIND" });
    }

    const period =
      id === "latest" ? previousClosedPeriod(kind) : describePeriod(kind, id);

    if (!period) {
      return res.status(400).json({ error: "INVALID_PERIOD" });
    }
    if (!period.closed) {
      return res.status(400).json({
        error: "PERIOD_NOT_CLOSED",
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
   * Kept separate until here so the picker can be shown before anything exists.
   */
  async listPeriods(req, res) {
    try {
      const kind = isPeriodKind(req.query?.kind)
        ? req.query.kind
        : DEFAULT_PERIOD_KIND;

      // 12 months, 4 quarters, 2 years — far enough back to be useful without
      // offering a hundred periods, every one of which is a paid generation.
      const depth = { month: 12, quarter: 4, year: 2 }[kind] ?? 12;

      const [periods, stored] = await Promise.all([
        Promise.resolve(recentClosedPeriods(kind, depth)),
        aiInsightsStore.listPeriods(req.businessId, kind, depth),
      ]);

      const byId = new Map(stored.map((row) => [row.id, row]));

      res.json({
        data: {
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
        },
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
        return res.status(400).json({
          error: "INVALID_PERIOD_KIND",
        });
      }

      // Optional section filter.
      if (section && (!isSectionName(section) || !isPeriodSection(section))) {
        return res.status(400).json({
          error: "INVALID_SECTION",
        });
      }

      // Validate pagination rather than silently accepting malformed values.
      const page = pageParam === undefined ? 1 : Number(pageParam);
      const limit = limitParam === undefined ? 10 : Number(limitParam);

      if (!Number.isInteger(page) || page < 1) {
        return res.status(400).json({
          error: "INVALID_PAGE",
        });
      }

      if (!Number.isInteger(limit) || limit < 1 || limit > 100) {
        return res.status(400).json({
          error: "INVALID_LIMIT",
        });
      }

      if (
        search !== undefined &&
        (typeof search !== "string" || search.length > 100)
      ) {
        return res.status(400).json({
          error: "INVALID_SEARCH",
        });
      }

      const result = await aiInsightsStore.listSavedInsights(req.businessId, {
        periodKind: kind,
        section,
        search,
        page,
        limit,
      });

      return res.json({
        data: result,
      });
    } catch (err) {
      return internalError(res, err);
    }
  },

  /**
   * Everything stored for one period. No AI call, no spend, whoever is asking.
   *
   * Sections that have never been generated are named in `missing` rather than
   * returned empty, so the page can offer to generate exactly those.
   */
  async readPeriod(req, res) {
    try {
      const stored = await aiInsightsStore.readPeriod(
        req.businessId,
        req.period,
      );

      /**
       * One entry per section — the newest, when a section has answers under more
       * than one prompt version.
       *
       * That happens on every prompt improvement: v3's answer stays stored while
       * v4's is written beside it. Both are legitimately there, but a page shows
       * one card per section, and "whichever the database returned last" is not a
       * choice. The newest wins, and `promptVersion` travels with it so the
       * caller can see its own version is ahead and offer to regenerate.
       */
      const sections = {};
      for (const document of stored) {
        const current = sections[document.section];
        if (current && new Date(current.generatedAt) > document.generatedAt)
          continue;
        sections[document.section] = document.formatted();
      }

      res.json({
        data: {
          period: {
            kind: req.period.kind,
            id: req.period.id,
            label: req.period.label,
            from: req.period.from,
            to: req.period.to,
            // The caller fetches the POS reports, so it needs both windows —
            // and takes them from here rather than working them out, so a
            // stored insight can never describe a window other than its own.
            previous: req.period.previous,
          },
          sections,
          missing: PERIOD_SECTIONS.filter((name) => !sections[name]),
          totalSections: PERIOD_SECTIONS.length,
        },
      });
    } catch (err) {
      internalError(res, err);
    }
  },

  async deleteSection(req, res) {
    try {
      const { section } = req.params;

      if (!isSectionName(section) || !isPeriodSection(section)) {
        return res.status(400).json({
          success: false,
          error: "INVALID_SECTION",
        });
      }

      const result = await aiInsightsStore.deleteSection({
        businessId: req.businessId,
        period: req.period,
        section,
      });

      return res.json({
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
   * Runs after `requireAdmin`: reading is for everyone, paying is not.
   */
  async prepareDraft(req, res, next) {
    try {
      const { section } = req.params;
      if (!isSectionName(section) || !isPeriodSection(section)) {
        // A name this service does not know, or one that is not period-scoped —
        // festival-prep belongs on the day-scoped route, not here.
        return res.status(400).json({ error: "INVALID_SECTION" });
      }

      const promptVersion = req.body?.promptVersion;
      if (!isPromptVersion(promptVersion)) {
        // Part of the stored key, so it is validated rather than trusted: an
        // arbitrary string would fan storage out into unlimited documents.
        return res.status(400).json({ error: "INVALID_PROMPT_VERSION" });
      }

      /**
       * The mode is checked here as well as at the save, deliberately.
       *
       * Without it, asking for a further batch of a section that has none — or
       * of one that does not offer batches at all — would pay a provider for an
       * answer the save then refuses. The check costs one indexed read.
       */
      const mode = req.body?.mode ?? "ensure";
      if (!["ensure", "regenerate", "more"].includes(mode)) {
        return res.status(400).json({ error: "INVALID_MODE" });
      }
      if (mode === "more") {
        if (!supportsMore(section)) {
          return res.status(400).json({ error: "MORE_NOT_SUPPORTED" });
        }
        const existing = await aiInsightsStore.readSection({
          businessId: req.businessId,
          period: req.period,
          section,
          promptVersion,
        });
        if (!existing)
          return res.status(404).json({ error: "NOTHING_TO_EXTEND" });
        if (existing.noMore)
          return res.status(409).json({ error: "NO_MORE_AVAILABLE" });
        if (existing.batches >= MAX_BATCHES) {
          return res.status(409).json({ error: "BATCH_LIMIT_REACHED" });
        }
      }

      const briefing =
        typeof req.body?.briefing === "string" ? req.body.briefing.trim() : "";
      if (!briefing)
        return res.status(400).json({ error: "BRIEFING_REQUIRED" });
      if (briefing.length > MAX_BRIEFING_CHARS) {
        return res.status(400).json({ error: "BRIEFING_TOO_LONG" });
      }

      const systemInstruction =
        typeof req.body?.systemInstruction === "string"
          ? req.body.systemInstruction.trim()
          : "";
      if (systemInstruction.length > MAX_INSTRUCTION_CHARS) {
        return res.status(400).json({ error: "INSTRUCTION_TOO_LONG" });
      }

      const responseSchema =
        req.body?.responseSchema && typeof req.body.responseSchema === "object"
          ? req.body.responseSchema
          : null;
      if (!responseSchema)
        return res.status(400).json({ error: "SCHEMA_REQUIRED" });

      const settings = await AISettings.findOne({ businessId: req.businessId });
      const providerId = settings?.provider ?? DEFAULT_PROVIDER;
      const credentials = settings?.[providerId];

      if (!credentials?.apiKey) {
        return res.status(424).json({ error: "NOT_CONFIGURED" });
      }
      if (!credentials.enabled) {
        return res.status(424).json({ error: "AI_DISABLED" });
      }

      req.generation = {
        section,
        promptVersion,
        briefing,
        systemInstruction,
        responseSchema,
        providerId,
        credentials,
        settings,
        /** Cards already on screen, so a further batch does not repeat them. */
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
   * Why this is separate from storing: what a section finally shows is the
   * model's answer *joined onto the period's own figures* — the item name, the
   * current price and the numbers all come from the data, and the model supplies
   * only the advice, keyed by an anonymised reference. That join happens in the
   * caller, where the data is. Storing the raw answer would be storing something
   * nobody can read back once those figures are gone.
   *
   * So the caller drafts, joins, and sends the finished cards to be kept.
   *
   * The paid answer is cached for a day under the same key, so the second half of
   * that pair failing — a dropped connection, a restart, a bad deploy — costs a
   * retry rather than another provider call.
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

      // Only when nobody asked for a new one: a regeneration means "ask again",
      // and serving an earlier draft would make the button appear to do nothing.
      if (
        cached &&
        mode === "ensure" &&
        cached.generatedAt &&
        cached.settingsModel ===
          signatureOf(req.generation.providerId, req.generation.credentials)
      ) {
        return res.json({
          data: {
            answer: cached.insights,
            model: cached.model,
            provider: cached.provider ?? req.generation.providerId,
            settingsModel: cached.settingsModel,
            generatedAt: cached.generatedAt,
            spent: false,
          },
        });
      }

      const lockKey = `${req.businessId}|${req.period.kind}|${req.period.id}|${section}|${promptVersion}|${mode}`;
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
            provider: req.generation.providerId,
            model: req.generation.credentials?.model ?? null,
            error: result.error,
          }),
        );

        if (result.error === "KEY_UNREADABLE") {
          return res.status(500).json({ error: "KEY_UNREADABLE" });
        }

        /**
         * 502 with everything the UI needs to say something useful.
         *
         * `detail` is the provider's own sentence and `retryAfter` its own
         * timing, when it gave either. The day-scoped route dropped both, which
         * is why a quota error there could only ever say "something went wrong".
         */
        return res.status(502).json({
          error: result.error,
          ...(result.detail ? { detail: result.detail } : {}),
          ...(result.retryAfter ? { retryAfter: result.retryAfter } : {}),
        });
      }

      // const generatedAt = new Date();
      const generatedAt = result.generatedAt;

      try {
        await AIInsightCache.findOneAndUpdate(
          { businessId: req.businessId, cacheKey },
          {
            adminId: req.adminId,
            insights: result.insights,
            model: result.model,
            provider: result.providerId,
            settingsModel: signatureOf(result.providerId, result.credentials),
            generatedAt,
            expiresAt: new Date(generatedAt.getTime() + DRAFT_TTL_MS),
          },
          { upsert: true },
        );
      } catch (error) {
        // A cache write failing must not lose the answer that was just paid for:
        // it is in the reply either way.
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
          model: result.model,
          usage: result.usage,
          shared,
        }),
      );

      res.json({
        data: {
          answer: result.insights,
          model: result.model,
          usage: result.usage,
          provider: result.providerId,
          settingsModel: signatureOf(result.providerId, result.credentials),
          generatedAt,
          spent: !shared,
          shared,
        },
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
   * Keep the finished cards — the second half of a generation, and the only part
   * a later visit reads.
   *
   * `items` are the cards as the caller resolved them, never the model's raw
   * answer. A period with no sales is stored the same way, with `empty: true`,
   * and no provider is ever called for it.
   */
  async save(req, res) {
    try {
      const { section } = req.params;
      if (!isSectionName(section) || !isPeriodSection(section)) {
        return res.status(400).json({ error: "INVALID_SECTION" });
      }

      const promptVersion = req.body?.promptVersion;
      if (!isPromptVersion(promptVersion)) {
        return res.status(400).json({ error: "INVALID_PROMPT_VERSION" });
      }

      const mode = req.body?.mode ?? "ensure";
      if (!["ensure", "regenerate", "more"].includes(mode)) {
        return res.status(400).json({ error: "INVALID_MODE" });
      }
      if (mode === "more" && !supportsMore(section)) {
        return res.status(400).json({ error: "MORE_NOT_SUPPORTED" });
      }

      /**
       * A period with nothing in it.
       *
       * The caller knows — it read the reports. Stored as an answer so the page
       * can say "no sales in September" and never ask again, and nothing is paid
       * for, because with no figures a model can only invent.
       */
      const empty = req.body?.empty === true;

      const items = Array.isArray(req.body?.items) ? req.body.items : null;
      if (!empty && !items)
        return res.status(400).json({ error: "ITEMS_REQUIRED" });

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
        if (!existing)
          return res.status(404).json({ error: "NOTHING_TO_EXTEND" });
        if (existing.noMore)
          return res.status(409).json({ error: "NO_MORE_AVAILABLE" });
        if (existing.batches >= MAX_BATCHES) {
          return res.status(409).json({ error: "BATCH_LIMIT_REACHED" });
        }

        // Cards already present are dropped rather than shown twice: the model is
        // told what to avoid, but being told is not the same as obeying.
        const seen = new Set(
          existing.items.map((item) => item?.id).filter(Boolean),
        );
        const fresh = items.filter((item) => !item?.id || !seen.has(item.id));
        const appended = await aiInsightsStore.appendItems(key, {
          items: fresh,
          model: req.body?.model ?? existing.model,
          generatedAt: new Date(),
          // Nothing new means the model has run out; asking again would pay for
          // the same silence.
          noMore: fresh.length === 0,
        });
        return res.json({ data: appended.formatted() });
      }

      const written = {
        items: empty ? [] : items,
        extra: empty
          ? { reason: req.body?.reason ?? "NO_SALES", ...(extra ?? {}) }
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

      res.json({ data: stored.formatted() });
    } catch (err) {
      internalError(res, err);
    }
  },

  // async markItemAdded(req, res) {
  //   try {
  //     const { section, promptVersion, suggestionId } = req.params;
  //     const { productId } = req.body ?? {};

  //     if (section !== "menu-suggestions" || !isPeriodSection(section)) {
  //       return res.status(400).json({ error: "INVALID_SECTION" });
  //     }

  //     if (!isPromptVersion(promptVersion)) {
  //       return res.status(400).json({ error: "INVALID_PROMPT_VERSION" });
  //     }

  //     if (
  //       typeof suggestionId !== "string" ||
  //       !suggestionId.trim() ||
  //       suggestionId.length > 200
  //     ) {
  //       return res.status(400).json({ error: "INVALID_SUGGESTION_ID" });
  //     }

  //     if (!isValidProductId(productId)) {
  //       return res.status(400).json({ error: "INVALID_PRODUCT_ID" });
  //     }

  //     const result = await aiInsightsStore.markItemAdded(
  //       {
  //         businessId: req.businessId,
  //         period: req.period,
  //         section,
  //         promptVersion,
  //       },
  //       {
  //         suggestionId,
  //         productId,
  //       },
  //     );

  //     if (!result.document) {
  //       return res.status(404).json({
  //         error: "SUGGESTION_NOT_FOUND",
  //       });
  //     }

  //     // An already-added suggestion must retain its original product.
  //     if (result.alreadyAdded && !result.sameProduct) {
  //       return res.status(409).json({
  //         error: "SUGGESTION_ALREADY_ADDED",
  //         data: result.document.formatted(),
  //       });
  //     }

  //     return res.json({
  //       data: result.document.formatted(),
  //       alreadyAdded: result.alreadyAdded,
  //     });
  //   } catch (err) {
  //     return internalError(res, err);
  //   }
  // },

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
        return res.status(400).json({ error: "INVALID_SECTION" });
      }

      if (!isPromptVersion(promptVersion)) {
        return res.status(400).json({ error: "INVALID_PROMPT_VERSION" });
      }

      if (
        typeof suggestionId !== "string" ||
        !suggestionId.trim() ||
        suggestionId.length > 200
      ) {
        return res.status(400).json({ error: "INVALID_SUGGESTION_ID" });
      }

      // Exactly one association must be supplied.
      if (Boolean(productId) === Boolean(addonId)) {
        return res.status(400).json({
          error: "PRODUCT_OR_ADDON_REQUIRED",
        });
      }

      if (productId && !isValidMongoId(productId)) {
        return res.status(400).json({ error: "INVALID_PRODUCT_ID" });
      }

      if (addonId && !isValidMongoId(addonId)) {
        return res.status(400).json({ error: "INVALID_ADDON_ID" });
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
        return res.status(404).json({
          error: "SUGGESTION_NOT_FOUND",
        });
      }

      if (result.alreadyAdded && !result.sameAssociation) {
        return res.status(409).json({
          error: "SUGGESTION_ALREADY_ADDED",
          data: result.document.formatted(),
        });
      }

      return res.json({
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
        return res.status(400).json({ error: "INVALID_SECTION" });
      }

      if (!isPromptVersion(promptVersion)) {
        return res.status(400).json({ error: "INVALID_PROMPT_VERSION" });
      }

      if (
        typeof suggestionId !== "string" ||
        !suggestionId.trim() ||
        suggestionId.length > 200
      ) {
        return res.status(400).json({ error: "INVALID_SUGGESTION_ID" });
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
        return res.status(404).json({
          error: "SUGGESTION_NOT_FOUND",
        });
      }

      const status = document.itemStatuses.find(
        (entry) => entry.suggestionId === suggestionId,
      );

      // Dismissal must never override an existing product association.
      if (status?.status === "added") {
        return res.status(409).json({
          error: "SUGGESTION_ALREADY_ADDED",
          data: document.formatted(),
        });
      }

      return res.json({
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
        return res.status(400).json({ error: "INVALID_SECTION" });
      }

      if (!isPromptVersion(promptVersion)) {
        return res.status(400).json({ error: "INVALID_PROMPT_VERSION" });
      }

      if (
        typeof suggestionId !== "string" ||
        !suggestionId.trim() ||
        suggestionId.length > 200
      ) {
        return res.status(400).json({ error: "INVALID_SUGGESTION_ID" });
      }

      if (!["price-updated", "discount-removed"].includes(actionType)) {
        return res.status(400).json({ error: "INVALID_ACTION_TYPE" });
      }

      if (!isValidMongoId(productId)) {
        return res.status(400).json({ error: "INVALID_PRODUCT_ID" });
      }

      if (variantId != null && !isValidMongoId(variantId)) {
        return res.status(400).json({ error: "INVALID_VARIANT_ID" });
      }

      if (
        previousValue !== null &&
        previousValue !== undefined &&
        (typeof previousValue !== "number" || !Number.isFinite(previousValue))
      ) {
        return res.status(400).json({ error: "INVALID_PREVIOUS_VALUE" });
      }

      if (
        appliedValue !== null &&
        appliedValue !== undefined &&
        (typeof appliedValue !== "number" || !Number.isFinite(appliedValue))
      ) {
        return res.status(400).json({ error: "INVALID_APPLIED_VALUE" });
      }

      if (
        actionType === "price-updated" &&
        (typeof previousValue !== "number" ||
          typeof appliedValue !== "number" ||
          appliedValue <= 0)
      ) {
        return res.status(400).json({ error: "INVALID_PRICE_VALUES" });
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
        return res.status(404).json({
          error: "SUGGESTION_NOT_FOUND",
        });
      }

      if (result.alreadyApplied && !result.sameAction) {
        return res.status(409).json({
          error: "SUGGESTION_ALREADY_APPLIED",
          data: result.document.formatted(),
        });
      }

      return res.json({
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
        return res.status(400).json({ error: "INVALID_PROMPT_VERSION" });
      }

      if (
        typeof suggestionId !== "string" ||
        !suggestionId.trim() ||
        suggestionId.length > 200
      ) {
        return res.status(400).json({ error: "INVALID_SUGGESTION_ID" });
      }

      if (!["discount-applied", "freebie-created"].includes(actionType)) {
        return res.status(400).json({ error: "INVALID_ACTION_TYPE" });
      }

      if (!isValidMongoId(productId)) {
        return res.status(400).json({ error: "INVALID_PRODUCT_ID" });
      }

      if (variantId != null && !isValidMongoId(variantId)) {
        return res.status(400).json({ error: "INVALID_VARIANT_ID" });
      }

      if (actionType === "discount-applied" && !isValidMongoId(discountId)) {
        return res.status(400).json({ error: "INVALID_DISCOUNT_ID" });
      }

      if (actionType === "freebie-created" && !isValidMongoId(offerId)) {
        return res.status(400).json({ error: "INVALID_OFFER_ID" });
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
        return res.status(404).json({
          error: "SUGGESTION_NOT_FOUND",
        });
      }

      if (result.alreadyApplied && !result.sameAction) {
        return res.status(409).json({
          error: "SUGGESTION_ALREADY_APPLIED",
          data: result.document.formatted(),
        });
      }

      return res.json({
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
        return res.status(400).json({ error: "INVALID_SECTION" });
      }

      if (!isPromptVersion(promptVersion)) {
        return res.status(400).json({ error: "INVALID_PROMPT_VERSION" });
      }

      if (
        typeof suggestionId !== "string" ||
        !suggestionId.trim() ||
        suggestionId.length > 200
      ) {
        return res.status(400).json({ error: "INVALID_SUGGESTION_ID" });
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
        return res.status(404).json({
          error: "SUGGESTION_NOT_FOUND",
        });
      }

      const status = document.itemStatuses.find(
        (entry) => entry.suggestionId === suggestionId,
      );

      if (status?.status === "applied") {
        return res.status(409).json({
          error: "SUGGESTION_ALREADY_APPLIED",
          data: document.formatted(),
        });
      }

      return res.json({
        data: document.formatted(),
      });
    } catch (err) {
      return internalError(res, err);
    }
  },

  /**
   * The provider call itself, and the only place a stored key is decrypted.
   *
   * Separated so the lock above has something to hold, and so a failure comes
   * back as a value rather than an exception — a provider refusal is an expected
   * outcome here, not a crash.
   */
  async callProvider(req) {
    const {
      briefing,
      systemInstruction,
      responseSchema,
      providerId,
      credentials,
      exclude,
    } = req.generation;

    const instruction = exclude.length
      ? `${systemInstruction}\n\nAlready shown, do not repeat:\n${exclude
          .slice(0, 50)
          .map((line) => `- ${String(line).slice(0, 200)}`)
          .join("\n")}`
      : systemInstruction;

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

    if (!result.ok) return result;

    // The model is told to return JSON, never trusted to. A malformed answer is
    // its own failure, reported with the code the UI already understands.
    try {
      return {
        ...result,
        insights: JSON.parse(result.text),
      };
    } catch {
      return {
        ok: false,
        error: "AI_MALFORMED_RESPONSE",
        detail: String(result.text ?? "").slice(0, 200),
      };
    }
  },
};

module.exports = { periodInsightsController, MAX_BATCHES };
