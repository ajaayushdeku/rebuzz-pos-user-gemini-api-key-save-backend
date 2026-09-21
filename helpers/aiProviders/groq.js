/**
 * Groq: a free tier on very fast hardware, OpenAI-compatible.
 *
 * Everything about making the call is shared (helpers/aiProviders/openaiCompatible.js).
 * What is Groq's own is here — chiefly which models to offer, because Groq's
 * catalogue is mostly models this app cannot use.
 */

const { createOpenAiCompatibleProvider } = require("./openaiCompatible");

const BASE = "https://api.groq.com/openai/v1";

/**
 * Small, fast, and on Groq's list of models that honour a strict JSON schema.
 * A default, not an allowlist: a key that cannot call it is caught at save
 * time and offered what it can use.
 */
const DEFAULT_MODEL = "openai/gpt-oss-20b";

/**
 * The model families Groq documents as supporting `json_schema`.
 *
 * Groq's `/models` reply says nothing about structured output — unlike
 * OpenRouter's, which lists supported parameters per model — so this is the
 * one place in the service where a capability has to be recognised by name.
 * Families rather than exact ids, so a point release (`-0905`) still matches,
 * and every other model is simply not offered: on a model that only does
 * `json_object`, a section's schema is ignored and the answer arrives in a
 * shape the app discards, which reaches the merchant as an empty card.
 */
const SCHEMA_CAPABLE = [/^openai\/gpt-oss/i, /^qwen\/qwen3/i, /kimi-k2/i];

/** Audio, moderation and vision-only models cannot write an insight. */
const NOT_FOR_TEXT = /whisper|tts|guard|vision|embed/i;

const provider = createOpenAiCompatibleProvider({
  id: "groq",
  baseUrl: BASE,
  defaultModel: DEFAULT_MODEL,
  // Groq has no free metadata endpoint that proves a key: a one-token
  // completion is the check.
  offerModel: (entry) => {
    const name = String(entry?.id ?? "");
    if (!name || NOT_FOR_TEXT.test(name)) return false;
    // `active: false` is a model Groq has retired but still lists.
    if (entry?.active === false) return false;
    return SCHEMA_CAPABLE.some((pattern) => pattern.test(name));
  },
});

const { verifyKey, listModels, suggestModels, generateInsights } = provider;

module.exports = {
  DEFAULT_MODEL,
  verifyKey,
  listModels,
  suggestModels,
  generateInsights,
};
