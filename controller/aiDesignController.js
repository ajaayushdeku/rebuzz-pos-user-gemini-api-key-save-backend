const { AISettings } = require("../models");
const { decrypt } = require("../helpers/aiCrypto");

const {
  processDesignInputs,
} = require("../helpers/aiDesign/referenceProcessor");

const {
  extractDesignContext,
} = require("../helpers/aiDesign/designContextExtractor");

const { buildDesignPrompt } = require("../helpers/aiDesign/promptBuilder");

const { generateOpenAIImage } = require("../helpers/aiDesign/openaiClient");

// -----------------------------------------------------------------------------
// Limits
// -----------------------------------------------------------------------------

const MAX_PROMPT_LENGTH = 6000;

const MAX_REQUIRED_TEXT_ITEMS = 30;
const MAX_REQUIRED_TEXT_LENGTH = 300;

const MAX_SOCIAL_URLS = 5;
const MAX_SOCIAL_URL_LENGTH = 2048;

const MAX_HISTORY_ITEMS = 20;
const MAX_HISTORY_MESSAGE_LENGTH = 3000;
const MAX_HISTORY_TOTAL_LENGTH = 12000;

const MAX_CONTEXT_LENGTH = 6000;
const MAX_FOLLOW_UP_LENGTH = 1000;

const EXPLICIT_FIELDS = [
  "designType",
  "platform",
  "dimensions",
  "style",
  "targetAudience",
  "brandName",
  "additionalInstructions",
];

const FIELD_LIMITS = {
  designType: 100,
  platform: 100,
  dimensions: 100,
  style: 200,
  targetAudience: 300,
  brandName: 150,
  additionalInstructions: 2000,
};

const resolveImageSize = (dimensions = "", platform = "") => {
  const description = `${dimensions} ${platform}`.toLowerCase();
  const dimensionMatch = description.match(/(\d{2,5})\s*(?:x|×|:)\s*(\d{2,5})/);

  if (dimensionMatch) {
    const width = Number(dimensionMatch[1]);
    const height = Number(dimensionMatch[2]);

    if (width > 0 && height > 0) {
      const ratio = width / height;

      if (ratio > 1.15) return "1536x1024";
      if (ratio < 0.87) return "1024x1536";
      return "1024x1024";
    }
  }

  if (/portrait|vertical|story|reel|short|tiktok/.test(description)) {
    return "1024x1536";
  }

  if (/landscape|horizontal|wide|banner/.test(description)) {
    return "1536x1024";
  }

  return "1024x1024";
};

// -----------------------------------------------------------------------------
// Error handling
// -----------------------------------------------------------------------------

const internalError = (res, err) => {
  console.error("[ai-design]", err?.message ?? err);

  return res.status(500).json({
    success: false,
    error: "INTERNAL_ERROR",
  });
};

const mapContextErrorStatus = (error) => {
  const statusMap = {
    BUSINESS_ID_REQUIRED: 400,
    DESIGN_PROMPT_REQUIRED: 400,
    DESIGN_PROMPT_TOO_LONG: 400,
    INVALID_DESIGN_OPTIONS: 400,
    INVALID_REQUIRED_TEXT: 400,
    INVALID_PREVIOUS_CONTEXT: 400,
    INVALID_CONVERSATION_HISTORY: 400,
    CONVERSATION_HISTORY_LIMIT_EXCEEDED: 400,
    CONVERSATION_MESSAGE_TOO_LONG: 400,
    CONVERSATION_HISTORY_TOO_LONG: 400,
    DESIGN_BRIEFING_TOO_LONG: 400,

    AI_SETTINGS_NOT_FOUND: 424,
    AI_SETTINGS_LOOKUP_FAILED: 500,
    OPENAI_NOT_ENABLED: 403,
    AI_KEY_MISSING: 424,
    AI_KEY_DECRYPTION_FAILED: 500,

    OPENAI_INVALID_API_KEY: 401,
    OPENAI_PERMISSION_DENIED: 403,
    OPENAI_QUOTA_EXCEEDED: 429,
    OPENAI_RATE_LIMITED: 429,
    OPENAI_REQUEST_LIMIT_REACHED: 429,
    OPENAI_RATE_OR_QUOTA_LIMIT: 429,
    OPENAI_TEXT_REQUEST_TIMEOUT: 504,
    OPENAI_TEXT_MODEL_UNAVAILABLE: 502,
    OPENAI_SERVICE_UNAVAILABLE: 503,
    OPENAI_CONNECTION_FAILED: 502,

    OPENAI_INVALID_RESPONSE: 502,
    OPENAI_EMPTY_TEXT_RESPONSE: 502,
    OPENAI_INCOMPLETE_RESPONSE: 502,
    OPENAI_TEXT_EXTRACTION_FAILED: 502,
    OPENAI_DESIGN_REQUEST_REFUSED: 400,
    INVALID_DESIGN_CONTEXT: 502,
    INVALID_DESIGN_CONTEXT_JSON: 502,
    DESIGN_CLARIFICATION_MISSING: 502,
  };

  return statusMap[error] || 502;
};

const mapImageErrorStatus = (error) => {
  const statusMap = {
    OPENAI_INVALID_API_KEY: 401,
    OPENAI_PERMISSION_DENIED: 403,
    OPENAI_QUOTA_EXCEEDED: 429,
    OPENAI_RATE_LIMITED: 429,
    OPENAI_REQUEST_LIMIT_REACHED: 429,
    OPENAI_RATE_OR_QUOTA_LIMIT: 429,

    OPENAI_IMAGE_MODERATION_BLOCKED: 400,
    OPENAI_IMAGE_INVALID_REQUEST: 400,
    OPENAI_IMAGE_INPUT_INVALID: 400,
    OPENAI_IMAGE_INPUTS_INVALID: 400,
    OPENAI_IMAGE_INPUT_COUNT_EXCEEDED: 400,
    OPENAI_IMAGE_COUNT_INVALID: 400,
    OPENAI_IMAGE_COUNT_MISMATCH: 502,

    OPENAI_IMAGE_PROMPT_REQUIRED: 400,
    OPENAI_IMAGE_PROMPT_TOO_LONG: 400,
    OPENAI_IMAGE_MODEL_UNSUPPORTED: 400,
    OPENAI_IMAGE_SIZE_UNSUPPORTED: 400,
    OPENAI_IMAGE_QUALITY_UNSUPPORTED: 400,
    OPENAI_IMAGE_FORMAT_UNSUPPORTED: 400,
    OPENAI_IMAGE_BACKGROUND_UNSUPPORTED: 400,
    OPENAI_IMAGE_TRANSPARENT_FORMAT_UNSUPPORTED: 400,

    OPENAI_IMAGE_BACKGROUND_UNSUPPORTED: 400,
    OPENAI_IMAGE_TRANSPARENT_FORMAT_UNSUPPORTED: 400,
    OPENAI_IMAGE_EMPTY_RESPONSE: 502,
    OPENAI_IMAGE_DATA_MISSING: 502,
    OPENAI_IMAGE_SIGNATURE_INVALID: 502,
    OPENAI_IMAGE_GENERATED_IMAGE_TOO_LARGE: 502,

    OPENAI_IMAGE_TOTAL_INPUT_TOO_LARGE: 413,
    OPENAI_IMAGE_INPUT_TOO_LARGE: 413,
    // OPENAI_IMAGE_GENERATED_IMAGE_TOO_LARGE: 502,
    OPENAI_GENERATED_IMAGE_TOO_LARGE: 502,

    OPENAI_IMAGE_EMPTY_RESPONSE: 502,
    OPENAI_IMAGE_DATA_MISSING: 502,
    OPENAI_GENERATED_IMAGE_INVALID: 502,
    OPENAI_INVALID_RESPONSE: 502,

    OPENAI_IMAGE_REQUEST_TIMEOUT: 504,
    OPENAI_SERVICE_UNAVAILABLE: 503,
    OPENAI_CONNECTION_FAILED: 502,
    OPENAI_IMAGE_MODEL_UNAVAILABLE: 502,
    OPENAI_IMAGE_GENERATION_FAILED: 502,
  };

  return statusMap[error] || 502;
};

// -----------------------------------------------------------------------------
// OpenAI image credentials
// -----------------------------------------------------------------------------

const getOpenAIImageKey = async (businessId) => {
  if (!businessId) {
    return {
      ok: false,
      error: "BUSINESS_ID_REQUIRED",
    };
  }

  const settings = await AISettings.findOne({
    businessId,
  });

  if (!settings?.openaiImage?.apiKey) {
    return {
      ok: false,
      error: "OPENAI_IMAGE_KEY_NOT_CONFIGURED",
    };
  }

  if (!settings.openaiImage.enabled) {
    return {
      ok: false,
      error: "OPENAI_IMAGE_GENERATION_DISABLED",
    };
  }

  try {
    const apiKey = decrypt(settings.openaiImage.apiKey);

    if (typeof apiKey !== "string" || !apiKey.trim()) {
      throw new Error("Invalid decrypted API key");
    }

    return {
      ok: true,
      apiKey: apiKey.trim(),
    };
  } catch {
    return {
      ok: false,
      error: "OPENAI_IMAGE_KEY_UNREADABLE",
    };
  }
};

// -----------------------------------------------------------------------------
// Input normalization
// -----------------------------------------------------------------------------

const normalizeArrayInput = (value) => {
  if (value === undefined || value === null || value === "") {
    return [];
  }

  if (Array.isArray(value)) {
    return value;
  }

  if (typeof value !== "string") {
    return null;
  }

  try {
    const parsed = JSON.parse(value);

    if (Array.isArray(parsed)) {
      return parsed;
    }
  } catch {
    // Treat a normal string as one item.
  }

  return [value];
};

const normalizeSocialUrls = (value) => {
  const result = normalizeArrayInput(value);

  if (!result || result.length > MAX_SOCIAL_URLS) {
    return null;
  }

  const normalized = [];

  for (const item of result) {
    if (
      typeof item !== "string" ||
      !item.trim() ||
      item.trim().length > MAX_SOCIAL_URL_LENGTH
    ) {
      return null;
    }

    let parsed;

    try {
      parsed = new URL(item.trim());
    } catch {
      return null;
    }

    // Social reference URLs must use HTTPS.
    if (
      parsed.protocol !== "https:" ||
      parsed.username ||
      parsed.password ||
      parsed.port
    ) {
      return null;
    }

    normalized.push(parsed.toString());
  }

  return [...new Set(normalized)];
};

const parseRequiredText = (value) => {
  const result = normalizeArrayInput(value);

  if (
    !result ||
    result.length > MAX_REQUIRED_TEXT_ITEMS ||
    !result.every(
      (item) =>
        typeof item === "string" &&
        item.trim().length > 0 &&
        item.trim().length <= MAX_REQUIRED_TEXT_LENGTH,
    )
  ) {
    return null;
  }

  return [...new Set(result.map((item) => item.trim()))];
};

// -----------------------------------------------------------------------------
// Context validation
// -----------------------------------------------------------------------------

const getContextOverrides = (body = {}) => {
  const overrides = {};

  for (const field of EXPLICIT_FIELDS) {
    const value = body[field];

    if (value === undefined || value === null || value === "") {
      continue;
    }

    if (
      typeof value !== "string" ||
      !value.trim() ||
      value.trim().length > FIELD_LIMITS[field]
    ) {
      return null;
    }

    overrides[field] = value.trim();
  }

  return overrides;
};

const validateRequiredTextList = (value) => {
  if (value === undefined || value === null) {
    return {
      ok: true,
      value: [],
    };
  }

  if (!Array.isArray(value) || value.length > MAX_REQUIRED_TEXT_ITEMS) {
    return {
      ok: false,
    };
  }

  const normalized = [];

  for (const item of value) {
    if (
      typeof item !== "string" ||
      !item.trim() ||
      item.trim().length > MAX_REQUIRED_TEXT_LENGTH
    ) {
      return {
        ok: false,
      };
    }

    normalized.push(item.trim());
  }

  return {
    ok: true,
    value: [...new Set(normalized)],
  };
};

const mergeRequiredText = (extractedText = [], explicitText = []) => {
  return [...new Set([...extractedText, ...explicitText])];
};

/**
 * Validate fields returned by the AI context extractor.
 *
 * AI-generated values are not trusted just because they
 * came from our configured provider.
 */
const validateExtractedContext = (context) => {
  if (!context || typeof context !== "object" || Array.isArray(context)) {
    return {
      ok: false,
    };
  }

  const validated = {};

  for (const [field, maxLength] of Object.entries(FIELD_LIMITS)) {
    const value = context[field];

    if (value === undefined || value === null || value === "") {
      continue;
    }

    if (
      typeof value !== "string" ||
      !value.trim() ||
      value.trim().length > maxLength
    ) {
      return {
        ok: false,
      };
    }

    validated[field] = value.trim();
  }

  if (
    context.needsClarification !== undefined &&
    typeof context.needsClarification !== "boolean"
  ) {
    return {
      ok: false,
    };
  }

  const requiredText = validateRequiredTextList(context.requiredText);

  if (!requiredText.ok) {
    return {
      ok: false,
    };
  }

  const needsClarification = context.needsClarification === true;
  const followUpQuestion = context.followUpQuestion;

  if (
    typeof followUpQuestion !== "string" ||
    followUpQuestion.trim().length > MAX_FOLLOW_UP_LENGTH ||
    (needsClarification && !followUpQuestion.trim())
  ) {
    return {
      ok: false,
    };
  }

  validated.requiredText = requiredText.value;
  validated.needsClarification = needsClarification;
  validated.followUpQuestion = needsClarification
    ? followUpQuestion.trim()
    : "";

  return {
    ok: true,
    value: validated,
  };
};

// -----------------------------------------------------------------------------
// Previous context validation
// -----------------------------------------------------------------------------

const validatePreviousContext = (value) => {
  if (value === undefined || value === null) {
    return {
      ok: true,
      value: null,
    };
  }

  // Multipart form fields arrive as strings. Parse the JSON representation
  // sent by CreateDesignTab before validating the context object.
  if (typeof value === "string") {
    try {
      value = JSON.parse(value);
    } catch {
      return {
        ok: false,
      };
    }
  }

  if (typeof value !== "object" || Array.isArray(value)) {
    return {
      ok: false,
    };
  }

  try {
    const serialized = JSON.stringify(value);

    if (
      typeof serialized !== "string" ||
      Buffer.byteLength(serialized, "utf8") > MAX_CONTEXT_LENGTH
    ) {
      return {
        ok: false,
      };
    }

    return {
      ok: true,
      value,
    };
  } catch {
    return {
      ok: false,
    };
  }
};

// -----------------------------------------------------------------------------
// Conversation history validation
// -----------------------------------------------------------------------------

const validateConversationHistory = (value) => {
  if (value === undefined || value === null) {
    return {
      ok: true,
      value: [],
    };
  }

  // Multipart form fields arrive as strings. Parse the JSON array sent by
  // CreateDesignTab before validating the conversation entries.
  if (typeof value === "string") {
    try {
      value = JSON.parse(value);
    } catch {
      return {
        ok: false,
      };
    }
  }

  if (!Array.isArray(value) || value.length > MAX_HISTORY_ITEMS) {
    return {
      ok: false,
    };
  }

  let totalLength = 0;

  const history = [];

  for (const item of value) {
    if (
      !item ||
      typeof item !== "object" ||
      Array.isArray(item) ||
      !["user", "assistant"].includes(item.role) ||
      typeof item.content !== "string" ||
      !item.content.trim() ||
      item.content.length > MAX_HISTORY_MESSAGE_LENGTH
    ) {
      return {
        ok: false,
      };
    }

    totalLength += item.content.length;

    if (totalLength > MAX_HISTORY_TOTAL_LENGTH) {
      return {
        ok: false,
      };
    }

    history.push({
      role: item.role,
      content: item.content.trim(),
    });
  }

  return {
    ok: true,
    value: history,
  };
};

// -----------------------------------------------------------------------------
// Controller
// -----------------------------------------------------------------------------

const aiDesignController = {
  async generate(req, res) {
    try {
      const body = req.body ?? {};
      const prompt = body.prompt;

      // 1. Validate the main prompt.
      if (
        typeof prompt !== "string" ||
        !prompt.trim() ||
        prompt.trim().length > MAX_PROMPT_LENGTH
      ) {
        return res.status(400).json({
          success: false,
          error: "INVALID_DESIGN_PROMPT",
        });
      }

      // 2. Validate business identity.
      if (!req.businessId) {
        return res.status(400).json({
          success: false,
          error: "BUSINESS_ID_REQUIRED",
        });
      }

      // 3. Validate explicit design context.
      const contextOverrides = getContextOverrides(body);

      if (!contextOverrides) {
        return res.status(400).json({
          success: false,
          error: "INVALID_DESIGN_CONTEXT",
        });
      }

      // 4. Normalize social reference URLs.
      const socialUrls = normalizeSocialUrls(body.socialUrls);

      if (!socialUrls) {
        return res.status(400).json({
          success: false,
          error: "DESIGN_SOCIAL_REFERENCES_INVALID",
        });
      }

      // 5. Validate required text.
      const explicitRequiredText = parseRequiredText(body.requiredText);

      if (explicitRequiredText === null) {
        return res.status(400).json({
          success: false,
          error: "INVALID_REQUIRED_TEXT",
        });
      }

      // 6. Validate previous context.
      const previousContext = validatePreviousContext(body.previousContext);

      if (!previousContext.ok) {
        return res.status(400).json({
          success: false,
          error: "INVALID_PREVIOUS_CONTEXT",
        });
      }

      // 7. Validate conversation history.
      const conversationHistory = validateConversationHistory(
        body.conversationHistory,
      );

      if (!conversationHistory.ok) {
        return res.status(400).json({
          success: false,
          error: "INVALID_CONVERSATION_HISTORY",
        });
      }

      const shouldGenerateImage =
        body.generateImage === true || body.generateImage === "true";

      // 8. Process uploaded images and assets.
      const referenceImages = req.designUploads?.referenceImages ?? [];

      const assets = req.designUploads?.assets ?? [];

      const processedInputs = processDesignInputs({
        referenceImages,
        assets,
        socialUrls,
      });

      if (!processedInputs || !processedInputs.ok) {
        return res.status(400).json({
          success: false,
          error: processedInputs?.error || "DESIGN_INPUT_PROCESSING_FAILED",
        });
      }

      // 9. Extract structured design context.
      //
      // First request:
      // Extract the brief using OpenAI.
      //
      // Confirmation request:
      // Reuse the already-approved context without making
      // another OpenAI text extraction request.

      let extracted;

      if (shouldGenerateImage) {
        if (!previousContext.value) {
          return res.status(400).json({
            success: false,
            error: "PREVIOUS_CONTEXT_REQUIRED",
          });
        }

        extracted = {
          ok: true,
          context: previousContext.value,
        };
      } else {
        extracted = await extractDesignContext({
          businessId: req.businessId,
          prompt: prompt.trim(),

          designOptions: {
            ...contextOverrides,
            requiredText: explicitRequiredText,
          },

          previousContext: previousContext.value,
          conversationHistory: conversationHistory.value,
        });
      }

      if (!extracted?.ok) {
        return res.status(mapContextErrorStatus(extracted?.error)).json({
          success: false,
          error: extracted?.error || "AI_INVALID_RESPONSE",
          message: extracted?.message,
          requestId: extracted?.requestId,
        });
      }

      // 10. Validate the extracted context.
      const validatedContext = validateExtractedContext(extracted.context);

      if (!validatedContext.ok) {
        return res.status(502).json({
          success: false,
          error: "AI_INVALID_RESPONSE",
        });
      }

      // 11. Merge extracted context with explicit frontend values.
      const finalContext = {
        ...validatedContext.value,
        ...contextOverrides,
      };

      finalContext.requiredText = mergeRequiredText(
        validatedContext.value.requiredText,
        explicitRequiredText,
      );

      // Validate the merged text once more.
      const mergedRequiredText = validateRequiredTextList(
        finalContext.requiredText,
      );

      if (!mergedRequiredText.ok) {
        return res.status(502).json({
          success: false,
          error: "AI_INVALID_RESPONSE",
        });
      }

      finalContext.requiredText = mergedRequiredText.value;

      // Do not generate an image if the merchant is trying to
      // confirm a brief that still needs clarification.

      if (shouldGenerateImage && finalContext.needsClarification) {
        return res.status(400).json({
          success: false,
          error: "DESIGN_BRIEF_NOT_READY",
        });
      }

      // 12. Return clarification before requesting image credentials.
      if (finalContext.needsClarification) {
        if (
          typeof finalContext.followUpQuestion !== "string" ||
          !finalContext.followUpQuestion.trim()
        ) {
          return res.status(502).json({
            success: false,
            error: "AI_INVALID_RESPONSE",
          });
        }

        return res.status(200).json({
          success: true,
          needsClarification: true,
          followUpQuestion: finalContext.followUpQuestion,
          context: finalContext,
        });
      }

      // 13. Build the final image-generation prompt.
      const designPrompt = buildDesignPrompt({
        prompt: prompt.trim(),
        ...finalContext,

        referenceImagesCount: processedInputs.referenceImages.length,

        assetsCount: processedInputs.assets.length,

        socialReferences: processedInputs.socialReferences,
      });

      if (
        !designPrompt?.ok ||
        typeof designPrompt.prompt !== "string" ||
        !designPrompt.prompt.trim()
      ) {
        return res.status(400).json({
          success: false,
          error: designPrompt?.error || "INVALID_GENERATED_DESIGN_PROMPT",
        });
      }

      // 14. Return the prepared design brief.
      //
      // Image generation only happens after the merchant
      // explicitly confirms by clicking Generate Design.

      if (!shouldGenerateImage) {
        return res.status(200).json({
          success: true,
          needsClarification: false,
          briefReady: true,

          message: "Your design brief is ready for review.",

          context: finalContext,

          design: {
            prompt: designPrompt.prompt,
            metadata: designPrompt.metadata,
          },
        });
      }

      // 14. Retrieve OpenAI image-generation credentials.
      const credentials = await getOpenAIImageKey(req.businessId);

      if (!credentials.ok) {
        const statusMap = {
          BUSINESS_ID_REQUIRED: 400,
          OPENAI_IMAGE_KEY_NOT_CONFIGURED: 424,
          OPENAI_IMAGE_GENERATION_DISABLED: 403,
          OPENAI_IMAGE_KEY_UNREADABLE: 500,
        };

        return res.status(statusMap[credentials.error] || 500).json({
          success: false,
          error: credentials.error,
        });
      }

      // 15. Generate the final image.
      const imageResult = await generateOpenAIImage(
        credentials.apiKey,
        designPrompt.prompt,
        {
          imageInputs: processedInputs.imageInputs,
          size: resolveImageSize(
            finalContext.dimensions,
            finalContext.platform,
          ),
          n: 1,
        },
      );

      if (!imageResult.ok) {
        console.warn("[ai-design-image-response]", {
          error: imageResult.error,
          requestId: imageResult.requestId ?? null,
        });

        return res.status(mapImageErrorStatus(imageResult.error)).json({
          success: false,
          error: imageResult.error,
          requestId: imageResult.requestId,
        });
      }

      // 16. Return generated design and metadata.
      return res.status(200).json({
        success: true,
        needsClarification: false,

        message: "Design generated successfully.",

        design: {
          prompt: designPrompt.prompt,
          metadata: designPrompt.metadata,
        },

        generation: {
          model: imageResult.model,
          size: imageResult.size,
          quality: imageResult.quality,
          outputFormat: imageResult.outputFormat,
          created: imageResult.created,
        },

        images: imageResult.images,
      });
    } catch (err) {
      return internalError(res, err);
    }
  },
};

module.exports = {
  aiDesignController,
};
