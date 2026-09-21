# Rebuzz AI Service

Stores each business's own AI provider key — Google Gemini, OpenRouter, Groq and others — and
makes model calls on their behalf so the key never reaches a browser.

Separate from the main POS API (`api.beta.rebuzzpos.com`) because that codebase
belongs to another team. That separation is the source of this service's one
genuinely hard problem — see **Trust** below.

## Why the key never leaves this service

A provider key bills the business that owns it. The frontend writes it once and
can never read it back:

- The settings form sends the key; nothing returns it.
- `GET /ai-key` answers only *whether* one exists, plus a mask for display.
- There is deliberately **no endpoint that returns a stored key**. Adding one
  would make a leaked session token enough to steal every business's
  credential.
- Insight generation happens here: the frontend posts the briefing text, this
  service decrypts the key, calls the provider, and returns only the result.

## Providers

`helpers/aiProviders/index.js` is the registry; each provider is one file beside
it exposing the same four calls (`verifyKey`, `listModels`, `suggestModels`,
`generateInsights`). Adding a third is a new file and an entry there — no route
changes, because nothing else imports a provider directly.

| Provider     | File                         | Default model                              | Notes                                                       |
| ------------ | ---------------------------- | ------------------------------------------ | ----------------------------------------------------------- |
| `gemini`     | `helpers/aiProviders/gemini.js` | `gemini-3.6-flash`                         | Flash models only; the free tier stopped covering Pro       |
| `openrouter` | `helpers/aiProviders/openrouter.js` | `openrouter/free`                          | Free, text-only, structured-output models only              |
| `groq`       | `helpers/aiProviders/groq.js` | `openai/gpt-oss-20b`                       | Only the families Groq documents as honouring `json_schema` |
| `mistral`    | `helpers/aiProviders/mistral.js` | `mistral-small-latest`                     | Limits are per model; see the save-time fallback below      |
| `nvidia`     | `helpers/aiProviders/nvidia.js` | `openai/gpt-oss-20b`                       | NVIDIA NIM trial credits                                    |

Every provider but Gemini is the OpenAI-compatible shape, so they share
`helpers/aiProviders/openaiCompatible.js` and are a short configuration each: base
URL, key check, and which models to offer. Another provider of that shape is
another such file.

Free tiers change terms without notice. A provider that starts asking for a
card before its free tier works answers `AI_PAYMENT_REQUIRED`, whatever status
it sent, so the merchant is told that rather than "no quota" or "rate limit".

When a new key is refused on the default model for a rate or quota limit, the
save tries up to three of the key's other models and keeps the first that
answers (`fellBackFrom` in the response says so). If none do, the save fails
with `AI_PLAN_LIMIT` — on a key that has never been used, that means the plan
does not include those models, and waiting will not help.

A business's chosen provider is `provider` on its settings document, and each
provider's credentials live in their own block (`gemini`, `openrouter`, …), so
switching does not throw away the key for another one. A record written
before there was a choice has no `provider` and reads as `gemini`.

Errors use one provider-neutral vocabulary — `AI_KEY_INVALID`,
`AI_QUOTA_EXCEEDED`, `AI_RATE_LIMIT`, `AI_MODEL_UNAVAILABLE`, `AI_UNAVAILABLE`,
`AI_TRUNCATED`, `AI_EMPTY_RESPONSE`, `AI_MALFORMED_RESPONSE` — so the frontend
has one set of messages whichever provider answered. (The Gemini service still
speaks `GEMINI_*` internally; the registry translates.)

OpenRouter's schema handling differs in one way worth knowing: its strict JSON
mode rejects a schema unless every object bans extra properties and lists all
its properties as required, so `toStrictSchema` adjusts the section schemas on
the way out rather than each section carrying two versions.

## Trust: this service does not own auth

The session token is issued by the POS API, so this service cannot verify it
alone. Two options, and the choice needs agreeing with that team:

1. **Ask the POS API** — forward the bearer token to a known endpoint (e.g.
   `GET /business` or the profile route) and take the business id from the
   answer. Needs no coordination, but adds a round trip to every request and
   trusts that endpoint to stay stable.
2. **Share the JWT secret** — verify the token's signature locally. One less
   hop, but it means holding another team's signing secret, and a rotation on
   their side silently breaks this service.

Option 1 is the safer default until there's a reason to optimise, and it is
what `requireBusiness` implements today (with an 8 s timeout). Whichever is
chosen, **the business id must come from the verified token, never from the
request body** — a client-supplied id would let any authenticated business read
and spend another's key.

## Storage

The key is encrypted at rest with AES-256-GCM under `AI_ENCRYPTION_KEY`, not
stored as a plain string. The document keeps the ciphertext, its iv and auth
tag, and a display mask (first and last few characters) so the settings screen
has something to show without ever decrypting.

`AI_ENCRYPTION_KEY` is not recoverable: lose it and every stored key must be
re-entered by its business.

## Endpoints

| Method   | Path                    | Does                                                          |
| -------- | ----------------------- | ------------------------------------------------------------- |
| `GET`    | `/api/settings/ai`      | Safe metadata only — provider, configured, enabled, model, masked key, and the provider catalogue |
| `POST`   | `/api/settings/ai`      | `{ apiKey, model?, provider? }` → encrypt and store. Saving also selects that provider |
| `PATCH`  | `/api/settings/ai`      | Toggle `enabled`, change the model, or switch `provider` (to one that already has a key). Cannot set the key |
| `DELETE` | `/api/settings/ai`      | Forget the key for the provider in use                         |
| `POST`   | `/api/settings/ai/test` | Verify a supplied key, or re-verify the stored one             |
| `GET`    | `/api/settings/ai/models` | The models the stored key can call; `?provider=` asks about another one it has a key for |
| `POST`   | `/api/ai-insights`      | `{ briefing, systemInstruction?, responseSchema?, cacheKey?, refresh? }` → insights |

`POST /api/settings/ai` verifies the key with the provider **before** storing it, so a
typo'd or revoked key is rejected next to the field rather than saving cleanly
and failing later inside a feature that then looks broken for some unrelated
reason. The date that check passed is kept as `lastVerifiedAt`, and the record
stores the exact model that was verified, so it can never be used against one
it was not tested with.

An `AI_MODEL_UNAVAILABLE` failure also returns `available` — the models this key
can actually call — because a valid key without access to the default model is
otherwise a dead end with nothing to try.
`POST /api/settings/ai/test` re-runs the same check on demand.

Failures are distinguished, because it is the business's own key and quota:
invalid key, quota exceeded, and model error need three different messages.

`POST /api/ai-insights` returns **424** both when no key is saved and when the
business has switched AI off. Failed Dependency rather than an error,
because nothing is wrong with the request: a precondition the merchant controls
is missing. The frontend can treat the status alone as "send them to settings"
and use the code — `NOT_CONFIGURED` or `AI_DISABLED` — to pick the sentence.
Upstream provider failures come back as **502** with the same error vocabulary
the settings route already uses.

The caller supplies the briefing; this service does not fetch POS analytics
itself. That keeps an insight card and the chart above it built from the same
numbers, so the two cannot disagree. `requireBusiness` still stashes the
caller's POS token for the day that decision is revisited.

## Caching answers

`POST /api/ai-insights` can keep an answer so the same question is not paid for
twice. The caller names it with `cacheKey` (letters, digits and `:._-`, up to
120 characters), for example `sales-recommendations:v1:2026-09-17`:

- A later request with the same key gets the stored answer back with
  `cached: true` and `usage: null`. Google is not called, and the request does
  not count against the rate limit.
- `refresh: true` skips the stored answer, generates a new one and replaces it.
- Freshness is up to the key. A key that includes the date stops matching the
  next day. Stored answers are deleted by MongoDB after 26 hours
  (`AIInsightCache`, TTL index), which is housekeeping only.
- An answer is not served if the business has removed its key, switched AI
  off, or changed its model since the answer was written.
- A `cacheKey` requires a `responseSchema`, because only parsed answers are
  stored. A cache read or write that fails falls back to a normal call.

Without `cacheKey` the route behaves exactly as before.

## Rate limiting

Two per-business in-memory guards (`middlewares/aiRateLimit.js`), scoped by the
verified `businessId`:

| Budget     | Routes that spend it                                                              | Limit             | Error code            |
| ---------- | --------------------------------------------------------------------------------- | ----------------- | --------------------- |
| Insights   | `POST /api/ai-insights`                                                           | 20 / hour         | `INSIGHTS_RATE_LIMIT` |
| Google calls from settings | `POST /api/settings/ai`, `PATCH` when changing the model, `POST /test`, `GET /models` | 10 / minute, shared | `VERIFY_RATE_LIMIT`   |

Each budget is one limiter instance shared across its routes, so the settings
routes draw on a single allowance rather than ten a minute each.

Only requests that are about to reach Google count. The insights route checks
the briefing, the stored key and the on/off switch first, then the cache, and a
refusal or a cached answer costs nothing. Counting refusals would lock a merchant out: the overview page
asks for insights on every visit, so twenty visits without a key used to leave
them rate-limited for up to an hour after saving one.

Both answer **429** with a `Retry-After` header and the same wait in the JSON
body (`retryAfter`, seconds). In-memory rather than Redis on purpose: the limit
is a cost guard for a single small process, not a security boundary, and a
restart failing open costs one extra window of calls. Replace the `Map` with a
shared store if this ever runs as multiple replicas.

## Logging

- Every request: one line — method, path, status, duration. **Never the body**;
  two routes carry a raw Gemini key in theirs, and body-logging middleware is
  the most common way credentials reach a log file.
- Insight calls: one structured JSON line per success
  (`insights.generated`), per failure (`insights.failed`) and per cached answer
  (`insights.cache_hit`) with business id,
  model, token usage and duration, so per-tenant quota spend is visible without
  asking Google. The briefing itself is never logged — it is merchant sales
  data.
- Errors: message only. Provider SDK error objects can echo the request back
  with the key in it.

## Layout

Laid out like `khajaGharBackend` (CommonJS, Express 4, Mongoose 6), so each
file has an obvious home when this service moves into it:

| Here                               | Does                                                   |
| ---------------------------------- | ------------------------------------------------------ |
| `app.js`                           | Boot checks, CORS, request log, error handler          |
| `routes/api.js`                    | Mounts the routers under `/api`                        |
| `api/business/aiSettings.js`       | Settings routes and their rate limit                   |
| `api/business/aiInsights.js`       | Insight route: prepare → cache → rate limit → generate |
| `controller/aiSettingsController.js`, `controller/aiInsightsController.js` | The handlers |
| `models/aiSettings.js`, `models/aiInsightCache.js` (`models/index.js`) | Schemas     |
| `middlewares/requireBusiness.js`   | Who is calling, asked of the POS API                   |
| `middlewares/aiRateLimit.js`       | Per-business in-memory limits                          |
| `helpers/aiCrypto.js`              | AES-256-GCM for stored keys                            |
| `helpers/aiProviders/`             | Provider registry (`index.js`) and one file each       |
| `configs/dbConnection.js`          | This service's own database                            |

## Moving into khajaGharBackend

What stays the way it is only because this runs as its own service:

- **`businessId` and `adminId` are Strings.** Both arrive from the POS API's
  answer, not from this service's own database. In khajaGharBackend they become
  `{ type: ObjectId, ref: "Business" }` and `{ type: ObjectId, ref: "User" }`.
  Records written before `adminId` existed pick it up on their next settings
  change; the rest can be backfilled from `Business` by `_id` at the move.
- **`requireBusiness`** is replaced by `JWT.sessionRequired` and a `Business`
  lookup on the tenant admin id (`role === "admin" ? user._id : user.adminId`).
- **Responses** are `{ data }` / `{ error: CODE }`, which the frontend's error
  messages are keyed on. khajaGharBackend answers `{ status, data }`, so either
  the frontend or these controllers change at the move — not both.
- **Rate limits** are in memory. khajaGharBackend already runs Redis
  (`middlewares/rateLimitMiddleware.js`, `makeRateLimiter`).
- **`configs/dbConnection.js`** and `app.js` are dropped; khajaGharBackend's own
  connection and server take over, and `AI_ENCRYPTION_KEY` moves to its `.env`.

## Getting started

```bash
cp .env.example .env
# fill in MONGODB_URI and generate AI_ENCRYPTION_KEY (command is in the file)
npm install
npm run dev
```

## Status

Working end to end. Key storage, the settings routes, insight generation, rate
limiting and structured logging are implemented here; the briefing writer and
the insight cards live in the frontend (`rebuzz-pos/lib/ai-insights/`).
