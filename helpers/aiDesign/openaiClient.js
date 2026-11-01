
const OPENAI_MODELS_URL = "https://api.openai.com/v1/models";

const verifyOpenAIKey = async (apiKey) => {
  if (typeof apiKey !== "string" || !apiKey.trim()) {
    return { ok: false, error: "API_KEY_REQUIRED" };
  }

  try {
    const response = await fetch(OPENAI_MODELS_URL, {
      method: "GET",
      headers: {
        Authorization: `Bearer ${apiKey.trim()}`,
      },
      signal: AbortSignal.timeout(10000),
    });

    if (response.ok) {
      return { ok: true };
    }

    if (response.status === 401) {
      return { ok: false, error: "OPENAI_INVALID_API_KEY" };
    }

    if (response.status === 403) {
      return { ok: false, error: "OPENAI_PERMISSION_DENIED" };
    }

    if (response.status === 429) {
      return { ok: false, error: "OPENAI_RATE_OR_QUOTA_LIMIT" };
    }

    if (response.status >= 500) {
      return { ok: false, error: "OPENAI_SERVICE_UNAVAILABLE" };
    }

    return { ok: false, error: "OPENAI_VERIFICATION_FAILED" };
  } catch (err) {
    if (err.name === "TimeoutError" || err.name === "AbortError") {
      return { ok: false, error: "OPENAI_REQUEST_TIMEOUT" };
    }

    return { ok: false, error: "OPENAI_CONNECTION_FAILED" };
  }
};

module.exports = { verifyOpenAIKey };
