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
    // Present from day one. Re-encrypting under a new key means finding the
    // records still on the old one — a field lookup with this, a migration
    // without it.
    keyVersion: {
      type: Number,
      required: true,
      default: 1,
    },
  },
  { _id: false },
);

/**
 * One provider's credentials. The same shape for every provider, so a new one
 * is a field below rather than a new schema.
 *
 * `model` is a default only. Saving a key overwrites it with the model it
 * actually verified, so a saved key can never be used against a model it was
 * not tested with.
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
});

const aiSettingsSchema = new mongoose.Schema(
  {
    // String, not ObjectId, while this runs as its own service: the id arrives
    // from the POS API's answer, and casting it here would couple this service
    // to that id format. Becomes { type: ObjectId, ref: "Business" } when the
    // model moves into khajaGharBackend.
    businessId: {
      type: String,
      required: true,
      unique: true,
      index: true,
    },
    // The business's admin, as every khajaGharBackend tenant model carries.
    // String for the same reason as businessId; becomes
    // { type: ObjectId, ref: "User" } on the move. Lookups stay on businessId.
    adminId: {
      type: String,
      required: true,
      index: true,
    },

    /**
     * Which provider this business uses. Defaults to Gemini, which is what
     * every record written before there was a choice is using — so existing
     * businesses keep working with no migration.
     */
    provider: {
      type: String,
      default: "gemini",
    },

    // One block per provider, rather than one shared block, so switching
    // provider does not throw away the key for the old one: switch back and
    // it still works.
    gemini: providerCredentialsSchema("gemini-3.6-flash"),
    openrouter: providerCredentialsSchema("openrouter/free"),
    groq: providerCredentialsSchema("openai/gpt-oss-20b"),
    mistral: providerCredentialsSchema("mistral-small-latest"),
    nvidia: providerCredentialsSchema("openai/gpt-oss-20b"),
  },
  {
    timestamps: true,
  },
);

/** The credentials for the provider in use. */
aiSettingsSchema.methods.active = function () {
  return this[this.provider] ?? this.gemini;
};

/**
 * The only shape allowed to leave the server.
 *
 * Controllers return this rather than the document, so a field added to the
 * schema later cannot leak by default.
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

// Belt and braces: if a document is ever serialised directly — a stray
// res.json(doc), a logger that stringifies its input — the ciphertext does
// not travel with it.
aiSettingsSchema.set("toJSON", {
  transform(_doc, ret) {
    if (ret.gemini) delete ret.gemini.apiKey;
    if (ret.openrouter) delete ret.openrouter.apiKey;
    if (ret.groq) delete ret.groq.apiKey;
    if (ret.mistral) delete ret.mistral.apiKey;
    if (ret.nvidia) delete ret.nvidia.apiKey;
    return ret;
  },
});

const AISettings = mongoose.model("AISettings", aiSettingsSchema);
module.exports = AISettings;
