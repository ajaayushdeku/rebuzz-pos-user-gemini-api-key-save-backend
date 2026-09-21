const mongoose = require("mongoose");

/**
 * Connect once at boot.
 *
 * Mongoose keeps its own pool, so this is called a single time and every
 * model reuses it — connecting per request would open a new pool each time.
 */
async function connectDatabase() {
  const uri = process.env.MONGODB_URI;
  if (!uri) {
    throw new Error("MONGODB_URI is not set");
  }

  // Fail fast rather than queue writes against a server that is not there:
  // the default buffers commands for 10s and then errors inside the request,
  // which reads as a broken route rather than a missing database.
  mongoose.set("bufferCommands", false);
  // As khajaGharBackend sets it, so queries behave the same after the move.
  mongoose.set("strictQuery", false);

  mongoose.connection.on("disconnected", () => {
    console.warn("[db] disconnected");
  });
  mongoose.connection.on("reconnected", () => {
    console.info("[db] reconnected");
  });

  await mongoose.connect(uri, {
    serverSelectionTimeoutMS: 8000,
  });

  console.info("[db] connected");
}

async function disconnectDatabase() {
  await mongoose.connection.close();
}

module.exports = { connectDatabase, disconnectDatabase };
