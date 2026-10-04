/**
 * Drives the period insights routes against a running server.
 *
 *   # terminal 1
 *   npm run dev:stub
 *
 *   # terminal 2
 *   npm run smoke:period -- <POS token>
 *
 * What this covers that the unit tests cannot: real HTTP, real routing, and
 * `requireBusiness` — which asks the POS API who the caller is, and is therefore
 * the one layer the tests have to skip.
 *
 * Nothing is paid for, as long as the server is running with
 * `AI_STUB_PROVIDER=1`. It refuses to run otherwise unless `--real` is passed,
 * because the alternative is quietly spending eight provider calls on a smoke
 * test.
 *
 * It cleans up after itself: the documents it writes are deleted at the end,
 * directly through mongoose, so a dev database is not left holding fabricated
 * insights that later look real. `--keep` leaves them for inspection.
 */

const mongoose = require("mongoose");

const AIInsights = require("../models/aiInsights");
const { PERIOD_SECTIONS } = require("../helpers/insightSections");

const BASE = process.env.SMOKE_BASE_URL || `http://localhost:${process.env.PORT || 4000}`;
const token = process.argv.find((arg) => arg.startsWith("ey"));
const keep = process.argv.includes("--keep");
const allowReal = process.argv.includes("--real");

/** Its own prompt version, so nothing it writes can collide with the real thing. */
const PROMPT_VERSION = "v99";

if (!token) {
  console.error("Usage: npm run smoke:period -- <POS token> [--keep] [--real]");
  console.error("");
  console.error("The token is the one the app uses: log in, then DevTools →");
  console.error("Application → Cookies → copy `token`.");
  process.exit(1);
}

let failures = 0;
const results = [];

const check = (label, ok, note = "") => {
  results.push({ label, ok, note });
  if (!ok) failures += 1;
  console.log(`${ok ? "  ok  " : " FAIL "}${label}${note ? `  — ${note}` : ""}`);
};

const api = async (method, path, body) => {
  const res = await fetch(`${BASE}${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${token}`,
      ...(body ? { "Content-Type": "application/json" } : {}),
    },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  return { status: res.status, body: await res.json().catch(() => ({})) };
};

/** A believable briefing. The stub ignores it; the validation does not. */
const briefingFor = (section, extra = "") =>
  `Section: ${section}. September 2026: 1,240 orders, Rs 310,000 revenue, ` +
  `top item momo (412 sold), slowest item sandwich (6 sold).${extra}`;

const generateBody = (section, overrides = {}) => ({
  promptVersion: PROMPT_VERSION,
  briefing: briefingFor(section),
  systemInstruction: "You advise the owner of a small restaurant in Nepal.",
  responseSchema: { type: "object", properties: { items: { type: "array" } } },
  basis: { orders: 1240, revenue: 310000 },
  ...overrides,
});

/** Two at a time, as the real page will: free tiers refuse eight at once. */
async function inPairs(items, work) {
  const out = [];
  for (let i = 0; i < items.length; i += 2) {
    out.push(...(await Promise.all(items.slice(i, i + 2).map(work))));
  }
  return out;
}

async function main() {
  console.log(`[smoke] ${BASE}`);

  // ── Is this actually the stub? ───────────────────────────────────────────
  // Asked of the server, not of this shell's environment: the question is what
  // the thing about to be called will do, and only it knows that.
  const health = await fetch(`${BASE}/health`).catch(() => null);
  if (!health?.ok) {
    console.error(`[smoke] ${BASE} is not answering — is \`npm run dev:stub\` running?`);
    process.exit(1);
  }
  const stubbed = (await health.json().catch(() => ({})))?.stub === true;
  if (!stubbed && !allowReal) {
    console.error(
      "[smoke] that server is NOT running the stub provider, so this would " +
        "spend real provider quota.",
    );
    console.error(
      "        Start it with `npm run dev:stub`, or pass --real to pay for it.",
    );
    process.exit(1);
  }
  console.log(`[smoke] provider: ${stubbed ? "stub (nothing is spent)" : "REAL — this costs money"}`);

  // ── The period list ─────────────────────────────────────────────────────
  const periods = await api("GET", "/api/period-insights/periods?kind=month");
  check("GET periods", periods.status === 200, `${periods.status}`);
  if (periods.status !== 200) {
    console.error(JSON.stringify(periods.body, null, 2));
    process.exit(1);
  }
  const period = periods.body.data.default;
  console.log(`[smoke] default period: ${period} · ${periods.body.data.periods[0].label}`);
  check("12 months offered", periods.body.data.periods.length === 12);
  check("7 period sections", periods.body.data.totalSections === 7);

  const url = (suffix = "") => `/api/period-insights/month/${period}${suffix}`;

  // ── Nothing stored yet ──────────────────────────────────────────────────
  const before = await api("GET", url());
  check("GET period before generating", before.status === 200);
  const alreadyThere = Object.keys(before.body.data?.sections ?? {}).length;

  // ── Generate every section, two at a time ───────────────────────────────
  const generated = await inPairs(PERIOD_SECTIONS, (section) =>
    api("POST", url(`/${section}`), generateBody(section)),
  );
  const ok = generated.filter((r) => r.status === 200);
  check(
    `generated ${PERIOD_SECTIONS.length} sections`,
    ok.length === PERIOD_SECTIONS.length,
    ok.length === PERIOD_SECTIONS.length
      ? "all spent once"
      : `only ${ok.length}: ${JSON.stringify(generated.find((r) => r.status !== 200)?.body)}`,
  );
  check("the first generation is marked as spent", ok[0]?.body?.data?.spent === true);
  check("stub answers arrived", (ok[0]?.body?.data?.items?.length ?? 0) > 0);
  check("the basis was stored", ok[0]?.body?.data?.basis?.orders === 1240);

  // ── Asking again must not spend ─────────────────────────────────────────
  const again = await api("POST", url("/pricing"), generateBody("pricing"));
  check("asking again returns the stored answer", again.body?.data?.spent === false);
  check("revision is still 1", again.body?.data?.revision === 1);

  // ── Two at once: the in-flight lock ─────────────────────────────────────
  await AIInsights.deleteOne({ section: "retention", promptVersion: PROMPT_VERSION });
  const [a, b] = await Promise.all([
    api("POST", url("/retention"), generateBody("retention")),
    api("POST", url("/retention"), generateBody("retention")),
  ]);
  const spent = [a, b].filter((r) => r.body?.data?.spent === true).length;
  check("two simultaneous requests pay once", spent === 1, `${spent} marked spent`);

  // ── Regenerate ──────────────────────────────────────────────────────────
  const regenerated = await api(
    "POST",
    url("/pricing"),
    generateBody("pricing", { mode: "regenerate" }),
  );
  check("regenerate bumps the revision", regenerated.body?.data?.revision === 2);
  check(
    "regenerate replaced the cards",
    regenerated.body?.data?.items?.[0]?.id !== ok[0]?.body?.data?.items?.[0]?.id,
  );

  // ── Generate more ───────────────────────────────────────────────────────
  const more = await api(
    "POST",
    url("/menu-suggestions"),
    generateBody("menu-suggestions", { mode: "more" }),
  );
  check("more adds a batch", more.body?.data?.batches === 2, `batches=${more.body?.data?.batches}`);
  check("more keeps the earlier cards", (more.body?.data?.items?.length ?? 0) > 2);

  const notAllowed = await api(
    "POST",
    url("/pricing"),
    generateBody("pricing", { mode: "more" }),
  );
  check("more is refused where it makes no sense", notAllowed.body?.error === "MORE_NOT_SUPPORTED");

  // ── A period with no sales ──────────────────────────────────────────────
  await AIInsights.deleteOne({ section: "staffing", promptVersion: PROMPT_VERSION });
  const empty = await api("POST", url("/staffing"), {
    promptVersion: PROMPT_VERSION,
    empty: true,
    reason: "NO_SALES",
    basis: { orders: 0 },
  });
  check("an empty period is stored without spending", empty.body?.data?.spent === false);
  check("and records why", empty.body?.data?.reason === "NO_SALES");

  // ── Provider failures, on demand ────────────────────────────────────────
  await AIInsights.deleteOne({ section: "slow-items", promptVersion: PROMPT_VERSION });
  const limited = await api(
    "POST",
    url("/slow-items"),
    generateBody("slow-items", { briefing: briefingFor("slow-items", " __FAIL:AI_RATE_LIMIT__") }),
  );
  check("a rate limit comes back as 502 + code", limited.status === 502 && limited.body?.error === "AI_RATE_LIMIT");
  check("with the provider's own sentence", Boolean(limited.body?.detail));
  check("and its timing", limited.body?.retryAfter === 42, `retryAfter=${limited.body?.retryAfter}`);

  const malformed = await api(
    "POST",
    url("/slow-items"),
    generateBody("slow-items", { briefing: briefingFor("slow-items", " __FAIL:MALFORMED__") }),
  );
  check("a non-JSON answer is the model's failure", malformed.body?.error === "AI_MALFORMED_RESPONSE");

  // ── Refusals that cost nothing ──────────────────────────────────────────
  const openPeriod = new Date().toISOString().slice(0, 7);
  const notClosed = await api(
    "POST",
    `/api/period-insights/month/${openPeriod}/pricing`,
    generateBody("pricing"),
  );
  check("an unfinished period is refused", notClosed.body?.error === "PERIOD_NOT_CLOSED");

  const badSection = await api("POST", url("/festival-prep"), generateBody("festival-prep"));
  check("festival-prep is not a period section", badSection.body?.error === "INVALID_SECTION");

  const badVersion = await api(
    "POST",
    url("/pricing"),
    generateBody("pricing", { promptVersion: "newest" }),
  );
  check("a junk prompt version is refused", badVersion.body?.error === "INVALID_PROMPT_VERSION");

  // ── The page's read ─────────────────────────────────────────────────────
  const after = await api("GET", url());
  const sections = Object.keys(after.body.data.sections);
  check(
    "the period now reads back its sections",
    sections.length >= PERIOD_SECTIONS.length - alreadyThere - 1,
    `${sections.length} stored, missing: ${after.body.data.missing.join(", ") || "none"}`,
  );

  console.log("");
  console.log(`[smoke] ${results.length - failures}/${results.length} checks passed`);
}

async function cleanup() {
  if (keep) {
    console.log(`[smoke] --keep: leaving documents with promptVersion ${PROMPT_VERSION}`);
    return;
  }
  const { deletedCount } = await AIInsights.deleteMany({ promptVersion: PROMPT_VERSION });
  console.log(`[smoke] cleaned up ${deletedCount} stub documents`);
}

(async () => {
  // Whether this would spend real money is asked of the server in main(), not
  // of this shell: a flag set here says nothing about what the server is doing.

  // Only for the cleanup and the two deliberate deletions above; the checks
  // themselves all go over HTTP.
  await mongoose.connect(process.env.MONGODB_URI, { serverSelectionTimeoutMS: 5000 });

  try {
    await main();
  } finally {
    await cleanup();
    await mongoose.connection.close();
  }

  process.exit(failures > 0 ? 1 : 0);
})().catch(async (error) => {
  console.error(`[smoke] FAILED: ${error?.message ?? error}`);
  process.exit(1);
});
