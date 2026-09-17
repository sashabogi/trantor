#!/usr/bin/env node
// `trantor harvest <seat-sha> <main-sha> [--card N]` (#7748): the receipt for a hand-made cherry-pick
// or squash. The receipt is what lets `trantor sync` realign the seat branch later.
import { resolveProject, hostId } from "../lib/project.mjs";
import { recordHarvest, receiptsPath, run } from "../lib/harvest.mjs";
import { signedPost } from "../hooks/lib/api.mjs";

const args = process.argv.slice(2);
const flag = (name) => { const i = args.indexOf(`--${name}`); return i >= 0 ? args[i + 1] : ""; };
const positional = args.filter((a, i) => !a.startsWith("--") && !(i > 0 && args[i - 1].startsWith("--") && !args[i - 1].startsWith("--no-")));
const [seatArg, mainArg] = positional;
if (!seatArg || !mainArg || args.includes("--help")) {
  console.error("usage: trantor harvest <seat-sha> <main-sha> [--card N] [--seat <agent>] [--project <p>] [--no-note]");
  process.exit(seatArg && mainArg ? 0 : 1);
}

const repo = process.cwd();
const project = flag("project") || resolveProject(repo);
const resolve = (s) => run(repo, ["rev-parse", "--verify", "-q", `${s}^{commit}`]).out || String(s).trim();
const seat = resolve(seatArg), main = resolve(mainArg);
if (!run(repo, ["rev-parse", "--verify", "-q", `${mainArg}^{commit}`]).ok) {
  console.error(`harvest: ${mainArg} is not a commit in ${repo}`);
  process.exit(1);
}
let branch = flag("seat") ? `seat/${flag("seat")}` : "";
if (!branch) {
  const holders = run(repo, ["branch", "--list", "seat/*", "--contains", seat, "--format=%(refname:short)"]).out;
  branch = holders.split("\n").filter(Boolean)[0] || "";
}

let receipt;
try { receipt = recordHarvest(project, { seat, main, card: flag("card"), branch, by: "harvest" }); }
catch (e) { console.error(`harvest: ${e.message}`); process.exit(1); }
const line = `harvested ${receipt.seat.slice(0, 7)} as ${receipt.main.slice(0, 7)}`;
console.log(`${line}${branch ? ` (${branch})` : ""}${receipt.card ? ` · card #${receipt.card}` : ""} → ${receiptsPath(project)}`);

if (receipt.card && !args.includes("--no-note")) {
  const me = `${hostId()}:${project}`;
  const r = await signedPost("/task/update", { id: receipt.card, note: line, by: me, project }, { session: me, project });
  if (r.ok) console.log(`card #${receipt.card} noted: ${line}`);
  else console.error(`warning: card #${receipt.card} not noted (${r.status || r.reason || "hub unreachable"}); the receipt is recorded`);
}
