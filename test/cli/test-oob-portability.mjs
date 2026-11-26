#!/usr/bin/env node
// #14322 out-of-the-box portability, CLI and hooks side: a stranger's fresh machine (empty HOME, one local
// loopback hub, no owner key, no scrooge registry) must not be told it is broken, and nothing opens
// windows or injects the operator's doctrine unless it is opted in. Env is injected into children and
// pure helpers; this process never mutates its own env.
import http from "node:http";
import { spawn, spawnSync, execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync, realpathSync, chmodSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { shouldWarnUnpinned, wantsBuildDoctrine, loopbackUrl } from "../../hooks/lib/start-gates.mjs";
import { tofuEnroll } from "../../lib/enroll.mjs";
import { autoHandoffEnabled, manualContinueLine } from "../../hooks/lib/handoff.mjs";
import { seatCliProblem, seatCli } from "../../lib/agent-preferences.mjs";
import { localCheckoutFor } from "../../lib/project.mjs";
import { parseJsonc } from "../../lib/jsonc.mjs";
import { excludeGraftLocally } from "../../bin/crew/open.mjs";

const ROOT = fileURLToPath(new URL("../..", import.meta.url));
let pass = 0, fail = 0;
const ok = (name, cond, detail = "") => {
  console.log(`  ${cond ? "PASS" : "FAIL"}  ${name}${cond || !detail ? "" : ` — ${detail}`}`);
  cond ? pass++ : fail++;
};
const scratch = mkdtempSync(join(tmpdir(), "trantor-oob-"));
const git = (...a) => execFileSync("git", a, { stdio: "ignore" });

function runHook(env) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, ["hooks/sessionstart.mjs"], { cwd: ROOT, env, stdio: ["pipe", "pipe", "pipe"] });
    let stdout = "", stderr = "";
    child.stdout.on("data", c => { stdout += c; }); child.stderr.on("data", c => { stderr += c; });
    const timer = setTimeout(() => child.kill("SIGKILL"), 20000);
    child.on("close", (status) => { clearTimeout(timer); resolve({ status, stdout, stderr }); });
    child.stdin.write(JSON.stringify({ source: "startup", cwd: env.PROJECT_CWD }));
    child.stdin.end();
  });
}
function cleanEnv(extra) {
  const env = Object.fromEntries(Object.entries(process.env).filter(([k]) => !/^(RELAY_|TRANTOR_|HERDR_|CREW_|RUNNER_|CLAUDE_|AGENT_BUS_)/.test(k)));
  return { ...env, TRANTOR_NO_UPDATE_CHECK: "1", TRANTOR_NO_BALANCE_CHECK: "1", ...extra };
}

try {
  console.log("# 1 first-session enrolment on a loopback hub");
  // A loopback hub that returns 401 on /peer until the key is TOFU-enrolled, like hub.mjs does.
  const enrolled = new Set();
  let enrollPosts = 0;
  const stub = http.createServer((req, res) => {
    let body = ""; req.on("data", c => { body += c; });
    req.on("end", () => {
      const pk = req.headers["x-trantor-pubkey"] || "";
      const send = (code, obj) => { res.writeHead(code, { "content-type": "application/json" }); res.end(JSON.stringify(obj)); };
      if (req.url.startsWith("/enroll")) { enrollPosts++; try { enrolled.add(JSON.parse(body).pubkey); } catch {} return send(200, { ok: true }); }
      if (req.url.startsWith("/peer?")) return enrolled.has(pk) ? send(200, { peer: {} }) : send(401, { error: "unknown identity" });
      if (req.url.startsWith("/peers")) return send(200, { peers: [] });
      return send(200, {});
    });
  });
  await new Promise(r => stub.listen(0, "127.0.0.1", r));
  const hub = `http://127.0.0.1:${stub.address().port}`;

  // Minted in a child with its own AGENT_BUS_DIR so no key lands in the real home.
  const seat = JSON.parse(spawnSync(process.execPath, ["--input-type=module", "-e",
    `import { loadOrCreate } from "${ROOT}lib/identity.mjs"; console.log(JSON.stringify(loadOrCreate("claude:oob-unit", "agent")));`],
    { env: cleanEnv({ HOME: scratch, AGENT_BUS_DIR: join(scratch, "unit-bus") }), encoding: "utf8" }).stdout);
  ok("tofuEnroll succeeds against a loopback hub", await tofuEnroll(hub, seat, "agent") === true && enrolled.has(seat.pubkey));
  ok("tofuEnroll refuses a non-loopback hub without any request", await tofuEnroll("https://hub.example.com", seat, "agent") === false);

  const bus = join(scratch, "bus"), home = join(scratch, "home"), proj = join(scratch, "proj", "freshproj");
  mkdirSync(bus, { recursive: true }); mkdirSync(home); mkdirSync(proj, { recursive: true }); git("init", "-q", proj);
  writeFileSync(join(bus, "config.json"), JSON.stringify({ url: hub }));
  const base = { HOME: home, AGENT_BUS_DIR: bus, RELAY_SESSION: "claude:freshproj", PROJECT_CWD: proj, CLAUDE_PROJECT_DIR: proj };
  const first = await runHook(cleanEnv(base));
  ok("first session exits 0", first.status === 0, first.stderr.slice(0, 200));
  ok("no false 'not enrolled' banner on the first session", !/not-enrolled|Not enrolled/.test(first.stdout + first.stderr), (first.stdout + first.stderr).slice(0, 300));
  ok("the hub got the TOFU enrolment", enrollPosts >= 2);
  ok("single local hub with no pins: no unpinned warning", !/hub-unpinned|not pinned/.test(first.stdout + first.stderr));
  ok("a live hub does not say it is down", !/hub is not running/.test(first.stdout));
  stub.close();

  console.log("\n# 2 unpinned warning gate and hub-down line");
  ok("global/default + loopback + no pins: silent", shouldWarnUnpinned("global", "http://127.0.0.1:4477", []) === false && shouldWarnUnpinned("default", "http://localhost:4477", []) === false);
  ok("pins exist: warn", shouldWarnUnpinned("global", "http://127.0.0.1:4477", ["other"]) === true);
  ok("non-loopback fallback: warn", shouldWarnUnpinned("global", "https://hub.example.com", []) === true);
  ok("a pinned or env hub never warns", shouldWarnUnpinned("pin", "https://x", ["a"]) === false && shouldWarnUnpinned("env", "https://x", []) === false);
  ok("loopbackUrl reads bare and slashed urls", loopbackUrl("http://127.0.0.1:4477") && loopbackUrl("http://127.0.0.1:4477/") && !loopbackUrl("http://10.0.0.5:4477"));
  const down = await runHook(cleanEnv({ ...base, RELAY_URL: "http://127.0.0.1:1" }));
  ok("hub down: one plain line names `trantor hub` and the app", /hub is not running/.test(down.stdout) && /trantor hub/.test(down.stdout) && /Trantor app/.test(down.stdout), down.stdout.slice(0, 300));

  console.log("\n# 3 build doctrine is opt-in");
  ok("wantsBuildDoctrine only on an explicit true", wantsBuildDoctrine({}) === false && wantsBuildDoctrine({ buildDoctrine: "yes" }) === false && wantsBuildDoctrine({ buildDoctrine: true }) === true);
  const orchEnv = { ...base, RELAY_URL: "http://127.0.0.1:1", TRANTOR_ORCH: "freshproj", RELAY_PROJECT: "freshproj" };
  const plain = await runHook(cleanEnv(orchEnv));
  ok("orchestrator gets the role line by default", /trantor-orchestrator-role/.test(plain.stdout));
  ok("...without the build doctrine", !/trantor-build-doctrine/.test(plain.stdout));
  ok("...and without operator-ruling attributions", !/operator ruling/.test(plain.stdout));
  writeFileSync(join(bus, "config.json"), JSON.stringify({ buildDoctrine: true }));
  const doc = await runHook(cleanEnv(orchEnv));
  ok("buildDoctrine:true injects the doctrine block", /trantor-build-doctrine/.test(doc.stdout));

  console.log("\n# 4 auto handoff is opt-in");
  ok("unset or false: off", !autoHandoffEnabled({}, {}) && !autoHandoffEnabled({ autoHandoffPrompt: false }, {}));
  ok("true: on", autoHandoffEnabled({ autoHandoffPrompt: true }, {}));
  ok("TRANTOR_NO_HANDOFF_SPAWN=1 is a hard off", !autoHandoffEnabled({ autoHandoffPrompt: true }, { TRANTOR_NO_HANDOFF_SPAWN: "1" }));
  const line = manualContinueLine("/x/h.json");
  ok("the off message says how to continue", /\/x\/h\.json/.test(line) && /trantor handoff/.test(line) && /recaps it/.test(line), line);

  console.log("\n# 5 scrooge registry seeded on a fresh machine");
  const sh = join(scratch, "scrooge-home");
  const r = spawnSync("python3", [join(ROOT, "engine/bin/scrooge"), "list"], { env: cleanEnv({ HOME: home, SCROOGE_HOME: sh }), encoding: "utf8", timeout: 20000 });
  ok("no traceback without a registry", !/Traceback/.test(r.stderr) && r.status === 0, r.stderr.slice(0, 300));
  ok("registry.json was seeded from the template", existsSync(join(sh, "registry.json")) &&
    readFileSync(join(sh, "registry.json"), "utf8") === readFileSync(join(ROOT, "engine/registry.template.json"), "utf8"));

  console.log("\n# 6 seat CLI preflight");
  ok("seatCli maps api providers to opencode", seatCli("glm") === "opencode" && seatCli("codex") === "codex");
  const miss = seatCliProblem("codex", () => false);
  ok("missing codex fails fast with the install hint", /npm install -g @openai\/codex/.test(miss) && /codex/.test(miss), miss);
  ok("present CLI: no problem", seatCliProblem("codex", () => true) === null);
  ok("opencode-hosted seat names opencode", /opencode-ai/.test(seatCliProblem("glm", () => false)));

  console.log("\n# 7 checkout lookup honours the cwd checkout outside the projects folder");
  const outside = realpathSync(proj), emptyRoot = join(scratch, "devroot"); mkdirSync(emptyRoot);
  const env = { HOME: home, AGENT_BUS_DIR: bus, TRANTOR_DEV_ROOT: emptyRoot };
  ok("localCheckoutFor finds the cwd checkout", localCheckoutFor("freshproj", proj, env) === outside, localCheckoutFor("freshproj", proj, env));
  ok("another project id is not the cwd", localCheckoutFor("otherproj", proj, env) === "");

  console.log("\n# 8 JSONC configs");
  const j = parseJsonc('{\n // c\n "a": [1, 2,], /* x */ "b": "http://x//y",\n}');
  ok("comments and trailing commas parse, strings keep //", j.a.length === 2 && j.b === "http://x//y");
  ok("strict JSON still parses", parseJsonc('{"k":1}').k === 1);
  let threw = false; try { parseJsonc("{nope"); } catch { threw = true; }
  ok("garbage still throws (connect then skips the file)", threw);

  console.log("\n# 9 setup.sh node path");
  const fake = join(scratch, "sys-node"); writeFileSync(fake, "#!/bin/sh\n"); chmodSync(fake, 0o755);
  const pick = (cands) => spawnSync("bash", ["-c", `. ${ROOT}/deploy/node-path.sh; pick_node`], { env: { ...process.env, TRANTOR_NODE_CANDIDATES: cands }, encoding: "utf8" });
  ok("a system node wins over the current one", pick(`/nonexistent/node ${fake}`).stdout.trim() === fake);
  const nvm = join(scratch, ".nvm", "bin"); mkdirSync(nvm, { recursive: true }); writeFileSync(join(nvm, "node"), "#!/bin/sh\n"); chmodSync(join(nvm, "node"), 0o755);
  const warn = spawnSync("bash", ["-c", `. ${ROOT}/deploy/node-path.sh; pick_node`], { env: { ...process.env, PATH: `${nvm}:/usr/bin:/bin`, TRANTOR_NODE_CANDIDATES: "/nonexistent/node" }, encoding: "utf8" });
  ok("an nvm node is used with a warning when nothing else exists", warn.stdout.trim() === join(nvm, "node") && /Node manager/.test(warn.stderr), warn.stderr);
  const sh2 = readFileSync(join(ROOT, "deploy/setup.sh"), "utf8");
  ok("setup.sh no longer aborts on a bootstrap error", /if ! launchctl bootstrap/.test(sh2));

  console.log("\n# 10 graft is excluded locally, never via the tracked .gitignore");
  const repo = join(scratch, "graftrepo"); mkdirSync(repo); git("init", "-q", repo);
  writeFileSync(join(repo, ".gitignore"), "node_modules\n");
  const file = excludeGraftLocally(repo);
  ok(".git/info/exclude got graft/", /graft\//.test(readFileSync(join(repo, ".git/info/exclude"), "utf8")) && file.endsWith("info/exclude"));
  ok("the tracked .gitignore is untouched", readFileSync(join(repo, ".gitignore"), "utf8") === "node_modules\n");
  excludeGraftLocally(repo);
  ok("a second call does not duplicate", (readFileSync(join(repo, ".git/info/exclude"), "utf8").match(/graft\//g) || []).length === 1);
} finally {
  rmSync(scratch, { recursive: true, force: true });
}

console.log(fail ? `\n${pass} passed, ${fail} FAILED` : `\nALL PASS (${pass})`);
process.exit(fail ? 1 : 0);
