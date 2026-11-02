const OPENAI_MODELS_URL = "https://api.openai.com/v1/models";
const OPENAI_IMAGE_GENERATIONS_URL =
  "https://api.openai.com/v1/images/generations";

const DEFAULT_IMAGE_MODEL = "gpt-image-2.5-flare";
const IMAGE_REQUEST_TIMEOUT_MS = 180000;

const SUPPORTED_IMAGE_MODELS = [
  "gpt-image-2.5-flare",
  "gpt-image-2.5-sunburst",
  "gpt-image-2",
  "gpt-image-1.5",
  "gpt-image-1-mini",
];

const SUPPORTED_IMAGE_SIZES = ["auto", "1024x1024", "1536x1024", "1024x1536"];

const SUPPORTED_IMAGE_QUALITIES = ["auto", "low", "medium", "high"];

const SUPPORTED_OUTPUT_FORMATS = ["png", "jpeg", "webp"];
const SUPPORTED_BACKGROUNDS = ["auto", "opaque", "transparent"];

/**
 * Verify whether an OpenAI API key is valid.
 *
 * This is used by the AI Design settings endpoints.
 */
const verifyOpenAIKey = async (apiKey) => {
  if (typeof apiKey !== "string" || !apiKey.trim()) {
    return { ok: false, error: "API_KEY_REQUIRED" };
  }

  try {
    const response = await fetch(OPENAI_MODELS_URL, {
      method: "GET",
      headers: {
        Authorization: `Bearer ${apiKey.trim()}`,
      },
      signal: AbortSignal.timeout(10000),
    });

    if (response.ok) {
      return { ok: true };
    }

    if (response.status === 401) {
      return { ok: false, error: "OPENAI_INVALID_API_KEY" };
    }

    if (response.status === 403) {
      return { ok: false, error: "OPENAI_PERMISSION_DENIED" };
    }

    if (response.status === 429) {
      return { ok: false, error: "OPENAI_RATE_OR_QUOTA_LIMIT" };
    }

    if (response.status >= 500) {
      return { ok: false, error: "OPENAI_SERVICE_UNAVAILABLE" };
    }

    return { ok: false, error: "OPENAI_VERIFICATION_FAILED" };
  } catch (err) {
    if (err.name === "TimeoutError" || err.name === "AbortError") {
      return { ok: false, error: "OPENAI_REQUEST_TIMEOUT" };
    }

    return { ok: false, error: "OPENAI_CONNECTION_FAILED" };
  }
};

/**
 * Generate an image using the OpenAI Images API.
 *
 * The API key must be decrypted by the calling controller
 * before being passed to this function.
 *
 * @param {string} apiKey - Merchant's decrypted OpenAI API key.
 * @param {string} prompt - Description of the image to generate.
 * @param {object} options - Optional image-generation settings.
 *
 * @returns {Promise<object>} Generated image data or a safe error code.
 */
const generateOpenAIImage = async (apiKey, prompt, options = {}) => {
  if (typeof apiKey !== "string" || !apiKey.trim()) {
    return { ok: false, error: "API_KEY_REQUIRED" };
  }

  if (typeof prompt !== "string" || !prompt.trim()) {
    return { ok: false, error: "OPENAI_IMAGE_PROMPT_REQUIRED" };
  }

  if (prompt.length > 32000) {
    return { ok: false, error: "OPENAI_IMAGE_PROMPT_TOO_LONG" };
  }

  const {
    model = DEFAULT_IMAGE_MODEL,
    size = "1024x1024",
    quality = "auto",
    outputFormat = "png",
    background = "auto",
    n = 1,
  } = options;

  // Validate generation settings before contacting OpenAI.
  if (!SUPPORTED_IMAGE_MODELS.includes(model)) {
    return { ok: false, error: "OPENAI_IMAGE_MODEL_UNSUPPORTED" };
  }

  if (!SUPPORTED_IMAGE_SIZES.includes(size)) {
    return { ok: false, error: "OPENAI_IMAGE_SIZE_UNSUPPORTED" };
  }

  if (!SUPPORTED_IMAGE_QUALITIES.includes(quality)) {
    return { ok: false, error: "OPENAI_IMAGE_QUALITY_UNSUPPORTED" };
  }

  if (!SUPPORTED_OUTPUT_FORMATS.includes(outputFormat)) {
    return { ok: false, error: "OPENAI_IMAGE_FORMAT_UNSUPPORTED" };
  }

  if (!SUPPORTED_BACKGROUNDS.includes(background)) {
    return { ok: false, error: "OPENAI_IMAGE_BACKGROUND_UNSUPPORTED" };
  }

  // Keep the initial implementation conservative to control costs.
  if (!Number.isInteger(n) || n < 1 || n > 4) {
    return { ok: false, error: "OPENAI_IMAGE_COUNT_INVALID" };
  }

  try {
    const response = await fetch(OPENAI_IMAGE_GENERATIONS_URL, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey.trim()}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model,
        prompt: prompt.trim(),
        size,
        quality,
        n,
        output_format: outputFormat,
        background,
      }),
      signal: AbortSignal.timeout(IMAGE_REQUEST_TIMEOUT_MS),
    });

    let result;

    try {
      result = await response.json();
    } catch {
      return {
        ok: false,
        error: "OPENAI_INVALID_RESPONSE",
      };
    }

    if (!response.ok) {
      const providerError = result?.error ?? {};
      const providerCode = providerError.code;

      if (response.status === 401) {
        return { ok: false, error: "OPENAI_INVALID_API_KEY" };
      }

      if (response.status === 403) {
        return { ok: false, error: "OPENAI_PERMISSION_DENIED" };
      }

      if (response.status === 429) {
        return { ok: false, error: "OPENAI_RATE_OR_QUOTA_LIMIT" };
      }

      if (providerCode === "moderation_blocked") {
        return { ok: false, error: "OPENAI_IMAGE_MODERATION_BLOCKED" };
      }

      if (response.status === 400) {
        return {
          ok: false,
          error: "OPENAI_IMAGE_INVALID_REQUEST",
          detail: providerError.message ?? null,
        };
      }

      if (response.status >= 500) {
        return { ok: false, error: "OPENAI_SERVICE_UNAVAILABLE" };
      }

      return {
        ok: false,
        error: "OPENAI_IMAGE_GENERATION_FAILED",
        detail: providerError.message ?? null,
      };
    }

    const generatedImages = result?.data;

    if (!Array.isArray(generatedImages) || generatedImages.length === 0) {
      return {
        ok: false,
        error: "OPENAI_IMAGE_EMPTY_RESPONSE",
      };
    }

    const images = generatedImages.map((image) => ({
      b64Json: image.b64_json ?? null,
      revisedPrompt: image.revised_prompt ?? null,
      mimeType: `image/${outputFormat}`,
    }));

    // GPT Image responses should contain base64 image data.
    if (images.some((image) => !image.b64Json)) {
      return {
        ok: false,
        error: "OPENAI_IMAGE_DATA_MISSING",
      };
    }

    return {
      ok: true,
      created: result.created ?? Math.floor(Date.now() / 1000),
      model,
      size: result.size ?? size,
      quality: result.quality ?? quality,
      outputFormat: result.output_format ?? outputFormat,
      images,
    };
  } catch (err) {
    if (err.name === "TimeoutError" || err.name === "AbortError") {
      return {
        ok: false,
        error: "OPENAI_IMAGE_REQUEST_TIMEOUT",
      };
    }

    return {
      ok: false,
      error: "OPENAI_CONNECTION_FAILED",
    };
  }
};

module.exports = {
  verifyOpenAIKey,
  generateOpenAIImage,
};
