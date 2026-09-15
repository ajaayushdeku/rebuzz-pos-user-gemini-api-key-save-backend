/**
 * Per-business in-memory rate limiter.
 *
 * Why this exists: every call past this point spends the merchant's own
 * Gemini quota (or a verification ping on theirs). The briefing cap bounds
 * the cost of one call; only a rate limit bounds the cost of many. A burst
 * of clicks, a retry loop, or an over-eager auto-refresh must not turn into
 * a bill nobody chose.
 *
 * Why in-memory rather than Redis: this service runs as a single small
 * process next to the POS frontend, and the limit is a cost guard, not a
 * security boundary — a restart clearing the buckets fails open toward
 * letting one extra hour of calls through, which is acceptable. If this ever
 * runs as multiple replicas, replace the Map with a shared store; the
 * middleware signature stays the same.
 */

/**
 * @param {{ windowMs?: number, max?: number, error?: string }} options
 */
export function rateLimit({ windowMs = 60_000, max = 10, error = "RATE_LIMITED" } = {}) {
  /** Key -> timestamps (ms) of recent allowed requests. */
  const buckets = new Map();

  return (req, res, next) => {
    // Scoped by business when auth has run, otherwise by IP — so one tenant's
    // burst never spends another tenant's budget, and unauthenticated callers
    // still share nothing wider than their own address.
    const key = req.businessId ?? req.ip ?? "unknown";
    const now = Date.now();

    const seen = buckets.get(key) ?? [];
    // Prune outside the window first so the array cannot grow without bound.
    const recent = seen.filter((t) => now - t < windowMs);

    if (recent.length >= max) {
      const oldest = recent[0];
      const retryAfterSec = Math.max(1, Math.ceil((oldest + windowMs - now) / 1000));
      res.setHeader("Retry-After", String(retryAfterSec));
      // Both header and body: header for HTTP clients, body for the frontend
      // client, which reads the JSON error (see AiInsightsApiError.retryAfter).
      return res.status(429).json({ error, retryAfter: retryAfterSec });
    }

    recent.push(now);
    buckets.set(key, recent);
    next();
  };
}

/**
 * Guard for the quota-spending route: at most 20 insight generations per
 * business per hour. Twenty is generous for a dashboard card a human reads
 * (even one refresh every 3 minutes fits) while still capping a runaway loop
 * at 20 calls before it must wait.
 */
export const insightsRateLimit = () =>
  rateLimit({ windowMs: 60 * 60 * 1000, max: 20, error: "INSIGHTS_RATE_LIMIT" });

/**
 * Guard for the key-verification ping: at most 10 checks per business per
 * minute. Verifying is cheap but still a live Google call, and the settings
 * form is exactly the place a double-click or impatient retry happens.
 */
export const verifyRateLimit = () =>
  rateLimit({ windowMs: 60 * 1000, max: 10, error: "VERIFY_RATE_LIMIT" });
