import { GoogleGenAI } from "@google/genai";

/**
 * Current stable Flash model, and the one Google's own 404 names as the
 * replacement for the older ones. Flash rather than Pro on purpose: this is
 * BYOK, so it is the merchant's quota, and Flash is what the free tier covers.
 *
 * The model line moves — 2.0-flash has since been shut down and 2.5-flash is
 * closed to new users — so this is a default, not an allowlist. A key that
 * cannot call this model is caught at save time and offered the ones it can
 * use; see suggestFlashModels below.
 */
const DEFAULT_MODEL = "gemini-3.6-flash";

/**
 * Map a provider failure onto a code the caller can act on.
 *
 * Raw provider errors are never returned: they leak internals and give the
 * user nothing to do. An invalid key, an exhausted quota and a rate limit
 * each need a different fix, so they get different codes.
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
 * One cheap call, purely to find out whether a key works.
 *
 * The error object is never logged whole — provider errors can echo the
 * request back, key included. Status and message are enough to tell a missing
 * model from a dead key, and neither carries the credential.
 */
export async function verifyGeminiKey(apiKey, model = DEFAULT_MODEL) {
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

/**
 * The models this key may actually use.
 *
 * "Model not available" is otherwise a dead end: the caller cannot tell a
 * retired model from a project that was never granted access, and guessing
 * names one at a time is a poor way to find out.
 */
export async function listGeminiModels(apiKey) {
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

/**
 * Words that rule a model out of the selector, whatever else its name says.
 *
 * One list, shared. It used to be written out twice — once here and once in
 * `suggestFlashModels` — and two copies of a list that has to follow Google's
 * model line are two copies that drift.
 */
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
 * Whether a model name is one worth offering.
 *
 * Flash only: the free tier stopped covering Pro models in 2026, so offering
 * one would send the user into a billing wall. Previews and `-latest` aliases
 * are out too — both move or vanish without notice, a poor thing to hand
 * someone as a setting they will store and forget.
 */
function isOfferableFlashModel(name) {
  return (
    name.includes("flash") &&
    !EXCLUDED_MODEL_WORDS.some((word) => name.includes(word)) &&
    !name.includes("preview") &&
    !name.endsWith("-latest")
  );
}

/** Google caps a page at a thousand. Asking for the cap avoids most paging. */
const MODELS_PAGE_SIZE = 1000;

/**
 * The models this key may actually use, straight from Google's models endpoint.
 *
 * GET https://generativelanguage.googleapis.com/v1beta/models with the key in
 * the x-goog-api-key header. The header rather than a query parameter because
 * a key in a URL lands in access logs, proxies and browser history — the
 * header keeps the credential out of everything that records the request line.
 *
 * Every page is read. The endpoint returns fifty models per page unless told
 * otherwise, and a key's list runs past that, so reading only the first page
 * silently dropped whichever models sorted onto the second — which, for an
 * alphabetical list, can be the newest ones.
 *
 * Listed does not mean usable. A key's model list includes entries it cannot
 * call — gemini-2.5-flash is listed for every key and 404s for new ones —
 * and many "flash" entries are audio, image or realtime variants that
 * generateContent cannot drive at all.
 */
export async function listAvailableModels(apiKey) {
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
        // Without a timeout a slow Google holds the settings request open
        // indefinitely, and the form's spinner with it.
        signal: AbortSignal.timeout(10_000),
      });

      if (!res.ok) {
        // Mirror a provider failure onto the same codes everything else uses.
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
      .filter((entry) =>
        // Only what generateContent can drive: the selector feeds insight
        // calls, and offering an embedding model there would 400 on first use.
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
 * Flash models this key can use, newest first.
 *
 * Called only when a model has already 404'd, to turn a dead end into a
 * choice. Deliberately derived from Google's own answer rather than a
 * hardcoded allowlist: the model line moves, and a static list would start
 * rejecting names that are perfectly valid — the same trap as validating an
 * API key by its prefix.
 *
 * Built on `listAvailableModels` so a suggestion and the selector can never
 * disagree. It used to filter names only, which meant it could suggest a model
 * that generateContent cannot drive — the very failure it exists to recover
 * from.
 */
export async function suggestFlashModels(apiKey) {
  const list = await listAvailableModels(apiKey);
  return list.ok ? list.models.slice(0, 5) : [];
}

/**
 * One insight call, on the business's own key and quota — with retries.
 *
 * The caller supplies all three inputs, and each does a different job:
 *
 * - `briefing` is the facts. The model cannot see the database, so this is a
 *   short written summary of the figures already on screen.
 * - `systemInstruction` is the job description. Who the model is answering as,
 *   and what it is for.
 * - `responseSchema` is the form to fill in. Without it the model returns
 *   prose, which has to be parsed by guesswork and renders differently every
 *   time. With it, the answer arrives as fields the UI can lay out.
 *
 * Transient upstream failures (busy model, per-minute quota) are retried with
 * a backoff before being reported, so a demand spike shows up as a slightly
 * slower card rather than an error. Retries happen here rather than in the
 * browser: the loop stays out of the rate limiter's accounting (each UI-driven
 * retry would otherwise burn one of the 20 hourly slots for the same user
 * request), and the merchant's key never has to leave this process.
 */
export async function generateInsights(
  apiKey,
  { briefing, systemInstruction, responseSchema, model = DEFAULT_MODEL },
) {
  let lastError = "GEMINI_UNAVAILABLE";

  for (let attempt = 0; attempt <= RETRY_DELAYS_MS.length; attempt++) {
    try {
      return await generateOnce(apiKey, {
        briefing,
        systemInstruction,
        responseSchema,
        model,
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

  // Unreachable — the loop returns on every path — but keeps the contract
  // honest for the compiler and for anyone reading without the loop in mind.
  return { ok: false, error: lastError };
}

/** One Gemini call. Extracted so generateInsights can retry it. */
async function generateOnce(
  apiKey,
  { briefing, systemInstruction, responseSchema, model },
) {
  const ai = new GoogleGenAI({ apiKey });

  const response = await ai.models.generateContent({
    model,
    contents: briefing,
    config: {
      ...(systemInstruction ? { systemInstruction } : {}),
      // Both or neither. A schema without the JSON mime type is ignored, and
      // the model quietly goes back to prose.
      ...(responseSchema
        ? {
            responseMimeType: "application/json",
            responseSchema,
          }
        : {}),
      temperature: 0.2,
      maxOutputTokens: 2048,
    },
  });

  const text = response.text ?? "";

  if (!text.trim()) {
    // An empty body is usually a safety block or a truncated response, and
    // it is not a provider error — the call succeeded and said nothing.
    return { ok: false, error: "GEMINI_EMPTY_RESPONSE" };
  }

  return {
    ok: true,
    text,
    model,
    // Passed back so the caller can show what the request cost. It is the
    // merchant's own quota being spent, so it should not be invisible.
    usage: {
      promptTokens: response.usageMetadata?.promptTokenCount ?? null,
      outputTokens: response.usageMetadata?.candidatesTokenCount ?? null,
      totalTokens: response.usageMetadata?.totalTokenCount ?? null,
    },
  };
}

/**
 * Codes worth another attempt, and no others.
 *
 * `GEMINI_UNAVAILABLE` is Google saying "the model is busy" (503) — spikes are
 * usually over in seconds, so waiting and retrying turns a user-visible error
 * into a slightly slower success. `GEMINI_RATE_LIMIT` is a per-minute quota
 * bump (429) — one retry after a pause is usually enough. Everything else
 * (invalid key, quota exhausted, malformed output) fails the same way on
 * every attempt, so retrying would just bill waiting time.
 */
const RETRYABLE = new Set(["GEMINI_UNAVAILABLE", "GEMINI_RATE_LIMIT"]);

/** Delays before the 2nd and 3rd attempt. Under 10 s total, so the dashboard
 * request stays well inside the proxy's patience while covering a typical
 * demand spike. */
const RETRY_DELAYS_MS = [2_000, 6_000];

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
