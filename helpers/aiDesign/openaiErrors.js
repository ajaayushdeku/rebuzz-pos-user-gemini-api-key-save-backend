const QUOTA_ERROR_CODES = new Set([
  "insufficient_quota",
  "billing_hard_limit_reached",
  "credit_balance_exhausted",
  "organization_usage_limit_exceeded",
  "organization_spend_limit_exceeded",
  "project_spend_limit_exceeded",
]);

/**
 * Classify OpenAI's HTTP 429 responses using the provider error details.
 * Unknown 429s stay distinct so callers do not misreport them as billing errors.
 */
const classifyOpenAI429Error = (response, result) => {
  if (response?.status !== 429) {
    return null;
  }

  const providerError = result?.error ?? {};
  const code = String(providerError.code ?? "").toLowerCase();
  const type = String(providerError.type ?? "").toLowerCase();
  const message = String(providerError.message ?? "").toLowerCase();

  if (
    QUOTA_ERROR_CODES.has(code) ||
    type === "insufficient_quota" ||
    message.includes("exceeded your current quota") ||
    message.includes("billing details")
  ) {
    return "OPENAI_QUOTA_EXCEEDED";
  }

  if (code === "rate_limit_exceeded" || message.includes("rate limit")) {
    return "OPENAI_RATE_LIMITED";
  }

  return "OPENAI_REQUEST_LIMIT_REACHED";
};

const getOpenAIRequestId = (response) => {
  const requestId = response?.headers?.get?.("x-request-id");
  return typeof requestId === "string" && requestId.trim()
    ? requestId.trim()
    : undefined;
};

const openAIRequestFailure = (response, error) => {
  const requestId = getOpenAIRequestId(response);

  return {
    ok: false,
    error,
    ...(requestId ? { requestId } : {}),
  };
};

module.exports = {
  classifyOpenAI429Error,
  getOpenAIRequestId,
  openAIRequestFailure,
};
