/**
 * Only the business's admin may spend money.
 *
 * Generating insights costs the merchant real provider quota, so it is not
 * something any logged-in staff member should be able to set off. Reading stored
 * insights stays open to everyone — that costs nothing.
 *
 * Mounted after `requireBusiness`, which is what establishes both sides of the
 * comparison: `adminId` from the POS's answer about the business, and `userId`
 * from the token the POS just accepted.
 *
 * Fails closed. An unidentified caller — a token with no subject, or a POS reply
 * without an admin — is refused rather than assumed to be the admin.
 */
const requireAdmin = (req, res, next) => {
  if (!req.userId || !req.adminId || req.userId !== req.adminId) {
    // 403, not 401: the caller is authenticated, just not allowed. A 401 would
    // send the frontend to the login screen, which would not help.
    return res.status(403).json({ error: "ADMIN_ONLY" });
  }
  next();
};

module.exports = requireAdmin;
