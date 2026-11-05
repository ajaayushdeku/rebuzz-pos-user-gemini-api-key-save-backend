const sharp = require("sharp");

const CLOUDFLARE_API_BASE = "https://api.cloudflare.com/client/v4/accounts";

const DEFAULT_TEXT_MODEL = "@cf/zai-org/glm-4.7-flash";
const DEFAULT_IMAGE_MODEL = "@cf/black-forest-labs/flux-2-klein-4b";

const REQUEST_TIMEOUT_MS = 180000;

const MAX_PROMPT_LENGTH = 12000;
const MAX_REFERENCE_IMAGES = 4;
const MAX_REFERENCE_IMAGE_BYTES = 10 * 1024 * 1024;
const MAX_OUTPUT_IMAGE_DIMENSION = 1920;

// FLUX.2 Klein 4B reference images must be smaller than 512 x 512.
const MAX_REFERENCE_IMAGE_DIMENSION = 511;

// -----------------------------------------------------------------------------
// Error handling
// -----------------------------------------------------------------------------

class CloudflareAIError extends Error {
  constructor(code, message, status = 500) {
    super(message);

    this.name = "CloudflareAIError";
    this.code = code;
    this.status = status;
  }
}

const createCloudflareError = (status, response) => {
  const apiError = response?.errors?.[0];

  if (status === 401 || status === 403) {
    return new CloudflareAIError(
      "CLOUDFLARE_AUTH_ERROR",
      "Cloudflare authentication failed. Check the business credentials and Workers AI permissions.",
      status,
    );
  }

  if (status === 429) {
    return new CloudflareAIError(
      "CLOUDFLARE_RATE_LIMIT",
      "Cloudflare Workers AI rate limit reached. Please try again later.",
      status,
    );
  }

  const error = new CloudflareAIError(
    "CLOUDFLARE_REQUEST_FAILED",
    apiError?.message ||
      response?.messages?.[0]?.message ||
      "The Cloudflare AI request failed.",
    status || 502,
  );

  // Keep provider details available for server-side diagnostics. The API
  // response to the browser still uses our stable application error code.
  error.providerCode = apiError?.code ?? null;
  error.providerMessage = apiError?.message || response?.messages?.[0]?.message || null;
  error.requestId = response?.result?.id ?? response?.result?.request_id ?? null;
  return error;
};

// -----------------------------------------------------------------------------
// Credential validation
// -----------------------------------------------------------------------------

const validateCredentials = ({ accountId, apiToken }) => {
  if (
    typeof accountId !== "string" ||
    !/^[a-f0-9]{32}$/i.test(accountId.trim())
  ) {
    throw new CloudflareAIError(
      "CLOUDFLARE_ACCOUNT_ID_INVALID",
      "A valid Cloudflare Account ID is required.",
      400,
    );
  }

  if (
    typeof apiToken !== "string" ||
    !apiToken.trim() ||
    apiToken.length > 512 ||
    /[\r\n]/.test(apiToken)
  ) {
    throw new CloudflareAIError(
      "CLOUDFLARE_API_TOKEN_INVALID",
      "A valid Cloudflare API Token is required.",
      400,
    );
  }
};

// -----------------------------------------------------------------------------
// Shared Cloudflare request
// -----------------------------------------------------------------------------

const cloudflareRequest = async ({
  accountId,
  apiToken,
  model,
  body,
  timeoutMs = REQUEST_TIMEOUT_MS,
}) => {
  validateCredentials({ accountId, apiToken });

  if (typeof model !== "string" || !model.startsWith("@cf/")) {
    throw new CloudflareAIError(
      "CLOUDFLARE_MODEL_INVALID",
      "An unsupported Cloudflare Workers AI model was selected.",
      400,
    );
  }

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const response = await fetch(
      `${CLOUDFLARE_API_BASE}/${accountId.trim()}/ai/run/${model}`,
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${apiToken.trim()}`,
          ...body.headers,
        },
        body: body.data,
        signal: controller.signal,
      },
    );

    const contentType = response.headers.get("content-type") || "";

    if (!contentType.includes("application/json")) {
      throw new CloudflareAIError(
        "CLOUDFLARE_INVALID_RESPONSE",
        "Cloudflare returned an unexpected response format.",
        502,
      );
    }

    const result = await response.json();

    if (!response.ok || result?.success !== true) {
      const error = createCloudflareError(response.status, result);
      error.requestId =
        response.headers.get("cf-ray") ||
        result?.result?.id ||
        result?.result?.request_id ||
        null;
      throw error;
    }

    return result.result;
  } catch (error) {
    if (error instanceof CloudflareAIError) {
      throw error;
    }

    if (error.name === "AbortError") {
      throw new CloudflareAIError(
        "CLOUDFLARE_REQUEST_TIMEOUT",
        "The Cloudflare AI request timed out.",
        504,
      );
    }

    throw new CloudflareAIError(
      "CLOUDFLARE_NETWORK_ERROR",
      "Unable to connect to Cloudflare Workers AI.",
      502,
    );
  } finally {
    clearTimeout(timeout);
  }
};

// -----------------------------------------------------------------------------
// Text generation
// -----------------------------------------------------------------------------

const generateCloudflareText = async (credentials, messages, options = {}) => {
  if (!Array.isArray(messages) || messages.length === 0) {
    throw new CloudflareAIError(
      "CLOUDFLARE_MESSAGES_INVALID",
      "At least one chat message is required.",
      400,
    );
  }

  for (const message of messages) {
    if (
      !message ||
      !["system", "user", "assistant"].includes(message.role) ||
      typeof message.content !== "string" ||
      !message.content.trim()
    ) {
      throw new CloudflareAIError(
        "CLOUDFLARE_MESSAGES_INVALID",
        "A chat message has an invalid role or content.",
        400,
      );
    }

    if (message.content.length > MAX_PROMPT_LENGTH) {
      throw new CloudflareAIError(
        "CLOUDFLARE_PROMPT_TOO_LONG",
        "A chat message exceeds the allowed length.",
        400,
      );
    }
  }

  const result = await cloudflareRequest({
    ...credentials,
    model: options.model || DEFAULT_TEXT_MODEL,
    body: {
      headers: {
        "Content-Type": "application/json",
      },
      data: JSON.stringify({
        messages,
        max_tokens: options.maxTokens || 4096,
        temperature: options.temperature ?? 0.2,
        chat_template_kwargs: {
          enable_thinking: options.enableThinking ?? false,
        },
      }),
    },
  });

  const content = result?.choices?.[0]?.message?.content;

  if (typeof content !== "string" || !content.trim()) {
    throw new CloudflareAIError(
      "CLOUDFLARE_EMPTY_TEXT_RESPONSE",
      "Cloudflare returned an empty text response.",
      502,
    );
  }

  return {
    content: content.trim(),
    model: result.model || options.model || DEFAULT_TEXT_MODEL,
    usage: result.usage || null,
  };
};

// -----------------------------------------------------------------------------
// Reference-image preparation
// -----------------------------------------------------------------------------

const prepareReferenceImages = async (images = []) => {
  if (!Array.isArray(images)) {
    throw new CloudflareAIError(
      "CLOUDFLARE_IMAGES_INVALID",
      "Reference images must be supplied as an array.",
      400,
    );
  }

  if (images.length > MAX_REFERENCE_IMAGES) {
    throw new CloudflareAIError(
      "CLOUDFLARE_TOO_MANY_REFERENCES",
      `FLUX.2 Klein 4B supports at most ${MAX_REFERENCE_IMAGES} reference images.`,
      400,
    );
  }

  const prepared = [];

  for (const image of images) {
    if (
      !image ||
      !Buffer.isBuffer(image.buffer) ||
      image.buffer.length === 0 ||
      image.buffer.length > MAX_REFERENCE_IMAGE_BYTES
    ) {
      throw new CloudflareAIError(
        "CLOUDFLARE_REFERENCE_INVALID",
        "A reference image is missing or exceeds the size limit.",
        400,
      );
    }

    try {
      const output = await sharp(image.buffer, {
        limitInputPixels: 40_000_000,
      })
        .rotate()
        .resize({
          width: MAX_REFERENCE_IMAGE_DIMENSION,
          height: MAX_REFERENCE_IMAGE_DIMENSION,
          fit: "inside",
          withoutEnlargement: true,
        })
        .png()
        .toBuffer();

      const metadata = await sharp(output).metadata();

      if (
        !metadata.width ||
        !metadata.height ||
        metadata.width >= 512 ||
        metadata.height >= 512
      ) {
        throw new Error("INVALID_REFERENCE_DIMENSIONS");
      }

      prepared.push(output);
    } catch {
      throw new CloudflareAIError(
        "CLOUDFLARE_REFERENCE_PROCESSING_FAILED",
        "A reference image could not be processed.",
        400,
      );
    }
  }

  return prepared;
};

// -----------------------------------------------------------------------------
// Image generation
// -----------------------------------------------------------------------------

const generateCloudflareImage = async (credentials, prompt, options = {}) => {
  if (
    typeof prompt !== "string" ||
    !prompt.trim() ||
    prompt.length > MAX_PROMPT_LENGTH
  ) {
    throw new CloudflareAIError(
      "CLOUDFLARE_IMAGE_PROMPT_INVALID",
      "A valid image-generation prompt is required.",
      400,
    );
  }

  const referenceImages = await prepareReferenceImages(
    options.imageInputs || [],
  );

  const width = Math.min(
    MAX_OUTPUT_IMAGE_DIMENSION,
    Math.max(256, Number(options.width) || 1024),
  );

  const height = Math.min(
    MAX_OUTPUT_IMAGE_DIMENSION,
    Math.max(256, Number(options.height) || 1024),
  );

  const form = new FormData();

  form.append("prompt", prompt.trim());
  form.append("width", String(width));
  form.append("height", String(height));

  referenceImages.forEach((buffer, index) => {
    form.append(
      `input_image_${index}`,
      new Blob([buffer], { type: "image/png" }),
      `reference-${index}.png`,
    );
  });

  const result = await cloudflareRequest({
    ...credentials,
    model: options.model || DEFAULT_IMAGE_MODEL,
    body: {
      headers: {},
      data: form,
    },
  });

  if (typeof result?.image !== "string" || !result.image) {
    throw new CloudflareAIError(
      "CLOUDFLARE_IMAGE_RESPONSE_INVALID",
      "Cloudflare did not return an image.",
      502,
    );
  }

  let imageBuffer;
  let metadata;

  try {
    imageBuffer = Buffer.from(result.image, "base64");

    if (imageBuffer.length === 0) {
      throw new Error("EMPTY_IMAGE");
    }

    metadata = await sharp(imageBuffer, {
      limitInputPixels: 100_000_000,
    }).metadata();

    if (
      !metadata.format ||
      !["png", "jpeg", "webp"].includes(metadata.format) ||
      !metadata.width ||
      !metadata.height
    ) {
      throw new Error("UNSUPPORTED_IMAGE_FORMAT");
    }
  } catch {
    throw new CloudflareAIError(
      "CLOUDFLARE_IMAGE_RESPONSE_INVALID",
      "Cloudflare returned invalid or unsupported image data.",
      502,
    );
  }

  return {
    image: result.image,
    buffer: imageBuffer,
    mimeType:
      metadata.format === "jpeg" ? "image/jpeg" : `image/${metadata.format}`,
    model: options.model || DEFAULT_IMAGE_MODEL,
    width: metadata.width,
    height: metadata.height,
    referenceCount: referenceImages.length,
  };
};

// -----------------------------------------------------------------------------
// Exports
// -----------------------------------------------------------------------------

module.exports = {
  CloudflareAIError,
  DEFAULT_TEXT_MODEL,
  DEFAULT_IMAGE_MODEL,
  cloudflareRequest,
  generateCloudflareText,
  generateCloudflareImage,
};
