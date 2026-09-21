const { GoogleGenAI } = require("@google/genai");

/**
 * Current stable Flash model. Flash, not Pro: it is the merchant's own quota,
 * and only Flash is on the free tier. A default, not an allowlist — a key that
 * cannot call it is offered alternatives at save time (suggestFlashModels).
 */
const DEFAULT_MODEL = "gemini-3.6-flash";

/**
 * Map a Gemini failure to a code the caller can act on. Raw errors are never
 * returned: a bad key, a spent quota and a rate limit each need a different fix.
 */
function normalizeError(error) {
  const status = error?.status ?? error?.response?.status;
  const message = String(error?.message ?? "").toLowerCase();

  if (status === 400 || status === 401 || status === 403) {
    return "GEMINI_KEY_INVALID";
  }
  if (status === 429) {
    return message.includes("quota")
      ? "GEMINI_QUOTA_EXCEEDED"
      : "GEMINI_RATE_LIMIT";
  }
  if (status === 404) {
    return "GEMINI_MODEL_UNAVAILABLE";
  }
  return "GEMINI_UNAVAILABLE";
}

/**
 * One-token call to check that a key works. Logs status and message only —
 * the full error object can echo the key back.
 */
async function verifyGeminiKey(apiKey, model = DEFAULT_MODEL) {
  try {
    const ai = new GoogleGenAI({ apiKey });
    await ai.models.generateContent({
      model,
      contents: "ping",
      config: { maxOutputTokens: 1 },
    });
    return { ok: true, model };
  } catch (error) {
    const code = normalizeError(error);
    console.warn(
      `[gemini] verify failed model=${model} code=${code} status=${
        error?.status ?? error?.response?.status ?? "?"
      } message=${String(error?.message ?? "").slice(0, 300)}`,
    );
    return { ok: false, error: code };
  }
}

/** Every model name the key can see, unfiltered (used by list-models.mjs). */
async function listGeminiModels(apiKey) {
  try {
    const ai = new GoogleGenAI({ apiKey });
    const names = [];
    for await (const model of await ai.models.list()) {
      names.push(model.name ?? model.baseModelId ?? String(model));
    }
    return { ok: true, models: names };
  } catch (error) {
    return { ok: false, error: normalizeError(error) };
  }
}

/** Name fragments that rule a model out of the selector. */
const EXCLUDED_MODEL_WORDS = [
  "image",
  "tts",
  "live",
  "audio",
  "omni",
  "transcribe",
  "embedding",
  // Closed to new users; Google's own 404 points at gemini-3.6-flash.
  "2.5-flash",
  "2.0-flash",
];

/**
 * Flash only (Pro is off the free tier). Previews and `-latest` aliases are
 * skipped too: they change or vanish, which is wrong for a stored setting.
 */
function isOfferableFlashModel(name) {
  return (
    name.includes("flash") &&
    !EXCLUDED_MODEL_WORDS.some((word) => name.includes(word)) &&
    !name.includes("preview") &&
    !name.endsWith("-latest")
  );
}

/** Google's maximum page size; asking for it avoids most paging. */
const MODELS_PAGE_SIZE = 1000;

/**
 * Flash models this key can use for insights, newest first.
 *
 * - The key goes in a header, not the URL, so it stays out of access logs.
 * - Every page is read; the first page alone can miss the newest models.
 * - Listed is not the same as usable, hence the generateContent and name
 *   filters below.
 */
async function listAvailableModels(apiKey) {
  try {
    const entries = [];
    let pageToken = "";

    do {
      const url = new URL(
        "https://generativelanguage.googleapis.com/v1beta/models",
      );
      url.searchParams.set("pageSize", String(MODELS_PAGE_SIZE));
      if (pageToken) url.searchParams.set("pageToken", pageToken);

      const res = await fetch(url, {
        headers: { "x-goog-api-key": apiKey },
        // A slow Google must not hold the settings form open forever.
        signal: AbortSignal.timeout(10_000),
      });

      if (!res.ok) {
        const code = normalizeError({ status: res.status });
        console.warn(
          `[gemini] list models failed code=${code} status=${res.status}`,
        );
        return { ok: false, error: code };
      }

      const json = await res.json().catch(() => ({}));
      if (Array.isArray(json?.models)) entries.push(...json.models);
      pageToken =
        typeof json?.nextPageToken === "string" ? json.nextPageToken : "";
    } while (pageToken);

    const models = entries
      // Only models that can write text; an embedding model would 400 on use.
      .filter((entry) =>
        entry?.supportedGenerationMethods?.includes("generateContent"),
      )
      .map((entry) => String(entry?.name ?? "").replace(/^models\//, ""))
      .filter((name) => name && isOfferableFlashModel(name))
      .sort()
      .reverse();

    return { ok: true, models };
  } catch (error) {
    return { ok: false, error: normalizeError(error) };
  }
}

/**
 * Up to five usable models to offer after a model 404s. Built on
 * listAvailableModels so suggestions and the selector always agree.
 */
async function suggestFlashModels(apiKey) {
  const list = await listAvailableModels(apiKey);
  return list.ok ? list.models.slice(0, 5) : [];
}

/**
 * Output ceiling per insight reply, thinking included. Flash thinks before it
 * answers and both count against this; at 2,048 replies were cut off mid-JSON.
 * Only tokens actually generated are billed, so the headroom is free.
 */
const INSIGHTS_MAX_OUTPUT_TOKENS = 8_192;

/**
 * One insight call on the business's own key, with retries.
 *
 * - `briefing`: the facts — a written summary of the figures on screen.
 * - `systemInstruction`: the model's role and task.
 * - `responseSchema`: the JSON shape the answer must fill, so the UI gets
 *   fields instead of prose.
 *
 * Busy-model and per-minute failures are retried here, not in the browser, so
 * retries do not use up the hourly rate limit.
 */
async function generateInsights(
  apiKey,
  {
    briefing,
    systemInstruction,
    responseSchema,
    model = DEFAULT_MODEL,
    maxOutputTokens = INSIGHTS_MAX_OUTPUT_TOKENS,
  },
) {
  let lastError = "GEMINI_UNAVAILABLE";

  for (let attempt = 0; attempt <= RETRY_DELAYS_MS.length; attempt++) {
    try {
      return await generateOnce(apiKey, {
        briefing,
        systemInstruction,
        responseSchema,
        model,
        maxOutputTokens,
      });
    } catch (error) {
      const code = normalizeError(error);
      lastError = code;
      console.warn(
        `[gemini] insights failed model=${model} code=${code} status=${
          error?.status ?? error?.response?.status ?? "?"
        } attempt=${attempt + 1} message=${String(error?.message ?? "").slice(0, 300)}`,
      );

      if (!RETRYABLE.has(code) || attempt === RETRY_DELAYS_MS.length) {
        return { ok: false, error: code };
      }

      await sleep(RETRY_DELAYS_MS[attempt]);
    }
  }

  // Unreachable: every loop path returns.
  return { ok: false, error: lastError };
}

/** A single Gemini call, split out so generateInsights can retry it. */
async function generateOnce(
  apiKey,
  { briefing, systemInstruction, responseSchema, model, maxOutputTokens },
) {
  const ai = new GoogleGenAI({ apiKey });

  const response = await ai.models.generateContent({
    model,
    contents: briefing,
    config: {
      ...(systemInstruction ? { systemInstruction } : {}),
      // The schema is ignored unless the JSON mime type is set with it.
      ...(responseSchema
        ? {
            responseMimeType: "application/json",
            responseSchema,
          }
        : {}),
      temperature: 0.2,
      maxOutputTokens,
    },
  });

  const text = response.text ?? "";
  const finishReason = response.candidates?.[0]?.finishReason;

  // A reply cut off at the token ceiling is reported as truncated, not passed
  // on to fail parsing. Not retried: the same call would run out the same way.
  if (finishReason === "MAX_TOKENS") {
    console.warn(
      `[gemini] insights truncated model=${model} maxOutputTokens=${maxOutputTokens} thinking=${
        response.usageMetadata?.thoughtsTokenCount ?? "?"
      } answer=${response.usageMetadata?.candidatesTokenCount ?? "?"}`,
    );
    return { ok: false, error: "GEMINI_TRUNCATED" };
  }

  // Usually a safety block: the call worked but said nothing.
  if (!text.trim()) {
    return { ok: false, error: "GEMINI_EMPTY_RESPONSE" };
  }

  return {
    ok: true,
    text,
    model,
    // Returned so the merchant can see what their own quota was spent on.
    usage: {
      promptTokens: response.usageMetadata?.promptTokenCount ?? null,
      outputTokens: response.usageMetadata?.candidatesTokenCount ?? null,
      totalTokens: response.usageMetadata?.totalTokenCount ?? null,
      // Often the larger share of the cost, so counted separately.
      thinkingTokens: response.usageMetadata?.thoughtsTokenCount ?? null,
    },
  };
}

/**
 * Only temporary failures are retried: a busy model (503) or a per-minute
 * limit (429). A bad key or spent quota fails the same way every time.
 */
const RETRYABLE = new Set(["GEMINI_UNAVAILABLE", "GEMINI_RATE_LIMIT"]);

/** Waits before the 2nd and 3rd attempts; under 10 s in total. */
const RETRY_DELAYS_MS = [2_000, 6_000];

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

module.exports = {
  DEFAULT_MODEL,
  verifyGeminiKey,
  listGeminiModels,
  listAvailableModels,
  suggestFlashModels,
  generateInsights,
};
