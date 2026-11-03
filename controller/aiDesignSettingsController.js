
const { AISettings } = require("../models");
const { encrypt, decrypt, maskKey } = require("../helpers/aiCrypto");
const { verifyOpenAIKey } = require("../helpers/aiDesign/openaiClient");

const internalError = (res, err) => {
  console.error("[ai-design-settings]", err?.message ?? err);
  return res.status(500).json({ error: "INTERNAL_ERROR" });
};

const openAIErrorStatus = (error) => {
  const statusMap = {
    OPENAI_INVALID_API_KEY: 400,
    OPENAI_PERMISSION_DENIED: 403,
    OPENAI_QUOTA_EXCEEDED: 429,
    OPENAI_RATE_LIMITED: 429,
    OPENAI_REQUEST_LIMIT_REACHED: 429,
    OPENAI_RATE_OR_QUOTA_LIMIT: 429,
    OPENAI_REQUEST_TIMEOUT: 504,
    OPENAI_SERVICE_UNAVAILABLE: 503,
    OPENAI_CONNECTION_FAILED: 502,
  };

  return statusMap[error] || 502;
};

const getImageSettings = (settings) => {
  const credentials = settings?.openaiImage;

  return {
    configured: Boolean(credentials?.apiKey),
    enabled: Boolean(credentials?.enabled && credentials?.apiKey),
    maskedKey: credentials?.maskedKey ?? null,
    lastVerifiedAt: credentials?.lastVerifiedAt ?? null,
    updatedAt: settings?.updatedAt ?? null,
  };
};

const aiDesignSettingsController = {
  async getSettings(req, res) {
    try {
      const settings = await AISettings.findOne({
        businessId: req.businessId,
      });

      return res.json({
        data: getImageSettings(settings),
      });
    } catch (err) {
      return internalError(res, err);
    }
  },

  async saveKey(req, res) {
    try {
      const apiKey =
        typeof req.body?.apiKey === "string"
          ? req.body.apiKey.trim()
          : "";

      if (!apiKey) {
        return res.status(400).json({
          error: "API_KEY_REQUIRED",
        });
      }

      const check = await verifyOpenAIKey(apiKey);

      if (!check.ok) {
        console.warn("[ai-design-key-verification]", {
          error: check.error,
          requestId: check.requestId ?? null,
        });

        return res.status(openAIErrorStatus(check.error)).json({
          error: check.error,
          requestId: check.requestId,
        });
      }

      const settings = await AISettings.findOneAndUpdate(
        { businessId: req.businessId },
        {
          businessId: req.businessId,
          adminId: req.adminId,
          "openaiImage.apiKey": encrypt(apiKey),
          "openaiImage.maskedKey": maskKey(apiKey),
          "openaiImage.enabled": true,
          "openaiImage.lastVerifiedAt": new Date(),
        },
        {
          new: true,
          upsert: true,
          setDefaultsOnInsert: true,
        },
      );

      return res.json({
        data: getImageSettings(settings),
      });
    } catch (err) {
      return internalError(res, err);
    }
  },

  async verifyKey(req, res) {
    try {
      const providedKey =
        typeof req.body?.apiKey === "string"
          ? req.body.apiKey.trim()
          : "";

      let apiKey = providedKey;

      if (!apiKey) {
        const settings = await AISettings.findOne({
          businessId: req.businessId,
        });

        if (!settings?.openaiImage?.apiKey) {
          return res.status(404).json({
            error: "NOT_CONFIGURED",
          });
        }

        try {
          apiKey = decrypt(settings.openaiImage.apiKey);
        } catch {
          return res.status(500).json({
            error: "KEY_UNREADABLE",
          });
        }
      }

      const check = await verifyOpenAIKey(apiKey);

      if (!check.ok) {
        console.warn("[ai-design-key-verification]", {
          error: check.error,
          requestId: check.requestId ?? null,
        });

        return res.status(openAIErrorStatus(check.error)).json({
          error: check.error,
          requestId: check.requestId,
        });
      }

      return res.json({
        data: {
          ok: true,
          provider: "openai",
        },
      });
    } catch (err) {
      return internalError(res, err);
    }
  },

  async updateSettings(req, res) {
    try {
      if (typeof req.body?.enabled !== "boolean") {
        return res.status(400).json({
          error: "INVALID_SETTINGS",
        });
      }

      const current = await AISettings.findOne({
        businessId: req.businessId,
      });

      if (!current?.openaiImage?.apiKey) {
        return res.status(404).json({
          error: "NOT_CONFIGURED",
        });
      }

      const settings = await AISettings.findOneAndUpdate(
        { businessId: req.businessId },
        {
          adminId: req.adminId,
          "openaiImage.enabled": req.body.enabled,
        },
        { new: true },
      );

      return res.json({
        data: getImageSettings(settings),
      });
    } catch (err) {
      return internalError(res, err);
    }
  },

  async deleteKey(req, res) {
    try {
      await AISettings.findOneAndUpdate(
        { businessId: req.businessId },
        {
          adminId: req.adminId,
          "openaiImage.apiKey": null,
          "openaiImage.maskedKey": null,
          "openaiImage.enabled": false,
          "openaiImage.lastVerifiedAt": null,
        },
      );

      return res.json({
        data: {
          configured: false,
          enabled: false,
          maskedKey: null,
          lastVerifiedAt: null,
        },
      });
    } catch (err) {
      return internalError(res, err);
    }
  },
};

module.exports = { aiDesignSettingsController };
