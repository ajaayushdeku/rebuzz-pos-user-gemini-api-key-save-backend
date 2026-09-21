const POS_API_URL = process.env.POS_API_URL;

/**
 * Establishes which business is calling.
 *
 * This service does not issue the session token, so it cannot verify one on
 * its own: it forwards the token to the POS API and takes the business id
 * from the answer. The id therefore always originates from a verified token
 * and never from the request body — a client-supplied id would let any
 * authenticated business read and spend another's key.
 */
export default async function requireBusiness(req, res, next) {
  const header = req.get("authorization") ?? "";
  const token = header.startsWith("Bearer ") ? header.slice(7).trim() : "";

  if (!token) {
    return res.status(401).json({ error: "AUTH_REQUIRED" });
  }

  let upstream;
  try {
    upstream = await fetch(`${POS_API_URL}/business/aboutBusiness`, {
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
      },
      // Without a timeout, a slow POS API stalls every request that lands here.
      signal: AbortSignal.timeout(8000),
    });
  } catch {
    return res.status(502).json({ error: "AUTH_UPSTREAM_UNAVAILABLE" });
  }

  if (upstream.status === 401 || upstream.status === 403) {
    return res.status(401).json({ error: "AUTH_INVALID" });
  }

  // Any other non-OK response is their outage, not the caller's mistake — 502
  // rather than 401, so a POS failure does not read as a bad login.
  if (!upstream.ok) {
    return res.status(502).json({ error: "AUTH_UPSTREAM_UNAVAILABLE" });
  }

  const json = await upstream.json().catch(() => null);

  // Shape confirmed against the POS API: { data: { business: { _id, ... } } }.
  // `_id` is the tenant, not `adminId` — one admin can hold several
  // businesses, and scoping by the admin would pool their keys together.
  const businessId = json?.data?.business?._id ?? null;

  if (!businessId) {
    return res.status(502).json({ error: "AUTH_UPSTREAM_SHAPE" });
  }

  req.businessId = String(businessId);
  // Kept for the insights route, which reads POS analytics as this user.
  req.posToken = token;
  next();
}
