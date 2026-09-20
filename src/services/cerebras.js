/**
 * Cerebras: a free tier on wafer-scale hardware, OpenAI-compatible.
 *
 * Everything about making the call is shared (services/openaiCompatible.js).
 * What is Cerebras's own is here — chiefly which models to offer, because
 * only some of its catalogue honours a strict JSON schema, and a model that
 * ignores the schema produces empty cards rather than a visible error.
 */

import { createOpenAiCompatibleProvider } from "./openaiCompatible.js";

const BASE = "https://api.cerebras.ai/v1";

/**
 * On Cerebras's public shared tier, and documented as honouring
 * `json_schema` with `strict: true`. A default, not an allowlist: a key that
 * cannot call it is caught at save time and offered what it can use.
 */
const DEFAULT_MODEL = "gpt-oss-120b";

/**
 * The models Cerebras documents as supporting strict `json_schema`.
 *
 * Their `/models` reply lists what a key may call but says nothing about
 * structured output, so — as with Groq — the capability is recognised by
 * name. Families rather than exact ids, so a point release still matches.
 * `kimi` and `gemma` are on the list because a key with a trial or a
 * dedicated endpoint can call them; a key that cannot simply never sees them,
 * since this filters what the provider itself returned.
 */
const SCHEMA_CAPABLE = [
  /^gpt-oss/i,
  /^qwen-3/i,
  /^gemma-4/i,
  /^kimi-k2/i,
];

/** Audio and embedding models cannot write an insight. */
const NOT_FOR_TEXT = /whisper|tts|embed|guard/i;

const provider = createOpenAiCompatibleProvider({
  id: "cerebras",
  baseUrl: BASE,
  defaultModel: DEFAULT_MODEL,
  // `/models` needs the key like everything else, so it proves nothing a
  // one-token completion does not; the completion is the check.
  offerModel: (entry) => {
    const name = String(entry?.id ?? "");
    if (!name || NOT_FOR_TEXT.test(name)) return false;
    return SCHEMA_CAPABLE.some((pattern) => pattern.test(name));
  },
});

export const { verifyKey, listModels, suggestModels, generateInsights } =
  provider;
export { DEFAULT_MODEL };
