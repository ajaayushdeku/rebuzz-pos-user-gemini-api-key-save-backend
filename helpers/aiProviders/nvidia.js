/**
 * NVIDIA NIM: a free developer allowance across a large catalogue of models,
 * OpenAI-compatible.
 *
 * Everything about making the call is shared (helpers/aiProviders/openaiCompatible.js).
 * What is NVIDIA's own is here, and it is mostly the catalogue: their list
 * carries embedding, vision, safety, translation and parsing models beside
 * the chat ones, and says nothing about which can follow a JSON schema.
 */

const { createOpenAiCompatibleProvider } = require("./openaiCompatible");

const BASE = "https://integrate.api.nvidia.com/v1";

/**
 * The same family this service uses on Groq, and documented as honouring a
 * strict schema. A default, not an allowlist: a key that cannot call it is
 * caught at save time and offered what it can use.
 */
const DEFAULT_MODEL = "openai/gpt-oss-20b";

/**
 * Families worth offering: ones known to follow `json_schema`.
 *
 * NVIDIA's `/models` is a plain list — id, owner, nothing about capability —
 * so as with Groq this is recognised by name. Deliberately
 * conservative: a model that ignores the schema does not fail loudly, it
 * produces cards the app then drops, which reaches the merchant as an empty
 * section.
 */
const SCHEMA_CAPABLE = [
  /^openai\/gpt-oss/i,
  /^nvidia\/nemotron-3/i,
  /^nvidia\/llama-3\.[13]-nemotron/i,
  /^google\/gemma-4/i,
  /^qwen\//i,
  /^moonshotai\/kimi-k/i,
  /^mistralai\/mistral-(large|nemotron)/i,
];

/**
 * Everything in their catalogue that cannot write an insight, by name.
 *
 * Checked before the allowlist because some of these share a family with a
 * chat model — `nemotron-parse` and `nemotron-3-embed` sit right beside
 * `nemotron-3-super`.
 */
const NOT_FOR_TEXT =
  /embed|guard|safety|parse|translate|retriever|rerank|reward|clip|vision|vila|neva|kosmos|cosmos|ocr|video|diffusion|riva|code(llama|gemma|stral)|starcoder/i;

const provider = createOpenAiCompatibleProvider({
  id: "nvidia",
  baseUrl: BASE,
  defaultModel: DEFAULT_MODEL,
  // Their `/models` is public, so it proves nothing about a key; a one-token
  // completion is the check.
  offerModel: (entry) => {
    const name = String(entry?.id ?? "");
    if (!name || NOT_FOR_TEXT.test(name)) return false;
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
