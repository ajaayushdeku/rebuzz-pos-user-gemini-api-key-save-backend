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

const NOT_FOR_TEXT = /(?:glm-\d+\.\d+v(?:-|$)|vision|asr|ocr|embed|image|video|audio)/i;

const provider = createOpenAiCompatibleProvider({
  id: "zai",
  baseUrl: BASE,
  defaultModel: DEFAULT_MODEL,
  // Z.AI's API documents JSON-object mode rather than OpenAI strict JSON Schema.
  // The common adapter includes the schema in the system prompt and the
  // controller validates the returned JSON before saving insights.
  responseFormat: "json_object",
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
