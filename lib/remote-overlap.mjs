// #11311: client-side open-PR overlap evidence. The session's OWN hook polls the repo it is
// actually editing (`git -C <gitRoot> remote get-url origin`) — never the hub, whose checkout and
// unauthenticated gh would match trantor's PRs to every project. Cached 5 min per repo in
// ~/.agent-bus/remote-overlap-<owner>-<name>.json; gh missing/unauthenticated = off, one log line.
import { execFile, spawnSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";

const POLL_TTL_MS = 5 * 60 * 1000;
const RATE_LIMIT_BACKOFF_MS = 10 * 60 * 1000;
const BLIP_BACKOFF_MS = 30 * 1000;
const GH_TIMEOUT_MS = Number(process.env.RELAY_REMOTE_OVERLAP_TIMEOUT_MS || 5000);
// Cap PRs per poll: each costs a /files call, and a busy repo must not eat the rate limit.
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

function defaultGhRun(args) {
  const r = spawnSync("gh", args, { encoding: "utf8", timeout: GH_TIMEOUT_MS, maxBuffer: 16 * 1024 * 1024 });
  if (r.error && !r.error.message?.includes("exited with")) {
    return { code: r.error.code ?? 1, stdout: "", stderr: String(r.stderr || r.error.message || "") };
  }
  return { code: r.status ?? 1, stdout: r.stdout || "", stderr: r.stderr || "" };
}

// Repo detection: `git remote get-url origin` from the session's git root. Null when there is
// no origin or it is not a GitHub-ish remote — the poller stays quietly off.
export function detectRepo({ dir = process.cwd(), run = defaultGitRun } = {}) {
  try {
    const r = run(["remote", "get-url", "origin"], { cwd: dir });
    return r.status === 0 ? parseRepoUrl(r.stdout) : null;
  } catch {
    return null;
  }
}

const cleanPaths = (files) =>
  [...new Set(Array.from(files ?? []).map((f) => String(f ?? "").trim()).filter(Boolean))].sort((a, b) => a.localeCompare(b));

// The poller. overlapsFor({repo, gitRoot, files}) is SYNC: cache file read first (the norm), a
// stale or cold repo triggers one gh poll (list + per-PR files) whose result rewrites the cache,
// so sibling processes (other claims, other seats) hit the warm file. rate-limit and gh-off state
// persist in the cache file too, so backoff survives the hook's short-lived processes.
export function createRemoteOverlap({
  run = defaultGhRun,
  gitRun = defaultGitRun,
  log = (m) => console.error(`[remote-overlap] ${m}`),
  now = Date.now,
  ttlMs = POLL_TTL_MS,
  backoffMs = RATE_LIMIT_BACKOFF_MS,
  cacheDir,
} = {}) {
  const dir = cacheDir || process.env.AGENT_BUS_DIR || join(homedir(), ".agent-bus");
  let enabled = true;
  let logged = "";

  const say = (m) => {
    if (!logged) {
      logged = m;
      log(m);
    }
  };

  const cachePath = (repo) => join(dir, `remote-overlap-${String(repo).replace(/\//g, "-")}.json`);
  const readCache = (repo) => {
    try {
      return JSON.parse(readFileSync(cachePath(repo), "utf8"));
    } catch {
      return null;
    }
  };
  const writeCache = (repo, data) => {
    try {
      mkdirSync(dir, { recursive: true });
      writeFileSync(cachePath(repo), JSON.stringify({ repo, at: now(), prs: [], off: "", blockedUntil: 0, ...data }));
    } catch {}
  };

  function fail(repo, res) {
    const stderr = String(res?.stderr || "");
    if (res?.code === "ENOENT" || GH_OFF.test(stderr)) {
      enabled = false;
      say(`gh unusable (${res?.code === "ENOENT" ? "gh not found" : "not authenticated"}) — remote-overlap off.`);
      writeCache(repo, { off: "gh missing or unauthenticated", prs: [] });
      return null;
    }
    const prior = readCache(repo);
    const blockedUntil = RATE_LIMIT.test(stderr) ? (say(`GitHub rate limit hit — polling paused ${Math.round(backoffMs / 60000)}m.`), now() + backoffMs) : now() + BLIP_BACKOFF_MS;
    writeCache(repo, { at: prior?.at ?? 0, prs: prior?.prs ?? [], blockedUntil, off: "" });
    return null;
  }

  function poll(repo) {
    const list = run(["api", `repos/${repo}/pulls?state=open`]);
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
      const res = run(["api", `repos/${repo}/pulls/${number}/files`]);
      let files = [];
      if (res.code === 0) {
        try {
          files = cleanPaths(JSON.parse(res.stdout || "[]").map((f) => f?.filename));
        } catch {
          files = [];
        }
      }
      prs.push({ number, author: String(p?.user?.login || ""), url: String(p?.html_url || ""), files });
    }
    const data = { repo, at: now(), prs, off: "", blockedUntil: 0 };
    writeCache(repo, data);
    return data;
  }

  function overlapsFor(input = {}) {
    if (!enabled) return [];
    const want = cleanPaths(input.files);
    if (!want.length) return [];
    const repo = String(input.repo || "").trim() || (input.gitRoot ? detectRepo({ dir: input.gitRoot, run: gitRun }) : null);
    if (!repo) return [];
    const t = now();
    let data = readCache(repo);
    if (!data || data.off) {
      // a fresh off marker stays off without spawning gh; past the TTL the poll retries once
      if (data?.off && t - (data.at ?? 0) <= ttlMs) return [];
      poll(repo);
      data = readCache(repo);
      if (!data || data.off) return [];
    } else if (t - (data.at ?? 0) > ttlMs && t >= (data.blockedUntil ?? 0)) {
      poll(repo);
      data = readCache(repo) ?? data;
    }
    const wantSet = new Set(want);
    const out = [];
    for (const p of data.prs ?? []) {
      const hit = (p.files || []).filter((f) => wantSet.has(f));
      if (hit.length) out.push({ repo, number: p.number, author: p.author, url: p.url, files: cleanPaths(hit) });
    }
    return out.sort((a, b) => a.number - b.number);
  }

  // Force a poll, cache result, return it (or null on failure) — the test seam and warm-up path.
  function refresh(repo) {
    return poll(repo);
  }

  return {
    overlapsFor,
    refresh,
    get enabled() {
      return enabled;
    },
  };
}

const defaultApi = createRemoteOverlap({});

// The hook-facing seam: never raises, whatever the input.
export function overlapsFor(input) {
  try {
    return defaultApi.overlapsFor(input);
  } catch {
    return [];
  }
}
