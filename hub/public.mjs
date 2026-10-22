import { isIP } from "node:net";

const ALLOWED = new Set([
  ...["/health", "/projects", "/catchup", "/tasks", "/card", "/events", "/stream",
    "/inbox", "/poll", "/recent", "/peers", "/holds", "/verify-gates", "/proposals",
    "/balances", "/economics", "/session/chat", "/session/prompt", "/crew/roster", "/_op"]
    .map(path => `GET ${path}`),
  ...["/enroll", "/task/update", "/task/checklist-toggle", "/send", "/delivered",
    "/verify-gate", "/hold/decide", "/proposal/decide", "/session/prompt", "/session/answer",
    "/crew/command", "/device/register", "/device/unregister"].map(path => `POST ${path}`),
]);
const WINDOW_MS = 60000;
const MAX_CLIENTS = 10000;

function normalizedIP(address) {
  if (!isIP(address) || address.includes("%")) return "";
  if (isIP(address) === 4) return address;
  const canonical = new URL(`http://[${address}]/`).hostname.slice(1, -1);
  if (!canonical.startsWith("::ffff:")) return canonical;
  const words = canonical.slice(7).split(":").map(word => parseInt(word, 16));
  return [words[0] >> 8, words[0] & 255, words[1] >> 8, words[1] & 255].join(".");
}

export function publicClientIP(req) {
  const socket = normalizedIP(req.socket.remoteAddress || "") || "unknown";
  const loopback = socket === "::1" || socket.startsWith("127.");
  if (!loopback) return socket;
  // The proxy (tailscale serve/funnel) APPENDS the address it saw, so only the last entry is
  // trustworthy; the first is whatever the caller sent and would let anyone dodge the limits.
  const forwarded = String(req.headers["x-forwarded-for"] || "").split(",").pop().trim();
  return normalizedIP(forwarded) || socket;
}

export function createPublicGate({ now = Date.now, log = line => process.stderr.write(`${line}\n`) } = {}) {
  const clients = new Map();
  const admissions = new WeakMap();
  const refusals = new Map();
  function count(kind) { refusals.set(kind, (refusals.get(kind) || 0) + 1); }
  function prune() {
    const cutoff = now() - WINDOW_MS;
    for (const [ip, bucket] of clients) {
      if (!bucket.streams && bucket.lastSeen <= cutoff) clients.delete(ip);
    }
  }
  function report() {
    prune();
    for (const [kind, total] of refusals) log(`[trantor] public refusal ${kind}: count=${total}`);
    refusals.clear();
  }
  const timer = setInterval(report, WINDOW_MS);
  timer.unref();

  function refuse(res, code, kind, retry = 0) {
    count(kind);
    const headers = { "content-type": "application/json" };
    if (retry) headers["retry-after"] = String(retry);
    res.writeHead(code, headers);
    res.end(JSON.stringify({ error: code === 404 ? "not found" : "rate limit exceeded" }));
    return false;
  }

  function admit(req, res, path) {
    const ts = now();
    const ip = publicClientIP(req);
    let bucket = clients.get(ip);
    if (!bucket) {
      if (clients.size >= MAX_CLIENTS) prune();
      // Fail closed at capacity; evicting a live bucket would reset its limit.
      if (clients.size >= MAX_CLIENTS) return refuse(res, 429, "capacity", 60);
      bucket = { start: ts, lastSeen: ts, requests: 0, enrolls: 0, streams: 0 };
      clients.set(ip, bucket);
    }
    bucket.lastSeen = ts;
    if (ts - bucket.start >= WINDOW_MS) {
      bucket.start = ts;
      bucket.requests = 0;
      bucket.enrolls = 0;
    }
    const retry = Math.max(1, Math.ceil((bucket.start + WINDOW_MS - ts) / 1000));
    if (bucket.requests >= 120) return refuse(res, 429, "general-limit", retry);
    bucket.requests++;
    if (!ALLOWED.has(`${req.method} ${path}`)) return refuse(res, 404, "route");
    if (path === "/enroll") {
      if (bucket.enrolls >= 10) return refuse(res, 429, "enroll-limit", retry);
      bucket.enrolls++;
    }
    admissions.set(req, bucket);
    res.once("finish", () => {
      if (res.statusCode === 401) {
        // The first unit was charged at admission; a failed signature costs one more.
        if (bucket.start + WINDOW_MS > now()) bucket.requests++;
        count("auth");
      } else if (res.statusCode === 403) count(path === "/enroll" ? "enrollment" : "authorization");
    });
    return true;
  }

  function openStream(req, res) {
    if (res.destroyed) return false;
    const bucket = admissions.get(req);
    if (bucket.streams >= 5) return refuse(res, 429, "stream-limit", 60);
    bucket.streams++;
    res.once("close", () => { bucket.streams--; bucket.lastSeen = now(); });
    return true;
  }

  return { admit, openStream, close: () => clearInterval(timer) };
}
