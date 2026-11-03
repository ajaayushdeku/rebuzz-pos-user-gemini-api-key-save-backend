const multer = require("multer");

// -----------------------------------------------------------------------------
// Upload limits
// -----------------------------------------------------------------------------

const MAX_FILE_SIZE = 5 * 1024 * 1024; // 5 MB
const MAX_REFERENCE_IMAGES = 3;
const MAX_ASSETS = 5;
const MAX_TOTAL_FILES = 8;

const MAX_FIELD_SIZE = 64 * 1024; // 64 KB
const MAX_FIELD_NAME_SIZE = 100;

const ALLOWED_MIME_TYPES = ["image/png", "image/jpeg", "image/webp"];

// -----------------------------------------------------------------------------
// Image signature detection
// -----------------------------------------------------------------------------

const detectImageMimeType = (buffer) => {
  if (!Buffer.isBuffer(buffer) || buffer.length < 12) {
    return null;
  }

  // PNG
  const isPng = buffer
    .subarray(0, 8)
    .equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));

  if (isPng) {
    return "image/png";
  }

  // JPEG
  const isJpeg = buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff;

  if (isJpeg) {
    return "image/jpeg";
  }

  // WebP
  const isWebp =
    buffer.toString("ascii", 0, 4) === "RIFF" &&
    buffer.toString("ascii", 8, 12) === "WEBP";

  if (isWebp) {
    return "image/webp";
  }

  return null;
};

/**
 * Validate the actual file signature.
 *
 * This is a basic format check, not a full image decoder.
 */
const isValidImageBuffer = (buffer) => {
  const detectedMimeType = detectImageMimeType(buffer);

  return ALLOWED_MIME_TYPES.includes(detectedMimeType);
};

// -----------------------------------------------------------------------------
// Multer configuration
// -----------------------------------------------------------------------------

const upload = multer({
  storage: multer.memoryStorage(),

  limits: {
    fileSize: MAX_FILE_SIZE,

    files: MAX_TOTAL_FILES,

    fields: 20,

    parts: 30,

    fieldSize: MAX_FIELD_SIZE,

    fieldNameSize: MAX_FIELD_NAME_SIZE,

    headerPairs: 100,
  },

  fileFilter: (req, file, callback) => {
    if (!ALLOWED_MIME_TYPES.includes(file.mimetype)) {
      return callback(new Error("DESIGN_IMAGE_TYPE_UNSUPPORTED"));
    }

    callback(null, true);
  },
});

// -----------------------------------------------------------------------------
// Multer error handling
// -----------------------------------------------------------------------------

const handleUploadError = (err, res, next) => {
  if (err instanceof multer.MulterError) {
    switch (err.code) {
      case "LIMIT_FILE_SIZE":
        return res.status(413).json({
          success: false,
          error: "DESIGN_IMAGE_TOO_LARGE",
          message: "Each image must be 5 MB or smaller.",
        });

      case "LIMIT_FILE_COUNT":
        return res.status(400).json({
          success: false,
          error: "DESIGN_IMAGE_COUNT_EXCEEDED",
        });

      case "LIMIT_UNEXPECTED_FILE":
        return res.status(400).json({
          success: false,
          error: "DESIGN_IMAGE_FIELD_INVALID",
          message:
            "Use referenceImages or assets as the upload field names. Maximum 3 references and 5 assets.",
        });

      case "LIMIT_FIELD_COUNT":
      case "LIMIT_PART_COUNT":
      case "LIMIT_FIELD_VALUE":
      case "LIMIT_FIELD_KEY":
        return res.status(400).json({
          success: false,
          error: "DESIGN_IMAGE_UPLOAD_LIMIT_EXCEEDED",
        });

      default:
        return res.status(400).json({
          success: false,
          error: "DESIGN_IMAGE_UPLOAD_INVALID",
        });
    }
  }

  if (err.message === "DESIGN_IMAGE_TYPE_UNSUPPORTED") {
    return res.status(415).json({
      success: false,
      error: "DESIGN_IMAGE_TYPE_UNSUPPORTED",
      message: "Only PNG, JPEG, and WebP images are supported.",
    });
  }

  return next(err);
};

// -----------------------------------------------------------------------------
// Upload middleware
// -----------------------------------------------------------------------------

/**
 * Accepts two multipart fields:
 *
 * referenceImages: up to 3 images
 * assets: up to 5 images
 */
const uploadDesignAssets = (req, res, next) => {
  upload.fields([
    {
      name: "referenceImages",
      maxCount: MAX_REFERENCE_IMAGES,
    },
    {
      name: "assets",
      maxCount: MAX_ASSETS,
    },
  ])(req, res, (err) => {
    if (err) {
      return handleUploadError(err, res, next);
    }

    const referenceImages = req.files?.referenceImages ?? [];

    const assets = req.files?.assets ?? [];

    const allFiles = [...referenceImages, ...assets];

    // -------------------------------------------------------------------------
    // 1. Validate total image count
    // -------------------------------------------------------------------------

    if (allFiles.length > MAX_TOTAL_FILES) {
      return res.status(400).json({
        success: false,
        error: "DESIGN_IMAGE_COUNT_EXCEEDED",
      });
    }

    // -------------------------------------------------------------------------
    // 2. Validate actual image signatures and MIME types
    // -------------------------------------------------------------------------

    for (const file of allFiles) {
      const detectedMimeType = detectImageMimeType(file.buffer);

      if (!detectedMimeType) {
        return res.status(415).json({
          success: false,
          error: "DESIGN_IMAGE_CONTENT_INVALID",
          message:
            "One or more uploaded files are not valid PNG, JPEG, or WebP images.",
        });
      }

      if (file.mimetype !== detectedMimeType) {
        return res.status(415).json({
          success: false,
          error: "DESIGN_IMAGE_MIME_MISMATCH",
          message:
            "The uploaded file type does not match its actual image format.",
        });
      }
    }

    // -------------------------------------------------------------------------
    // 3. Keep upload purposes separate
    // -------------------------------------------------------------------------

    req.designUploads = {
      referenceImages,
      assets,
    };

    next();
  });
};

// -----------------------------------------------------------------------------
// Exports
// -----------------------------------------------------------------------------

module.exports = {
  uploadDesignAssets,
  isValidImageBuffer,
};
