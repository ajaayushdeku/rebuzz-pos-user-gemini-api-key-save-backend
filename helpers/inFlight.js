/**
 * One piece of paid work at a time, per key.
 *
 * This is what replaces the hourly rate limiter. The limiter was a quota; this
 * is narrower and more useful — it stops the *same* generation being paid for
 * twice. A double-click, a dropped connection the user retries, two tabs open on
 * the same period: each of those used to be a second provider call for an answer
 * already on its way.
 *
 * A second caller does not get an error. It waits on the work already running and
 * receives the same result, which is what the user meant by clicking twice.
 *
 * In memory, per process — the same trade-off the old limiter documented. With
 * more than one replica each would hold its own locks, so two instances could
 * still duplicate one generation; the stored document's unique key means the
 * second write loses rather than duplicating the data. A shared lock would need
 * Redis, and this is a cost guard, not a correctness boundary.
 */

/** key -> the promise of the work currently running under it. */
const running = new Map();

/**
 * Run `work`, or join the run already in progress for this key.
 *
 * Returns `{ shared, result }` — `shared` being true when this caller joined
 * someone else's work rather than starting its own, which the caller may want to
 * log or report, since nothing was spent on its behalf.
 */
async function runOnce(key, work) {
  const existing = running.get(key);
  if (existing) {
    return { shared: true, result: await existing };
  }

  // Started eagerly and stored before the first await, so two calls in the same
  // tick cannot both find the map empty.
  const promise = (async () => work())();
  running.set(key, promise);

  try {
    return { shared: false, result: await promise };
  } finally {
    // Only if it is still ours: a slow failure must not delete a newer run's
    // entry and let a third caller start a duplicate.
    if (running.get(key) === promise) running.delete(key);
  }
}

/** Whether something is already running under this key. For reporting only. */
const isRunning = (key) => running.has(key);

/** How many are in flight, for a health or debug line. */
const inFlightCount = () => running.size;

module.exports = { runOnce, isRunning, inFlightCount };
