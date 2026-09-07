import mongoose from "mongoose";

/**
 * Connect once at boot.
 *
 * Mongoose keeps its own pool, so this is called a single time and every
 * model reuses it — connecting per request would open a new pool each time.
 */
export async function connectDatabase() {
  const uri = process.env.MONGODB_URI;
  if (!uri) {
    throw new Error("MONGODB_URI is not set");
  }

  // Fail fast rather than queue writes against a server that is not there:
  // the default buffers commands for 10s and then errors inside the request,
  // which reads as a broken route rather than a missing database.
  mongoose.set("bufferCommands", false);

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

export async function disconnectDatabase() {
  await mongoose.connection.close();
}
