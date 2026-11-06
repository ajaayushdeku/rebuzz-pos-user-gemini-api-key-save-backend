const AISettings = require("../../models/aiSettings");
const { decrypt } = require("../aiCrypto");
const {
  DEFAULT_PROVIDER,
  PROVIDER_IDS,
  getProvider,
} = require("../aiProviders");

/**
 * Failures for which another configured provider can reasonably help.
 *
 * Invalid credentials, malformed output, truncation and empty responses are
 * deliberately excluded: changing providers would hide a configuration or
 * prompt problem rather than recover from an unavailable allowance/service.
 */
const FALLBACK_ELIGIBLE_ERRORS = new Set([
  "AI_QUOTA_EXCEEDED",
  "AI_RATE_LIMIT",
  "AI_UNAVAILABLE",
  "AI_MODEL_UNAVAILABLE",
  "AI_PAYMENT_REQUIRED",
]);

async function callProvider(providerId, credentials, options) {
  let apiKey;

  try {
    apiKey = decrypt(credentials.apiKey);
  } catch {
    return { ok: false, error: "KEY_UNREADABLE" };
  }

  try {
    return await getProvider(providerId).generateInsights(apiKey, {
      ...options,
      model: credentials.model || undefined,
    });
  } catch {
    // Provider adapters normally normalize errors themselves. Keep this
    // boundary defensive so one unexpected SDK exception cannot skip fallback.
    return { ok: false, error: "AI_UNAVAILABLE" };
  }
}

/**
 * Permanently select the provider that just succeeded.
 *
 * The provider predicate is an optimistic concurrency guard: if a person
 * changed the selection while generation was in flight, this update matches
 * nothing and must not undo their choice. Older Gemini records may not have a
 * persisted provider field, hence the missing-field alternative.
 */
async function persistFallbackProvider({
  businessId,
  previousProviderId,
  nextProviderId,
}) {
  const providerGuard =
    previousProviderId === DEFAULT_PROVIDER
      ? {
          $or: [
            { provider: DEFAULT_PROVIDER },
            { provider: { $exists: false } },
          ],
        }
      : { provider: previousProviderId };

  try {
    const update = await AISettings.updateOne(
      { businessId, ...providerGuard },
      { $set: { provider: nextProviderId } },
    );

    return (update.matchedCount ?? update.n ?? 0) > 0;
  } catch (error) {
    // The generated answer is still useful; report the persistence failure
    // without logging credentials or interrupting the response.
    console.warn(
      `[insights] could not persist fallback provider business=${businessId}: ${error?.message}`,
    );
    return false;
  }
}

/**
 * Call the selected provider first, then explicitly opted-in alternatives.
 *
 * A successful alternate is returned with its own provider and credentials so
 * both insight controllers can cache and report the provider that actually
 * answered, rather than the provider that failed.
 */
async function generateWithFallback({
  businessId,
  settings,
  providerId,
  credentials,
  options,
}) {
  const primary = await callProvider(providerId, credentials, options);

  if (primary.ok) {
    return { ...primary, providerId, credentials, fallback: false };
  }

  if (
    primary.error === "KEY_UNREADABLE" ||
    !FALLBACK_ELIGIBLE_ERRORS.has(primary.error)
  ) {
    return { ...primary, providerId, credentials, fallback: false };
  }

  for (const candidateId of PROVIDER_IDS) {
    if (candidateId === providerId) continue;

    const candidateCredentials = settings?.[candidateId];
    if (
      !candidateCredentials?.apiKey ||
      candidateCredentials.enabled !== true ||
      candidateCredentials.allowAutomaticFallback !== true
    ) {
      continue;
    }

    const result = await callProvider(
      candidateId,
      candidateCredentials,
      options,
    );

    if (!result.ok) {
      // A candidate can itself be out of quota or have a stale key. Keep
      // checking other opted-in providers, without replacing the primary error.
      continue;
    }

    const persisted = await persistFallbackProvider({
      businessId,
      previousProviderId: providerId,
      nextProviderId: candidateId,
    });

    return {
      ...result,
      providerId: candidateId,
      credentials: candidateCredentials,
      fallback: true,
      fallbackFrom: providerId,
      providerPersisted: persisted,
    };
  }

  // Preserve the selected provider's original failure if every alternate fails.
  return { ...primary, providerId, credentials, fallback: false };
}

module.exports = {
  FALLBACK_ELIGIBLE_ERRORS,
  generateWithFallback,
  persistFallbackProvider,
};
