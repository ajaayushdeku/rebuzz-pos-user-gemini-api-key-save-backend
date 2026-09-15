import mongoose from "mongoose";

/** Ciphertext plus everything needed to read it back. */
const encryptedValueSchema = new mongoose.Schema(
  {
    ciphertext: { type: String, required: true },
    iv: { type: String, required: true },
    authTag: { type: String, required: true },
    // Present from day one. Re-encrypting under a new key means finding the
    // records still on the old one — a field lookup with this, a migration
    // without it.
    keyVersion: { type: Number, required: true, default: 1 },
  },
  { _id: false },
);

const aiSettingsSchema = new mongoose.Schema(
  {
    // String, not ObjectId: the id arrives from another system's token, and
    // casting it here would couple this service to their id format.
    businessId: { type: String, required: true, unique: true, index: true },

    gemini: {
      enabled: { type: Boolean, default: true },
      // Default only. POST / overwrites this with the model it actually
      // verified, so a saved key can never be used against a model it was not
      // tested with. PATCH still accepts any string, unverified — it exists so
      // a user can switch to one of the names a failed check handed back.
      model: { type: String, default: "gemini-3.6-flash" },
      apiKey: { type: encryptedValueSchema, default: null },
      maskedKey: { type: String, default: null },
      lastVerifiedAt: { type: Date, default: null },
    },
  },
  { timestamps: true },
);

/**
 * The only shape allowed to leave the server.
 *
 * Routes return this rather than the document, so a field added to the schema
 * later cannot leak by default.
 */
aiSettingsSchema.methods.toSafeJSON = function toSafeJSON() {
  return {
    configured: Boolean(this.gemini?.apiKey),
    enabled: Boolean(this.gemini?.enabled),
    model: this.gemini?.model ?? null,
    maskedKey: this.gemini?.maskedKey ?? null,
    lastVerifiedAt: this.gemini?.lastVerifiedAt ?? null,
    updatedAt: this.updatedAt,
  };
};

// Belt and braces: if a document is ever serialised directly — a stray
// res.json(doc), a logger that stringifies its input — the ciphertext does
// not travel with it.
aiSettingsSchema.set("toJSON", {
  transform(_doc, ret) {
    if (ret.gemini) delete ret.gemini.apiKey;
    return ret;
  },
});

export default mongoose.model("AISettings", aiSettingsSchema);
