/**
 * The insight sections this service knows about, and how each one is scoped.
 *
 * The service used to know nothing about sections: the caller composed a cache
 * key like `pricing:v3:2026-10-04` and the key was the whole contract. That
 * cannot survive periods — a section name is now part of a stored document's
 * identity, so an unchecked one would let a caller create unlimited distinct
 * documents, each of them a paid generation.
 *
 * So the names live here, and a request naming anything else is refused.
 */

/**
 * `period`  — describes a completed period, stored for good.
 * `current` — describes now, and keeps the old 26-hour cache.
 *
 * `festival-prep` is the one `current` section, and the reason the distinction
 * exists at all: it advises on *upcoming* festivals, so "what you should have
 * prepared for Dashain last September" is useless to anybody. It stays on the
 * day-scoped path, which is also why the period selector will not apply to it.
 */
const SECTIONS = {
  pricing: { scope: "period" },
  "slow-items": { scope: "period" },
  "menu-suggestions": { scope: "period", supportsMore: true },
  "sales-recommendations": { scope: "period", supportsMore: true },
  retention: { scope: "period" },
  "hour-playbook": { scope: "period" },
  staffing: { scope: "period" },
  "festival-prep": { scope: "current" },
};

const SECTION_NAMES = Object.keys(SECTIONS);

/** The ones the AI Insights page generates per period. */
const PERIOD_SECTIONS = SECTION_NAMES.filter(
  (name) => SECTIONS[name].scope === "period",
);

const isSectionName = (value) =>
  typeof value === "string" && Object.hasOwn(SECTIONS, value);

/** Whether this section may be asked for a further batch of cards. */
const supportsMore = (name) => Boolean(SECTIONS[name]?.supportsMore);

/** Whether this section is stored per period rather than per day. */
const isPeriodSection = (name) => SECTIONS[name]?.scope === "period";

/**
 * A prompt version as it may appear in a stored document's key.
 *
 * Deliberately narrow: it is part of a database key, and the versions the
 * frontend actually sends are `v1`…`v9`. Anything else is a caller mistake or an
 * attempt to fan out storage.
 */
const PROMPT_VERSION_PATTERN = /^v\d{1,3}$/;

const isPromptVersion = (value) =>
  typeof value === "string" && PROMPT_VERSION_PATTERN.test(value);

module.exports = {
  SECTIONS,
  SECTION_NAMES,
  PERIOD_SECTIONS,
  isSectionName,
  isPeriodSection,
  supportsMore,
  isPromptVersion,
};
