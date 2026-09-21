/**
 * OpenRouter: one key, many models, several of them free.
 *
 * Everything about making the call is shared with the other OpenAI-compatible
 * providers (services/openaiCompatible.js). What is OpenRouter's own is here:
 * where it lives, how a key is checked, and which of its models are worth
 * offering a merchant.
 */

import { createOpenAiCompatibleProvider } from "./openaiCompatible.js";

const BASE = "https://openrouter.ai/api/v1";

/**
 * The default model: OpenRouter's own free router.
 *
 * It picks a free model per request and filters for the features the request
 * needs — structured output, in our case — which is exactly the problem a
 * hardcoded free model has: free models come and go weekly, and a pinned name
 * turns into a 404 in a month.
 */
const DEFAULT_MODEL = "openrouter/free";

/** A model is free when both halves of its price are zero. */
const isFree = (entry) =>
  Number(entry?.pricing?.prompt ?? 1) === 0 &&
  Number(entry?.pricing?.completion ?? 1) === 0;

/**
 * Only models that can be made to answer in a fixed shape.
 *
 * Every insight section sends a JSON schema and the app drops anything that
 * does not match it, so a model without structured output produces empty cards
 * rather than a visible error. Better never to offer it.
 */
const canDoStructuredOutput = (entry) => {
  const params = entry?.supported_parameters;
  return (
    Array.isArray(params) &&
    (params.includes("structured_outputs") || params.includes("response_format"))
  );
};

/**
 * Text out, and nothing else.
 *
 * Free and schema-capable is not enough on its own: OpenRouter's free list
 * includes music and image models — Lyria answers "text+audio" — which take
 * the same parameters and would be offered as a choice for writing insights.
 */
const writesTextOnly = (entry) => {
  const out = entry?.architecture?.output_modalities;
  return Array.isArray(out) && out.length === 1 && out[0] === "text";
};

const provider = createOpenAiCompatibleProvider({
  id: "openrouter",
  baseUrl: BASE,
  defaultModel: DEFAULT_MODEL,
  /**
   * Sent with every call so the account's dashboard shows what spent the
   * quota. OpenRouter reads these two headers for its attribution; both are
   * optional and neither carries anything about the business.
   */
  headers: {
    "HTTP-Referer": "https://rebuzz.pos",
    "X-Title": "Rebuzz POS",
  },
  // Free, and answers "is this key real?" before a completion is spent.
  keyCheckPath: "/key",
  offerModel: (entry) =>
    isFree(entry) && canDoStructuredOutput(entry) && writesTextOnly(entry),
});

export const { verifyKey, listModels, suggestModels, generateInsights } =
  provider;
export { DEFAULT_MODEL };
