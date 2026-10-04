const assert = require("node:assert/strict");
const { after, before, beforeEach, test } = require("node:test");
const mongoose = require("mongoose");

const {
  periodInsightsController: controller,
} = require("../controller/periodInsightsController");
const { aiInsightsStore } = require("../data/aiInsightsStore");
const AIInsights = require("../models/aiInsights");
const AISettings = require("../models/aiSettings");
const AIInsightCache = require("../models/aiInsightCache");
const { encrypt } = require("../helpers/aiCrypto");
const { PROVIDERS } = require("../helpers/aiProviders");
const { previousClosedPeriod } = require("../helpers/analyticsPeriods");
const requireAdmin = require("../middlewares/requireAdmin");

/**
 * The period insights request path, end to end except for HTTP and the POS.
 *
 * The handlers are called directly with a fake request and response: there is no
 * server to start, no token to borrow and no provider to pay. The provider is
 * replaced by a stub whose calls are counted, which is how "a stored answer is
 * not generated again" can be asserted rather than hoped for.
 */

const DEV_URI = process.env.MONGODB_URI ?? "mongodb://127.0.0.1:27017/rebuzz_ai";
const TEST_URI = DEV_URI.replace(/\/([^/?]+)(\?|$)/, "/$1_period_test$2");

const BUSINESS = "test-business-period";
const ADMIN = "test-admin-period";
const PERIOD = previousClosedPeriod("month", new Date("2026-10-04T03:15:00Z"));

/** Replaces the real Gemini call. Scriptable, and it counts its calls. */
const stub = {
  calls: 0,
  reply: null,
  reset(reply) {
    stub.calls = 0;
    stub.reply = reply ?? {
      ok: true,
      text: JSON.stringify({ items: [{ id: "1", text: "Sell more momos" }], windows: { weeks: 4 } }),
      model: "stub-model-1",
      usage: { totalTokens: 10 },
    };
  },
};

let realGenerate;

const fakeRes = () => {
  const res = { statusCode: 200, body: null, headersSent: false };
  res.status = (code) => {
    res.statusCode = code;
    return res;
  };
  res.json = (body) => {
    res.body = body;
    res.headersSent = true;
    return res;
  };
  res.setHeader = () => res;
  return res;
};

const makeReq = (overrides = {}) => ({
  businessId: BUSINESS,
  adminId: ADMIN,
  userId: ADMIN,
  params: { kind: "month", id: PERIOD.id },
  query: {},
  body: {},
  ...overrides,
});

/** Run a handler chain the way Express would, stopping at the first reply. */
const run = async (handlers, req) => {
  const res = fakeRes();
  for (const handler of handlers) {
    let advanced = false;
    await handler(req, res, () => {
      advanced = true;
    });
    if (res.body !== null || !advanced) break;
  }
  return res;
};

/** The usual successful POST body for one section. */
const body = (extra = {}) => ({
  promptVersion: "v3",
  briefing: "September: 1,240 orders, Rs 310,000 revenue.",
  systemInstruction: "You advise a restaurant owner.",
  responseSchema: { type: "object" },
  basis: { orders: 1240, revenue: 310000 },
  ...extra,
});

const draftChain = [controller.resolvePeriod, controller.prepareDraft, controller.draft];
const saveChain = [controller.resolvePeriod, controller.save];

/**
 * What a section route does: draft, join, store.
 *
 * The join is the frontend's work — the model's advice is keyed by an anonymised
 * reference and the card's figures come from the period's own data — so here it
 * stands in for that by passing the drafted items straight through. Everything
 * else is exactly the sequence the real caller performs, which is why the
 * assertions below still read as one action.
 */
const generate = async (req) => {
  // A period with no sales never reaches a provider: there is nothing to ask.
  if (req.body?.empty) {
    const saved = await run(saveChain, { ...req });
    if (saved.body?.data) saved.body.data.spent = false;
    return saved;
  }

  const drafted = await run(draftChain, { ...req });
  if (!drafted.body?.data) return drafted;

  const { answer, model, provider, settingsModel, spent } = drafted.body.data;
  const saved = await run(saveChain, {
    ...req,
    body: {
      ...req.body,
      items: Array.isArray(answer?.items) ? answer.items : [],
      extra: answer && !Array.isArray(answer) ? { windows: answer.windows } : null,
      model,
      provider,
      settingsModel,
    },
  });

  // Carried through so a caller can still tell whether this cost anything.
  if (saved.body?.data) saved.body.data.spent = spent;
  return saved;
};

before(async () => {
  await mongoose.connect(TEST_URI, { serverSelectionTimeoutMS: 5000 });
  await AIInsights.init();

  realGenerate = PROVIDERS.gemini.generateInsights;
  PROVIDERS.gemini.generateInsights = async () => {
    stub.calls += 1;
    // A real provider takes time; a tick here is enough for the in-flight lock
    // test to have two callers overlap.
    await new Promise((resolve) => setTimeout(resolve, 15));
    return stub.reply;
  };

  await AISettings.create({
    businessId: BUSINESS,
    adminId: ADMIN,
    provider: "gemini",
    gemini: {
      enabled: true,
      model: "gemini-3.6-flash",
      apiKey: encrypt("stub-api-key-value"),
      maskedKey: "stub••••key",
      lastVerifiedAt: new Date(),
    },
  });
});

beforeEach(async () => {
  await AIInsights.deleteMany({});
  // The drafts too: a paid answer is cached for a day so the save half can be
  // retried for free, which means a leftover draft would answer the next test
  // and the provider would never be reached. Found exactly that way.
  await AIInsightCache.deleteMany({});
  stub.reset();
});

after(async () => {
  PROVIDERS.gemini.generateInsights = realGenerate;
  await mongoose.connection.dropDatabase();
  await mongoose.connection.close();
});

// ── Period resolution ────────────────────────────────────────────────────────

test("latest resolves to the previous completed period", async () => {
  const req = makeReq({ params: { kind: "month", id: "latest" } });
  await run([controller.resolvePeriod, controller.readPeriod], req);
  assert.equal(req.period.id, previousClosedPeriod("month").id);
});

test("a period that has not finished is refused", async () => {
  const open = new Date().toISOString().slice(0, 7);
  const res = await run(
    [controller.resolvePeriod],
    makeReq({ params: { kind: "month", id: open } }),
  );
  assert.equal(res.statusCode, 400);
  assert.equal(res.body.error, "PERIOD_NOT_CLOSED");
});

test("junk periods and unknown kinds are refused", async () => {
  for (const [params, code] of [
    [{ kind: "fortnight", id: "2026-09" }, "INVALID_PERIOD_KIND"],
    [{ kind: "month", id: "2026-13" }, "INVALID_PERIOD"],
    [{ kind: "month", id: "../../etc" }, "INVALID_PERIOD"],
  ]) {
    const res = await run([controller.resolvePeriod], makeReq({ params }));
    assert.equal(res.statusCode, 400);
    assert.equal(res.body.error, code, JSON.stringify(params));
  }
});

// ── Who may spend ────────────────────────────────────────────────────────────

test("a staff member may read but not generate", async () => {
  const staff = makeReq({ userId: "some-other-user" });
  const denied = await run([requireAdmin], staff);
  assert.equal(denied.statusCode, 403);
  assert.equal(denied.body.error, "ADMIN_ONLY");

  // The same user reading is fine.
  const read = await run([controller.resolvePeriod, controller.readPeriod], staff);
  assert.equal(read.statusCode, 200);
});

test("an unidentified caller is not treated as the admin", async () => {
  const res = await run([requireAdmin], makeReq({ userId: null }));
  assert.equal(res.statusCode, 403);
});

// ── Validation before anything is spent ──────────────────────────────────────

test("requests that could not succeed are refused without a provider call", async () => {
  const cases = [
    [{ section: "nonsense" }, body(), "INVALID_SECTION"],
    // Period-scoped only: festival-prep is forward-looking and stays on the
    // day-scoped route.
    [{ section: "festival-prep" }, body(), "INVALID_SECTION"],
    [{ section: "pricing" }, body({ promptVersion: "latest" }), "INVALID_PROMPT_VERSION"],
    [{ section: "pricing" }, body({ promptVersion: undefined }), "INVALID_PROMPT_VERSION"],
    [{ section: "pricing" }, body({ briefing: "" }), "BRIEFING_REQUIRED"],
    [{ section: "pricing" }, body({ responseSchema: null }), "SCHEMA_REQUIRED"],
    [{ section: "pricing" }, body({ mode: "sideways" }), "INVALID_MODE"],
    [{ section: "pricing" }, body({ briefing: "x".repeat(16_001) }), "BRIEFING_TOO_LONG"],
    // `more` is only offered where the model can keep finding new cards.
    [{ section: "pricing" }, body({ mode: "more" }), "MORE_NOT_SUPPORTED"],
  ];

  for (const [params, requestBody, code] of cases) {
    const res = await generate(
      makeReq({ params: { kind: "month", id: PERIOD.id, ...params }, body: requestBody }),
    );
    assert.equal(res.body.error, code, `${params.section}: ${JSON.stringify(requestBody).slice(0, 60)}`);
  }
  assert.equal(stub.calls, 0, "nothing should have reached the provider");
});

test("a business with no key is told so rather than failing later", async () => {
  const res = await generate(
    makeReq({
      businessId: "business-with-no-key",
      params: { kind: "month", id: PERIOD.id, section: "pricing" },
      body: body(),
    }),
  );
  assert.equal(res.statusCode, 424);
  assert.equal(res.body.error, "NOT_CONFIGURED");
  assert.equal(stub.calls, 0);
});

// ── ensure ───────────────────────────────────────────────────────────────────

test("ensure generates once, then never again", async () => {
  const first = await generate(
    makeReq({ params: { kind: "month", id: PERIOD.id, section: "pricing" }, body: body() }),
  );
  assert.equal(first.statusCode, 200);
  assert.equal(first.body.data.items.length, 1);
  assert.equal(first.body.data.spent, true);
  assert.equal(first.body.data.stored, true);
  assert.equal(first.body.data.basis.orders, 1240);
  // `extra` from the answer is spread into the reply.
  assert.deepEqual(first.body.data.windows, { weeks: 4 });
  assert.equal(stub.calls, 1);

  const second = await generate(
    makeReq({ params: { kind: "month", id: PERIOD.id, section: "pricing" }, body: body() }),
  );
  assert.equal(second.body.data.spent, false);
  assert.equal(second.body.data.revision, 1);
  assert.equal(stub.calls, 1, "the stored answer must not be generated again");
});

test("two simultaneous requests pay once and both get the answer", async () => {
  const request = () =>
    generate(
      makeReq({ params: { kind: "month", id: PERIOD.id, section: "pricing" }, body: body() }),
    );

  const [a, b] = await Promise.all([request(), request()]);

  assert.equal(stub.calls, 1, "the in-flight lock should have joined the second");
  assert.equal(a.statusCode, 200);
  assert.equal(b.statusCode, 200);
  // One of them joined the other's work, so only one call was paid for.
  assert.deepEqual([a.body.data.spent, b.body.data.spent].sort(), [false, true]);
  assert.equal(await AIInsights.countDocuments({}), 1);
});

// ── regenerate and more ──────────────────────────────────────────────────────

test("regenerate replaces the answer and counts the revision", async () => {
  const params = { kind: "month", id: PERIOD.id, section: "pricing" };
  await generate(makeReq({ params, body: body() }));

  stub.reply = {
    ok: true,
    text: JSON.stringify({ items: [{ id: "9", text: "Different advice" }] }),
    model: "stub-model-2",
    usage: null,
  };

  const again = await generate(makeReq({ params, body: body({ mode: "regenerate" }) }));
  assert.equal(again.body.data.items.length, 1);
  assert.equal(again.body.data.items[0].id, "9");
  assert.equal(again.body.data.revision, 2);
  assert.equal(stub.calls, 2);
  assert.equal(await AIInsights.countDocuments({}), 1);
});

test("more appends, skips cards already shown, and stops when nothing is new", async () => {
  const params = { kind: "month", id: PERIOD.id, section: "menu-suggestions" };
  await generate(makeReq({ params, body: body() }));

  // A batch holding one new card and one already on screen.
  stub.reply = {
    ok: true,
    text: JSON.stringify({ items: [{ id: "1", text: "Sell more momos" }, { id: "2", text: "Add a thali" }] }),
    model: "stub-model-1",
    usage: null,
  };
  const more = await generate(makeReq({ params, body: body({ mode: "more" }) }));
  assert.deepEqual(more.body.data.items.map((i) => i.id), ["1", "2"], "the duplicate is dropped");
  assert.equal(more.body.data.batches, 2);
  assert.equal(more.body.data.noMore, false);

  // A batch with nothing new in it at all.
  stub.reply = {
    ok: true,
    text: JSON.stringify({ items: [{ id: "1" }, { id: "2" }] }),
    model: "stub-model-1",
    usage: null,
  };
  const exhausted = await generate(makeReq({ params, body: body({ mode: "more" }) }));
  assert.equal(exhausted.body.data.noMore, true);
  assert.equal(exhausted.body.data.items.length, 2);

  // And once it has said so, asking again is refused rather than paid for.
  const refused = await generate(makeReq({ params, body: body({ mode: "more" }) }));
  assert.equal(refused.statusCode, 409);
  assert.equal(refused.body.error, "NO_MORE_AVAILABLE");
});

test("more on a section that was never generated has nothing to extend", async () => {
  const res = await generate(
    makeReq({
      params: { kind: "month", id: PERIOD.id, section: "menu-suggestions" },
      body: body({ mode: "more" }),
    }),
  );
  assert.equal(res.statusCode, 404);
  assert.equal(res.body.error, "NOTHING_TO_EXTEND");
  assert.equal(stub.calls, 0);
});

// ── A period with no sales ───────────────────────────────────────────────────

test("an empty period is stored without calling the provider", async () => {
  const res = await generate(
    makeReq({
      params: { kind: "month", id: PERIOD.id, section: "pricing" },
      body: { promptVersion: "v3", empty: true, reason: "NO_SALES", basis: { orders: 0 } },
    }),
  );

  assert.equal(res.statusCode, 200);
  assert.equal(res.body.data.items.length, 0);
  assert.equal(res.body.data.reason, "NO_SALES");
  assert.equal(res.body.data.spent, false);
  assert.equal(stub.calls, 0, "there is nothing to analyse, so nothing is paid for");

  // Stored, so the page does not ask again on every visit.
  const stored = await aiInsightsStore.readSection({
    businessId: BUSINESS,
    period: PERIOD,
    section: "pricing",
    promptVersion: "v3",
  });
  assert.ok(stored);
});

// ── Provider failures ────────────────────────────────────────────────────────

test("a provider refusal carries its code, sentence and timing", async () => {
  stub.reply = {
    ok: false,
    error: "AI_RATE_LIMIT",
    detail: "Quota exceeded for requests per minute.",
    retryAfter: 42,
  };

  const res = await generate(
    makeReq({ params: { kind: "month", id: PERIOD.id, section: "pricing" }, body: body() }),
  );

  assert.equal(res.statusCode, 502);
  assert.equal(res.body.error, "AI_RATE_LIMIT");
  assert.equal(res.body.detail, "Quota exceeded for requests per minute.");
  assert.equal(res.body.retryAfter, 42);
  // A failure stores nothing, so the next attempt is a clean one.
  assert.equal(await AIInsights.countDocuments({}), 0);
});

test("an answer that is not JSON is reported as the model's failure", async () => {
  stub.reply = { ok: true, text: "Sorry, I can't help with that.", model: "stub-model-1" };

  const res = await generate(
    makeReq({ params: { kind: "month", id: PERIOD.id, section: "pricing" }, body: body() }),
  );
  assert.equal(res.statusCode, 502);
  assert.equal(res.body.error, "AI_MALFORMED_RESPONSE");
  assert.match(res.body.detail, /Sorry/);
});

// ── Reading ──────────────────────────────────────────────────────────────────

test("reading a period names what is there and what is missing", async () => {
  await generate(
    makeReq({ params: { kind: "month", id: PERIOD.id, section: "pricing" }, body: body() }),
  );

  const res = await run(
    [controller.resolvePeriod, controller.readPeriod],
    makeReq({ params: { kind: "month", id: PERIOD.id } }),
  );

  assert.equal(res.body.data.period.id, PERIOD.id);
  assert.equal(res.body.data.period.from, PERIOD.from);
  assert.deepEqual(Object.keys(res.body.data.sections), ["pricing"]);
  assert.ok(res.body.data.missing.includes("retention"));
  assert.ok(!res.body.data.missing.includes("pricing"));
  // festival-prep is not period-scoped, so it is never "missing" from a period.
  assert.ok(!res.body.data.missing.includes("festival-prep"));
  assert.equal(res.body.data.totalSections, 7);
});

test("reading a period nobody has generated is empty, not an error", async () => {
  const res = await run(
    [controller.resolvePeriod, controller.readPeriod],
    makeReq({ params: { kind: "month", id: "2026-07" } }),
  );
  assert.equal(res.statusCode, 200);
  assert.deepEqual(res.body.data.sections, {});
  assert.equal(res.body.data.missing.length, 7);
});

test("the period list marks which ones are ready", async () => {
  await generate(
    makeReq({ params: { kind: "month", id: PERIOD.id, section: "pricing" }, body: body() }),
  );

  const res = await run([controller.listPeriods], makeReq());
  const data = res.body.data;

  assert.equal(data.kind, "month");
  assert.equal(data.default, PERIOD.id);
  assert.equal(data.periods.length, 12);
  assert.equal(data.periods[0].id, PERIOD.id);
  assert.equal(data.periods[0].generatedSections, 1);
  assert.equal(data.periods[1].generatedSections, 0);
  assert.equal(data.totalSections, 7);
  assert.deepEqual(
    data.kinds.map((k) => k.kind),
    ["month", "quarter", "year"],
  );
});

test("quarters and years work through the same path", async () => {
  for (const [kind, id] of [
    ["quarter", "2026-Q2"],
    ["year", "2025"],
  ]) {
    const res = await generate(
      makeReq({ params: { kind, id, section: "pricing" }, body: body() }),
    );
    assert.equal(res.statusCode, 200, `${kind} ${id}`);
    assert.equal(res.body.data.period.id, id);
  }
  // Three documents for one business: one per period, none colliding.
  assert.equal(await AIInsights.countDocuments({}), 2);
});

test("two prompt versions of one section read back as the newest", async () => {
  const params = { kind: "month", id: PERIOD.id, section: "pricing" };

  // v3's answer, then v4's beside it — what a prompt improvement leaves behind.
  await generate(makeReq({ params, body: body({ promptVersion: "v3" }) }));
  stub.reply = {
    ok: true,
    text: JSON.stringify({ items: [{ id: "new", text: "Written by v4" }] }),
    model: "stub-model-2",
    usage: null,
  };
  await generate(makeReq({ params, body: body({ promptVersion: "v4" }) }));

  assert.equal(await AIInsights.countDocuments({ section: "pricing" }), 2, "both are kept");

  const res = await run(
    [controller.resolvePeriod, controller.readPeriod],
    makeReq({ params: { kind: "month", id: PERIOD.id } }),
  );

  // One card for the section, and it is v4's — not whichever the database
  // happened to return last.
  assert.equal(Object.keys(res.body.data.sections).length, 1);
  assert.equal(res.body.data.sections.pricing.promptVersion, "v4");
  assert.equal(res.body.data.sections.pricing.items[0].id, "new");
});
