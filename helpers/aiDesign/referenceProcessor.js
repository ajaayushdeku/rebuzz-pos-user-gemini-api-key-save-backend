const { isValidImageBuffer } = require("../../middlewares/uploadDesignAssets");

// -----------------------------------------------------------------------------
// Limits
// -----------------------------------------------------------------------------

const MAX_TOTAL_IMAGES = 8;
const MAX_SOCIAL_URLS = 5;

const MAX_IMAGE_BYTES = 10 * 1024 * 1024; // 10 MB per image
const MAX_TOTAL_IMAGE_BYTES = 30 * 1024 * 1024; // 30 MB total

const MAX_SOCIAL_URL_LENGTH = 2048;

const ALLOWED_IMAGE_TYPES = ["image/png", "image/jpeg", "image/webp"];

// Only accept recognized social media domains.
// URLs are stored as metadata. They are never fetched directly.
const SOCIAL_DOMAINS = [
  "facebook.com",
  "fb.watch",
  "instagram.com",
  "pinterest.com",
  "pin.it",
  "tiktok.com",
  "vm.tiktok.com",
  "x.com",
  "twitter.com",
  "youtube.com",
  "youtu.be",
];

// -----------------------------------------------------------------------------
// Social URL validation
// -----------------------------------------------------------------------------

const isAllowedSocialDomain = (hostname) => {
  return SOCIAL_DOMAINS.some(
    (domain) => hostname === domain || hostname.endsWith(`.${domain}`),
  );
};

const getSocialPlatform = (hostname) => {
  if (
    hostname === "facebook.com" ||
    hostname.endsWith(".facebook.com") ||
    hostname === "fb.watch"
  ) {
    return "facebook";
  }

  if (hostname === "instagram.com" || hostname.endsWith(".instagram.com")) {
    return "instagram";
  }

  if (
    hostname === "pinterest.com" ||
    hostname.endsWith(".pinterest.com") ||
    hostname === "pin.it"
  ) {
    return "pinterest";
  }

  if (
    hostname === "tiktok.com" ||
    hostname.endsWith(".tiktok.com") ||
    hostname === "vm.tiktok.com"
  ) {
    return "tiktok";
  }

  if (
    hostname === "x.com" ||
    hostname.endsWith(".x.com") ||
    hostname === "twitter.com" ||
    hostname.endsWith(".twitter.com")
  ) {
    return "x";
  }

  if (
    hostname === "youtube.com" ||
    hostname.endsWith(".youtube.com") ||
    hostname === "youtu.be"
  ) {
    return "youtube";
  }

  return "unknown";
};

/**
 * Validate and normalize a social media reference URL.
 *
 * We retain the URL as metadata instead of scraping it.
 */
const validateSocialReference = (value) => {
  if (typeof value !== "string" || !value.trim()) {
    return {
      ok: false,
      error: "DESIGN_REFERENCE_URL_REQUIRED",
    };
  }

  if (value.length > MAX_SOCIAL_URL_LENGTH) {
    return {
      ok: false,
      error: "DESIGN_REFERENCE_URL_TOO_LONG",
    };
  }

  try {
    const url = new URL(value.trim());

    if (url.protocol !== "https:") {
      return {
        ok: false,
        error: "DESIGN_REFERENCE_URL_INVALID",
      };
    }

    if (
      url.username ||
      url.password ||
      url.port ||
      url.hostname.endsWith(".")
    ) {
      return {
        ok: false,
        error: "DESIGN_REFERENCE_URL_INVALID",
      };
    }

    const hostname = url.hostname.toLowerCase();

    if (!isAllowedSocialDomain(hostname)) {
      return {
        ok: false,
        error: "DESIGN_REFERENCE_DOMAIN_UNSUPPORTED",
      };
    }

    // Remove fragments because they are not needed to identify
    // the shared post and may contain client-side state.
    url.hash = "";

    return {
      ok: true,
      reference: {
        url: url.toString(),
        platform: getSocialPlatform(hostname),
      },
    };
  } catch {
    return {
      ok: false,
      error: "DESIGN_REFERENCE_URL_INVALID",
    };
  }
};

// -----------------------------------------------------------------------------
// Image validation
// -----------------------------------------------------------------------------

/**
 * Detect image MIME type from the actual file signature.
 *
 * Never rely exclusively on the MIME type supplied by the client.
 */
const detectImageMimeType = (buffer) => {
  if (!Buffer.isBuffer(buffer) || buffer.length < 12) {
    return null;
  }

  // PNG signature
  if (
    buffer.length >= 8 &&
    buffer
      .subarray(0, 8)
      .equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))
  ) {
    return "image/png";
  }

  // JPEG signature
  if (buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff) {
    return "image/jpeg";
  }

  // WebP signature
  if (
    buffer.toString("ascii", 0, 4) === "RIFF" &&
    buffer.toString("ascii", 8, 12) === "WEBP"
  ) {
    return "image/webp";
  }

  return null;
};

/**
 * Validate an uploaded image.
 *
 * Returns the verified MIME type or an error.
 */
const validateUploadedImage = (file) => {
  if (!file || typeof file !== "object" || !Buffer.isBuffer(file.buffer)) {
    return {
      ok: false,
      error: "DESIGN_IMAGE_BUFFER_INVALID",
    };
  }

  const buffer = file.buffer;

  if (buffer.length === 0 || buffer.length > MAX_IMAGE_BYTES) {
    return {
      ok: false,
      error: "DESIGN_IMAGE_SIZE_INVALID",
    };
  }

  const detectedMimeType = detectImageMimeType(buffer);

  if (!detectedMimeType || !ALLOWED_IMAGE_TYPES.includes(detectedMimeType)) {
    return {
      ok: false,
      error: "DESIGN_IMAGE_TYPE_UNSUPPORTED",
    };
  }

  // Ensure the declared MIME type matches the actual file.
  if (file.mimetype !== detectedMimeType) {
    return {
      ok: false,
      error: "DESIGN_IMAGE_MIME_MISMATCH",
    };
  }

  // Additional image validation from the upload middleware.
  if (!isValidImageBuffer(buffer)) {
    return {
      ok: false,
      error: "DESIGN_IMAGE_CONTENT_INVALID",
    };
  }

  return {
    ok: true,
    mimeType: detectedMimeType,
    size: buffer.length,
  };
};

// -----------------------------------------------------------------------------
// Image conversion
// -----------------------------------------------------------------------------

/**
 * Convert validated uploads into base64 data URLs.
 *
 * These are supplied to the OpenAI Images API.
 */
const convertUploadsToImageInputs = (files = []) => {
  if (!Array.isArray(files)) {
    throw new Error("DESIGN_INPUTS_INVALID");
  }

  return files.map((file) => {
    const validation = validateUploadedImage(file);

    if (!validation.ok) {
      throw new Error(validation.error);
    }

    return {
      image_url: `data:${validation.mimeType};base64,${file.buffer.toString("base64")}`,
    };
  });
};

// -----------------------------------------------------------------------------
// Main input processor
// -----------------------------------------------------------------------------

/**
 * Prepare all design inputs for the generation workflow.
 *
 * referenceImages:
 *   Existing designs used as visual inspiration.
 *
 * assets:
 *   Product images, logos and brand assets intended for the output.
 *
 * socialUrls:
 *   Links to inspiration posts. These are metadata only.
 */
const processDesignInputs = ({
  referenceImages = [],
  assets = [],
  socialUrls = [],
} = {}) => {
  if (
    !Array.isArray(referenceImages) ||
    !Array.isArray(assets) ||
    !Array.isArray(socialUrls)
  ) {
    return {
      ok: false,
      error: "DESIGN_INPUTS_INVALID",
    };
  }

  // ---------------------------------------------------------------------------
  // 1. Validate image count
  // ---------------------------------------------------------------------------

  const totalImages = referenceImages.length + assets.length;

  if (totalImages > MAX_TOTAL_IMAGES) {
    return {
      ok: false,
      error: "DESIGN_IMAGE_COUNT_EXCEEDED",
    };
  }

  if (socialUrls.length > MAX_SOCIAL_URLS) {
    return {
      ok: false,
      error: "DESIGN_SOCIAL_REFERENCES_INVALID",
    };
  }

  // ---------------------------------------------------------------------------
  // 2. Validate aggregate image size
  // ---------------------------------------------------------------------------

  let totalImageBytes = 0;

  for (const file of [...referenceImages, ...assets]) {
    if (!file || !Buffer.isBuffer(file.buffer)) {
      return {
        ok: false,
        error: "DESIGN_IMAGE_BUFFER_INVALID",
      };
    }

    totalImageBytes += file.buffer.length;

    if (totalImageBytes > MAX_TOTAL_IMAGE_BYTES) {
      return {
        ok: false,
        error: "DESIGN_TOTAL_IMAGE_SIZE_EXCEEDED",
      };
    }
  }

  try {
    // -------------------------------------------------------------------------
    // 3. Process reference images
    // -------------------------------------------------------------------------

    const processedReferences = convertUploadsToImageInputs(referenceImages);

    // -------------------------------------------------------------------------
    // 4. Process actual brand/product assets
    // -------------------------------------------------------------------------

    const processedAssets = convertUploadsToImageInputs(assets);

    // -------------------------------------------------------------------------
    // 5. Validate social references
    // -------------------------------------------------------------------------

    const socialReferences = [];
    const seenUrls = new Set();

    for (const socialUrl of socialUrls) {
      const result = validateSocialReference(socialUrl);

      if (!result.ok) {
        return result;
      }

      const normalizedUrl = result.reference.url;

      if (seenUrls.has(normalizedUrl)) {
        continue;
      }

      seenUrls.add(normalizedUrl);

      socialReferences.push(result.reference);
    }

    // -------------------------------------------------------------------------
    // 6. Return processed inputs
    // -------------------------------------------------------------------------

    return {
      ok: true,

      // Keep reference images and actual assets separate.
      referenceImages: processedReferences,
      assets: processedAssets,

      // Combined inputs for the OpenAI image-generation request.
      imageInputs: [...processedReferences, ...processedAssets],

      // Social URLs are metadata only.
      socialReferences,
    };
  } catch (error) {
    const allowedErrors = [
      "DESIGN_IMAGE_BUFFER_INVALID",
      "DESIGN_IMAGE_SIZE_INVALID",
      "DESIGN_IMAGE_TYPE_UNSUPPORTED",
      "DESIGN_IMAGE_MIME_MISMATCH",
      "DESIGN_IMAGE_CONTENT_INVALID",
    ];

    return {
      ok: false,
      error: allowedErrors.includes(error.message)
        ? error.message
        : "DESIGN_INPUT_PROCESSING_FAILED",
    };
  }
};

module.exports = {
  processDesignInputs,
  validateSocialReference,
};
