// Windows are read from env ONCE at load (calls stay pure): without an override, a test cannot
// observe a condition CLEARING — peers stay "live" for five minutes no matter what the test does,
// so the episode-recurrence path was untestable and therefore unproven.
const PEER_LIVE_MS = Number(process.env.RELAY_OVERSEER_PEER_LIVE_MS || 5 * 60 * 1000);
const CLAIM_LIVE_MS = Number(process.env.RELAY_OVERSEER_CLAIM_LIVE_MS || 10 * 60 * 1000);
const KINDS = new Set(["same-project-sessions", "file-conflict", "linked-activity"]);
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
  // The same claims indexed by PATH ALONE, project dropped. A claim's `project` is the CLAIMANT's
  // project, not the file's, so one path claimed under two project names is two sessions on one
  // file — the cross-project overlap that claimSessionsByFile, keyed on project+file, structurally
  // cannot see. linked-activity reads this one.
  const claimProjectsByPath = new Map();
  for (const claim of asArray(claims)) {
    const project = clean(claim?.project);
    const file = clean(claim?.file);
    const session = clean(claim?.session);
    if (!project || !file || !session || !isFresh(claim?.ts, at, CLAIM_LIVE_MS)) continue;
    const key = `${project}\u0000${file}`;
    const sessions = claimSessionsByFile.get(key) ?? new Set();
    sessions.add(session);
    claimSessionsByFile.set(key, sessions);
    const byProject = claimProjectsByPath.get(file) ?? new Map();
    byProject.set(project, (byProject.get(project) ?? new Set()).add(session));
    claimProjectsByPath.set(file, byProject);
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

  // A link is DECLARED — the operator already told us these projects move together, so two sessions
  // being LIVE on both sides restates the operator's own declaration and stays true for as long as
  // the machine is on. crebral-health ↔ crebral-scribe produced 468 identical warnings across 8 days
  // (2026-08-12 audit); trantor ↔ trantor-duty is codependent by policy, so on that machine the
  // condition is permanent (#7029: it woke a seat that then spent a full turn proving a negative).
  // Presence is a STATE. Narrowing it to "both sides are executing" was still a state — a busier
  // one. The only thing worth a wake is an EVENT: two sessions actually on the same thing. There
  // are exactly two the hub already holds, so neither has to be invented —
  //   (1) one FILE PATH claimed live from both sides of the link (file claims exist for this; the
  //       file-conflict kind keys on project+file and so is blind across projects), and
  //   (2) one CARD ID held (doing/testing) by live sessions from both sides — `assignee` is intent
  //       and `workedBy` is the signed evidence of who actually moved it, so a card wearing two
  //       live faces from two linked projects is two sessions on one piece of work.
  // No event, no warning. This under-warns by construction and that is the intended bias: a warning
  // that fires on a permanent condition teaches its readers to ignore it.
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

  const deduped = new Map();
  for (const collision of sortCollisions(out)) deduped.set(collisionKey(collision), collision);
  return [...deduped.values()];
}
