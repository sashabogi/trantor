// #11311: open-PR overlap evidence for the overseer — a cached, rate-limit-aware poll of open PRs
// and their changed files via gh. gh missing or unauthenticated turns the poller OFF with one log
// line; it must never raise, because warn-level evidence may never break the hub tick.
import { execFile, spawnSync } from "node:child_process";

const POLL_TTL_MS = 5 * 60 * 1000;
const RATE_LIMIT_BACKOFF_MS = 10 * 60 * 1000;
const BLIP_BACKOFF_MS = 30 * 1000;
// Cap PRs per poll: each one costs a /files call, and a busy repo must not eat the rate limit.
const PR_CAP = 25;

const GH_OFF = /gh auth login|not logged into|gh: auth|authentication/i;
const RATE_LIMIT = /rate limit/i;

// "owner/name" from every remote form in the wild — https, ssh, git://, with credentials or a
// .git suffix — or a bare owner/name that is already parsed. Anything else is not pollable.
export function parseRepoUrl(url) {
  const raw = String(url ?? "").trim();
  if (!raw) return null;
  if (/^[\w.-]+\/[\w.-]+$/.test(raw)) return raw;
  const m = raw.match(/^(?:(?:https?:\/\/|ssh:\/\/|git:\/\/)(?:[^@/]+@)?|git@)?[^/:@]+[:/](.+?)(?:\.git)?\/?$/i);
  const parts = m ? m[1].replace(/\.git$/i, "").split("/").filter(Boolean) : [];
  const owner = parts[parts.length - 2];
  const name = parts[parts.length - 1];
  return owner && name && /^[\w.-]+$/.test(owner) && /^[\w.-]+$/.test(name) ? `${owner}/${name}` : null;
}

function defaultGitRun(args, { cwd } = {}) {
  const r = spawnSync("git", args, { cwd, encoding: "utf8", timeout: 5000 });
  return { status: r.status, stdout: r.stdout || "", stderr: r.stderr || "" };
}

// Repo detection: `git remote get-url origin` from the session's git root. Null when there is
// no origin or it is not a GitHub-ish remote — the detector stays quietly off.
export function detectRepo({ dir = process.cwd(), run = defaultGitRun } = {}) {
  try {
    const r = run(["remote", "get-url", "origin"], { cwd: dir });
    return r.status === 0 ? parseRepoUrl(r.stdout) : null;
  } catch {
    return null;
  }
}

function defaultGhRun(args) {
  return new Promise((resolve) => {
    execFile("gh", args, { encoding: "utf8", timeout: 10_000, maxBuffer: 16 * 1024 * 1024 },
      (error, stdout, stderr) => {
        if (!error) return resolve({ code: 0, stdout, stderr: "" });
        resolve({ code: error.code ?? 1, stdout: String(stdout ?? ""), stderr: String(stderr || error.message || "") });
      });
  });
}

const cleanPaths = (files) =>
  [...new Set(Array.from(files ?? []).map((f) => String(f ?? "").trim()).filter(Boolean))].sort((a, b) => a.localeCompare(b));

// The cached poller. refresh(repo) is the only async path and never rejects; overlapsFor(repo,
// files) is a SYNC read of the last good poll (the overseer tick is sync), kicking a background
// refresh when the cache is stale or cold, so early ticks answer [] and evidence lands next tick.
export function createRemoteOverlap({
  run = defaultGhRun,
  log = (m) => console.error(`[remote-overlap] ${m}`),
  now = Date.now,
  ttlMs = POLL_TTL_MS,
  backoffMs = RATE_LIMIT_BACKOFF_MS,
} = {}) {
  let enabled = true;
  let blockedUntil = 0;
  const caches = new Map();
  const inflight = new Map();

  const stop = (reason) => {
    if (!enabled) return;
    enabled = false;
    log(`gh unusable (${reason}) — remote-overlap evidence off.`);
  };

  function fail(repo, res) {
    const stderr = String(res?.stderr || "");
    if (res?.code === "ENOENT" || GH_OFF.test(stderr)) {
      stop("gh missing or unauthenticated");
      return null;
    }
    if (RATE_LIMIT.test(stderr)) {
      blockedUntil = now() + backoffMs;
      log(`GitHub rate limit hit — polling paused ${Math.round(backoffMs / 60000)}m, stale evidence stays in use.`);
    } else {
      blockedUntil = now() + BLIP_BACKOFF_MS;
    }
    return caches.get(repo) ?? null;
  }

  async function poll(repo) {
    const list = await run(["api", `repos/${repo}/pulls?state=open`]);
    if (list.code !== 0) return fail(repo, list);
    let pulls;
    try {
      pulls = JSON.parse(list.stdout || "[]");
    } catch {
      return fail(repo, { code: list.code, stderr: "unparsable PR list" });
    }
    if (!Array.isArray(pulls)) return fail(repo, { code: list.code, stderr: "unexpected PR list shape" });
    const prs = [];
    for (const p of pulls.slice(0, PR_CAP)) {
      const number = Number(p?.number);
      if (!Number.isFinite(number)) continue;
      const res = await run(["api", `repos/${repo}/pulls/${number}/files`]);
      let files = [];
      if (res.code === 0) {
        try {
          files = cleanPaths(JSON.parse(res.stdout || "[]").map((f) => f?.filename));
        } catch {
          files = [];
        }
      }
      prs.push({ pr: number, author: String(p?.user?.login || ""), url: String(p?.html_url || ""), files });
    }
    caches.set(repo, { at: now(), prs });
    return caches.get(repo);
  }

  function refresh(repo) {
    if (!repo || !enabled) return Promise.resolve(null);
    if (now() < blockedUntil) return Promise.resolve(caches.get(repo) ?? null);
    const cached = caches.get(repo);
    if (cached && now() - cached.at <= ttlMs) return Promise.resolve(cached);
    let pending = inflight.get(repo);
    if (!pending) {
      pending = poll(repo)
        .catch((e) => fail(repo, { code: e?.code ?? 1, stderr: e?.message ?? String(e) }))
        .finally(() => inflight.delete(repo));
      inflight.set(repo, pending);
    }
    return pending;
  }

  function overlapsFor(repo, files) {
    if (!repo || !enabled) return [];
    const want = cleanPaths(files);
    if (want.length === 0) return [];
    let cached = caches.get(repo);
    if (!cached || now() - cached.at > ttlMs) void refresh(repo);
    const wantSet = new Set(want);
    const out = [];
    for (const p of caches.get(repo)?.prs ?? []) {
      const hit = (p.files || []).filter((f) => wantSet.has(f));
      if (hit.length) out.push({ pr: p.pr, author: p.author, url: p.url, files: cleanPaths(hit) });
    }
    return out.sort((a, b) => a.pr - b.pr);
  }

  return {
    overlapsFor,
    refresh,
    get enabled() {
      return enabled;
    },
  };
}
