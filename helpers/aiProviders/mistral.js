/**
 * Mistral: a large free allowance, OpenAI-compatible.
 *
 * Everything about making the call is shared (services/openaiCompatible.js).
 * What is Mistral's own is here: where it lives, and which of its models can
 * write an insight.
 *
 * Worth knowing before choosing it: Mistral's free tier is generous, but it
 * asks you to allow training on the traffic you send. The settings screen says
 * so — the briefings carry a business's sales figures and product names.
 */

import { createOpenAiCompatibleProvider } from "./openaiCompatible.js";

const BASE = "https://api.mistral.ai/v1";

/** Their small general model: free-tier friendly, and does structured output. */
const DEFAULT_MODEL = "mistral-small-latest";

/**
 * Their catalogue is broader than chat — embeddings, moderation, OCR, audio —
 * and none of those can answer an insight. Mistral's `/models` reports what a
 * model can do, so the capability is read rather than guessed at from the
 * name; the name check only removes the specialist lines that report chat but
 * are built for something else.
 */
const NOT_FOR_TEXT = /embed|moderation|ocr|audio|voxtral|transcrib|tts/i;

const provider = createOpenAiCompatibleProvider({
  id: "mistral",
  baseUrl: BASE,
  defaultModel: DEFAULT_MODEL,
  // `/models` needs the key like everything else, so a one-token completion
  // is the check that a key works.
  offerModel: (entry) => {
    const name = String(entry?.id ?? "");
    if (!name || NOT_FOR_TEXT.test(name)) return false;
    // Older entries report no capabilities at all; chat is the sane default
    // for a model that says nothing, and the save-time check catches the rest.
    const chat = entry?.capabilities?.completion_chat;
    return chat === undefined || chat === true;
  },
});

export const { verifyKey, listModels, suggestModels, generateInsights } =
  provider;
export { DEFAULT_MODEL };
