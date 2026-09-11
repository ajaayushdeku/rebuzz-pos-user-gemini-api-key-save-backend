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

Option 1 is the safer default until there's a reason to optimise. Whichever is
chosen, **the business id must come from the verified token, never from the
request body** — a client-supplied id would let any authenticated business read
and spend another's key.

## Storage

The key is encrypted at rest with AES-256-GCM under `ENCRYPTION_KEY`, not
stored as a plain string. The document keeps the ciphertext, its iv and auth
tag, and a display mask (first and last few characters) so the settings screen
has something to show without ever decrypting.

`ENCRYPTION_KEY` is not recoverable: lose it and every stored key must be
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

Save-time verification is currently **paused** — see the commented block in
`routes/aiSettings.js`. A key is stored without asking Google whether it works,
so `lastVerifiedAt` stays null rather than claiming a check that never
happened. The consequence is that a typo'd key saves cleanly and only fails
when a real feature runs. `POST /api/settings/ai/test` verifies on demand in
the meantime.

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

## Getting started

```bash
cp .env.example .env
# fill in MONGODB_URI and generate ENCRYPTION_KEY (command is in the file)
npm install
npm run dev
```

## Status

Working. Key storage, the settings routes and insight generation are
implemented. Still to build: the briefing writer and the card that shows the
result, both of which live in the frontend.
