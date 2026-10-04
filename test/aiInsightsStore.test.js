const assert = require("node:assert/strict");
const { after, before, beforeEach, test } = require("node:test");
const mongoose = require("mongoose");

const { aiInsightsStore } = require("../data/aiInsightsStore");
const AIInsights = require("../models/aiInsights");
const { describePeriod } = require("../helpers/analyticsPeriods");

/**
 * The store against a real mongod — the indexes and the atomic updates are the
 * point, and neither can be exercised against a stub.
 *
 * Runs in its own database, never the development one, so a test can drop
 * everything it touched without any chance of taking real data with it.
 */

const DEV_URI = process.env.MONGODB_URI ?? "mongodb://127.0.0.1:27017/rebuzz_ai";
const TEST_URI = DEV_URI.replace(/\/([^/?]+)(\?|$)/, "/$1_store_test$2");

const PERIOD = describePeriod("month", "2026-09", new Date("2026-10-04T03:15:00Z"));
const BUSINESS = "test-business-1";

const keyFor = (section, promptVersion = "v3") => ({
  businessId: BUSINESS,
  period: PERIOD,
  section,
  promptVersion,
});

const payload = (overrides = {}) => ({
  adminId: "test-admin-1",
  periodStart: PERIOD.start,
  periodEnd: PERIOD.end,
  items: [{ id: "a", text: "Raise the momo price" }],
  extra: { windows: { from: PERIOD.from, to: PERIOD.to } },
  model: "gemini-3.6-flash",
  provider: "gemini",
  settingsModel: "gemini:gemini-3.6-flash",
  generatedAt: new Date("2026-10-04T04:00:00Z"),
  ...overrides,
});

before(async () => {
  await mongoose.connect(TEST_URI, { serverSelectionTimeoutMS: 5000 });
  // The unique index is what half of these assertions rest on, and Mongoose
  // builds indexes in the background — so wait for it rather than racing it.
  await AIInsights.init();
});

beforeEach(async () => {
  await AIInsights.deleteMany({});
});

after(async () => {
  await mongoose.connection.dropDatabase();
  await mongoose.connection.close();
});

test("a period with nothing generated reads as empty, not as an error", async () => {
  assert.deepEqual(await aiInsightsStore.readPeriod(BUSINESS, PERIOD), []);
  assert.equal(await aiInsightsStore.readSection(keyFor("pricing")), null);
});

test("store then read round-trips the answer and the period bounds", async () => {
  await aiInsightsStore.store(keyFor("pricing"), payload());

  const stored = await aiInsightsStore.readSection(keyFor("pricing"));
  assert.equal(stored.items.length, 1);
  assert.equal(stored.items[0].text, "Raise the momo price");
  assert.equal(stored.periodId, "2026-09");
  assert.equal(stored.periodStart.toISOString(), "2026-08-31T18:15:00.000Z");
  assert.equal(stored.revision, 1);
  assert.equal(stored.batches, 1);

  const out = stored.formatted();
  assert.equal(out.stored, true);
  assert.equal(out.period.id, "2026-09");
  // `extra` is spread into the reply, which is how `windows` reaches the UI.
  assert.equal(out.windows.from, "2026-09-01");
  assert.equal(out.generatedAt, "2026-10-04T04:00:00.000Z");
});

test("storing twice updates one document rather than making a second", async () => {
  await aiInsightsStore.store(keyFor("pricing"), payload());
  await aiInsightsStore.store(
    keyFor("pricing"),
    payload({ items: [{ id: "b", text: "Second attempt" }] }),
  );

  assert.equal(await AIInsights.countDocuments({}), 1);
  const stored = await aiInsightsStore.readSection(keyFor("pricing"));
  assert.equal(stored.items[0].text, "Second attempt");
  // A retry must not relabel the answer as newer than its first write.
  assert.equal(stored.generatedAt.toISOString(), "2026-10-04T04:00:00.000Z");
  assert.equal(stored.revision, 1);
});

test("the same section under a new prompt version is a different answer", async () => {
  await aiInsightsStore.store(keyFor("pricing", "v3"), payload());
  await aiInsightsStore.store(
    keyFor("pricing", "v4"),
    payload({ items: [{ id: "c", text: "Written by the new prompt" }] }),
  );

  assert.equal(await AIInsights.countDocuments({}), 2);
  assert.equal((await aiInsightsStore.readSection(keyFor("pricing", "v3"))).items[0].id, "a");
  assert.equal((await aiInsightsStore.readSection(keyFor("pricing", "v4"))).items[0].id, "c");
});

test("the unique index refuses a duplicate written behind the store's back", async () => {
  await aiInsightsStore.store(keyFor("pricing"), payload());
  await assert.rejects(
    () =>
      AIInsights.create({
        businessId: BUSINESS,
        adminId: "test-admin-1",
        periodKind: "month",
        periodId: "2026-09",
        periodStart: PERIOD.start,
        periodEnd: PERIOD.end,
        section: "pricing",
        promptVersion: "v3",
        items: [],
        generatedAt: new Date(),
      }),
    (error) => error.code === 11000,
  );
});

test("regenerate replaces the cards and counts the revision", async () => {
  await aiInsightsStore.store(keyFor("pricing"), payload());
  const again = await aiInsightsStore.replace(keyFor("pricing"), {
    items: [{ id: "x", text: "Fresh advice" }],
    extra: { windows: { from: PERIOD.from, to: PERIOD.to } },
    model: "gemini-3.6-flash",
    provider: "gemini",
    settingsModel: "gemini:gemini-3.6-flash",
    generatedAt: new Date("2026-10-05T04:00:00Z"),
  });

  assert.equal(again.items.length, 1);
  assert.equal(again.items[0].id, "x");
  assert.equal(again.revision, 2);
  assert.equal(again.lastRegeneratedAt.toISOString(), "2026-10-05T04:00:00.000Z");
  // The first answer's timestamp is still what it was: this is a new answer to
  // the same question, not a claim that the original was written later.
  assert.equal(again.generatedAt.toISOString(), "2026-10-04T04:00:00.000Z");
  // Batches reset: the new answer is whole, so old extra cards are not kept.
  assert.equal(again.batches, 1);
});

test("regenerating something that was never stored reports a miss", async () => {
  const missing = await aiInsightsStore.replace(keyFor("pricing"), {
    items: [],
    extra: null,
    model: null,
    provider: null,
    settingsModel: null,
    generatedAt: new Date(),
  });
  assert.equal(missing, null);
});

test("generate more appends without losing a batch to a race", async () => {
  await aiInsightsStore.store(keyFor("menu-suggestions"), payload());

  // Both at once, as two tabs would: a read-merge-write store would keep only
  // one of these.
  await Promise.all([
    aiInsightsStore.appendItems(keyFor("menu-suggestions"), {
      items: [{ id: "m1" }, { id: "m2" }],
      model: "gemini-3.6-flash",
      generatedAt: new Date("2026-10-04T05:00:00Z"),
    }),
    aiInsightsStore.appendItems(keyFor("menu-suggestions"), {
      items: [{ id: "m3" }],
      model: "gemini-3.6-flash",
      generatedAt: new Date("2026-10-04T05:00:01Z"),
    }),
  ]);

  const stored = await aiInsightsStore.readSection(keyFor("menu-suggestions"));
  assert.equal(stored.items.length, 4, "the first card plus all three appended");
  assert.equal(stored.batches, 3);
  assert.deepEqual(
    stored.items.map((i) => i.id).sort(),
    ["a", "m1", "m2", "m3"],
  );
});

test("noMore is recorded so the button can stop offering a paid no-op", async () => {
  await aiInsightsStore.store(keyFor("menu-suggestions"), payload());
  const after_ = await aiInsightsStore.appendItems(keyFor("menu-suggestions"), {
    items: [],
    model: "gemini-3.6-flash",
    generatedAt: new Date(),
    noMore: true,
  });
  assert.equal(after_.noMore, true);
});

test("readPeriod returns every section for the period, and only that period", async () => {
  await aiInsightsStore.store(keyFor("pricing"), payload());
  await aiInsightsStore.store(keyFor("slow-items"), payload());
  // A different period, and a different business, must not come back.
  const august = describePeriod("month", "2026-08", new Date("2026-10-04T03:15:00Z"));
  await aiInsightsStore.store(
    { businessId: BUSINESS, period: august, section: "pricing", promptVersion: "v3" },
    payload({ periodStart: august.start, periodEnd: august.end }),
  );
  await aiInsightsStore.store(
    { businessId: "other-business", period: PERIOD, section: "pricing", promptVersion: "v3" },
    payload(),
  );

  const sections = await aiInsightsStore.readPeriod(BUSINESS, PERIOD);
  assert.deepEqual(
    sections.map((s) => s.section),
    ["pricing", "slow-items"],
  );
});

test("listPeriods names the periods that are ready, newest first", async () => {
  const august = describePeriod("month", "2026-08", new Date("2026-10-04T03:15:00Z"));
  await aiInsightsStore.store(keyFor("pricing"), payload());
  await aiInsightsStore.store(keyFor("slow-items"), payload());
  await aiInsightsStore.store(
    { businessId: BUSINESS, period: august, section: "pricing", promptVersion: "v3" },
    payload({ periodStart: august.start, periodEnd: august.end }),
  );

  const periods = await aiInsightsStore.listPeriods(BUSINESS, "month");
  assert.deepEqual(
    periods.map((p) => p.id),
    ["2026-09", "2026-08"],
  );
  assert.equal(periods[0].sectionCount, 2);
  assert.equal(periods[1].sectionCount, 1);
});
