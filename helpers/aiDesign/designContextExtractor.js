const { AISettings } = require("../../models");
const { decrypt } = require("../aiCrypto");
const {
  classifyOpenAI429Error,
  openAIRequestFailure,
} = require("./openaiErrors");

const OPENAI_RESPONSES_URL = "https://api.openai.com/v1/responses";

const DEFAULT_TEXT_MODEL = process.env.OPENAI_TEXT_MODEL || "gpt-6-luna";

const OPENAI_REQUEST_TIMEOUT_MS = 60000;

const MAX_PROMPT_LENGTH = 6000;
const MAX_REQUIRED_TEXT_ITEMS = 30;
const MAX_REQUIRED_TEXT_LENGTH = 300;

const MAX_CONVERSATION_MESSAGES = 20;
const MAX_CONVERSATION_MESSAGE_LENGTH = 3000;
const MAX_CONVERSATION_TOTAL_LENGTH = 12000;

const MAX_PREVIOUS_CONTEXT_LENGTH = 6000;
const MAX_BRIEFING_LENGTH = 30000;

const MAX_FOLLOW_UP_LENGTH = 1000;

const FIELD_LIMITS = {
  designType: 100,
  platform: 100,
  dimensions: 100,
  style: 200,
  targetAudience: 300,
  brandName: 150,
  additionalInstructions: 2000,
};

const DESIGN_CONTEXT_SCHEMA = {
  type: "object",
  additionalProperties: false,
  properties: {
    designType: {
      type: "string",
    },
    platform: {
      type: "string",
    },
    dimensions: {
      type: "string",
    },
    style: {
      type: "string",
    },
    targetAudience: {
      type: "string",
    },
    brandName: {
      type: "string",
    },
    requiredText: {
      type: "array",
      items: {
        type: "string",
      },
    },
    additionalInstructions: {
      type: "string",
    },
    needsClarification: {
      type: "boolean",
    },
    followUpQuestion: {
      type: "string",
    },
  },
  required: [
    "designType",
    "platform",
    "dimensions",
    "style",
    "targetAudience",
    "brandName",
    "requiredText",
    "additionalInstructions",
    "needsClarification",
    "followUpQuestion",
  ],
};

const SYSTEM_INSTRUCTION = `
You are an AI graphic design assistant for a business design application.

Your task is to understand the user's design request and build a structured
design brief.

The user may describe their requirements over multiple messages.

Your responsibilities:

1. Understand what the user wants to create.
2. Extract the design requirements from the entire conversation.
3. Preserve information already provided in previous context.
4. Ask a follow-up question only when an essential requirement is missing.
5. Do not ask about optional preferences unless they are genuinely necessary.
6. Never invent brand names, promotional text, prices, contact details,
   addresses, dates, or other business information.
7. Preserve user-provided text accurately.
8. Do not discard earlier requirements when the user adds new information.
9. If the user corrects an earlier requirement, use the latest correction.
10. Do not generate the actual image. Your task is only to prepare the brief.

Essential information normally includes:

- What type of design the user wants.
- Where the design will be used, or its intended platform.
- Dimensions when they are necessary and cannot reasonably be inferred.

Optional information includes:

- Brand name.
- Target audience.
- Visual style.
- Colors.
- Additional instructions.

Do not ask the user to provide optional information unless it is important
for fulfilling the specific request.

When essential information is missing:
- Set needsClarification to true.
- Ask one concise, specific follow-up question.
- Do not ask multiple unrelated questions at once.

When enough information is available:
- Set needsClarification to false.
- Set followUpQuestion to an empty string.

For requiredText:
- Include exact text that must appear in the design.
- Preserve spelling, numbers, prices, dates and contact information.
- Do not create promotional claims or business details that the user
  did not provide.

Return only information matching the supplied JSON schema.
`;

const createEmptyDesignContext = () => ({
  designType: "",
  platform: "",
  dimensions: "",
  style: "",
  targetAudience: "",
  brandName: "",
  requiredText: [],
  additionalInstructions: "",
  needsClarification: true,
  followUpQuestion: "",
});

const isPlainObject = (value) =>
  value !== null && typeof value === "object" && !Array.isArray(value);

const getSerializedLength = (value) => {
  try {
    return Buffer.byteLength(JSON.stringify(value), "utf8");
  } catch {
    return Infinity;
  }
};

const normalizeString = (value, maxLength) => {
  if (typeof value !== "string") {
    return "";
  }

  return value.trim().slice(0, maxLength);
};

const normalizeRequiredText = (value) => {
  if (!Array.isArray(value)) {
    return [];
  }

  const result = [];
  const seen = new Set();

  for (const item of value) {
    if (typeof item !== "string") {
      continue;
    }

    const text = item.trim().slice(0, MAX_REQUIRED_TEXT_LENGTH);

    if (!text) {
      continue;
    }

    const key = text.toLowerCase();

    if (seen.has(key)) {
      continue;
    }

    seen.add(key);
    result.push(text);

    if (result.length >= MAX_REQUIRED_TEXT_ITEMS) {
      break;
    }
  }

  return result;
};

const validateDesignContext = (value) => {
  if (!isPlainObject(value)) {
    return {
      ok: false,
      error: "INVALID_DESIGN_CONTEXT",
    };
  }

  const context = createEmptyDesignContext();

  for (const [field, maxLength] of Object.entries(FIELD_LIMITS)) {
    context[field] = normalizeString(value[field], maxLength);
  }

  context.requiredText = normalizeRequiredText(value.requiredText);

  context.needsClarification =
    typeof value.needsClarification === "boolean"
      ? value.needsClarification
      : true;

  context.followUpQuestion = normalizeString(
    value.followUpQuestion,
    MAX_FOLLOW_UP_LENGTH,
  );

  if (context.needsClarification && !context.followUpQuestion) {
    return {
      ok: false,
      error: "DESIGN_CLARIFICATION_MISSING",
    };
  }

  if (!context.needsClarification) {
    context.followUpQuestion = "";
  }

  return {
    ok: true,
    value: context,
  };
};

const parseDesignContext = (value) => {
  let parsed = value;

  if (typeof parsed === "string") {
    try {
      parsed = JSON.parse(parsed);
    } catch {
      return {
        ok: false,
        error: "INVALID_DESIGN_CONTEXT_JSON",
      };
    }
  }

  return validateDesignContext(parsed);
};

const normalizeDesignOptions = (value) => {
  if (value === undefined || value === null) {
    return {
      ok: true,
      value: {},
    };
  }

  if (!isPlainObject(value)) {
    return {
      ok: false,
      error: "INVALID_DESIGN_OPTIONS",
    };
  }

  const normalized = {};

  for (const [field, maxLength] of Object.entries(FIELD_LIMITS)) {
    if (typeof value[field] === "string") {
      normalized[field] = normalizeString(value[field], maxLength);
    }
  }

  if (value.requiredText !== undefined) {
    if (!Array.isArray(value.requiredText)) {
      return {
        ok: false,
        error: "INVALID_REQUIRED_TEXT",
      };
    }

    normalized.requiredText = normalizeRequiredText(value.requiredText);
  }

  return {
    ok: true,
    value: normalized,
  };
};

const normalizePreviousContext = (value) => {
  if (value === undefined || value === null || value === "") {
    return {
      ok: true,
      value: null,
    };
  }

  if (typeof value === "string") {
    try {
      value = JSON.parse(value);
    } catch {
      return {
        ok: false,
        error: "INVALID_PREVIOUS_CONTEXT",
      };
    }
  }

  if (!isPlainObject(value)) {
    return {
      ok: false,
      error: "INVALID_PREVIOUS_CONTEXT",
    };
  }

  if (getSerializedLength(value) > MAX_PREVIOUS_CONTEXT_LENGTH) {
    return {
      ok: false,
      error: "PREVIOUS_CONTEXT_TOO_LONG",
    };
  }

  const validated = validateDesignContext({
    ...createEmptyDesignContext(),
    ...value,
  });

  if (!validated.ok) {
    return validated;
  }

  return {
    ok: true,
    value: validated.value,
  };
};

const normalizeConversationHistory = (value) => {
  if (value === undefined || value === null || value === "") {
    return {
      ok: true,
      value: [],
    };
  }

  if (typeof value === "string") {
    try {
      value = JSON.parse(value);
    } catch {
      return {
        ok: false,
        error: "INVALID_CONVERSATION_HISTORY",
      };
    }
  }

  if (!Array.isArray(value)) {
    return {
      ok: false,
      error: "INVALID_CONVERSATION_HISTORY",
    };
  }

  if (value.length > MAX_CONVERSATION_MESSAGES) {
    return {
      ok: false,
      error: "CONVERSATION_HISTORY_LIMIT_EXCEEDED",
    };
  }

  const history = [];
  let totalLength = 0;

  for (const message of value) {
    if (!isPlainObject(message)) {
      return {
        ok: false,
        error: "INVALID_CONVERSATION_HISTORY",
      };
    }

    if (message.role !== "user" && message.role !== "assistant") {
      return {
        ok: false,
        error: "INVALID_CONVERSATION_HISTORY",
      };
    }

    if (typeof message.content !== "string" || !message.content.trim()) {
      return {
        ok: false,
        error: "INVALID_CONVERSATION_HISTORY",
      };
    }

    const content = message.content.trim();

    if (content.length > MAX_CONVERSATION_MESSAGE_LENGTH) {
      return {
        ok: false,
        error: "CONVERSATION_MESSAGE_TOO_LONG",
      };
    }

    totalLength += content.length;

    if (totalLength > MAX_CONVERSATION_TOTAL_LENGTH) {
      return {
        ok: false,
        error: "CONVERSATION_HISTORY_TOO_LONG",
      };
    }

    history.push({
      role: message.role,
      content,
    });
  }

  return {
    ok: true,
    value: history,
  };
};

const mergeRequiredText = (...lists) => {
  return normalizeRequiredText(
    lists.flatMap((list) => (Array.isArray(list) ? list : [])),
  );
};

const mergeDesignContext = (
  previousContext,
  extractedContext,
  designOptions = {},
) => {
  const previous = previousContext || createEmptyDesignContext();

  const merged = {
    ...previous,
  };

  for (const field of Object.keys(FIELD_LIMITS)) {
    const extractedValue = extractedContext[field];

    if (typeof extractedValue === "string" && extractedValue.trim()) {
      merged[field] = extractedValue.trim();
    }
  }

  // Explicit application-level options take priority over AI extraction.
  for (const [field, value] of Object.entries(designOptions)) {
    if (field === "requiredText") {
      continue;
    }

    if (typeof value === "string" && value.trim()) {
      merged[field] = value.trim();
    }
  }

  merged.requiredText = mergeRequiredText(
    extractedContext.requiredText,
    designOptions.requiredText,
  );

  // These fields determine whether the UI should ask another question or
  // present the brief for confirmation. Preserve the latest extraction result.
  merged.needsClarification = extractedContext.needsClarification;
  merged.followUpQuestion = extractedContext.followUpQuestion || "";

  return merged;
};

const buildDesignBriefing = ({
  prompt,
  conversationHistory,
  previousContext,
  designOptions,
}) => {
  const briefing = {
    latestUserMessage: prompt,
    conversationHistory,
    previousDesignContext: previousContext,
    explicitlyProvidedDesignOptions: designOptions,
  };

  const serialized = JSON.stringify(briefing);

  if (Buffer.byteLength(serialized, "utf8") > MAX_BRIEFING_LENGTH) {
    return {
      ok: false,
      error: "DESIGN_BRIEFING_TOO_LONG",
    };
  }

  return {
    ok: true,
    value: serialized,
  };
};

const extractOutputText = (response) => {
  if (!Array.isArray(response?.output)) {
    return "";
  }

  const textParts = [];

  for (const item of response.output) {
    if (item?.type === "message" && Array.isArray(item.content)) {
      for (const content of item.content) {
        if (content?.type === "output_text" && content.text) {
          textParts.push(content.text);
        }
      }
    }
  }

  return textParts.join("\n").trim();
};

const getOpenAIError = (status, result) => {
  const rateLimitError = classifyOpenAI429Error({ status }, result);

  if (rateLimitError) {
    return rateLimitError;
  }

  const type = result?.error?.type;

  if (status === 401) {
    return "OPENAI_INVALID_API_KEY";
  }

  if (status === 403) {
    return "OPENAI_PERMISSION_DENIED";
  }

  if (status === 408 || status === 504) {
    return "OPENAI_TEXT_REQUEST_TIMEOUT";
  }

  if (status === 404) {
    return "OPENAI_TEXT_MODEL_UNAVAILABLE";
  }

  if (status >= 500) {
    return "OPENAI_SERVICE_UNAVAILABLE";
  }

  if (type === "server_error") {
    return "OPENAI_SERVICE_UNAVAILABLE";
  }

  return "OPENAI_TEXT_EXTRACTION_FAILED";
};

/**
 * Call OpenAI Responses API to extract structured design context.
 */
const requestDesignContext = async (apiKey, briefing) => {
  let response;

  try {
    response = await fetch(OPENAI_RESPONSES_URL, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: DEFAULT_TEXT_MODEL,
        instructions: SYSTEM_INSTRUCTION,
        input: [
          {
            role: "user",
            content: [
              {
                type: "input_text",
                text: briefing,
              },
            ],
          },
        ],
        text: {
          format: {
            type: "json_schema",
            name: "design_context",
            strict: true,
            schema: DESIGN_CONTEXT_SCHEMA,
          },
        },
      }),
      signal: AbortSignal.timeout(OPENAI_REQUEST_TIMEOUT_MS),
    });
  } catch (error) {
    if (error?.name === "TimeoutError" || error?.name === "AbortError") {
      return {
        ok: false,
        error: "OPENAI_TEXT_REQUEST_TIMEOUT",
      };
    }

    console.error("[openai-design-context-request]", {
      name: error?.name || "UnknownError",
    });

    return {
      ok: false,
      error: "OPENAI_CONNECTION_FAILED",
    };
  }

  let result;

  try {
    result = await response.json();
  } catch {
    return openAIRequestFailure(response, "OPENAI_INVALID_RESPONSE");
  }

  if (!response.ok) {
    const failure = openAIRequestFailure(
      response,
      getOpenAIError(response.status, result),
    );

    console.warn("[openai-design-context-response]", {
      status: response.status,
      providerCode: result?.error?.code ?? null,
      providerType: result?.error?.type ?? null,
      error: failure.error,
      requestId: failure.requestId ?? null,
    });

    return failure;
  }

  if (result?.status === "incomplete") {
    return {
      ok: false,
      error: "OPENAI_INCOMPLETE_RESPONSE",
    };
  }

  const refusal = result?.output?.some((item) =>
    item?.content?.some((content) => content?.type === "refusal"),
  );

  if (refusal) {
    return {
      ok: false,
      error: "OPENAI_DESIGN_REQUEST_REFUSED",
    };
  }

  const outputText = extractOutputText(result);

  if (!outputText) {
    return {
      ok: false,
      error: "OPENAI_EMPTY_TEXT_RESPONSE",
    };
  }

  const parsed = parseDesignContext(outputText);

  if (!parsed.ok) {
    return {
      ok: false,
      error: parsed.error,
    };
  }

  return {
    ok: true,
    value: parsed.value,
  };
};

/**
 * Extract structured design context using OpenAI.
 *
 * @param {object} params
 * @param {string} params.businessId
 * @param {string} params.prompt
 * @param {Array} params.conversationHistory
 * @param {object|null} params.previousContext
 * @param {object} params.designOptions
 *
 * @returns {Promise<object>}
 */
const extractDesignContext = async ({
  businessId,
  prompt,
  conversationHistory = [],
  previousContext = null,
  designOptions = {},
}) => {
  // ---------------------------------------------
  // VALIDATE BUSINESS
  // ---------------------------------------------

  if (typeof businessId !== "string" || !businessId.trim()) {
    return {
      ok: false,
      error: "BUSINESS_ID_REQUIRED",
    };
  }

  // ---------------------------------------------
  // VALIDATE PROMPT
  // ---------------------------------------------

  if (typeof prompt !== "string" || !prompt.trim()) {
    return {
      ok: false,
      error: "DESIGN_PROMPT_REQUIRED",
    };
  }

  const normalizedPrompt = prompt.trim();

  if (normalizedPrompt.length > MAX_PROMPT_LENGTH) {
    return {
      ok: false,
      error: "DESIGN_PROMPT_TOO_LONG",
    };
  }

  // ---------------------------------------------
  // VALIDATE DESIGN OPTIONS
  // ---------------------------------------------

  const normalizedOptions = normalizeDesignOptions(designOptions);

  if (!normalizedOptions.ok) {
    return normalizedOptions;
  }

  // ---------------------------------------------
  // VALIDATE PREVIOUS CONTEXT
  // ---------------------------------------------

  const normalizedPrevious = normalizePreviousContext(previousContext);

  if (!normalizedPrevious.ok) {
    return normalizedPrevious;
  }

  // ---------------------------------------------
  // VALIDATE CONVERSATION HISTORY
  // ---------------------------------------------

  const normalizedHistory = normalizeConversationHistory(conversationHistory);

  if (!normalizedHistory.ok) {
    return normalizedHistory;
  }

  // ---------------------------------------------
  // BUILD DESIGN BRIEFING
  // ---------------------------------------------

  const briefing = buildDesignBriefing({
    prompt: normalizedPrompt,
    conversationHistory: normalizedHistory.value,
    previousContext: normalizedPrevious.value,
    designOptions: normalizedOptions.value,
  });

  if (!briefing.ok) {
    return briefing;
  }

  // ---------------------------------------------
  // GET BUSINESS OPENAI SETTINGS
  // ---------------------------------------------

  let settings;

  try {
    settings = await AISettings.findOne({
      businessId: businessId.trim(),
    });
  } catch (error) {
    console.error("[design-context-settings]", {
      name: error?.name || "UnknownError",
    });

    return {
      ok: false,
      error: "AI_SETTINGS_LOOKUP_FAILED",
    };
  }

  if (!settings) {
    return {
      ok: false,
      error: "AI_SETTINGS_NOT_FOUND",
    };
  }

  // AI Design uses the OpenAI configuration directly.
  // Other AI features can continue using their existing providers.
  const credentials = settings.openaiImage;

  if (!credentials?.enabled) {
    return {
      ok: false,
      error: "OPENAI_NOT_ENABLED",
    };
  }

  // ---------------------------------------------
  // VALIDATE ENCRYPTED API KEY
  // ---------------------------------------------

  const encryptedKey = credentials.apiKey;

  if (
    !encryptedKey ||
    typeof encryptedKey !== "object" ||
    !encryptedKey.ciphertext ||
    !encryptedKey.iv ||
    !encryptedKey.authTag
  ) {
    return {
      ok: false,
      error: "AI_KEY_MISSING",
    };
  }

  // ---------------------------------------------
  // DECRYPT API KEY
  // ---------------------------------------------

  let apiKey;

  try {
    apiKey = decrypt(encryptedKey);

    if (typeof apiKey !== "string" || !apiKey.trim()) {
      throw new Error("EMPTY_DECRYPTED_KEY");
    }

    apiKey = apiKey.trim();
  } catch (error) {
    console.error("[design-context-key-decryption]", {
      name: error?.name || "UnknownError",
    });

    return {
      ok: false,
      error: "AI_KEY_DECRYPTION_FAILED",
    };
  }

  // ---------------------------------------------
  // CALL OPENAI
  // ---------------------------------------------

  const extraction = await requestDesignContext(apiKey, briefing.value);

  if (!extraction.ok) {
    return extraction;
  }

  // ---------------------------------------------
  // MERGE PREVIOUS CONTEXT AND NEW EXTRACTION
  // ---------------------------------------------

  const mergedContext = mergeDesignContext(
    normalizedPrevious.value,
    extraction.value,
    normalizedOptions.value,
  );

  const validatedContext = validateDesignContext(mergedContext);

  if (!validatedContext.ok) {
    return validatedContext;
  }

  // ---------------------------------------------
  // SUCCESS
  // ---------------------------------------------

  return {
    ok: true,
    context: validatedContext.value,
    model: DEFAULT_TEXT_MODEL,
  };
};

module.exports = {
  extractDesignContext,

  // Export helpers for testing.
  createEmptyDesignContext,
  normalizeRequiredText,
  validateDesignContext,
  parseDesignContext,
  normalizeDesignOptions,
  normalizePreviousContext,
  normalizeConversationHistory,
  mergeDesignContext,
  buildDesignBriefing,
};
