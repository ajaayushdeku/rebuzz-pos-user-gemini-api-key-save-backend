import { GoogleGenAI } from "@google/genai";

const DEFAULT_MODEL = "gemini-2.5-flash";

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
 * Flash models this key can use, newest first.
 *
 * Called only when a model has already 404'd, to turn a dead end into a
 * choice. Deliberately derived from Google's own answer rather than a
 * hardcoded allowlist: the model line moves, and a static list would start
 * rejecting names that are perfectly valid — the same trap as validating an
 * API key by its prefix.
 */
export async function suggestFlashModels(apiKey) {
  const list = await listGeminiModels(apiKey);
  if (!list.ok) return [];

  return list.models
    .map((name) => name.replace(/^models\//, ""))
    // Flash only: the free tier stopped covering Pro models in 2026, so
    // offering one would send the user into a billing wall.
    .filter(
      (name) =>
        name.includes("flash") &&
        !name.includes("image") &&
        !name.includes("tts") &&
        !name.includes("live"),
    )
    .sort()
    .reverse()
    .slice(0, 5);
}
