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

| Method   | Path           | Does                                                    |
| -------- | -------------- | ------------------------------------------------------- |
| `GET`    | `/ai-key`      | `{ hasKey, maskedKey, updatedAt }` — never the key       |
| `PUT`    | `/ai-key`      | `{ apiKey }` → validate against Gemini, encrypt, store   |
| `DELETE` | `/ai-key`      | Remove this business's key                               |
| `POST`   | `/ai-insights` | `{ briefing, systemInstruction, responseSchema }` → insights |

`PUT` makes one cheap Gemini call before storing. A typo'd key that fails
silently at save time surfaces days later as a broken dashboard.

Failures are distinguished, because it is the business's own key and quota:
invalid key, quota exceeded, and model error need three different messages.
`POST /ai-insights` returns **424** when no key is saved, which the frontend
uses to send the user to settings rather than show a dead error.

## Getting started

```bash
cp .env.example .env
# fill in MONGODB_URI and generate ENCRYPTION_KEY (command is in the file)
npm install
npm run dev
```

## Status

Scaffold only. `src/` has the directory layout; no route, model or service code
is written yet.
