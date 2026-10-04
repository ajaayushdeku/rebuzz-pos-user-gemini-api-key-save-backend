const { aiInsightsStore } = require("../data/aiInsightsStore");
const AISettings = require("../models/aiSettings");
const { decrypt } = require("../helpers/aiCrypto");
const { DEFAULT_PROVIDER, getProvider } = require("../helpers/aiProviders");
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
   * Everything stored for one period. No AI call, no spend, whoever is asking.
   *
   * Sections that have never been generated are named in `missing` rather than
   * returned empty, so the page can offer to generate exactly those.
   */
  async readPeriod(req, res) {
    try {
      const stored = await aiInsightsStore.readPeriod(req.businessId, req.period);

      const sections = {};
      for (const document of stored) sections[document.section] = document.formatted();

      res.json({
        data: {
          period: {
            kind: req.period.kind,
            id: req.period.id,
            label: req.period.label,
            from: req.period.from,
            to: req.period.to,
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

  /**
   * Everything that can refuse a generation before anything is spent.
   *
   * Runs after `requireAdmin`: reading is for everyone, paying is not.
   */
  async prepare(req, res, next) {
    try {
      const { section } = req.params;
      if (!isSectionName(section) || !isPeriodSection(section)) {
        // A name this service does not know, or one that is not period-scoped —
        // festival-prep belongs on the day-scoped route, not here.
        return res.status(400).json({ error: "INVALID_SECTION" });
      }

      const mode = req.body?.mode ?? "ensure";
      if (!["ensure", "regenerate", "more"].includes(mode)) {
        return res.status(400).json({ error: "INVALID_MODE" });
      }
      if (mode === "more" && !supportsMore(section)) {
        return res.status(400).json({ error: "MORE_NOT_SUPPORTED" });
      }

      const promptVersion = req.body?.promptVersion;
      if (!isPromptVersion(promptVersion)) {
        // Part of the stored key, so it is validated rather than trusted: an
        // arbitrary string would fan storage out into unlimited documents.
        return res.status(400).json({ error: "INVALID_PROMPT_VERSION" });
      }

      /**
       * A period with nothing in it.
       *
       * The caller knows — it read the reports. Stored as an answer so the page
       * can say "no sales in September" and never ask again, and no provider is
       * called, because with no figures a model can only invent.
       */
      const empty = req.body?.empty === true;

      const briefing =
        typeof req.body?.briefing === "string" ? req.body.briefing.trim() : "";
      if (!empty && !briefing) {
        return res.status(400).json({ error: "BRIEFING_REQUIRED" });
      }
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
      if (!empty && !responseSchema) {
        // Only parsed answers can be stored as cards; without a schema there
        // would be nothing to put in `items`.
        return res.status(400).json({ error: "SCHEMA_REQUIRED" });
      }

      /** A small note of the figures behind the answer, for later explanation. */
      const basis =
        req.body?.basis && typeof req.body.basis === "object"
          ? Object.fromEntries(Object.entries(req.body.basis).slice(0, MAX_BASIS_KEYS))
          : null;

      const settings = await AISettings.findOne({ businessId: req.businessId });
      const providerId = settings?.provider ?? DEFAULT_PROVIDER;
      const credentials = settings?.[providerId];

      // An empty period needs no key: nothing is going to be called.
      if (!empty) {
        if (!credentials?.apiKey) {
          return res.status(424).json({ error: "NOT_CONFIGURED" });
        }
        if (!credentials.enabled) {
          return res.status(424).json({ error: "AI_DISABLED" });
        }
      }

      req.generation = {
        section,
        mode,
        promptVersion,
        empty,
        reason: empty ? (req.body?.reason ?? "NO_SALES") : null,
        briefing,
        systemInstruction,
        responseSchema,
        basis,
        providerId,
        credentials,
        /** Cards already on screen, so a further batch does not repeat them. */
        exclude: Array.isArray(req.body?.exclude) ? req.body.exclude : [],
      };
      next();
    } catch (err) {
      internalError(res, err);
    }
  },

  async generate(req, res) {
    const { section, mode, promptVersion, empty } = req.generation;
    const key = {
      businessId: req.businessId,
      period: req.period,
      section,
      promptVersion,
    };

    try {
      const existing = await aiInsightsStore.readSection(key);

      // ── Nothing to do ────────────────────────────────────────────────────
      // The whole point of storing: an answer that exists is returned, and the
      // provider is not called. This is the normal path once a period is done.
      if (mode === "ensure" && existing) {
        return res.json({ data: { ...existing.formatted(), spent: false } });
      }
      if (mode === "more") {
        if (!existing) return res.status(404).json({ error: "NOTHING_TO_EXTEND" });
        if (existing.noMore) return res.status(409).json({ error: "NO_MORE_AVAILABLE" });
        if (existing.batches >= MAX_BATCHES) {
          return res.status(409).json({ error: "BATCH_LIMIT_REACHED" });
        }
      }

      // ── A period with no sales ───────────────────────────────────────────
      if (empty) {
        const stored = await aiInsightsStore.store(key, {
          adminId: req.adminId,
          periodStart: req.period.start,
          periodEnd: req.period.end,
          items: [],
          extra: { reason: req.generation.reason },
          basis: req.generation.basis,
          model: null,
          provider: null,
          settingsModel: null,
          generatedAt: new Date(),
        });
        return res.json({ data: { ...stored.formatted(), spent: false } });
      }

      // ── Paid from here on ────────────────────────────────────────────────
      // One generation at a time per section and period. A second caller waits
      // on this one and gets the same answer rather than paying again.
      const lockKey = `${req.businessId}|${req.period.kind}|${req.period.id}|${section}|${promptVersion}|${mode}`;

      const { shared, result } = await runOnce(lockKey, () =>
        periodInsightsController.callProvider(req),
      );

      if (!result.ok) {
        console.warn(
          JSON.stringify({
            level: "warn",
            event: "period_insights.failed",
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

      const { items, extra } = splitAnswer(result.insights);
      const generatedAt = new Date();
      const written = {
        model: result.model,
        provider: req.generation.providerId,
        settingsModel: signatureOf(req.generation.providerId, req.generation.credentials),
        generatedAt,
      };

      let stored;
      if (mode === "more") {
        // Cards already present are dropped rather than shown twice: the model
        // is told what to avoid, but being told is not the same as obeying.
        const seen = new Set(existing.items.map((item) => item?.id).filter(Boolean));
        const fresh = items.filter((item) => !item?.id || !seen.has(item.id));
        stored = await aiInsightsStore.appendItems(key, {
          items: fresh,
          model: result.model,
          generatedAt,
          // Nothing new means the model has run out; asking again would pay for
          // the same silence.
          noMore: fresh.length === 0,
        });
      } else if (existing) {
        stored = await aiInsightsStore.replace(key, { items, extra, basis: req.generation.basis, ...written });
      } else {
        stored = await aiInsightsStore.store(key, {
          adminId: req.adminId,
          periodStart: req.period.start,
          periodEnd: req.period.end,
          items,
          extra,
          basis: req.generation.basis,
          ...written,
        });
      }

      console.info(
        JSON.stringify({
          level: "info",
          event: "period_insights.generated",
          businessId: req.businessId,
          period: `${req.period.kind}:${req.period.id}`,
          section,
          mode,
          model: result.model,
          usage: result.usage,
          // True when this request joined a generation already running, so the
          // answer was not paid for twice.
          shared,
        }),
      );

      res.json({ data: { ...stored.formatted(), spent: !shared, shared } });
    } catch (err) {
      if (res.headersSent) {
        console.error("[error]", err?.message ?? err);
        return;
      }
      internalError(res, err);
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

    let apiKey;
    try {
      apiKey = decrypt(credentials.apiKey);
    } catch {
      // The ciphertext no longer verifies: altered, or written under a different
      // AI_ENCRYPTION_KEY. Re-entering the key is the only fix, so say that
      // rather than letting it surface as a generic failure.
      return { ok: false, error: "KEY_UNREADABLE" };
    }

    const instruction = exclude.length
      ? `${systemInstruction}\n\nAlready shown, do not repeat:\n${exclude
          .slice(0, 50)
          .map((line) => `- ${String(line).slice(0, 200)}`)
          .join("\n")}`
      : systemInstruction;

    const result = await getProvider(providerId).generateInsights(apiKey, {
      briefing,
      systemInstruction: instruction || undefined,
      responseSchema: responseSchema || undefined,
      model: credentials.model || undefined,
    });

    if (!result.ok) return result;

    // The model is told to return JSON, never trusted to. A malformed answer is
    // its own failure, reported with the code the UI already understands.
    try {
      return { ...result, insights: JSON.parse(result.text) };
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
