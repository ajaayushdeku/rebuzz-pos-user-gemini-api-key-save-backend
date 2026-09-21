/**
 * The shape most providers copied from OpenAI, as one reusable provider.
 *
 * OpenRouter and Groq differ in their base URL, how a key is checked, and
 * which models are worth offering — not in how a chat completion is made. That
 * common part lives here, and each provider is a short configuration file
 * beside it rather than a second copy of the same 300 lines.
 *
 * Errors use the provider-neutral `AI_*` vocabulary; see helpers/aiProviders/index.js.
 */

/** Ten seconds is plenty for a key check or a model list; a hung request holds the settings form open. */
const METADATA_TIMEOUT_MS = 10_000;

/** One insight call. Slower than Gemini on free models, so a longer rope. */
const INSIGHT_TIMEOUT_MS = 60_000;

/**
 * Same ceiling as the Gemini service, and for the same reason: a reply cut off
 * mid-JSON reaches the merchant as "we couldn't read the answer".
 */
const INSIGHTS_MAX_OUTPUT_TOKENS = 8_192;

/**
 * Codes worth another attempt, and no others. A busy upstream and a per-minute
 * limit both clear on their own; an invalid key or a spent daily allowance
 * fail the same way every time.
 */
const RETRYABLE = new Set(["AI_UNAVAILABLE", "AI_RATE_LIMIT"]);

/** Delays before the 2nd and 3rd attempt, under 10 s in total. */
const RETRY_DELAYS_MS = [2_000, 6_000];

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Map a failure onto a code the caller can act on.
 *
 * Raw provider errors are never returned: they leak internals and give the
 * user nothing to do. 402 is "out of credits", which on a free account means
 * the allowance is spent — the same situation as a quota, so it reports as one.
 */
function normalizeError(status, message = "") {
  const text = String(message).toLowerCase();

  // A provider that has started asking for a card before its free tier works,
  // as free tiers sometimes do. Checked first, whatever the status: it is
  // neither a bad key nor a limit, and waiting or trying other models will not
  // change it.
  if (/payment method|add (a|your) (card|payment)|billing (details|info)/.test(text)) {
    return "AI_PAYMENT_REQUIRED";
  }

  if (status === 401 || status === 403) return "AI_KEY_INVALID";
  if (status === 402) return "AI_QUOTA_EXCEEDED";
  if (status === 429) {
    return text.includes("quota") || text.includes("daily")
      ? "AI_QUOTA_EXCEEDED"
      : "AI_RATE_LIMIT";
  }
  // 410 is a model that used to exist: NVIDIA answers it for anything past
  // its end of life, and "gone" is a model problem, not an outage.
  if (status === 404 || status === 410) return "AI_MODEL_UNAVAILABLE";
  if (status === 400) {
    // A 400 is usually the schema this service sent, not the merchant's key —
    // telling them their key is invalid would send them to fix the wrong thing.
    if (text.includes("api key")) return "AI_KEY_INVALID";
    return text.includes("model") ? "AI_MODEL_UNAVAILABLE" : "AI_UNAVAILABLE";
  }
  return "AI_UNAVAILABLE";
}

/**
 * The message a provider puts in a failure, without the rest of the body.
 *
 * Three shapes, because "OpenAI-compatible" stops at the happy path: OpenAI
 * and OpenRouter nest it under `error`, Groq and NVIDIA put it at the top
 * level, and Mistral uses `detail` — a string for a refusal, a list of field
 * complaints for a malformed request.
 */
function errorMessageOf(json) {
  const raw = json?.error?.message ?? json?.message ?? json?.detail;
  if (typeof raw === "string") return raw;
  if (Array.isArray(raw)) return String(raw[0]?.msg ?? raw[0]?.message ?? "");
  return "";
}

/**
 * The schema, as strict JSON-schema providers require it.
 *
 * OpenAI-compatible strict mode rejects a schema unless every object bans
 * extra properties and lists all of its properties as required. The section
 * schemas are written for Gemini, which asks for neither, so they are adjusted
 * here rather than in eight section files — the app already drops anything
 * that comes back malformed, so this only has to satisfy the provider.
 */
function toStrictSchema(schema) {
  if (Array.isArray(schema)) return schema.map(toStrictSchema);
  if (!schema || typeof schema !== "object") return schema;

  const out = {};
  for (const [key, value] of Object.entries(schema)) {
    out[key] = toStrictSchema(value);
  }

  if (out.type === "object" && out.properties) {
    out.additionalProperties = false;
    out.required = Object.keys(out.properties);
  }
  return out;
}

/**
 * Build a provider from the few things that actually differ.
 *
 * @param {object} config
 * @param {string} config.id            For log lines.
 * @param {string} config.baseUrl       Up to but not including `/chat/completions`.
 * @param {string} config.defaultModel
 * @param {object} [config.headers]     Anything the provider wants on every call.
 * @param {string} [config.keyCheckPath] A cheap GET that proves a key is real.
 * @param {(entry: object) => boolean} config.offerModel  Which listed models to offer.
 */
function createOpenAiCompatibleProvider({
  id,
  baseUrl,
  defaultModel,
  headers = {},
  keyCheckPath,
  offerModel,
}) {
  async function call(apiKey, path, { method = "GET", body, timeout }) {
    const res = await fetch(`${baseUrl}${path}`, {
      method,
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
        ...headers,
      },
      ...(body ? { body: JSON.stringify(body) } : {}),
      signal: AbortSignal.timeout(timeout),
    });

    const json = await res.json().catch(() => ({}));
    return { res, json };
  }

  /**
   * Whether a key works, and whether it can call this model.
   *
   * Where the provider offers one, a free metadata call answers "is this key
   * real?" first, which is the common failure when someone pastes a key. Only
   * then is a one-token completion spent to prove the model itself is
   * callable — the only way to catch a model the account cannot use before it
   * is stored.
   */
  async function verifyKey(apiKey, model = defaultModel) {
    if (keyCheckPath) {
      try {
        const { res, json } = await call(apiKey, keyCheckPath, {
          timeout: METADATA_TIMEOUT_MS,
        });
        if (!res.ok) {
          const upstream = errorMessageOf(json);
          const code = normalizeError(res.status, upstream);
          console.warn(
            `[${id}] verify key failed code=${code} status=${res.status} message=${upstream.slice(0, 300)}`,
          );
          return { ok: false, error: code, detail: upstream.slice(0, 200) };
        }
      } catch (error) {
        console.warn(
          `[${id}] verify key failed message=${String(error?.message ?? "").slice(0, 300)}`,
        );
        return { ok: false, error: "AI_UNAVAILABLE" };
      }
    }

    try {
      const { res, json } = await call(apiKey, "/chat/completions", {
        method: "POST",
        timeout: METADATA_TIMEOUT_MS,
        body: {
          model,
          messages: [{ role: "user", content: "ping" }],
          max_tokens: 1,
        },
      });

      if (!res.ok) {
        const upstream = errorMessageOf(json);
        const code = normalizeError(res.status, upstream);
        console.warn(
          `[${id}] verify model failed model=${model} code=${code} status=${res.status} message=${upstream.slice(0, 300)}`,
        );
        /**
         * The provider's own sentence travels with the code.
         *
         * Our codes say what kind of problem it is; only the provider knows
         * the particulars — which plan, which model, when the limit resets —
         * and a merchant staring at "no quota left" on a key they made a
         * minute ago has nothing to act on without it.
         */
        return { ok: false, error: code, detail: upstream.slice(0, 200) };
      }

      return { ok: true, model };
    } catch (error) {
      console.warn(
        `[${id}] verify model failed model=${model} message=${String(
          error?.message ?? "",
        ).slice(0, 300)}`,
      );
      return { ok: false, error: "AI_UNAVAILABLE" };
    }
  }

  /**
   * The models this key can use and this app can drive, best first.
   *
   * What counts is the provider's own business (`offerModel`), but the rule is
   * always some version of "free, text, and able to answer in a fixed shape" —
   * every insight section sends a JSON schema, and the app drops anything that
   * does not match it, so a model without structured output produces empty
   * cards rather than a visible error.
   */
  async function listModels(apiKey) {
    try {
      const { res, json } = await call(apiKey, "/models", {
        timeout: METADATA_TIMEOUT_MS,
      });

      if (!res.ok) {
        const code = normalizeError(res.status, errorMessageOf(json));
        console.warn(`[${id}] list models failed code=${code} status=${res.status}`);
        return { ok: false, error: code };
      }

      const entries = Array.isArray(json?.data) ? json.data : [];
      const models = entries
        .filter((entry) => offerModel(entry))
        .map((entry) => String(entry?.id ?? ""))
        .filter(Boolean)
        .sort();

      // The default leads the list when it is available: it is the one this
      // service is known to work with.
      const first = models.includes(defaultModel) ? [defaultModel] : [];
      return {
        ok: true,
        models: [...first, ...models.filter((name) => name !== defaultModel)],
      };
    } catch (error) {
      console.warn(
        `[${id}] list models failed message=${String(error?.message ?? "").slice(0, 300)}`,
      );
      return { ok: false, error: "AI_UNAVAILABLE" };
    }
  }

  /** The names to offer after a model turned out to be unavailable. */
  async function suggestModels(apiKey) {
    const list = await listModels(apiKey);
    return list.ok ? list.models.slice(0, 5) : [];
  }

  /** One call. Extracted so generateInsights can retry it. */
  async function generateOnce(
    apiKey,
    { briefing, systemInstruction, responseSchema, model, maxOutputTokens },
  ) {
    let res;
    let json;
    try {
      ({ res, json } = await call(apiKey, "/chat/completions", {
        method: "POST",
        timeout: INSIGHT_TIMEOUT_MS,
        body: {
          model,
          messages: [
            ...(systemInstruction
              ? [{ role: "system", content: systemInstruction }]
              : []),
            { role: "user", content: briefing },
          ],
          ...(responseSchema
            ? {
                response_format: {
                  type: "json_schema",
                  json_schema: {
                    name: "insights",
                    strict: true,
                    schema: toStrictSchema(responseSchema),
                  },
                },
              }
            : {}),
          temperature: 0.2,
          max_tokens: maxOutputTokens,
        },
      }));
    } catch (error) {
      console.warn(
        `[${id}] call failed model=${model} message=${String(
          error?.message ?? "",
        ).slice(0, 300)}`,
      );
      return { ok: false, error: "AI_UNAVAILABLE" };
    }

    if (!res.ok) {
      return {
        ok: false,
        error: normalizeError(res.status, errorMessageOf(json)),
      };
    }

    const choice = json?.choices?.[0];
    const text = String(choice?.message?.content ?? "");

    // Reported as what it is: a reply that hit the ceiling is half a JSON
    // document, and calling that a "format" problem sends anyone investigating
    // after the wrong thing. Not retried — the same briefing runs out the same
    // way.
    if (choice?.finish_reason === "length") {
      console.warn(
        `[${id}] insights truncated model=${model} maxOutputTokens=${maxOutputTokens}`,
      );
      return { ok: false, error: "AI_TRUNCATED" };
    }

    if (!text.trim()) {
      // The call succeeded and said nothing — a filter or an empty generation,
      // not a provider error.
      return { ok: false, error: "AI_EMPTY_RESPONSE" };
    }

    return {
      ok: true,
      text,
      // What actually answered, which with a router is not what was asked for:
      // it picks a model per request, and the caller stores this against the
      // cached answer.
      model: String(json?.model ?? model),
      usage: {
        promptTokens: json?.usage?.prompt_tokens ?? null,
        outputTokens: json?.usage?.completion_tokens ?? null,
        totalTokens: json?.usage?.total_tokens ?? null,
        // OpenAI-compatible bodies report reasoning tokens here when the model
        // does any; absent for most free models.
        thinkingTokens:
          json?.usage?.completion_tokens_details?.reasoning_tokens ?? null,
      },
    };
  }

  /**
   * One insight call on the business's own key — with retries.
   *
   * Same contract as the Gemini service: the briefing is the facts, the system
   * instruction is the job, and the schema is the form to fill in. Transient
   * failures (a busy model, a per-minute limit) are retried here so a spike
   * shows up as a slower card rather than an error, and so a retry never costs
   * the merchant one of their hourly slots upstream.
   */
  async function generateInsights(
    apiKey,
    {
      briefing,
      systemInstruction,
      responseSchema,
      model = defaultModel,
      maxOutputTokens = INSIGHTS_MAX_OUTPUT_TOKENS,
    },
  ) {
    let lastError = "AI_UNAVAILABLE";

    for (let attempt = 0; attempt <= RETRY_DELAYS_MS.length; attempt++) {
      const result = await generateOnce(apiKey, {
        briefing,
        systemInstruction,
        responseSchema,
        model,
        maxOutputTokens,
      });

      if (result.ok) return result;

      lastError = result.error;
      console.warn(
        `[${id}] insights failed model=${model} code=${result.error} attempt=${attempt + 1}`,
      );

      if (!RETRYABLE.has(result.error) || attempt === RETRY_DELAYS_MS.length) {
        return result;
      }
      await sleep(RETRY_DELAYS_MS[attempt]);
    }

    return { ok: false, error: lastError };
  }

  return { verifyKey, listModels, suggestModels, generateInsights, defaultModel };
}

module.exports = { toStrictSchema, createOpenAiCompatibleProvider };
