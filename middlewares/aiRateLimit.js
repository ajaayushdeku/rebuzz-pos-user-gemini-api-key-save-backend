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
 * @param {{
 *   windowMs?: number,
 *   max?: number,
 *   error?: string,
 *   onLimit?: (req: object, res: object, retryAfterSec: number) => Promise<boolean>
 * }} options
 *
 * `onLimit` is offered the refused request before the 429 is written, and
 * answers whether it handled it. The insights route uses it to serve the last
 * answer it has rather than an error — a card that is an hour old is worth
 * more to a merchant than an empty panel.
 */
function rateLimit({
  windowMs = 60_000,
  max = 10,
  error = "RATE_LIMITED",
  onLimit,
} = {}) {
  /** Key -> timestamps (ms) of recent allowed requests. */
  const buckets = new Map();

  /** The key a request counts against; see the note in the middleware. */
  const keyFor = (req) => req.businessId ?? req.ip ?? "unknown";

  /**
   * What the bucket holds right now, without charging it.
   *
   * `resetAt` is when the window next frees a slot — the oldest surviving
   * timestamp plus the window — or, with an empty bucket, one window ahead.
   */
  const snapshot = (req) => {
    const now = Date.now();
    const recent = (buckets.get(keyFor(req)) ?? []).filter(
      (t) => now - t < windowMs,
    );
    return {
      limit: max,
      used: recent.length,
      remaining: Math.max(0, max - recent.length),
      resetAt: (recent.length ? recent[0] : now) + windowMs,
      windowMs,
    };
  };

  /** The snapshot as the conventional headers. */
  const setHeaders = (req, res) => {
    const { limit, remaining, resetAt } = snapshot(req);
    res.setHeader("X-RateLimit-Limit", String(limit));
    res.setHeader("X-RateLimit-Remaining", String(remaining));
    res.setHeader("X-RateLimit-Reset", String(Math.ceil(resetAt / 1000)));
  };

  /**
   * Reports the bucket without spending from it.
   *
   * Mounted ahead of the cache so every answer carries the headers, not only
   * the ones that reach the provider — a cached insight costs no quota, and a
   * meter that only moved on a miss would look stuck.
   */
  const peek = (req, res, next) => {
    setHeaders(req, res);
    next();
  };

  const middleware = async (req, res, next) => {
    // Scoped by business when auth has run, otherwise by IP — so one tenant's
    // burst never spends another tenant's budget, and unauthenticated callers
    // still share nothing wider than their own address.
    const key = keyFor(req);
    const now = Date.now();

    const seen = buckets.get(key) ?? [];
    // Prune outside the window first so the array cannot grow without bound.
    const recent = seen.filter((t) => now - t < windowMs);

    if (recent.length >= max) {
      const oldest = recent[0];
      const retryAfterSec = Math.max(1, Math.ceil((oldest + windowMs - now) / 1000));

      setHeaders(req, res);

      // A refusal costs nothing upstream, so the bucket is not charged for it
      // either — and whoever wants to answer it differently gets first refusal.
      if (onLimit && (await onLimit(req, res, retryAfterSec))) return;

      res.setHeader("Retry-After", String(retryAfterSec));
      // Both header and body: header for HTTP clients, body for the frontend
      // client, which reads the JSON error (see AiInsightsApiError.retryAfter).
      return res.status(429).json({ error, retryAfter: retryAfterSec });
    }

    recent.push(now);
    buckets.set(key, recent);
    // After charging, so the caller is told what is left rather than what was
    // left before this request.
    setHeaders(req, res);
    next();
  };

  // Hung off the middleware rather than returned beside it: the routes already
  // pass it straight to `router.post`, and this keeps that call unchanged.
  middleware.peek = peek;
  middleware.snapshot = snapshot;

  return middleware;
}

/**
 * Guard for the quota-spending route: at most 20 insight generations per
 * business per hour. Twenty is generous for a dashboard card a human reads
 * (even one refresh every 3 minutes fits) while still capping a runaway loop
 * at 20 calls before it must wait.
 */
const insightsRateLimit = (onLimit) =>
  rateLimit({
    windowMs: 60 * 60 * 1000,
    max: 20,
    error: "INSIGHTS_RATE_LIMIT",
    onLimit,
  });

/**
 * Guard for the key-verification ping: at most 10 checks per business per
 * minute. Verifying is cheap but still a live Google call, and the settings
 * form is exactly the place a double-click or impatient retry happens.
 */
const verifyRateLimit = () =>
  rateLimit({ windowMs: 60 * 1000, max: 10, error: "VERIFY_RATE_LIMIT" });

module.exports = { rateLimit, insightsRateLimit, verifyRateLimit };
