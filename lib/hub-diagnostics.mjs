import { monitorEventLoopDelay } from "node:perf_hooks";

const clean = value => String(value || "unknown").replace(/[\r\n]/g, " ").slice(0, 160);

export function createHubDiagnostics({
  lagThresholdMs = 500,
  sampleIntervalMs = 100,
  logIntervalMs = 1000,
  now = Date.now,
  log = line => process.stdout.write(`${line}\n`),
  histogram = null,
} = {}) {
  const delay = histogram || monitorEventLoopDelay({ resolution: 20 });
  const inFlight = new Map();
  let lastStep = null;
  let lastLagLog = -Infinity;
  let timer = null;

  const recordStep = (name, bytes) => {
    lastStep = { name: clean(name), bytes: Math.max(0, Number(bytes) || 0), at: now() };
  };

  const checkLag = () => {
    const durationMs = delay.max / 1e6;
    delay.reset();
    const at = now();
    const requests = [...inFlight.values()];
    for (const [req, detail] of inFlight) if (detail.endedAt) inFlight.delete(req);
    if (durationMs <= lagThresholdMs || at - lastLagLog < logIntervalMs) return;
    lastLagLog = at;
    const routes = requests
      .map(req => `${req.method} ${req.path} (${Math.max(0, Math.round((req.endedAt || at) - req.startedAt))}ms)`)
      .slice(0, 3)
      .join(", ");
    const step = lastStep
      ? `${lastStep.name} bytes=${lastStep.bytes} age=${Math.max(0, at - lastStep.at)}ms`
      : "none";
    log(`[trantor] event-loop stall ${Math.round(durationMs)}ms (>${lagThresholdMs}ms); inFlight=${routes || "none"}; lastStep=${step}`);
  };

  return {
    recordStep,
    checkLag,
    beginRequest(req) {
      let path = "unknown";
      try { path = new URL(req.url, "http://x").pathname; } catch {}
      inFlight.set(req, { method: clean(req.method), path: clean(path), startedAt: now() });
    },
    endRequest(req) {
      const detail = inFlight.get(req);
      if (detail) detail.endedAt = now();
    },
    start() {
      if (timer) return;
      delay.enable();
      timer = setInterval(checkLag, sampleIntervalMs);
      timer.unref?.();
    },
    stop() {
      if (timer) clearInterval(timer);
      timer = null;
      delay.disable();
    },
  };
}
