const express = require("express");
const router = express.Router();

const requireBusiness = require("../../middlewares/requireBusiness");

const { uploadDesignAssets } = require("../../middlewares/uploadDesignAssets");

const { aiDesignController } = require("../../controller/aiDesignController");

const handleDesignUploads = (req, res, next) => {
  uploadDesignAssets(req, res, (error) => {
    if (!error) return next();

    if (error.code === "LIMIT_FILE_SIZE") {
      return res.status(400).json({
        error: "IMAGE_TOO_LARGE",
        message: "Each uploaded image must be 5 MB or smaller.",
      });
    }

    if (
      error.code === "LIMIT_FILE_COUNT" ||
      error.code === "LIMIT_UNEXPECTED_FILE"
    ) {
      return res.status(400).json({
        error: "TOO_MANY_IMAGES",
        message: "The number of uploaded images exceeds the allowed limit.",
      });
    }

    if (error.message === "UNSUPPORTED_IMAGE_TYPE") {
      return res.status(400).json({
        error: "UNSUPPORTED_IMAGE_TYPE",
        message: "Only PNG, JPEG, and WebP images are supported.",
      });
    }

    return next(error);
  });
};

router.post(
  "/generate",
  requireBusiness,
  handleDesignUploads,
  aiDesignController.generate,
);

module.exports = router;
