#!/usr/bin/env node
import http from "node:http";
import { execSync, spawn } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { drillEnv } from "../drill-env.mjs";

const CARD = 13942;
const PROJ = "tt-permission-receipt";
const sends = [];
const card = { id: CARD, status: "doing", log: [] };
let handed = false;
let pass = 0;
let fail = 0;
const ok = (name, condition, extra = "") => {
  console.log(`  ${condition ? "PASS" : "FAIL"}  ${name}${condition || !extra ? "" : `\n          ${extra}`}`);
  condition ? pass++ : fail++;
};
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const read = path => { try { return readFileSync(path, "utf8"); } catch { return ""; } };

const hub = http.createServer((req, res) => {
  let body = "";
  req.on("data", chunk => { body += chunk; });
  req.on("end", () => {
    const url = new URL(req.url, "http://x");
    const P = path => url.pathname === path;
    const reply = value => {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify(value));
    };
    if (req.method === "POST" && P("/send")) {
      const message = JSON.parse(body || "{}");
      sends.push(message);
      return reply({ ok: true, id: sends.length });
    }
    if (req.method === "POST" && (P("/task/update") || P("/card-move"))) {
      const update = JSON.parse(body || "{}");
      if (Number(update.id) === CARD) {
        if (update.status) card.status = update.status;
        if (update.note) card.log.push({ ts: Date.now(), by: update.by, text: update.note });
      }
      return reply({ ok: true });
    }
    if (P("/card")) return reply({ ok: true, task: { ...card } });
    if (P("/tasks")) return reply({ tasks: [{ ...card }] });
    if (P("/events")) return reply({ events: [], cursor: 0, latest: 0 });
    if (P("/contracts")) return reply({ contracts: [] });
    if (P("/inbox")) return reply({ messages: [], cursor: 0 });
    if (P("/lessons")) return reply({ lessons: [] });
    if (P("/policy")) return reply({ links: [], autonomy: { "*": 1 } });
    if (P("/poll")) {
      if (!handed) {
        handed = true;
        return reply({ messages: [{ id: 7, from: "owner@laptop", to: url.searchParams.get("session"), project: PROJ,
          text: `contract: card #${CARD} — update the deployment configuration`, ts: Date.now() }], cursor: 7 });
      }
      return setTimeout(() => reply({ messages: [], cursor: 7 }), 100);
    }
    return reply({ ok: true });
  });
});
await new Promise(resolve => hub.listen(0, "127.0.0.1", resolve));

const root = mkdtempSync(join(tmpdir(), "tt-permission-receipt-"));
const HOME = join(root, "home");
const REPO = join(root, "repo");
const BUS = join(HOME, ".agent-bus");
const fakebin = join(root, "bin");
mkdirSync(BUS, { recursive: true });
mkdirSync(REPO, { recursive: true });
mkdirSync(fakebin, { recursive: true });
const git = args => execSync(`git ${args}`, { cwd: REPO, stdio: "ignore" });
git("init -q -b main");
writeFileSync(join(REPO, "seed.txt"), "seed\n");
git("add -A");
git("-c user.name=d -c user.email=d@d commit -qm init");
writeFileSync(join(fakebin, "opencode"), `#!/bin/sh
if grep -q "NEW BUS MESSAGE" "$HOME/.agent-bus/turn-opencode-${PROJ}.txt"; then
  echo "partial work" > partial.txt
  git add partial.txt
  git -c user.name=d -c user.email=d@d commit -qm "partial work"
  echo "! permission requested: external_directory (/etc/trantor/denied); auto-rejecting" >&2
  echo "Error: The user rejected permission to use this specific tool call." >&2
else
  echo "Ready for a contract."
fi
exit 0
`);
chmodSync(join(fakebin, "opencode"), 0o755);

const runner = spawn(process.execPath, ["bin/crew-runner.mjs", "opencode", REPO], {
  cwd: process.cwd(),
  env: { ...drillEnv(), HOME, PATH: `${fakebin}:${process.env.PATH}`,
    RELAY_URL: `http://127.0.0.1:${hub.address().port}`, RELAY_AGENT: "opencode", RELAY_PROJECT: PROJ,
    CREW_KICKOFF: "say hi and end your turn", TRANTOR_NO_DESKTOP_NOTIFY: "1" },
  stdio: "ignore",
});
const started = Date.now();
while (Date.now() - started < 15000 && !sends.some(message => message.to === "owner@laptop"
  && (/✅ done on/.test(message.text || "") || /permission rejected:/.test(message.text || "")))) await sleep(100);
await sleep(1000);
runner.kill("SIGKILL");
await sleep(150);
hub.close();

const direct = sends.filter(message => message.to === "owner@laptop");
const rejected = direct.filter(message => /permission rejected:/.test(message.text || ""));
const rows = read(join(BUS, "logs", `opencode-${PROJ}.jsonl`)).split("\n").filter(Boolean)
  .map(line => { try { return JSON.parse(line); } catch { return {}; } });
const row = rows.find(item => item.trigger === "direct message");

console.log("# permission rejection never becomes a done receipt (#13945)");
ok("the assigner gets exactly one rejection naming the denied tool and card",
  rejected.length === 1 && /permission rejected: external_directory on #13942/.test(rejected[0]?.text || ""),
  direct.map(message => message.text).join("\n"));
ok("no done receipt is sent", !direct.some(message => /✅ done on/.test(message.text || "")));
ok("telemetry records rejected, never completed", row?.outcome === "rejected"
  && String(row.verdict || "").startsWith("classified permission-rejected"), JSON.stringify(row || {}));
ok("the card is blocked with the same evidence", card.status === "blocked"
  && card.log.some(note => /external_directory/.test(note.text) && /#13942/.test(note.text)), JSON.stringify(card));
ok("the denied wake stays owed", existsSync(join(BUS, `pending-opencode-${PROJ}.json`)));

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
