import express from "express";
import cors from "cors";

import { connectDatabase, disconnectDatabase } from "./config/db.js";
import { assertEncryptionReady } from "./lib/crypto.js";
import aiSettingsRouter from "./routes/aiSettings.js";

const PORT = Number(process.env.PORT ?? 4000);

/**
 * Everything that must be true before the server accepts a request.
 *
 * Checked here rather than lazily: a service that boots without a valid
 * AI_ENCRYPTION_KEY would accept writes it can never decrypt, and the damage
 * is only discovered when someone tries to read one back.
 */
function assertConfigured() {
  const missing = ["MONGODB_URI", "POS_API_URL"].filter(
    (name) => !process.env[name],
  );
  if (missing.length > 0) {
    throw new Error(`Missing required env: ${missing.join(", ")}`);
  }
  assertEncryptionReady();
}

const app = express();

app.use(
  cors({
    // One named origin, not "*" — these routes carry a bearer token.
    origin: process.env.CORS_ORIGIN ?? "http://localhost:3000",
    credentials: true,
  }),
);

// Small cap: the largest legitimate body here is a briefing of a few KB.
app.use(express.json({ limit: "256kb" }));

// Deliberately no request-body logging anywhere in this service. Two routes
// carry a raw Gemini key in the body, and body-logging middleware is the
// most common way credentials reach a log file.

app.get("/health", (_req, res) => {
  res.json({ ok: true });
});

app.use("/api/settings/ai", aiSettingsRouter);

app.use((_req, res) => {
  res.status(404).json({ error: "NOT_FOUND" });
});

// Express 5 forwards rejected promises here, so routes need no async wrapper.
app.use((error, _req, res, _next) => {
  // Message only. Error objects from the provider SDK can echo the request
  // back, key included.
  console.error("[error]", error?.message ?? error);
  res.status(500).json({ error: "INTERNAL_ERROR" });
});

async function start() {
  assertConfigured();
  await connectDatabase();

  const server = app.listen(PORT, () => {
    console.info(`[server] listening on http://localhost:${PORT}`);
  });

  for (const signal of ["SIGINT", "SIGTERM"]) {
    process.on(signal, () => {
      console.info(`[server] ${signal} — shutting down`);
      server.close(async () => {
        await disconnectDatabase();
        process.exit(0);
      });
    });
  }
}

start().catch((error) => {
  console.error("[server] failed to start:", error.message);
  process.exit(1);
});
