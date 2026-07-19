/**
 * A counting semaphore for whole Claude turns.
 *
 * Why this exists: on the Agent SDK path, `query()` spawns the Claude Code CLI
 * as a child process for the duration of a turn (see ../agent.js). Nothing in
 * the Discord event loop serialises turns — `handleMessage` is a plain event
 * handler, so three people messaging in three servers means three subprocesses
 * alive at once, each with its own RSS inside Render's single 512MB cgroup.
 * Container limits count subprocesses, so concurrency multiplies the whole
 * footprint rather than just the heap.
 *
 * Deliberately a cap rather than a strict lock. A turn here can run for minutes
 * (MAX_TOOL_CALLS=30, MAX_TOKENS_PER_TURN=150000), so serialising everything to
 * one would make a second user wait out a full build with no explanation —
 * which reads as "the bot is broken", the exact symptom this is meant to
 * prevent. Two concurrent turns bounds the peak while keeping a second person
 * responsive.
 */
export function createLimiter(max) {
  let active = 0;
  const waiting = [];

  function releaseSlot() {
    const next = waiting.shift();
    // The slot is handed straight to the next waiter rather than decremented
    // and re-acquired. Decrementing first would open a window where a fresh
    // acquire() — which runs synchronously — sees active < max and takes the
    // slot, while the woken waiter also increments, putting `active` above max.
    if (next) next();
    else active--;
  }

  return {
    get active() {
      return active;
    },
    get queued() {
      return waiting.length;
    },

    /**
     * Wait for a slot. Returns a release function that is safe to call twice.
     *
     * @param {(position: number) => void} [onQueued] - Called only if the caller
     *   actually has to wait, with its 1-based position in the queue. Use it to
     *   tell the user why nothing is happening; silent queuing is harder to
     *   diagnose than the resource exhaustion it replaces.
     */
    async acquire(onQueued) {
      if (active < max) {
        active++;
      } else {
        if (onQueued) {
          try {
            onQueued(waiting.length + 1);
          } catch {
            /* notifying the user is best-effort and must not lose the slot */
          }
        }
        // Resolving this promise transfers a slot that is already counted in
        // `active`, so there is no increment on this branch.
        await new Promise((resolve) => waiting.push(resolve));
      }

      let released = false;
      return () => {
        if (released) return;
        released = true;
        releaseSlot();
      };
    },
  };
}

// How many Claude turns may run at once, process-wide and across all projects.
// The limit is a property of the container's memory, not of any one project, so
// it deliberately is not per-project.
export const MAX_CONCURRENT_TURNS = parseInt(
  process.env.MAX_CONCURRENT_TURNS || '2',
  10,
);

export const turnLimiter = createLimiter(MAX_CONCURRENT_TURNS);
