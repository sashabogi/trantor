#!/usr/bin/env node
// trantor new — project genesis, the CLI half (#5862). One command stands a project up:
//
//   trantor new <name> [--from <git-url>] [--brief <file>] [--dir <parent>] [--adopt] [--json]
//
// It makes the project directory at <parent>/<name> — --dir names the PARENT, never the project
// directory itself (default parent: TRANTOR_DEV_ROOT or ~/development). The name is always
// appended under it, so `--dir P` with name N creates P/N. Starts git on main (or clones --from,
// or adopts an existing folder with --adopt), seeds CLAUDE.md from the
// brief (verbatim brief + the trantor conventions block), installs the same auto-card hook as
// `trantor init-hooks`, posts the brief as the hub project brief (POST /project — the same call
// relay_project_brief makes), and opens the first card "genesis: <name>" on the new board.
//
// It NEVER spawns a session: the wake is genesis-2, the app half. A hub that is down downgrades
// the genesis to a warning (card: null) — the directory is real either way, and a dead hub must
// not make a made project look unmade.
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync, appendFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { ensureEnrolled, loadIdentity, signedPost } from "../hooks/lib/api.mjs";
import { setAutonomy } from "../lib/autonomy.mjs";
import { resolveHub, setProjectHub } from "../lib/project.mjs";

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));

// The trantor conventions block — what every trantor-wired project's CLAUDE.md carries so the
// first session knows the board, the crew, and the gates exist. Kept SHORT and factual; the
// brief above it is the project's own voice.
const CONVENTIONS = [
  "",
  "## Trantor conventions",
  "",
  "This project is wired into Trantor (the board, the bus, the crew):",
  "",
  "- **Board** — work lives on the board, not in anyone's head. `trantor catchup` answers",
  "  \"where are we?\"; the desktop app (`trantor app install`) shows the live board.",
  "- **Crew** — `trantor up codex kimi glm` fires seats into their own worktrees; contracts go",
  "  over the bus (`relay_send`), and every seat reports what became of its card. See the",
  "  `/trantor:crew` skill for the full doctrine before firing anything.",
  "- **Gates** — a card reaches done only with real evidence: the test command, the counts,",
  "  and the observed behavior. \"It should work\" is not a state a card can be in.",
  "- **Commits card themselves** — the post-commit hook (trantor auto-card) backfills the board",
  "  from git; keep commit messages in the imperative and reference card ids when one exists.",
  "",
].join("\n");

const die = (msg) => { console.error(`trantor new: ${msg}`); process.exit(1); };

// ── args ────────────────────────────────────────────────────────────────────────────────────────
const args = process.argv.slice(2);
const flag = (n) => { const i = args.indexOf("--" + n); return i >= 0 ? args[i + 1] : null; };
const has = (n) => args.includes("--" + n);
const json = has("json");
const name = args.find(a => !a.startsWith("--"));
if (!name) die("usage: trantor new <name> [--from <git-url>] [--brief <file>] [--dir <parent>] [--adopt] [--json] — project lands at <parent>/<name>");
if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(name)) die(`invalid project name "${name}" — letters, digits, dot, dash, underscore`);
const from = flag("from");
const briefFile = flag("brief");
const adopt = has("adopt");
// The brief is read BEFORE anything is created: a refused genesis must leave no directory behind.
let brief = "";
if (briefFile) {
  if (!existsSync(briefFile)) die(`brief file not found: ${briefFile}`);
  brief = readFileSync(briefFile, "utf8").trimEnd();
}

// ── the directory ───────────────────────────────────────────────────────────────────────────────
const dirArg = flag("dir");
const devRoot = dirArg
  ? resolve(dirArg)
  : (process.env.TRANTOR_DEV_ROOT ? resolve(process.env.TRANTOR_DEV_ROOT) : join(homedir(), "development"));
if (dirArg && !isAbsolute(dirArg)) { /* relative --dir is allowed; resolved above */ }
const dir = isAbsolute(name) ? name : join(devRoot, name);

const existed = existsSync(dir);
const occupied = existed && readdirSync(dir).length > 0;
if (occupied && !adopt) die(`"${dir}" already exists and is not empty — pass --adopt to adopt it`);
if (adopt && !existed) die(`--adopt: "${dir}" does not exist — nothing to adopt`);
if (!existed) mkdirSync(dir, { recursive: true });

// ── git ─────────────────────────────────────────────────────────────────────────────────────────
const git = (gitArgs) => spawnSync("git", gitArgs, { cwd: dir, encoding: "utf8" });
const gitOk = (r, what) => { if (r.status !== 0) die(`${what} failed: ${(r.stderr || r.stdout || "").trim()}`); };

let branch;
if (from) {
  gitOk(git(["clone", from, "."]), "git clone");
  branch = git(["branch", "--show-current"]).stdout.trim() || "main";
} else {
  if (!existsSync(join(dir, ".git"))) gitOk(git(["init", "-b", "main"]), "git init");
  branch = git(["branch", "--show-current"]).stdout.trim() || "main";
}

// ── CLAUDE.md — verbatim brief + the conventions block ──────────────────────────────────────────
const claude = join(dir, "CLAUDE.md");
if (existsSync(claude)) {
  const current = readFileSync(claude, "utf8");
  if (!current.includes("## Trantor conventions")) appendFileSync(claude, `\n${CONVENTIONS}\n`);
} else {
  const head = brief ? `${brief}\n` : `# ${name}\n\n(Genesis — no brief was given. Add this project's what/why/goal here.)\n`;
  writeFileSync(claude, `${head}${CONVENTIONS}`);
}

// ── hooks — the SAME install trantor init-hooks performs, in the new repo ───────────────────────
const hook = spawnSync(process.execPath, [join(ROOT, "bin", "init-hooks.mjs")], { cwd: dir, encoding: "utf8" });
if (hook.status !== 0) die(`hook install failed: ${(hook.stderr || "").trim()}`);

// A new project is a new trust boundary. Pin its harness dial even when the machine-wide default
// is bypass, so opening it can never inherit another project's permission choice.
setAutonomy(name, { harness: "prompt" });

// ── the hub: pin + brief + first card, signed like every other client ──────────────────────────
const hub = resolveHub(name);
// Pin the new project to the hub it posts to (#5862 residual): without the pin, the first
// session in the dir falls back to the global default and wears the "not pinned to a hub"
// warning even though genesis chose this hub deliberately. Same persistence as `trantor hub set`.
setProjectHub(name, hub);
const session = process.env.RELAY_SESSION || `genesis:${name}`;
const identity = loadIdentity(session);
let card = null;
let hubError = null;
try {
  await ensureEnrolled(session, identity, name);
  const briefForHub = (brief || `Genesis of ${name} — created by trantor new.`).slice(0, 600);
  const r1 = await signedPost("/project", { project: name, brief: briefForHub, by: session }, { session, project: name, timeoutMs: 8000 });
  if (!r1.ok) throw new Error(`hub ${r1.status} on /project`);
  const r2 = await signedPost("/task", {
    project: name,
    title: `genesis: ${name}`,
    status: "todo",
    by: session,
    note: "project genesis — created by trantor new",
  }, { session, project: name, timeoutMs: 8000 });
  if (!r2.ok) throw new Error(`hub ${r2.status} on /task`);
  card = r2.json?.task?.id ?? null;
} catch (e) {
  hubError = e instanceof Error ? e.message : String(e);
  console.error(`trantor new: hub unreachable or refusing (${hubError}) — the project exists locally; the brief and first card were NOT posted.`);
}

// ── report ──────────────────────────────────────────────────────────────────────────────────────
// dir is the created project directory <parent>/<name>; parent is the --dir (or default) root the
// name was appended under — the two together state the parent contract explicitly.
if (json) {
  console.log(JSON.stringify({ name, parent: devRoot, dir, branch, hub, card }));
} else {
  console.log(`✓ ${dir} (${branch}${from ? ", cloned" : adopt ? ", adopted" : ""})`);
  console.log(`✓ CLAUDE.md seeded${brief ? " from the brief" : " (no brief — add the project's what/why/goal)"}`);
  console.log(`✓ auto-card hook installed (trantor init-hooks)`);
  if (card !== null) console.log(`✓ hub ${hub}: brief posted, card #${card} ("genesis: ${name}")`);
  else if (hubError) console.log(`! hub ${hub}: brief/card not posted (${hubError})`);
  console.log(`\nNext: cd ${dir} && claude — or fire the crew with \`trantor up\`. No session was spawned.`);
}
