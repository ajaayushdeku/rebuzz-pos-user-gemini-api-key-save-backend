/**
 * The providers this service can call, behind one interface.
 *
 * Every route works through this file rather than importing a provider
 * directly, so adding a third one is a new entry here plus its own service
 * file — not a change to the settings routes, the insight route or the UI.
 *
 * Each provider exposes the same four calls:
 *   verifyKey(apiKey, model?)  -> { ok, model } | { ok: false, error }
 *   listModels(apiKey)         -> { ok, models } | { ok: false, error }
 *   suggestModels(apiKey)      -> string[]   (names to offer after a 404)
 *   generateInsights(apiKey, { briefing, systemInstruction, responseSchema, model })
 *
 * Errors use one provider-neutral vocabulary, so the frontend has a single set
 * of messages:
 *   AI_KEY_INVALID · AI_QUOTA_EXCEEDED · AI_RATE_LIMIT · AI_MODEL_UNAVAILABLE
 *   AI_UNAVAILABLE · AI_TRUNCATED · AI_EMPTY_RESPONSE · AI_MALFORMED_RESPONSE
 */

import {
  generateInsights as geminiGenerate,
  listAvailableModels as geminiListModels,
  suggestFlashModels as geminiSuggest,
  verifyGeminiKey,
} from "./gemini.js";
import * as openrouter from "./openrouter.js";
import * as groq from "./groq.js";
import * as mistral from "./mistral.js";
import * as nvidia from "./nvidia.js";

/**
 * The Gemini service still speaks its own `GEMINI_*` codes.
 *
 * Translated here rather than edited there: those strings are in its log lines
 * and its own retry set, and a provider that predates the neutral vocabulary
 * is exactly the thing an adapter is for.
 */
const neutral = (code) =>
  typeof code === "string" ? code.replace(/^GEMINI_/, "AI_") : "AI_UNAVAILABLE";

const translate = async (promise) => {
  const result = await promise;
  return result?.ok ? result : { ...result, error: neutral(result?.error) };
};

const gemini = {
  verifyKey: (apiKey, model) => translate(verifyGeminiKey(apiKey, model)),
  listModels: (apiKey) => translate(geminiListModels(apiKey)),
  suggestModels: geminiSuggest,
  generateInsights: (apiKey, options) =>
    translate(geminiGenerate(apiKey, options)),
};

/**
 * Everything the app needs to know about a provider, in one place.
 *
 * `defaultModel` is a starting point, never an allowlist: model lines move,
 * and a key that cannot call the default is caught at save time and offered
 * what it can use instead.
 */
export const PROVIDERS = {
  gemini: {
    id: "gemini",
    label: "Google Gemini",
    defaultModel: "gemini-3.6-flash",
    keysUrl: "https://aistudio.google.com/apikey",
    ...gemini,
  },
  openrouter: {
    id: "openrouter",
    label: "OpenRouter",
    defaultModel: openrouter.DEFAULT_MODEL,
    keysUrl: "https://openrouter.ai/keys",
    verifyKey: openrouter.verifyKey,
    listModels: openrouter.listModels,
    suggestModels: openrouter.suggestModels,
    generateInsights: openrouter.generateInsights,
  },
  groq: {
    id: "groq",
    label: "Groq",
    defaultModel: groq.DEFAULT_MODEL,
    keysUrl: "https://console.groq.com/keys",
    verifyKey: groq.verifyKey,
    listModels: groq.listModels,
    suggestModels: groq.suggestModels,
    generateInsights: groq.generateInsights,
  },
  mistral: {
    id: "mistral",
    label: "Mistral",
    defaultModel: mistral.DEFAULT_MODEL,
    keysUrl: "https://console.mistral.ai/api-keys",
    verifyKey: mistral.verifyKey,
    listModels: mistral.listModels,
    suggestModels: mistral.suggestModels,
    generateInsights: mistral.generateInsights,
  },
  nvidia: {
    id: "nvidia",
    label: "NVIDIA NIM",
    defaultModel: nvidia.DEFAULT_MODEL,
    keysUrl: "https://build.nvidia.com",
    verifyKey: nvidia.verifyKey,
    listModels: nvidia.listModels,
    suggestModels: nvidia.suggestModels,
    generateInsights: nvidia.generateInsights,
  },
};

/** The provider ids, for validating what arrives from a request. */
export const PROVIDER_IDS = Object.keys(PROVIDERS);

/** The one used when a business has never chosen — and every existing one. */
export const DEFAULT_PROVIDER = "gemini";

export function isProviderId(value) {
  return typeof value === "string" && PROVIDER_IDS.includes(value);
}

/**
 * The provider for an id, falling back to the default.
 *
 * Never throws: an id can reach this from a stored document written by an
 * older or newer version of the service, and a settings page that 500s is a
 * worse answer than one that shows the default provider.
 */
export function getProvider(id) {
  return PROVIDERS[id] ?? PROVIDERS[DEFAULT_PROVIDER];
}

/** What the settings UI needs to describe the choices. Never any credentials. */
export function providerCatalogue() {
  return PROVIDER_IDS.map((id) => ({
    id,
    label: PROVIDERS[id].label,
    defaultModel: PROVIDERS[id].defaultModel,
    keysUrl: PROVIDERS[id].keysUrl,
  }));
}
