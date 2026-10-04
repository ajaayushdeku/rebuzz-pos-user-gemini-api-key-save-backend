# Period insights — decisions

AI insights describe a **completed analytics period** (by default last month)
rather than today, and are **stored permanently** once generated. These are the
decisions behind that, agreed before implementation; the reasoning is here so a
later change is made deliberately rather than by accident.

## Periods

| | |
| --- | --- |
| Default | the previous completed month — on 4 Oct 2026, that is September 2026 |
| Kinds | `month` (`2026-09`), `quarter` (`2026-Q3`), `year` (`2025`) |
| Quarter | **three** calendar months — Q3 is Jul–Sep. A four-month "third" was considered and rejected: nothing else calls that a quarter. If one is ever wanted it becomes its own kind, so neither invalidates the other's stored insights. |
| Year | calendar year. Nepal's fiscal year (Shrawan–Ashad) would be a separate kind, `fy2082`. |
| Timezone | Asia/Kathmandu, **+05:45**. September is `2026-08-31T18:15:00Z → 2026-09-30T18:15:00Z`, matching how the POS stores a plain date. |
| Selectable range | 12 months, 4 quarters, 2 years |
| Labels | Gregorian only. BS labels are a later frontend addition; a Gregorian month spans two BS months. |

## Which sections follow a period

Seven of the eight do. `festival-prep` does not: it advises on *upcoming*
festivals, so a September retrospective about Dashain preparation would be
useless after the fact. It keeps the existing day-scoped cache.

| Section | Scope |
| --- | --- |
| `pricing`, `slow-items`, `menu-suggestions`, `sales-recommendations`, `retention`, `hour-playbook`, `staffing` | period |
| `festival-prep` | current |

The period selector therefore applies to the whole page **except** the festival
section.

## Generating

- **On demand only**, from a button. Nothing generates because a page was
  opened: eight provider calls spent by anyone wandering onto the page is not a
  cost the merchant chose.
- **Admin only.** Enforceable: the POS validates the token, and its subject
  (`userId`) is compared with the business's `adminId`. No other page triggers
  generation.
- **Concurrency of 2** across sections. Free tiers limit requests per minute, and
  eight parallel calls would mostly answer 429.
- **Partial success is kept.** Five sections that worked are stored; the three
  that failed report why and can be retried alone. Discarding successful calls
  would mean paying for them twice.
- **A period with no sales at all is stored as "no data", with no AI call** — with
  no figures a model can only invent. Thin data *is* generated from, with the
  volume stated in the briefing so the answer can be honest about it.

## Regenerate / more

| Action | Behaviour |
| --- | --- |
| Open | read stored only, no spend |
| Regenerate | per section (plus "regenerate all" over the same path), overwrites, `revision += 1`, no history kept, behind a confirmation dialog showing the revision count |
| Generate more | unchanged: `menu-suggestions` and `sales-recommendations` only, capped by `MAX_MORE_BATCHES` |
| Prompt version bumped | the old answer stays, with "newer analysis available — regenerate". Auto-regenerating would spend for every business on every deploy. |

## Generating is two calls, not one

A card is the model's answer **joined onto the period's own figures**: the item
name, the current price and the numbers come from the data, and the model
supplies only the advice, keyed by an anonymised reference (`parsePricing` joins
on `facts.candidates`). Whoever holds the data must finish that join — and what
gets stored has to be the finished cards, because the figures are gone by the
next visit.

So the caller does three things, and only the middle one costs money:

| | |
| --- | --- |
| `GET /period-insights/:kind/:id` | the period's windows, and what is already stored. When the section is there, it stops — no reports are fetched and nothing is spent. |
| `POST …/:section/draft` | asks the model and returns the answer **without storing it**. Behind the in-flight lock. |
| `POST …/:section` | stores the finished cards (`items`), or an empty period. |

A paid draft is cached for 26 hours under its own key, so the second half failing
— a dropped connection, a restart, a bad deploy — costs a retry rather than
another provider call. `mode: "regenerate"` and `"more"` bypass that cache, since
both mean "ask again".

The draft also refuses what the save would refuse — `more` on a section with
nothing stored, or one that offers no batches — so a provider is never paid for an
answer that cannot be kept.

**A trap this creates for tests and tools:** deleting a stored insight does not
make the next draft call a provider; the cached draft answers instead. Anything
wanting a genuinely fresh generation must clear both, which is what
`resetSection` in `scripts/period-smoke.js` does.

## Limits and errors

The application's hourly limiter is **gone**. What replaces it:

- an **in-flight lock** per (business, period, section) — not a quota, a
  duplicate-spend guard, so a double-click or two tabs cannot both pay;
- the provider's own limits, reported honestly. `GET /ai-insights/quota` and the
  quota meter go with the limiter; each section shows when it was last generated
  instead.

No automatic retry beyond what the provider layer already does, and **no silent
fallback to another provider** — switching changes who wrote the answer, so the
user is told and chooses.

| Code | What the user is told |
| --- | --- |
| `AI_RATE_LIMIT` | wait, with `retryAfter` when the provider gives one |
| `AI_QUOTA_EXCEEDED` | plan limit — try another model or provider |
| `AI_MODEL_UNAVAILABLE` | pick another model |
| `AI_KEY_INVALID`, `KEY_UNREADABLE` | fix the key in settings |
| `AI_UNAVAILABLE` | provider trouble, try later |
| `AI_TRUNCATED`, `AI_EMPTY_RESPONSE`, `AI_MALFORMED_RESPONSE` | this model answered badly — regenerate or switch |

`detail` and `retryAfter` now travel with the failure; the insights route used to
drop both.

## Data

- POS reports are read for the **period's own range** — a quarter is fetched as
  its three months, not as thirteen weekly reports.
- Each stored insight records the figures it was based on, so it stays
  explicable months later.
- Scope is per business. Removing an API key does not delete stored insights:
  they cost money to produce and stay valid.

## Scope of this phase

`backend/` on MongoDB, tested locally against a **stub provider** — no real
provider calls. `POST /ai-insights` keeps working untouched, because the sales
forecast and the offer scheduler use it. Firestore comes later: the data layer
sits behind `data/aiInsightsStore.js` so that port is a second implementation of
one file, not a change to the request path. `ai-backend/` (the Firestore copy)
is knowingly left behind in the meantime.
