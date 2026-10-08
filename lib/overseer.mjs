// Windows are read from env ONCE at load (calls stay pure): without an override, a test cannot
// observe a condition CLEARING — peers stay "live" for five minutes no matter what the test does,
// so the episode-recurrence path was untestable and therefore unproven.
const PEER_LIVE_MS = Number(process.env.RELAY_OVERSEER_PEER_LIVE_MS || 5 * 60 * 1000);
const CLAIM_LIVE_MS = Number(process.env.RELAY_OVERSEER_CLAIM_LIVE_MS || 10 * 60 * 1000);
const KINDS = new Set(["same-project-sessions", "file-conflict", "linked-activity", "remote-overlap"]);
// A card in `todo` is queued, not held; `done`/`failed`/`blocked` are nobody's hands. Only these
// two mean a session has it open right now.
const HELD_STATUSES = new Set(["doing", "testing"]);

const asArray = (v) => Array.isArray(v) ? v : [];
const clean = (v) => String(v ?? "").trim();
const finiteNumber = (v) => Number.isFinite(Number(v)) ? Number(v) : null;

function isLevel(v) {
  return v === 1 || v === 2 || v === 3 || v === 4;
}

export function levelFor(project, autonomy = {}) {
  const key = clean(project);
  const direct = autonomy?.[key];
  if (isLevel(direct)) return direct;
  const fallback = autonomy?.["*"];
  return isLevel(fallback) ? fallback : 2;
}

export function checkoutKey({ project, gitRoot }) {
  return JSON.stringify(gitRoot ? ["checkout", gitRoot] : ["project", project]);
}

export function collisionIdentity(collision) {
  // #11311: remote episodes are PROJECT/repo/PR/file per the orchestrator's spec — project, not
  // checkoutKey, so one gitRoot shared across projects never merges two projects' remote episodes.
  const base = collision.kind === "remote-overlap" ? clean(collision.project) : checkoutKey(collision);
  const remote = collision.kind === "remote-overlap" ? ` ${clean(collision.repo)}#${finiteNumber(collision.pr) ?? ""}` : "";
  return `${base} ${collision.kind} ${(collision.files || []).join(",")}${remote}`;
}

function isFresh(ts, now, ttl) {
  const n = finiteNumber(ts);
  return n != null && now - n <= ttl;
}

function sortedStrings(items) {
  return [...new Set(Array.from(items ?? []).map(clean).filter(Boolean))].sort((a, b) => a.localeCompare(b));
}

function pushCollision(out, collision) {
  if (!collision.project || !KINDS.has(collision.kind) || collision.sessions.length === 0) return;
  const row = {
    project: collision.project,
    kind: collision.kind,
    sessions: sortedStrings(collision.sessions),
    files: sortedStrings(collision.files ?? []),
    detail: collision.detail,
  };
  if (collision.gitRoot) { row.gitRoot = collision.gitRoot; row.projects = collision.projects; }
  // (repo, PR number, file) is the remote-overlap episode identity — collisionIdentity appends it.
  if (collision.repo) { row.repo = clean(collision.repo); row.pr = finiteNumber(collision.pr); }
  out.push(row);
}

function collisionKey(c) {
  return [
    c.project,
    c.kind,
    c.files[0] ?? "",
    c.sessions[0] ?? "",
    c.detail,
  ].join("\u0000");
}

function sortCollisions(collisions) {
  return [...collisions].sort((a, b) =>
    a.project.localeCompare(b.project) ||
    a.kind.localeCompare(b.kind) ||
    (a.files[0] ?? "").localeCompare(b.files[0] ?? "") ||
    (a.sessions[0] ?? "").localeCompare(b.sessions[0] ?? "") ||
    a.detail.localeCompare(b.detail)
  );
}

export function detectCollisions({ peers = [], claims = [], links = [], cards = [], autonomy = {}, now } = {}) {
  const at = finiteNumber(now) ?? 0;
  const out = [];

  const livePeers = [];
  const seenPeers = new Set();
  for (const peer of asArray(peers)) {
    const session = clean(peer?.session);
    const project = clean(peer?.project);
    if (!session || !project || !isFresh(peer?.lastSeen, at, PEER_LIVE_MS)) continue;
    const key = `${project}\u0000${session}`;
    if (seenPeers.has(key)) continue;
    seenPeers.add(key);
    livePeers.push({ ...peer, session, project });
  }

  const sessionsByCheckout = new Map();
  for (const peer of livePeers) {
    const key = checkoutKey(peer);
    const group = sessionsByCheckout.get(key) ?? [];
    group.push(peer);
    sessionsByCheckout.set(key, group);
  }
  for (const group of sessionsByCheckout.values()) {
    const sessions = sortedStrings(group.map(p => p.session));
    if (sessions.length < 2) continue;
    const projects = sortedStrings(group.map(p => p.project));
    const gitRoot = clean(group[0].gitRoot);
    pushCollision(out, {
      project: projects[0], projects, gitRoot,
      kind: "same-project-sessions", sessions, files: [],
      detail: `${sessions.join(", ")} are live on ${gitRoot ? `checkout ${gitRoot}` : `project ${projects[0]}`}.`,
    });
  }

  const claimSessionsByFile = new Map();
  // The same claims indexed by PATH ALONE, project dropped. A claim's `project` is the CLAIMANT's
  // project, not the file's, so one path claimed under two project names is two sessions on one
  // file — the cross-project overlap that claimSessionsByFile, keyed on project+file, structurally
  // cannot see. linked-activity reads this one.
  const claimProjectsByPath = new Map();
  const liveClaims = [];
  for (const claim of asArray(claims)) {
    const project = clean(claim?.project);
    const file = clean(claim?.file);
    const session = clean(claim?.session);
    if (!project || !file || !session || !isFresh(claim?.ts, at, CLAIM_LIVE_MS)) continue;
    const gitRoot = clean(claim.gitRoot || livePeers.find(p => p.session === session)?.gitRoot);
    const key = JSON.stringify([checkoutKey({ project, gitRoot }), file]);
    liveClaims.push({ project, file, session, gitRoot, key, remote: claim.remote });
    const group = claimSessionsByFile.get(key) ?? { gitRoot, file, sessions: new Set(), projects: new Set() };
    group.sessions.add(session);
    group.projects.add(project);
    claimSessionsByFile.set(key, group);
    const byProject = claimProjectsByPath.get(file) ?? new Map();
    byProject.set(project, (byProject.get(project) ?? new Set()).add(session));
    claimProjectsByPath.set(file, byProject);
  }

  for (const key of [...claimSessionsByFile.keys()].sort()) {
    const group = claimSessionsByFile.get(key);
    const projects = sortedStrings(group.projects);
    const project = projects[0], file = group.file;
    const sessions = sortedStrings(group.sessions);
    if (sessions.length < 2) continue;
    pushCollision(out, {
      project,
      kind: "file-conflict", gitRoot: group.gitRoot, projects,
      sessions,
      files: [file],
      detail: `${sessions.join(", ")} have live claims on ${group.gitRoot || project}/${file}.`,
    });
  }

  // A link is DECLARED, so two live sessions on both sides is a permanent state, not an event (#7029).
  // Only an event warns: one file path claimed, or one card held, from both sides of the link.
  const projectOfSession = new Map();
  for (const peer of livePeers) if (!projectOfSession.has(peer.session)) projectOfSession.set(peer.session, peer.project);

  const heldCards = [];
  for (const card of asArray(cards)) {
    const id = finiteNumber(card?.id);
    if (id == null || !HELD_STATUSES.has(clean(card?.status))) continue;
    // Only LIVE sessions count. A card assigned to a seat that went home is not a collision.
    const holders = sortedStrings([card?.assignee, card?.workedBy]).filter((s) => projectOfSession.has(s));
    if (holders.length < 2) continue;
    heldCards.push({ id, holders });
  }

  for (const link of asArray(links)) {
    const projects = sortedStrings(link?.projects ?? []);
    if (projects.length < 2) continue;
    const inLink = new Set(projects);
    const files = [];
    const sessions = new Set();
    const contested = new Set();
    const evidence = [];

    for (const path of [...claimProjectsByPath.keys()].sort()) {
      const claimSides = [...claimProjectsByPath.get(path).entries()].filter(([project]) => inLink.has(project));
      if (claimSides.length < 2) continue;
      const claimants = sortedStrings(claimSides.flatMap(([, ss]) => [...ss]));
      if (claimants.length < 2) continue;
      files.push(path);
      for (const [project] of claimSides) contested.add(project);
      for (const s of claimants) sessions.add(s);
      evidence.push(`${path} is claimed by ${claimants.join(", ")}`);
    }

    for (const card of heldCards) {
      const holders = card.holders.filter((s) => inLink.has(projectOfSession.get(s)));
      const holderProjects = new Set(holders.map((s) => projectOfSession.get(s)));
      if (holderProjects.size < 2) continue;
      for (const project of holderProjects) contested.add(project);
      for (const s of holders) sessions.add(s);
      evidence.push(`card #${card.id} is held by ${holders.join(", ")}`);
    }

    if (evidence.length === 0) continue;
    // ONE collision per link, evidence and all. The episode key downstream is project+kind+files, so
    // per-file splitting would mint a fresh episode (and a fresh wake) every time the evidence set
    // shifted — the same volatility that made membership a bad episode key (#5350). A second
    // contended card inside a standing episode therefore stays silent; under-warning is the bias.
    const sides = sortedStrings(contested);
    pushCollision(out, {
      project: sides[0] ?? projects[0],
      kind: "linked-activity",
      sessions: [...sessions],
      files,
      detail: `Linked projects ${sides.join(", ")} are on the same work: ${evidence.join("; ")}.`,
    });
  }

  // #11311: open-PR evidence is computed CLIENT-SIDE (hooks/file-claim.mjs polls the claimant's
  // own checkout via lib/remote-overlap.mjs) and rides the claim as its `remote` field — repo- and
  // checkout-scoped by construction, one collision per (repo, PR, file) triple, warn-level, gone
  // when the PR closes. That triple IS the episode identity (collisionIdentity appends repo#pr).
  for (const claim of liveClaims) {
    // sessions are PROJECT-scoped (orchestrator spec): everyone live on this project+file joins
    // the episode, whatever checkout they push from — a gitRoot is not a project boundary.
    const coSessions = sortedStrings(
      liveClaims.filter((c) => c.project === claim.project && c.file === claim.file).map((c) => c.session)
    );
    for (const r of asArray(claim.remote)) {
      const pr = finiteNumber(r?.number);
      const repo = clean(r?.repo);
      if (pr == null || !repo || !repo.includes("/")) continue;
      const author = clean(r?.author) || "unknown";
      const url = clean(r?.url);
      for (const file of sortedStrings(r.files)) {
        if (file !== claim.file) continue;
        pushCollision(out, {
          project: claim.project,
          kind: "remote-overlap",
          gitRoot: claim.gitRoot,
          sessions: coSessions,
          files: [file],
          repo,
          pr,
          detail: `open PR #${pr} by ${author} in ${repo} also changes ${file}${url ? ` (${url})` : ""}.`,
        });
      }
    }
  }

  const deduped = new Map();
  for (const collision of sortCollisions(out)) deduped.set(collisionKey(collision), collision);
  return [...deduped.values()];
}
