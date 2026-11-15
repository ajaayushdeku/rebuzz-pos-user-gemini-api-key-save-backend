/**
 * Z.AI: GLM models through Z.AI's OpenAI-compatible API.
 *
 * Z.AI's Chat Completions API uses JSON-object mode for structured responses.
 * The shared adapter adds the requested JSON schema to the system instruction;
 * the Insights controller remains responsible for parsing and validating it.
 */

const { createOpenAiCompatibleProvider } = require("./openaiCompatible");

const BASE = "https://api.z.ai/api/paas/v4";

/**
 * A Flash model is a sensible starting point for business insights.
 * Availability is verified against the merchant's own API key at save time.
 */
const DEFAULT_MODEL = "glm-4.7-flash";

const NOT_FOR_TEXT =
  /(?:glm-\d+\.\d+v(?:-|$)|vision|asr|ocr|embed|image|video|audio)/i;

const provider = createOpenAiCompatibleProvider({
  id: "zai",
  baseUrl: BASE,
  defaultModel: DEFAULT_MODEL,
  responseFormat: "json_object",

  insightTimeoutMs: 120_000,

  // Do not repeatedly hit Z.AI when its rate limit is reached.
  retryableErrors: ["AI_UNAVAILABLE"],
  retryDelaysMs: [2_000],

  offerModel: (entry) => {
    const name = String(entry?.id ?? "");
    return Boolean(name) && /^glm-/i.test(name) && !NOT_FOR_TEXT.test(name);
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
