const { AISettings } = require("../../models");
const { decrypt } = require("../aiCrypto");
const { generateCloudflareText } = require("./cloudflareClient");

const DEFAULT_TEXT_MODEL = "@cf/zai-org/glm-4.7-flash";

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
    designType: { type: "string" },
    platform: { type: "string" },
    dimensions: { type: "string" },
    style: { type: "string" },
    targetAudience: { type: "string" },
    brandName: { type: "string" },
    requiredText: {
      type: "array",
      items: { type: "string" },
    },
    additionalInstructions: { type: "string" },
    needsClarification: { type: "boolean" },
    followUpQuestion: { type: "string" },
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
    // Remove optional Markdown code fences if the model includes them.
    parsed = parsed
      .replace(/^```(?:json)?\s*/i, "")
      .replace(/\s*```$/, "")
      .trim();

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

  // Preserve the latest extraction's clarification decision.
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

const buildSystemInstruction = () => {
  return `${SYSTEM_INSTRUCTION}

You MUST return a valid JSON object matching this exact JSON schema:

${JSON.stringify(DESIGN_CONTEXT_SCHEMA, null, 2)}

Important:
- Return JSON only.
- Do not include Markdown code fences.
- Do not include explanations before or after the JSON.
- Include every required property.
- Use the correct data types for every property.
- Do not add properties that are not in the schema.
`;
};

/**
 * Extract structured design context using Cloudflare Workers AI.
 */
const requestDesignContext = async (credentials, briefing, model) => {
  let result;

  try {
    result = await generateCloudflareText(
      credentials,
      [
        {
          role: "system",
          content: buildSystemInstruction(),
        },
        {
          role: "user",
          content: briefing,
        },
      ],
      {
        model,
        maxTokens: 2500,
        temperature: 0.1,
      },
    );
  } catch (error) {
    console.error("[cloudflare-design-context-request]", {
      code: error?.code || null,
      status: error?.status || null,
      name: error?.name || "UnknownError",
    });

    return {
      ok: false,
      error: error?.code || "CLOUDFLARE_TEXT_EXTRACTION_FAILED",
    };
  }

  const outputText =
    typeof result?.content === "string" ? result.content.trim() : "";

  if (!outputText) {
    return {
      ok: false,
      error: "CLOUDFLARE_EMPTY_TEXT_RESPONSE",
    };
  }

  const parsed = parseDesignContext(outputText);

  if (!parsed.ok) {
    console.warn("[cloudflare-design-context-parse]", {
      error: parsed.error,
      model: result?.model || model,
    });

    return {
      ok: false,
      error: "CLOUDFLARE_INVALID_DESIGN_CONTEXT",
    };
  }

  return {
    ok: true,
    value: parsed.value,
    model: result?.model || model,
  };
};

/**
 * Extract structured design context using Cloudflare Workers AI.
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
  if (typeof businessId !== "string" || !businessId.trim()) {
    return {
      ok: false,
      error: "BUSINESS_ID_REQUIRED",
    };
  }

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

  const normalizedOptions = normalizeDesignOptions(designOptions);

  if (!normalizedOptions.ok) {
    return normalizedOptions;
  }

  const normalizedPrevious = normalizePreviousContext(previousContext);

  if (!normalizedPrevious.ok) {
    return normalizedPrevious;
  }

  const normalizedHistory = normalizeConversationHistory(conversationHistory);

  if (!normalizedHistory.ok) {
    return normalizedHistory;
  }

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
  // GET BUSINESS CLOUDFLARE SETTINGS
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

  const credentials = settings.cloudflareAI;

  if (!credentials?.enabled) {
    return {
      ok: false,
      error: "CLOUDFLARE_NOT_ENABLED",
    };
  }

  // ---------------------------------------------
  // VALIDATE ENCRYPTED CLOUDFLARE CREDENTIALS
  // ---------------------------------------------

  const encryptedAccountId = credentials.accountId;
  const encryptedApiToken = credentials.apiToken;

  const isValidEncryptedValue = (value) =>
    value &&
    typeof value === "object" &&
    value.ciphertext &&
    value.iv &&
    value.authTag;

  if (
    !isValidEncryptedValue(encryptedAccountId) ||
    !isValidEncryptedValue(encryptedApiToken)
  ) {
    return {
      ok: false,
      error: "CLOUDFLARE_CREDENTIALS_MISSING",
    };
  }

  // ---------------------------------------------
  // DECRYPT CLOUDFLARE CREDENTIALS
  // ---------------------------------------------

  let accountId;
  let apiToken;

  try {
    accountId = decrypt(encryptedAccountId);
    apiToken = decrypt(encryptedApiToken);

    if (
      typeof accountId !== "string" ||
      !accountId.trim() ||
      typeof apiToken !== "string" ||
      !apiToken.trim()
    ) {
      throw new Error("EMPTY_DECRYPTED_CREDENTIALS");
    }

    accountId = accountId.trim();
    apiToken = apiToken.trim();
  } catch (error) {
    console.error("[design-context-credentials-decryption]", {
      name: error?.name || "UnknownError",
    });

    return {
      ok: false,
      error: "CLOUDFLARE_CREDENTIALS_DECRYPTION_FAILED",
    };
  }

  const cloudflareCredentials = {
    accountId,
    apiToken,
  };

  const textModel = credentials.textModel || DEFAULT_TEXT_MODEL;

  // ---------------------------------------------
  // CALL CLOUDFLARE WORKERS AI
  // ---------------------------------------------

  const extraction = await requestDesignContext(
    cloudflareCredentials,
    briefing.value,
    textModel,
  );

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

  return {
    ok: true,
    context: validatedContext.value,
    model: extraction.model || textModel,
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
