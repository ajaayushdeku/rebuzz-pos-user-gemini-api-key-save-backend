/**
 * The analytics periods AI insights are generated for.
 *
 * Insights used to describe "today", keyed by the date the caller happened to
 * send. They now describe a *completed* period — by default last month — which
 * changes one thing fundamentally: a closed period's figures never change
 * again, so its insight is permanently valid and worth storing rather than
 * expiring. Everything in `models/aiInsights.js` follows from that.
 *
 * Every period lives in this registry and nowhere else. Adding one is an entry
 * in `KINDS` below; no route, controller or model learns about it. That is the
 * whole point of the file — "support more periods later" must not mean touching
 * the request path again.
 *
 * ── Why calendar quarters, not "the last four months" ─────────────────────────
 * A trailing window moves every day, so it has no stable id, nothing can be
 * stored under it, and two visitors an hour apart analyse different data. A
 * calendar quarter is a closed, nameable thing: `2026-Q3` means Jul–Sep for
 * everybody, forever. If a trailing window is wanted as well, it belongs here
 * as its OWN kind (`trailing4m`) rather than as a redefinition of `quarter`, so
 * the two can coexist and neither invalidates what the other stored.
 */

/**
 * Nepal is UTC+5:45 — the 45 is why a whole-hour shortcut does not work.
 *
 * The same constant and the same shift-then-read-UTC-parts rule as
 * `rebuzz-pos/lib/nepalDate.ts`. It has to be the same: the POS stores a plain
 * date as the instant that date begins in Nepal, so a period boundary computed
 * in UTC would include 5¾ hours of the neighbouring month's sales and exclude
 * 5¾ hours of its own. Nepal has no DST, which is what makes a fixed offset
 * correct here rather than merely convenient.
 */
const NEPAL_OFFSET_MS = (5 * 60 + 45) * 60 * 1000;

/** The Nepal calendar parts of an instant: 1-based month, as people write it. */
function nepalParts(instant) {
  const shifted = new Date(instant.getTime() + NEPAL_OFFSET_MS);
  return {
    year: shifted.getUTCFullYear(),
    month: shifted.getUTCMonth() + 1,
    day: shifted.getUTCDate(),
  };
}

/** The instant a Nepal calendar day begins, which is what the POS stores. */
function nepalMidnight(year, month, day) {
  return new Date(Date.UTC(year, month - 1, day) - NEPAL_OFFSET_MS);
}

/** A Nepal calendar day as `YYYY-MM-DD`, the form report endpoints take. */
function nepalDateString(instant) {
  return new Date(instant.getTime() + NEPAL_OFFSET_MS).toISOString().slice(0, 10);
}

const pad2 = (n) => String(n).padStart(2, "0");

/**
 * One kind of period.
 *
 * `idFor` names the period an instant falls in. `bounds` turns an id back into
 * Nepal calendar parts — start inclusive, end exclusive, because an exclusive
 * end is the only form that cannot double-count the boundary instant. `step`
 * moves back whole periods, which is how "the previous completed one" is found
 * without any month-length arithmetic at the call site.
 */
const KINDS = {
  month: {
    label: "Monthly",
    idFor: ({ year, month }) => `${year}-${pad2(month)}`,
    bounds: (id) => {
      const match = /^(\d{4})-(0[1-9]|1[0-2])$/.exec(id);
      if (!match) return null;
      const year = Number(match[1]);
      const month = Number(match[2]);
      return { start: [year, month, 1], endExclusive: [year, month + 1, 1] };
    },
    step: ({ year, month }, by) => {
      // Month arithmetic through a zero-based index, so December + 1 rolls the
      // year rather than producing month 13.
      const index = year * 12 + (month - 1) + by;
      return { year: Math.floor(index / 12), month: (index % 12) + 1, day: 1 };
    },
    describe: (id) => {
      const [year, month] = id.split("-").map(Number);
      return `${MONTH_NAMES[month - 1]} ${year}`;
    },
  },

  quarter: {
    label: "Quarterly",
    idFor: ({ year, month }) => `${year}-Q${Math.floor((month - 1) / 3) + 1}`,
    bounds: (id) => {
      const match = /^(\d{4})-Q([1-4])$/.exec(id);
      if (!match) return null;
      const year = Number(match[1]);
      const quarter = Number(match[2]);
      const firstMonth = (quarter - 1) * 3 + 1;
      return {
        start: [year, firstMonth, 1],
        endExclusive: [year, firstMonth + 3, 1],
      };
    },
    step: ({ year, month }, by) => {
      const quarterIndex = year * 4 + Math.floor((month - 1) / 3) + by;
      return {
        year: Math.floor(quarterIndex / 4),
        month: (quarterIndex % 4) * 3 + 1,
        day: 1,
      };
    },
    describe: (id) => {
      const [year, quarter] = id.split("-Q");
      const first = (Number(quarter) - 1) * 3;
      return `${MONTH_NAMES[first].slice(0, 3)}–${MONTH_NAMES[first + 2].slice(0, 3)} ${year}`;
    },
  },

  year: {
    label: "Yearly",
    idFor: ({ year }) => String(year),
    bounds: (id) => {
      const match = /^(\d{4})$/.exec(id);
      if (!match) return null;
      const year = Number(match[1]);
      return { start: [year, 1, 1], endExclusive: [year + 1, 1, 1] };
    },
    step: ({ year }, by) => ({ year: year + by, month: 1, day: 1 }),
    describe: (id) => id,
  },
};

const MONTH_NAMES = [
  "January",
  "February",
  "March",
  "April",
  "May",
  "June",
  "July",
  "August",
  "September",
  "October",
  "November",
  "December",
];

/** The kinds a request may name. */
const PERIOD_KINDS = Object.keys(KINDS);

/** The one a page shows when the caller asks for nothing in particular. */
const DEFAULT_PERIOD_KIND = "month";

const isPeriodKind = (value) =>
  typeof value === "string" && Object.hasOwn(KINDS, value);

/**
 * A period as everything downstream needs it, or null if the id is not one this
 * registry can produce.
 *
 * Null rather than a throw, and validated rather than parsed loosely, because
 * the id arrives from a request and ends up in a database key: an unchecked one
 * would let a caller mint unlimited distinct periods, and every one of them is a
 * paid AI generation.
 *
 * `from`/`to` are inclusive Nepal calendar dates, the form the POS report
 * endpoints take. `end` is the last instant of the period, for display; queries
 * should use `start <= t < endExclusive`.
 */
function describePeriod(kind, id, now = new Date(), { withPrevious = true } = {}) {
  if (!isPeriodKind(kind)) return null;

  const bounds = KINDS[kind].bounds(String(id ?? ""));
  if (!bounds) return null;

  const start = nepalMidnight(...bounds.start);
  const endExclusive = nepalMidnight(...bounds.endExclusive);

  /**
   * The period before this one, of the same kind.
   *
   * Every section compares a period against what came before it — "momo sales
   * up 12%" needs a baseline — and the baseline has to be the same shape: the
   * month before a month, the quarter before a quarter. Calculated here rather
   * than by the caller, so there is one calendar and the comparison can never
   * be against a window of a different length.
   *
   * `withPrevious: false` stops the recursion; nothing needs the previous
   * period's previous period.
   */
  const previous = withPrevious
    ? (() => {
        const [year, month] = bounds.start;
        const stepped = KINDS[kind].step({ year, month }, -1);
        return describePeriod(kind, KINDS[kind].idFor(stepped), now, {
          withPrevious: false,
        });
      })()
    : null;

  return {
    kind,
    id: String(id),
    label: KINDS[kind].describe(String(id)),
    start,
    endExclusive,
    end: new Date(endExclusive.getTime() - 1),
    from: nepalDateString(start),
    to: nepalDateString(new Date(endExclusive.getTime() - 1)),
    ...(previous
      ? { previous: { id: previous.id, from: previous.from, to: previous.to } }
      : {}),
    /**
     * Whether the period is over in Nepal.
     *
     * Only a closed period is worth storing permanently: an open one's figures
     * are still moving, so an insight about it goes stale by the hour. The
     * routes use this to decide whether an answer may be kept.
     */
    closed: endExclusive.getTime() <= now.getTime(),
  };
}

/**
 * The most recent period of this kind that has finished — the default to show.
 *
 * On 4 October 2026 the monthly answer is September 2026, and it stays
 * September for the whole of October. Derived by stepping back from the period
 * containing `now`, so it is correct on the 1st at 00:01 Nepal time, which is
 * the moment a naive "last 30 days" gets it wrong.
 */
function previousClosedPeriod(kind = DEFAULT_PERIOD_KIND, now = new Date()) {
  if (!isPeriodKind(kind)) return null;
  const previous = KINDS[kind].step(nepalParts(now), -1);
  return describePeriod(kind, KINDS[kind].idFor(previous), now);
}

/**
 * The last `count` closed periods, newest first — for a period picker.
 *
 * Nothing here knows which of them have insights stored; that is the store's
 * question, and keeping it separate means the list can be offered before any
 * insight exists.
 */
function recentClosedPeriods(kind = DEFAULT_PERIOD_KIND, count = 12, now = new Date()) {
  if (!isPeriodKind(kind)) return [];
  const parts = nepalParts(now);
  const periods = [];
  for (let back = 1; back <= count; back += 1) {
    const stepped = KINDS[kind].step(parts, -back);
    periods.push(describePeriod(kind, KINDS[kind].idFor(stepped), now));
  }
  return periods;
}

/** What the period selector needs: the kinds, named. */
const periodCatalogue = () =>
  PERIOD_KINDS.map((kind) => ({ kind, label: KINDS[kind].label }));

module.exports = {
  NEPAL_OFFSET_MS,
  PERIOD_KINDS,
  DEFAULT_PERIOD_KIND,
  isPeriodKind,
  describePeriod,
  previousClosedPeriod,
  recentClosedPeriods,
  periodCatalogue,
  // Exported for the model and for tests; nothing else should be doing date
  // arithmetic by hand.
  nepalParts,
  nepalMidnight,
  nepalDateString,
};
