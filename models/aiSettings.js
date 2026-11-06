const mongoose = require("mongoose");
const { pick } = require("../helpers/functions");

/** Ciphertext plus everything needed to read it back. */
const encryptedValueSchema = new mongoose.Schema(
  {
    ciphertext: {
      type: String,
      required: true,
    },
    iv: {
      type: String,
      required: true,
    },
    authTag: {
      type: String,
      required: true,
    },
    keyVersion: {
      type: Number,
      required: true,
      default: 1,
    },
  },
  { _id: false },
);

/**
 * One provider's credentials.
 *
 * Used by the existing AI Insights providers and OpenAI Image.
 */
const providerCredentialsSchema = (defaultModel) => ({
  enabled: {
    type: Boolean,
    default: true,
  },
  model: {
    type: String,
    default: defaultModel,
  },
  apiKey: {
    type: encryptedValueSchema,
    default: null,
  },
  maskedKey: {
    type: String,
    default: null,
  },
  lastVerifiedAt: {
    type: Date,
    default: null,
  },
  allowAutomaticFallback: {
    type: Boolean,
    default: false,
  },
});

/**
 * Cloudflare Workers AI configuration for AI Design.
 *
 * Each business stores its own Cloudflare Account ID and API Token.
 * Both credentials are encrypted independently.
 *
 * This configuration is intentionally separate from the AI Insights
 * provider configuration above.
 */
const cloudflareAICredentialsSchema = new mongoose.Schema(
  {
    enabled: {
      type: Boolean,
      default: true,
    },

    accountId: {
      type: encryptedValueSchema,
      default: null,
    },

    apiToken: {
      type: encryptedValueSchema,
      default: null,
    },

    maskedAccountId: {
      type: String,
      default: null,
    },

    maskedApiToken: {
      type: String,
      default: null,
    },

    textModel: {
      type: String,
      default: "@cf/zai-org/glm-4.7-flash",
    },

    imageModel: {
      type: String,
      default: "@cf/black-forest-labs/flux-2-klein-4b",
    },

    lastVerifiedAt: {
      type: Date,
      default: null,
    },
  },
  { _id: false },
);

const aiSettingsSchema = new mongoose.Schema(
  {
    // String, not ObjectId, while this runs as its own service.
    businessId: {
      type: String,
      required: true,
      unique: true,
      index: true,
    },

    // The business's admin.
    adminId: {
      type: String,
      required: true,
      index: true,
    },

    /**
     * AI Insights provider selection.
     * Existing businesses continue using Gemini by default.
     */
    provider: {
      type: String,
      default: "gemini",
    },

    // Existing AI Insights providers.
    gemini: providerCredentialsSchema("gemini-3.6-flash"),
    openrouter: providerCredentialsSchema("openrouter/free"),
    groq: providerCredentialsSchema("openai/gpt-oss-20b"),
    mistral: providerCredentialsSchema("mistral-small-latest"),
    nvidia: providerCredentialsSchema("openai/gpt-oss-20b"),
    zai: providerCredentialsSchema("glm-4.7-flash"),

    // Existing OpenAI image configuration retained for rollback.
    openaiImage: providerCredentialsSchema(null),

    // Separate Cloudflare configuration for AI Design.
    cloudflareAI: {
      type: cloudflareAICredentialsSchema,
      default: () => ({}),
    },
  },
  {
    timestamps: true,
  },
);

/** Existing AI Insights provider selection. */
aiSettingsSchema.methods.active = function () {
  return this[this.provider] ?? this.gemini;
};

/**
 * Existing AI Insights response format.
 * Cloudflare AI Design credentials are deliberately excluded.
 */
aiSettingsSchema.methods.formatted = function (req) {
  const active = this.active();
  const settings = pick("provider", "updatedAt")(this);

  return {
    provider: settings.provider ?? "gemini",
    configured: Boolean(active?.apiKey),
    enabled: Boolean(active?.enabled),
    model: active?.model ?? null,
    maskedKey: active?.maskedKey ?? null,
    lastVerifiedAt: active?.lastVerifiedAt ?? null,
    updatedAt: settings.updatedAt,
  };
};

// Prevent encrypted credentials from being exposed through serialization.
aiSettingsSchema.set("toJSON", {
  transform(_doc, ret) {
    if (ret.gemini) delete ret.gemini.apiKey;
    if (ret.openrouter) delete ret.openrouter.apiKey;
    if (ret.groq) delete ret.groq.apiKey;
    if (ret.mistral) delete ret.mistral.apiKey;
    if (ret.nvidia) delete ret.nvidia.apiKey;
    if (ret.zai) delete ret.zai.apiKey;
    if (ret.openaiImage) delete ret.openaiImage.apiKey;

    if (ret.cloudflareAI) {
      delete ret.cloudflareAI.accountId;
      delete ret.cloudflareAI.apiToken;
    }

    return ret;
  },
});

const AISettings = mongoose.model("AISettings", aiSettingsSchema);

module.exports = AISettings;
