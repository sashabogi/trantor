// Persistence is a standing health condition, not a stream of retry errors. This tracker keeps the
// retry schedule and the operator-facing state together so they cannot disagree.
export const PERSIST_RETRY_BASE_MS = 1000;
export const PERSIST_RETRY_MAX_MS = 60_000;
export const PERSIST_LOG_INTERVAL_MS = 60_000;

const positive = (value, fallback) => {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? n : fallback;
};

export function createPersistHealth(options = {}) {
  const baseMs = positive(options.baseMs, PERSIST_RETRY_BASE_MS);
  const maxMs = Math.max(baseMs, positive(options.maxMs, PERSIST_RETRY_MAX_MS));
  const logIntervalMs = positive(options.logIntervalMs, PERSIST_LOG_INTERVAL_MS);
  let failedAt = 0;
  let lastError = "";
  let retries = 0;
  let retryMs = baseMs;
  let nextAttemptAt = 0;
  let lastLogAt = -Infinity;

  const view = (at = Date.now()) => ({
    ok: retries === 0,
    failingSinceMs: retries === 0 ? 0 : Math.max(0, Number(at) - failedAt),
    lastError,
    retries,
  });

  return {
    canAttempt(at = Date.now()) {
      return retries === 0 || Number(at) >= nextAttemptAt;
    },
    failed(error, at = Date.now()) {
      const when = Number(at);
      if (retries === 0) failedAt = when;
      retries += 1;
      lastError = String(error?.message || error || "persist failed").replace(/\u0000/g, "").replace(/\s+/g, " ").slice(0, 500);
      const delayMs = retryMs;
      nextAttemptAt = when + delayMs;
      retryMs = Math.min(maxMs, retryMs * 2);
      const shouldLog = when - lastLogAt >= logIntervalMs;
      if (shouldLog) lastLogAt = when;
      return { delayMs, shouldLog, health: view(when) };
    },
    succeeded() {
      failedAt = 0;
      lastError = "";
      retries = 0;
      retryMs = baseMs;
      nextAttemptAt = 0;
      lastLogAt = -Infinity;
    },
    view,
  };
}
