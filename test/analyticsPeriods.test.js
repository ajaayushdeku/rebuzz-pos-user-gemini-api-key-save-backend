const assert = require("node:assert/strict");
const { test } = require("node:test");

const {
  describePeriod,
  previousClosedPeriod,
  recentClosedPeriods,
  isPeriodKind,
  nepalParts,
} = require("../helpers/analyticsPeriods");

/**
 * Period boundaries, against frozen instants.
 *
 * Every case here is a date, which is exactly the kind of logic that looks
 * obviously right and is off by one in production. The +05:45 offset makes it
 * worse than most: in the 5¾ hours after 18:15 UTC, Nepal is already on the next
 * calendar day, so a naive UTC month boundary misfiles that window of sales.
 */

/** 4 October 2026, 09:00 Nepal — the example from the brief. */
const OCT_4 = new Date("2026-10-04T03:15:00.000Z");

test("September 2026 spans the Nepal month, not the UTC one", () => {
  const period = describePeriod("month", "2026-09", OCT_4);

  // Nepal midnight on 1 September is 18:15 UTC on 31 August.
  assert.equal(period.start.toISOString(), "2026-08-31T18:15:00.000Z");
  assert.equal(period.endExclusive.toISOString(), "2026-09-30T18:15:00.000Z");
  // The inclusive dates a report endpoint is asked for.
  assert.equal(period.from, "2026-09-01");
  assert.equal(period.to, "2026-09-30");
  assert.equal(period.label, "September 2026");
  assert.equal(period.closed, true);
});

test("on 4 October the default monthly period is September", () => {
  const period = previousClosedPeriod("month", OCT_4);
  assert.equal(period.id, "2026-09");
  assert.equal(period.from, "2026-09-01");
  assert.equal(period.to, "2026-09-30");
});

test("the default holds all month, not just at the start", () => {
  for (const day of ["2026-10-01", "2026-10-17", "2026-10-31"]) {
    const at = new Date(`${day}T06:00:00.000Z`);
    assert.equal(previousClosedPeriod("month", at).id, "2026-09", day);
  }
});

test("the 5:45 window: 18:20 UTC on 30 September is already October in Nepal", () => {
  // Before Nepal midnight — still September, so August is last month.
  const before = new Date("2026-09-30T18:10:00.000Z");
  assert.equal(nepalParts(before).month, 9);
  assert.equal(previousClosedPeriod("month", before).id, "2026-08");

  // Ten minutes later it is 1 October in Nepal, and September has closed.
  const after = new Date("2026-09-30T18:20:00.000Z");
  assert.equal(nepalParts(after).month, 10);
  assert.equal(previousClosedPeriod("month", after).id, "2026-09");
});

test("an unfinished period is not closed", () => {
  assert.equal(describePeriod("month", "2026-10", OCT_4).closed, false);
  assert.equal(describePeriod("month", "2026-09", OCT_4).closed, true);
  // The boundary instant itself: September closes the moment October begins.
  const atMidnight = new Date("2026-09-30T18:15:00.000Z");
  assert.equal(describePeriod("month", "2026-09", atMidnight).closed, true);
});

test("December rolls the year rather than becoming month 13", () => {
  const jan2 = new Date("2027-01-02T06:00:00.000Z");
  const period = previousClosedPeriod("month", jan2);
  assert.equal(period.id, "2026-12");
  assert.equal(period.from, "2026-12-01");
  assert.equal(period.to, "2026-12-31");
});

test("February takes its own length, leap year included", () => {
  assert.equal(describePeriod("month", "2026-02", OCT_4).to, "2026-02-28");
  assert.equal(
    describePeriod("month", "2028-02", new Date("2028-04-01T06:00:00.000Z")).to,
    "2028-02-29",
  );
});

test("quarters are calendar quarters", () => {
  const q3 = describePeriod("quarter", "2026-Q3", OCT_4);
  assert.equal(q3.from, "2026-07-01");
  assert.equal(q3.to, "2026-09-30");
  assert.equal(q3.closed, true);

  // On 4 October, Q4 has only just started, so the default is Q3.
  assert.equal(previousClosedPeriod("quarter", OCT_4).id, "2026-Q3");
  assert.equal(describePeriod("quarter", "2026-Q4", OCT_4).closed, false);
});

test("quarters step back across a year boundary", () => {
  const jan = new Date("2027-01-15T06:00:00.000Z");
  assert.equal(previousClosedPeriod("quarter", jan).id, "2026-Q4");
  assert.equal(describePeriod("quarter", "2026-Q4", jan).from, "2026-10-01");
  assert.equal(describePeriod("quarter", "2026-Q4", jan).to, "2026-12-31");
});

test("the yearly period is the previous completed year", () => {
  const period = previousClosedPeriod("year", OCT_4);
  assert.equal(period.id, "2025");
  assert.equal(period.from, "2025-01-01");
  assert.equal(period.to, "2025-12-31");
  assert.equal(describePeriod("year", "2026", OCT_4).closed, false);
});

test("ids that could not have been produced here are refused", () => {
  for (const bad of [
    "2026-13",
    "2026-00",
    "2026-9",
    "26-09",
    "2026-09-01",
    "2026-Q5",
    "2026-Q0",
    "../../etc/passwd",
    "",
    null,
    undefined,
    "$ne",
  ]) {
    assert.equal(describePeriod("month", bad, OCT_4), null, `month ${bad}`);
  }
  assert.equal(describePeriod("quarter", "2026-Q5", OCT_4), null);
  assert.equal(describePeriod("year", "20267", OCT_4), null);
  // An unknown kind cannot smuggle itself through either.
  assert.equal(describePeriod("fortnight", "2026-09", OCT_4), null);
  assert.equal(isPeriodKind("fortnight"), false);
});

test("the picker lists closed periods, newest first", () => {
  const periods = recentClosedPeriods("month", 3, OCT_4);
  assert.deepEqual(
    periods.map((p) => p.id),
    ["2026-09", "2026-08", "2026-07"],
  );
  assert.ok(periods.every((p) => p.closed));
});
