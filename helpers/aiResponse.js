const AI_MESSAGES = {
  AUTH_REQUIRED: "Login Required",
  BUSINESS_NOT_FOUND: "Looks you have not registered your business yet!!",
  API_KEY_REQUIRED: "API key is required.",
  NOTHING_TO_UPDATE: "Nothing to update.",
  NOT_CONFIGURED: "No AI key is saved for this business.",
  PROVIDER_NOT_CONFIGURED: "Save a key for that provider before switching to it.",
  AI_DISABLED: "AI is switched off for this business.",
  KEY_UNREADABLE: "The saved AI key can no longer be read. Please enter it again.",
  BRIEFING_REQUIRED: "Briefing is required.",
  BRIEFING_TOO_LONG: "Briefing is too long.",
  INSTRUCTION_TOO_LONG: "System instruction is too long.",
  INVALID_CACHE_KEY: "Invalid cache key.",
  CACHE_NEEDS_SCHEMA: "A cache key needs a response schema.",
  AI_KEY_INVALID: "The AI provider rejected this key.",
  AI_QUOTA_EXCEEDED: "This key has used up its quota.",
  AI_RATE_LIMIT: "The AI provider is rate limiting this key. Try again shortly.",
  AI_PLAN_LIMIT: "This key's plan does not include the available models.",
  AI_MODEL_UNAVAILABLE: "This key cannot use that model.",
  AI_UNAVAILABLE: "The AI provider is unavailable right now.",
  AI_TRUNCATED: "The AI answer was cut off.",
  AI_EMPTY_RESPONSE: "The AI returned an empty answer.",
  AI_MALFORMED_RESPONSE: "The AI answered in a format that could not be read.",
  // Period insights.
  INVALID_PERIOD_KIND: "That is not a period this app reports on.",
  INVALID_PERIOD: "That period could not be read.",
  PERIOD_NOT_CLOSED: "That period has not finished yet.",
  INVALID_SECTION: "That is not a section of the insights page.",
  INVALID_PROMPT_VERSION: "That prompt version is not recognised.",
  INVALID_MODE: "That is not something that can be asked for.",
  MORE_NOT_SUPPORTED: "This section cannot be extended.",
  NOTHING_TO_EXTEND: "There is nothing stored for this section yet.",
  NO_MORE_AVAILABLE: "There is nothing more to add for this period.",
  BATCH_LIMIT_REACHED: "This section has been extended as far as it goes.",
  ITEMS_REQUIRED: "Items are required unless the period is empty.",
  SCHEMA_REQUIRED: "A response schema is required.",
  INSIGHTS_RATE_LIMIT: "Too many insight requests. Try again later.",
  VERIFY_RATE_LIMIT: "Too many key checks. Try again in a minute.",
  INTERNAL_ERROR: "Internal Server Error",
};

const aiFail = (res, statusCode, code, extra = {}) =>
  res.status(statusCode).json({
    status: statusCode >= 500 ? "error" : "fail",
    data: {
      code,
      message: AI_MESSAGES[code] || code,
      ...extra,
    },
  });

const aiSuccess = (res, data) => res.json({ status: "success", data });

const aiInternalError = (res, err) => {
  console.error("[ai] error:", err?.message ?? err);
  return aiFail(res, 500, "INTERNAL_ERROR");
};

module.exports = { aiFail, aiSuccess, aiInternalError, AI_MESSAGES };
