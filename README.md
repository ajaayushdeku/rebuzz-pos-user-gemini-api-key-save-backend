# Rebuzz AI Service

Stores each business's own Google Gemini API key, and makes model calls on
their behalf so the key never reaches a browser.

Separate from the main POS API (`api.beta.rebuzzpos.com`) because that codebase
belongs to another team. That separation is the source of this service's one
genuinely hard problem — see **Trust** below.

## Why the key never leaves this service

A Gemini key bills the business that owns it. The frontend writes it once and
can never read it back:

- The settings form sends the key; nothing returns it.
- `GET /ai-key` answers only *whether* one exists, plus a mask for display.
- There is deliberately **no endpoint that returns a stored key**. Adding one
  would make a leaked session token enough to steal every business's
  credential.
- Insight generation happens here: the frontend posts the briefing text, this
  service decrypts the key, calls Gemini, and returns only the result.

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
| `GET`    | `/api/settings/ai`      | Safe metadata only — configured, enabled, model, masked key    |
| `POST`   | `/api/settings/ai`      | `{ apiKey, model? }` → encrypt and store                       |
| `PATCH`  | `/api/settings/ai`      | Toggle `enabled` or change the model. Cannot set the key       |
| `DELETE` | `/api/settings/ai`      | Forget this business's key                                     |
| `POST`   | `/api/settings/ai/test` | Verify a supplied key, or re-verify the stored one             |
| `POST`   | `/api/ai-insights`      | `{ briefing, systemInstruction?, responseSchema? }` → insights |

`POST /api/settings/ai` verifies the key with Google **before** storing it, so a
typo'd or revoked key is rejected next to the field rather than saving cleanly
and failing later inside a feature that then looks broken for some unrelated
reason. The date that check passed is kept as `lastVerifiedAt`, and the record
stores the exact model that was verified, so it can never be used against one
it was not tested with.

A `GEMINI_MODEL_UNAVAILABLE` failure also returns `available` — the Flash models
this key can actually call — because a valid key without access to the default
model is otherwise a dead end with nothing to try.
`POST /api/settings/ai/test` re-runs the same check on demand.

Failures are distinguished, because it is the business's own key and quota:
invalid key, quota exceeded, and model error need three different messages.

`POST /api/ai-insights` returns **424** both when no key is saved and when the
business has switched Gemini off. Failed Dependency rather than an error,
because nothing is wrong with the request: a precondition the merchant controls
is missing. The frontend can treat the status alone as "send them to settings"
and use the code — `NOT_CONFIGURED` or `AI_DISABLED` — to pick the sentence.
Upstream Gemini failures come back as **502** with the same error vocabulary
the settings route already uses.

The caller supplies the briefing; this service does not fetch POS analytics
itself. That keeps an insight card and the chart above it built from the same
numbers, so the two cannot disagree. `requireBusiness` still stashes the
caller's POS token for the day that decision is revisited.

## Rate limiting

Two per-business in-memory guards (`src/lib/rateLimit.js`), scoped by the
verified `businessId`:

| Budget     | Routes that spend it                                                              | Limit             | Error code            |
| ---------- | --------------------------------------------------------------------------------- | ----------------- | --------------------- |
| Insights   | `POST /api/ai-insights`                                                           | 20 / hour         | `INSIGHTS_RATE_LIMIT` |
| Google calls from settings | `POST /api/settings/ai`, `PATCH` when changing the model, `POST /test`, `GET /models` | 10 / minute, shared | `VERIFY_RATE_LIMIT`   |

Each budget is one limiter instance shared across its routes, so the settings
routes draw on a single allowance rather than ten a minute each.

Only requests that are about to reach Google count. The insights route checks
the briefing, the stored key and the on/off switch first, and a refusal there
costs nothing. Counting refusals would lock a merchant out: the overview page
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
  (`insights.generated`) and per failure (`insights.failed`) with business id,
  model, token usage and duration, so per-tenant quota spend is visible without
  asking Google. The briefing itself is never logged — it is merchant sales
  data.
- Errors: message only. Provider SDK error objects can echo the request back
  with the key in it.

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
