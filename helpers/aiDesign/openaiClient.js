const OPENAI_MODELS_URL = "https://api.openai.com/v1/models";

const OPENAI_IMAGE_GENERATIONS_URL =
  "https://api.openai.com/v1/images/generations";

const OPENAI_IMAGE_EDITS_URL = "https://api.openai.com/v1/images/edits";

const {
  classifyOpenAI429Error,
  openAIRequestFailure,
} = require("./openaiErrors");

const DEFAULT_IMAGE_MODEL = "gpt-image-2.5-flare";

const IMAGE_REQUEST_TIMEOUT_MS = 180000;
const KEY_VERIFICATION_TIMEOUT_MS = 10000;

const MAX_PROMPT_LENGTH = 32000;

const MAX_IMAGE_INPUTS = 8;
const MAX_INPUT_IMAGE_BYTES = 5 * 1024 * 1024;
const MAX_TOTAL_INPUT_BYTES = 30 * 1024 * 1024;
const MAX_GENERATED_IMAGE_BYTES = 30 * 1024 * 1024;

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

const OUTPUT_MIME_TYPES = {
  png: "image/png",
  jpeg: "image/jpeg",
  webp: "image/webp",
};

const INPUT_IMAGE_TYPES = {
  "image/png": {
    extension: "png",
    signature: (buffer) =>
      buffer.length >= 8 &&
      buffer
        .subarray(0, 8)
        .equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])),
  },

  "image/jpeg": {
    extension: "jpg",
    signature: (buffer) =>
      buffer.length >= 3 &&
      buffer[0] === 0xff &&
      buffer[1] === 0xd8 &&
      buffer[2] === 0xff,
  },

  "image/webp": {
    extension: "webp",
    signature: (buffer) =>
      buffer.length >= 12 &&
      buffer.toString("ascii", 0, 4) === "RIFF" &&
      buffer.toString("ascii", 8, 12) === "WEBP",
  },
};

const OUTPUT_SIGNATURE_VALIDATORS = {
  png: INPUT_IMAGE_TYPES["image/png"].signature,
  jpeg: INPUT_IMAGE_TYPES["image/jpeg"].signature,
  webp: INPUT_IMAGE_TYPES["image/webp"].signature,
};

const isTimeoutError = (error) =>
  error?.name === "TimeoutError" || error?.name === "AbortError";

const isValidBase64 = (value) => {
  if (typeof value !== "string" || !value.length) {
    return false;
  }

  if (value.length % 4 !== 0) {
    return false;
  }

  if (!/^[A-Za-z0-9+/]*={0,2}$/.test(value)) {
    return false;
  }

  try {
    const decoded = Buffer.from(value, "base64");

    return decoded.length > 0 && decoded.toString("base64") === value;
  } catch {
    return false;
  }
};

/**
 * Verify whether an OpenAI API key can access the Models API.
 *
 * Important:
 * This does not guarantee access to image-generation models.
 * Actual image-generation permissions are checked during generation.
 */
const verifyOpenAIKey = async (apiKey) => {
  if (typeof apiKey !== "string" || !apiKey.trim()) {
    return {
      ok: false,
      error: "API_KEY_REQUIRED",
    };
  }

  try {
    const response = await fetch(OPENAI_MODELS_URL, {
      method: "GET",
      headers: {
        Authorization: `Bearer ${apiKey.trim()}`,
      },
      signal: AbortSignal.timeout(KEY_VERIFICATION_TIMEOUT_MS),
    });

    if (response.ok) {
      return {
        ok: true,
      };
    }

    let result = {};

    try {
      result = await response.json();
    } catch {
      // Provider returned no readable error body.
    }

    if (response.status === 401) {
      return openAIRequestFailure(response, "OPENAI_INVALID_API_KEY");
    }

    if (response.status === 403) {
      return openAIRequestFailure(response, "OPENAI_PERMISSION_DENIED");
    }

    if (response.status === 429) {
      return openAIRequestFailure(
        response,
        classifyOpenAI429Error(response, result),
      );
    }

    if (response.status === 408 || response.status === 504) {
      return openAIRequestFailure(response, "OPENAI_REQUEST_TIMEOUT");
    }

    if (response.status >= 500) {
      return openAIRequestFailure(response, "OPENAI_SERVICE_UNAVAILABLE");
    }

    return openAIRequestFailure(response, "OPENAI_VERIFICATION_FAILED");
  } catch (error) {
    if (isTimeoutError(error)) {
      return {
        ok: false,
        error: "OPENAI_REQUEST_TIMEOUT",
      };
    }

    return {
      ok: false,
      error: "OPENAI_CONNECTION_FAILED",
    };
  }
};

/**
 * Convert a validated base64 image data URL into a Blob.
 *
 * Expected input:
 *
 * {
 *   image_url: "data:image/png;base64,..."
 * }
 */
const convertImageInputToBlob = (imageInput) => {
  if (!imageInput || typeof imageInput.image_url !== "string") {
    throw new Error("INVALID_IMAGE_INPUT");
  }

  const match = imageInput.image_url.match(
    /^data:(image\/(?:png|jpeg|webp));base64,([A-Za-z0-9+/]+={0,2})$/,
  );

  if (!match) {
    throw new Error("INVALID_IMAGE_DATA_URL");
  }

  const mimeType = match[1];
  const base64Data = match[2];

  if (!isValidBase64(base64Data)) {
    throw new Error("INVALID_IMAGE_DATA_URL");
  }

  const imageType = INPUT_IMAGE_TYPES[mimeType];

  if (!imageType) {
    throw new Error("INVALID_IMAGE_INPUT");
  }

  const buffer = Buffer.from(base64Data, "base64");

  if (!buffer.length) {
    throw new Error("EMPTY_IMAGE_INPUT");
  }

  if (buffer.length > MAX_INPUT_IMAGE_BYTES) {
    throw new Error("IMAGE_INPUT_TOO_LARGE");
  }

  // Verify that the actual file signature matches its MIME type.
  if (!imageType.signature(buffer)) {
    throw new Error("INVALID_IMAGE_SIGNATURE");
  }

  return {
    blob: new Blob([buffer], {
      type: mimeType,
    }),
    extension: imageType.extension,
    size: buffer.length,
  };
};

/**
 * Convert OpenAI error responses into safe application errors.
 *
 * Do not return raw provider error messages to the frontend.
 */

const normalizeOpenAIError = (response, result) => {
  const providerError = result?.error ?? {};
  const providerCode = String(providerError.code ?? "").toLowerCase();
  const providerType = String(providerError.type ?? "").toLowerCase();
  const failure = (error) => openAIRequestFailure(response, error);

  if (response.status === 401) {
    return failure("OPENAI_INVALID_API_KEY");
  }

  if (response.status === 403) {
    return failure("OPENAI_PERMISSION_DENIED");
  }

  const rateLimitError = classifyOpenAI429Error(response, result);

  if (rateLimitError) {
    return failure(rateLimitError);
  }

  if (
    providerCode === "moderation_blocked" ||
    providerType === "image_generation_user_error"
  ) {
    return failure("OPENAI_IMAGE_MODERATION_BLOCKED");
  }

  if (response.status === 408 || response.status === 504) {
    return failure("OPENAI_IMAGE_REQUEST_TIMEOUT");
  }

  if (response.status === 413) {
    return failure("OPENAI_IMAGE_INPUT_TOO_LARGE");
  }

  if (response.status === 404 || providerCode === "model_not_found") {
    return failure("OPENAI_IMAGE_MODEL_UNAVAILABLE");
  }

  if (response.status === 400) {
    return failure("OPENAI_IMAGE_INVALID_REQUEST");
  }

  if (response.status >= 500) {
    return failure("OPENAI_SERVICE_UNAVAILABLE");
  }

  return failure("OPENAI_IMAGE_GENERATION_FAILED");
};

/**
 * Validate the generated image data returned by OpenAI.
 */
const validateGeneratedImages = (
  generatedImages,
  outputFormat,
  expectedCount,
) => {
  if (!Array.isArray(generatedImages) || generatedImages.length === 0) {
    return {
      ok: false,
      error: "OPENAI_IMAGE_EMPTY_RESPONSE",
    };
  }

  if (generatedImages.length !== expectedCount) {
    return {
      ok: false,
      error: "OPENAI_IMAGE_COUNT_MISMATCH",
    };
  }

  const signatureValidator = OUTPUT_SIGNATURE_VALIDATORS[outputFormat];

  const images = [];

  for (const image of generatedImages) {
    const base64Data = image?.b64_json;

    if (typeof base64Data !== "string" || !isValidBase64(base64Data)) {
      return {
        ok: false,
        error: "OPENAI_IMAGE_DATA_MISSING",
      };
    }

    // Estimate decoded size before allocating the Buffer.
    const estimatedSize = Math.floor((base64Data.length * 3) / 4);

    if (estimatedSize > MAX_GENERATED_IMAGE_BYTES) {
      return {
        ok: false,
        error: "OPENAI_GENERATED_IMAGE_TOO_LARGE",
      };
    }

    const buffer = Buffer.from(base64Data, "base64");

    if (!buffer.length || buffer.length > MAX_GENERATED_IMAGE_BYTES) {
      return {
        ok: false,
        error: "OPENAI_GENERATED_IMAGE_INVALID",
      };
    }

    if (!signatureValidator(buffer)) {
      return {
        ok: false,
        error: "OPENAI_GENERATED_IMAGE_INVALID",
      };
    }

    images.push({
      b64Json: base64Data,
      revisedPrompt:
        typeof image.revised_prompt === "string" ? image.revised_prompt : null,
      mimeType: OUTPUT_MIME_TYPES[outputFormat],
    });
  }

  return {
    ok: true,
    images,
  };
};

/**
 * Generate an image using the OpenAI Images API.
 *
 * Without image inputs:
 * POST /v1/images/generations
 *
 * With image inputs:
 * POST /v1/images/edits
 *
 * @param {string} apiKey
 * @param {string} prompt
 * @param {object} options
 *
 * @returns {Promise<object>}
 */
const generateOpenAIImage = async (apiKey, prompt, options = {}) => {
  if (typeof apiKey !== "string" || !apiKey.trim()) {
    return {
      ok: false,
      error: "API_KEY_REQUIRED",
    };
  }

  if (typeof prompt !== "string" || !prompt.trim()) {
    return {
      ok: false,
      error: "OPENAI_IMAGE_PROMPT_REQUIRED",
    };
  }

  if (prompt.length > MAX_PROMPT_LENGTH) {
    return {
      ok: false,
      error: "OPENAI_IMAGE_PROMPT_TOO_LONG",
    };
  }

  if (!options || typeof options !== "object" || Array.isArray(options)) {
    return {
      ok: false,
      error: "OPENAI_IMAGE_OPTIONS_INVALID",
    };
  }

  const {
    model = DEFAULT_IMAGE_MODEL,
    size = "1024x1024",
    quality = "auto",
    outputFormat = "png",
    background = "auto",
    n = 1,
    imageInputs = [],
  } = options;

  // ---------------------------------------------
  // VALIDATE GENERATION SETTINGS
  // ---------------------------------------------

  if (!SUPPORTED_IMAGE_MODELS.includes(model)) {
    return {
      ok: false,
      error: "OPENAI_IMAGE_MODEL_UNSUPPORTED",
    };
  }

  if (!SUPPORTED_IMAGE_SIZES.includes(size)) {
    return {
      ok: false,
      error: "OPENAI_IMAGE_SIZE_UNSUPPORTED",
    };
  }

  if (!SUPPORTED_IMAGE_QUALITIES.includes(quality)) {
    return {
      ok: false,
      error: "OPENAI_IMAGE_QUALITY_UNSUPPORTED",
    };
  }

  if (!SUPPORTED_OUTPUT_FORMATS.includes(outputFormat)) {
    return {
      ok: false,
      error: "OPENAI_IMAGE_FORMAT_UNSUPPORTED",
    };
  }

  if (!SUPPORTED_BACKGROUNDS.includes(background)) {
    return {
      ok: false,
      error: "OPENAI_IMAGE_BACKGROUND_UNSUPPORTED",
    };
  }

  // JPEG does not support transparency.
  if (background === "transparent" && outputFormat === "jpeg") {
    return {
      ok: false,
      error: "OPENAI_IMAGE_TRANSPARENT_FORMAT_UNSUPPORTED",
    };
  }

  if (!Number.isInteger(n) || n < 1 || n > 4) {
    return {
      ok: false,
      error: "OPENAI_IMAGE_COUNT_INVALID",
    };
  }

  if (!Array.isArray(imageInputs)) {
    return {
      ok: false,
      error: "OPENAI_IMAGE_INPUTS_INVALID",
    };
  }

  if (imageInputs.length > MAX_IMAGE_INPUTS) {
    return {
      ok: false,
      error: "OPENAI_IMAGE_INPUT_COUNT_EXCEEDED",
    };
  }

  // ---------------------------------------------
  // PREPARE REQUEST
  // ---------------------------------------------

  try {
    let response;

    if (imageInputs.length > 0) {
      // ---------------------------------------------
      // IMAGE GENERATION WITH REFERENCE IMAGES
      // ---------------------------------------------

      const formData = new FormData();

      formData.append("model", model);
      formData.append("prompt", prompt.trim());
      formData.append("size", size);
      formData.append("quality", quality);
      formData.append("n", String(n));
      formData.append("output_format", outputFormat);
      formData.append("background", background);

      let totalInputBytes = 0;

      for (const [index, imageInput] of imageInputs.entries()) {
        const converted = convertImageInputToBlob(imageInput);

        totalInputBytes += converted.size;

        if (totalInputBytes > MAX_TOTAL_INPUT_BYTES) {
          return {
            ok: false,
            error: "OPENAI_IMAGE_TOTAL_INPUT_TOO_LARGE",
          };
        }

        formData.append(
          "image[]",
          converted.blob,
          `design-input-${index + 1}.${converted.extension}`,
        );
      }

      response = await fetch(OPENAI_IMAGE_EDITS_URL, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${apiKey.trim()}`,
        },
        body: formData,
        signal: AbortSignal.timeout(IMAGE_REQUEST_TIMEOUT_MS),
      });
    } else {
      // ---------------------------------------------
      // TEXT-ONLY IMAGE GENERATION
      // ---------------------------------------------

      response = await fetch(OPENAI_IMAGE_GENERATIONS_URL, {
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
    }

    // ---------------------------------------------
    // PARSE PROVIDER RESPONSE
    // ---------------------------------------------

    let result;

    try {
      result = await response.json();
    } catch {
      return {
        ok: false,
        error: "OPENAI_INVALID_RESPONSE",
      };
    }

    // ---------------------------------------------
    // HANDLE PROVIDER ERRORS
    // ---------------------------------------------

    if (!response.ok) {
      return normalizeOpenAIError(response, result);
    }

    // ---------------------------------------------
    // VALIDATE GENERATED IMAGES
    // ---------------------------------------------

    const validation = validateGeneratedImages(result?.data, outputFormat, n);

    if (!validation.ok) {
      return validation;
    }

    // ---------------------------------------------
    // SUCCESS
    // ---------------------------------------------

    return {
      ok: true,
      created: Number.isInteger(result.created)
        ? result.created
        : Math.floor(Date.now() / 1000),
      model,
      size,
      quality,
      outputFormat,
      images: validation.images,
    };
  } catch (error) {
    if (isTimeoutError(error)) {
      return {
        ok: false,
        error: "OPENAI_IMAGE_REQUEST_TIMEOUT",
      };
    }

    if (
      [
        "INVALID_IMAGE_INPUT",
        "INVALID_IMAGE_DATA_URL",
        "EMPTY_IMAGE_INPUT",
        "INVALID_IMAGE_SIGNATURE",
        "IMAGE_INPUT_TOO_LARGE",
      ].includes(error?.message)
    ) {
      return {
        ok: false,
        error: "OPENAI_IMAGE_INPUT_INVALID",
      };
    }

    // Log only safe diagnostic information.
    console.error("[openai-image-generation]", {
      name: error?.name ?? "UnknownError",
      message: error?.message ?? "Unknown error",
    });

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
