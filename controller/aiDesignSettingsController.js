const { AISettings } = require("../models");
const { encrypt, decrypt, maskKey } = require("../helpers/aiCrypto");

const {
  CloudflareAIError,
  DEFAULT_TEXT_MODEL,
  DEFAULT_IMAGE_MODEL,
  generateCloudflareText,
} = require("../helpers/aiDesign/cloudflareClient");

// -----------------------------------------------------------------------------
// Error handling
// -----------------------------------------------------------------------------

const internalError = (res, err) => {
  console.error("[ai-design-settings]", err?.message ?? err);

  return res.status(500).json({
    error: "INTERNAL_ERROR",
  });
};

const cloudflareErrorStatus = (error) => {
  if (Number.isInteger(error?.status)) {
    return error.status;
  }

  const statusMap = {
    CLOUDFLARE_ACCOUNT_ID_INVALID: 400,
    CLOUDFLARE_API_TOKEN_INVALID: 400,
    CLOUDFLARE_AUTH_ERROR: 401,
    CLOUDFLARE_RATE_LIMIT: 429,
    CLOUDFLARE_REQUEST_TIMEOUT: 504,
    CLOUDFLARE_NETWORK_ERROR: 502,
    CLOUDFLARE_INVALID_RESPONSE: 502,
  };

  return statusMap[error?.code] || 502;
};

// -----------------------------------------------------------------------------
// Settings response
// -----------------------------------------------------------------------------

const getCloudflareSettings = (settings) => {
  const credentials = settings?.cloudflareAI;

  const configured = Boolean(credentials?.accountId && credentials?.apiToken);

  return {
    configured,
    enabled: Boolean(configured && credentials?.enabled),

    maskedAccountId: credentials?.maskedAccountId ?? null,
    maskedApiToken: credentials?.maskedApiToken ?? null,

    textModel: credentials?.textModel || DEFAULT_TEXT_MODEL,
    imageModel: credentials?.imageModel || DEFAULT_IMAGE_MODEL,

    lastVerifiedAt: credentials?.lastVerifiedAt ?? null,
    updatedAt: settings?.updatedAt ?? null,
  };
};

// -----------------------------------------------------------------------------
// Workers AI verification
// -----------------------------------------------------------------------------

const verifyCloudflareCredentials = async ({
  accountId,
  apiToken,
  textModel = DEFAULT_TEXT_MODEL,
}) => {
  return generateCloudflareText(
    {
      accountId,
      apiToken,
    },
    [
      {
        role: "user",
        content: "Reply with exactly: Cloudflare connection successful.",
      },
    ],
    {
      model: textModel,
      maxTokens: 128,
      enableThinking: false,
      temperature: 0,
    },
  );
};

// -----------------------------------------------------------------------------
// Controller
// -----------------------------------------------------------------------------

const aiDesignSettingsController = {
  // GET: Retrieve the current business's Cloudflare settings.
  async getSettings(req, res) {
    try {
      const settings = await AISettings.findOne({
        businessId: req.businessId,
      });

      return res.json({
        data: getCloudflareSettings(settings),
      });
    } catch (err) {
      return internalError(res, err);
    }
  },

  // POST: Verify and save Cloudflare credentials.
  async saveKey(req, res) {
    try {
      const accountId =
        typeof req.body?.accountId === "string"
          ? req.body.accountId.trim()
          : "";

      const apiToken =
        typeof req.body?.apiToken === "string" ? req.body.apiToken.trim() : "";

      if (!accountId || !apiToken) {
        return res.status(400).json({
          error: "CLOUDFLARE_CREDENTIALS_REQUIRED",
        });
      }

      // Verify actual Workers AI access before saving credentials.
      try {
        await verifyCloudflareCredentials({
          accountId,
          apiToken,
        });
      } catch (error) {
        console.warn("[cloudflare-ai-verification]", {
          error: error?.code || "UNKNOWN_ERROR",
          status: error?.status || null,
        });

        return res.status(cloudflareErrorStatus(error)).json({
          error: error?.code || "CLOUDFLARE_VERIFICATION_FAILED",
        });
      }

      const settings = await AISettings.findOneAndUpdate(
        {
          businessId: req.businessId,
        },
        {
          businessId: req.businessId,
          adminId: req.adminId,

          "cloudflareAI.accountId": encrypt(accountId),
          "cloudflareAI.apiToken": encrypt(apiToken),

          "cloudflareAI.maskedAccountId": maskKey(accountId),
          "cloudflareAI.maskedApiToken": maskKey(apiToken),

          "cloudflareAI.enabled": true,

          "cloudflareAI.textModel": DEFAULT_TEXT_MODEL,
          "cloudflareAI.imageModel": DEFAULT_IMAGE_MODEL,

          "cloudflareAI.lastVerifiedAt": new Date(),
        },
        {
          new: true,
          upsert: true,
          setDefaultsOnInsert: true,
        },
      );

      return res.json({
        data: getCloudflareSettings(settings),
      });
    } catch (err) {
      return internalError(res, err);
    }
  },

  // POST: Verify provided credentials or the credentials already saved.
  async verifyKey(req, res) {
    try {
      const providedAccountId =
        typeof req.body?.accountId === "string"
          ? req.body.accountId.trim()
          : "";

      const providedApiToken =
        typeof req.body?.apiToken === "string" ? req.body.apiToken.trim() : "";

      const hasProvidedCredentials =
        Boolean(providedAccountId) || Boolean(providedApiToken);

      let accountId = providedAccountId;
      let apiToken = providedApiToken;

      if (hasProvidedCredentials && (!accountId || !apiToken)) {
        return res.status(400).json({
          error: "CLOUDFLARE_CREDENTIALS_REQUIRED",
        });
      }

      if (!hasProvidedCredentials) {
        const settings = await AISettings.findOne({
          businessId: req.businessId,
        });

        if (
          !settings?.cloudflareAI?.accountId ||
          !settings?.cloudflareAI?.apiToken
        ) {
          return res.status(404).json({
            error: "NOT_CONFIGURED",
          });
        }

        try {
          accountId = decrypt(settings.cloudflareAI.accountId);
          apiToken = decrypt(settings.cloudflareAI.apiToken);
        } catch {
          return res.status(500).json({
            error: "CREDENTIALS_UNREADABLE",
          });
        }
      }

      try {
        await verifyCloudflareCredentials({
          accountId,
          apiToken,
        });
      } catch (error) {
        console.warn("[cloudflare-ai-verification]", {
          error: error?.code || "UNKNOWN_ERROR",
          status: error?.status || null,
        });

        return res.status(cloudflareErrorStatus(error)).json({
          error: error?.code || "CLOUDFLARE_VERIFICATION_FAILED",
        });
      }

      return res.json({
        data: {
          ok: true,
          provider: "cloudflare",
        },
      });
    } catch (err) {
      return internalError(res, err);
    }
  },

  // PATCH: Enable or disable Cloudflare AI for this business.
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

      if (
        !current?.cloudflareAI?.accountId ||
        !current?.cloudflareAI?.apiToken
      ) {
        return res.status(404).json({
          error: "NOT_CONFIGURED",
        });
      }

      const settings = await AISettings.findOneAndUpdate(
        {
          businessId: req.businessId,
        },
        {
          adminId: req.adminId,
          "cloudflareAI.enabled": req.body.enabled,
        },
        {
          new: true,
        },
      );

      return res.json({
        data: getCloudflareSettings(settings),
      });
    } catch (err) {
      return internalError(res, err);
    }
  },

  // DELETE: Remove saved Cloudflare credentials.
  async deleteKey(req, res) {
    try {
      const settings = await AISettings.findOne({
        businessId: req.businessId,
      });

      if (!settings) {
        return res.json({
          data: {
            configured: false,
            enabled: false,
            maskedAccountId: null,
            maskedApiToken: null,
            lastVerifiedAt: null,
          },
        });
      }

      const updatedSettings = await AISettings.findOneAndUpdate(
        {
          businessId: req.businessId,
        },
        {
          adminId: req.adminId,

          $unset: {
            "cloudflareAI.accountId": 1,
            "cloudflareAI.apiToken": 1,
            "cloudflareAI.maskedAccountId": 1,
            "cloudflareAI.maskedApiToken": 1,
          },

          $set: {
            "cloudflareAI.enabled": false,
            "cloudflareAI.lastVerifiedAt": null,
          },
        },
        {
          new: true,
        },
      );

      return res.json({
        data: getCloudflareSettings(updatedSettings),
      });
    } catch (err) {
      return internalError(res, err);
    }
  },
};

module.exports = {
  aiDesignSettingsController,
};

// const { AISettings } = require("../models");
// const { encrypt, decrypt, maskKey } = require("../helpers/aiCrypto");
// const { verifyOpenAIKey } = require("../helpers/aiDesign/openaiClient");

// const internalError = (res, err) => {
//   console.error("[ai-design-settings]", err?.message ?? err);
//   return res.status(500).json({ error: "INTERNAL_ERROR" });
// };

// const openAIErrorStatus = (error) => {
//   const statusMap = {
//     OPENAI_INVALID_API_KEY: 400,
//     OPENAI_PERMISSION_DENIED: 403,
//     OPENAI_QUOTA_EXCEEDED: 429,
//     OPENAI_RATE_LIMITED: 429,
//     OPENAI_REQUEST_LIMIT_REACHED: 429,
//     OPENAI_RATE_OR_QUOTA_LIMIT: 429,
//     OPENAI_REQUEST_TIMEOUT: 504,
//     OPENAI_SERVICE_UNAVAILABLE: 503,
//     OPENAI_CONNECTION_FAILED: 502,
//   };

//   return statusMap[error] || 502;
// };

// const getImageSettings = (settings) => {
//   const credentials = settings?.openaiImage;

//   return {
//     configured: Boolean(credentials?.apiKey),
//     enabled: Boolean(credentials?.enabled && credentials?.apiKey),
//     maskedKey: credentials?.maskedKey ?? null,
//     lastVerifiedAt: credentials?.lastVerifiedAt ?? null,
//     updatedAt: settings?.updatedAt ?? null,
//   };
// };

// const aiDesignSettingsController = {
//   async getSettings(req, res) {
//     try {
//       const settings = await AISettings.findOne({
//         businessId: req.businessId,
//       });

//       return res.json({
//         data: getImageSettings(settings),
//       });
//     } catch (err) {
//       return internalError(res, err);
//     }
//   },

//   async saveKey(req, res) {
//     try {
//       const apiKey =
//         typeof req.body?.apiKey === "string"
//           ? req.body.apiKey.trim()
//           : "";

//       if (!apiKey) {
//         return res.status(400).json({
//           error: "API_KEY_REQUIRED",
//         });
//       }

//       const check = await verifyOpenAIKey(apiKey);

//       if (!check.ok) {
//         console.warn("[ai-design-key-verification]", {
//           error: check.error,
//           requestId: check.requestId ?? null,
//         });

//         return res.status(openAIErrorStatus(check.error)).json({
//           error: check.error,
//           requestId: check.requestId,
//         });
//       }

//       const settings = await AISettings.findOneAndUpdate(
//         { businessId: req.businessId },
//         {
//           businessId: req.businessId,
//           adminId: req.adminId,
//           "openaiImage.apiKey": encrypt(apiKey),
//           "openaiImage.maskedKey": maskKey(apiKey),
//           "openaiImage.enabled": true,
//           "openaiImage.lastVerifiedAt": new Date(),
//         },
//         {
//           new: true,
//           upsert: true,
//           setDefaultsOnInsert: true,
//         },
//       );

//       return res.json({
//         data: getImageSettings(settings),
//       });
//     } catch (err) {
//       return internalError(res, err);
//     }
//   },

//   async verifyKey(req, res) {
//     try {
//       const providedKey =
//         typeof req.body?.apiKey === "string"
//           ? req.body.apiKey.trim()
//           : "";

//       let apiKey = providedKey;

//       if (!apiKey) {
//         const settings = await AISettings.findOne({
//           businessId: req.businessId,
//         });

//         if (!settings?.openaiImage?.apiKey) {
//           return res.status(404).json({
//             error: "NOT_CONFIGURED",
//           });
//         }

//         try {
//           apiKey = decrypt(settings.openaiImage.apiKey);
//         } catch {
//           return res.status(500).json({
//             error: "KEY_UNREADABLE",
//           });
//         }
//       }

//       const check = await verifyOpenAIKey(apiKey);

//       if (!check.ok) {
//         console.warn("[ai-design-key-verification]", {
//           error: check.error,
//           requestId: check.requestId ?? null,
//         });

//         return res.status(openAIErrorStatus(check.error)).json({
//           error: check.error,
//           requestId: check.requestId,
//         });
//       }

//       return res.json({
//         data: {
//           ok: true,
//           provider: "openai",
//         },
//       });
//     } catch (err) {
//       return internalError(res, err);
//     }
//   },

//   async updateSettings(req, res) {
//     try {
//       if (typeof req.body?.enabled !== "boolean") {
//         return res.status(400).json({
//           error: "INVALID_SETTINGS",
//         });
//       }

//       const current = await AISettings.findOne({
//         businessId: req.businessId,
//       });

//       if (!current?.openaiImage?.apiKey) {
//         return res.status(404).json({
//           error: "NOT_CONFIGURED",
//         });
//       }

//       const settings = await AISettings.findOneAndUpdate(
//         { businessId: req.businessId },
//         {
//           adminId: req.adminId,
//           "openaiImage.enabled": req.body.enabled,
//         },
//         { new: true },
//       );

//       return res.json({
//         data: getImageSettings(settings),
//       });
//     } catch (err) {
//       return internalError(res, err);
//     }
//   },

//   async deleteKey(req, res) {
//     try {
//       await AISettings.findOneAndUpdate(
//         { businessId: req.businessId },
//         {
//           adminId: req.adminId,
//           "openaiImage.apiKey": null,
//           "openaiImage.maskedKey": null,
//           "openaiImage.enabled": false,
//           "openaiImage.lastVerifiedAt": null,
//         },
//       );

//       return res.json({
//         data: {
//           configured: false,
//           enabled: false,
//           maskedKey: null,
//           lastVerifiedAt: null,
//         },
//       });
//     } catch (err) {
//       return internalError(res, err);
//     }
//   },
// };

// module.exports = { aiDesignSettingsController };
