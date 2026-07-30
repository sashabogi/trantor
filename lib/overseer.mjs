const PEER_LIVE_MS = 5 * 60 * 1000;
const CLAIM_LIVE_MS = 10 * 60 * 1000;

const KINDS = new Set(["same-project-sessions", "file-conflict", "linked-activity"]);

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
  return isLevel(fallback) ? fallback : 1;
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
  out.push({
    project: collision.project,
    kind: collision.kind,
    sessions: sortedStrings(collision.sessions),
    files: sortedStrings(collision.files ?? []),
    detail: collision.detail,
  });
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

export function detectCollisions({ peers = [], claims = [], links = [], autonomy = {}, now } = {}) {
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

  const sessionsByProject = new Map();
  for (const peer of livePeers) {
    const sessions = sessionsByProject.get(peer.project) ?? [];
    sessions.push(peer.session);
    sessionsByProject.set(peer.project, sessions);
  }

  for (const project of sortedStrings(sessionsByProject.keys())) {
    const sessions = sortedStrings(sessionsByProject.get(project));
    if (sessions.length < 2) continue;
    pushCollision(out, {
      project,
      kind: "same-project-sessions",
      sessions,
      files: [],
      detail: `${sessions.join(", ")} are live on project ${project}.`,
    });
  }

  const claimSessionsByFile = new Map();
  for (const claim of asArray(claims)) {
    const project = clean(claim?.project);
    const file = clean(claim?.file);
    const session = clean(claim?.session);
    if (!project || !file || !session || !isFresh(claim?.ts, at, CLAIM_LIVE_MS)) continue;
    const key = `${project}\u0000${file}`;
    const sessions = claimSessionsByFile.get(key) ?? new Set();
    sessions.add(session);
    claimSessionsByFile.set(key, sessions);
  }

  for (const key of [...claimSessionsByFile.keys()].sort()) {
    const [project, file] = key.split("\u0000");
    const sessions = sortedStrings(claimSessionsByFile.get(key));
    if (sessions.length < 2) continue;
    pushCollision(out, {
      project,
      kind: "file-conflict",
      sessions,
      files: [file],
      detail: `${sessions.join(", ")} have live claims on ${project}/${file}.`,
    });
  }

  for (const link of asArray(links)) {
    const projects = sortedStrings(link?.projects ?? []);
    if (projects.length < 2) continue;
    const activeProjects = projects.filter((project) => (sessionsByProject.get(project) ?? []).length > 0);
    if (activeProjects.length < 2) continue;
    const sessions = sortedStrings(activeProjects.flatMap((project) => sessionsByProject.get(project) ?? []));
    pushCollision(out, {
      project: activeProjects[0],
      kind: "linked-activity",
      sessions,
      files: [],
      detail: `Linked projects ${activeProjects.join(", ")} have live sessions ${sessions.join(", ")}.`,
    });
  }

  const deduped = new Map();
  for (const collision of sortCollisions(out)) deduped.set(collisionKey(collision), collision);
  return [...deduped.values()];
}
