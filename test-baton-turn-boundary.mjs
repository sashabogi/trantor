#!/usr/bin/env node
// trantor — the baton must not fire in the middle of a turn.
//
// 2026-08-24, measured: the handoff was written at 23:11:49 and the work it was meant to describe
// was committed at 23:12:25. Thirty-six seconds. The successor got a summary of a session that was
// half a minute from its own conclusions, and reported four things as open that were already done.
//
// There WAS a mid-build guard — subagentsActive() — but it only asks "is a spawned sub-agent still
// writing?". A session driving tool calls in its own main loop has no sub-agents, so the check
// passes and the baton fires. And it can only ever fire mid-turn, because the heartbeat runs on
// PostToolUse: between two tool calls is the only moment it is ever called.
//
// So the warn threshold ARMS the baton, and the Stop hook fires it at the next turn boundary —
// the one point where the turn is finished and a summary describes something complete.
import { spawn, spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, readdirSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { drillEnv } from "./drill-env.mjs";

const ROOT = dirname(fileURLToPath(import.meta.url));
let pass = 0, fail = 0;
const ok = (n, c, x = "") => { if (c) { pass++; console.log(`  ✓ ${n}`); } else { fail++; console.log(`  ✗ ${n}${x ? " — " + x : ""}`); } };
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

console.log("# trantor baton turn-boundary drill");

// A transcript whose last usage line puts context way over the warn line.
function makeWorld() {
  const w = mkdtempSync(join(tmpdir(), "tt-baton-tb-"));
  const BUS = join(w, ".agent-bus"); mkdirSync(join(BUS, "handoffs"), { recursive: true });
  // This suite drills the AUTO chain (arm at warn → fire at Stop). Since #5509 W2 the dial
  // defaults to "ask" (the operator fires; nothing auto-arms), so the world opts in explicitly.
  // The ask-mode default gets its own drill at the end of the suite.
  writeFileSync(join(BUS, "autonomy.json"), JSON.stringify({ version: 1, defaults: { baton: "auto" }, projects: {} }));
  const proj = join(w, "proj"); mkdirSync(proj, { recursive: true });
  spawnSync("git", ["init", "-q"], { cwd: proj });
  const tdir = join(w, "transcripts"); mkdirSync(tdir, { recursive: true });
  const transcript = join(tdir, "t.jsonl");
  const turn = (t) => JSON.stringify({ type: "assistant", message: { role: "assistant", content: [{ type: "text", text: t }],
    usage: { input_tokens: 190_000, output_tokens: 500, cache_read_input_tokens: 0 } } });
  writeFileSync(transcript, Array.from({ length: 40 }, (_, i) => turn(`turn ${i}: substantive work `.repeat(10))).join("\n") + "\n");
  return { w, BUS, proj, transcript };
}

const env = (W) => ({
  ...drillEnv(),
  HOME: W.w, AGENT_BUS_DIR: W.BUS, RELAY_DATA_DIR: W.BUS,
  CLAUDE_PROJECT_DIR: W.proj,
  RELAY_CONTEXT_WINDOW: "200000",       // 190k of 200k → ~95%, over the 90% warn line
  RELAY_SESSION: "", RELAY_PROJECT: "", RELAY_URL: "http://127.0.0.1:9",   // hub unreachable: irrelevant here
  TRANTOR_NO_SCROOGE: "1",              // no LLM in a drill
  TRANTOR_NO_BATON_SPAWN: "1",          // and never open a real Terminal window…
  TRANTOR_NO_HANDOFF_SPAWN: "1",        // …by EITHER name. Setting only the first opened eight.
});

function runHook(hook, W, stdin) {
  return new Promise((resolve) => {
    const kid = spawn(process.execPath, [join(ROOT, "hooks", hook)], { cwd: ROOT, stdio: ["pipe", "pipe", "pipe"], env: env(W) });
    let so = "", se = ""; kid.stdout.on("data", d => (so += d)); kid.stderr.on("data", d => (se += d));
    kid.on("close", () => resolve({ so, se }));
    kid.stdin.end(JSON.stringify(stdin));
    setTimeout(() => { try { kid.kill("SIGKILL"); } catch {} }, 20000).unref?.();
  });
}
const handoffs = (W) => { try { return readdirSync(join(W.BUS, "handoffs")).filter(f => f.endsWith(".json")); } catch { return []; } };
const armedFile = (W) => { try { return readdirSync(W.BUS).filter(f => f.startsWith("handoff-armed-")); } catch { return []; } };

console.log("\nA heartbeat over the warn line ARMS the baton; it does not fire it:");
const W1 = makeWorld();
{
  const r = await runHook("heartbeat.mjs", W1, { session_id: "s-1", cwd: W1.proj, transcript_path: W1.transcript });
  await sleep(1200);
  ok("no handoff is written mid-turn", handoffs(W1).length === 0, `${handoffs(W1).length}: ${handoffs(W1).join(", ")}`);
  ok("…but it is armed for the next turn boundary", armedFile(W1).length === 1, `armed: ${armedFile(W1).join(", ")}`);
  ok("…and it says so", /arm/i.test(r.se), r.se.slice(0, 160));
}

console.log("\nThe next Stop — a real turn boundary — fires it:");
{
  const r = await runHook("stop-inbox.mjs", W1, { session_id: "s-1", cwd: W1.proj, stop_hook_active: false });
  await sleep(2500);
  ok("the handoff is written at the boundary", handoffs(W1).length === 1, `${handoffs(W1).length}: ${handoffs(W1).join(", ")}`);
  ok("…and the arming is cleared", armedFile(W1).length === 0, `still armed: ${armedFile(W1).join(", ")}`);
  ok("…and the stop is not blocked by it", !/"decision":"block"/.test(r.so) || /outstanding|unread/i.test(r.so), r.so.slice(0, 140));
}

console.log("\nExactly one baton per armed context — a second Stop does not fire another:");
{
  await runHook("stop-inbox.mjs", W1, { session_id: "s-1", cwd: W1.proj, stop_hook_active: false });
  await sleep(1500);
  ok("still exactly one handoff", handoffs(W1).length === 1, `${handoffs(W1).length}: ${handoffs(W1).join(", ")}`);
}

console.log("\nBelow the warn line nothing is armed at all:");
{
  const W2 = makeWorld();
  const e = { ...env(W2), RELAY_CONTEXT_WINDOW: "2000000" };   // 190k of 2M → ~10%
  await new Promise((resolve) => {
    const kid = spawn(process.execPath, [join(ROOT, "hooks", "heartbeat.mjs")], { cwd: ROOT, stdio: ["pipe", "ignore", "ignore"], env: e });
    kid.on("close", resolve);
    kid.stdin.end(JSON.stringify({ session_id: "s-2", cwd: W2.proj, transcript_path: W2.transcript }));
    setTimeout(() => { try { kid.kill("SIGKILL"); } catch {} }, 15000).unref?.();
  });
  await sleep(800);
  ok("nothing armed", armedFile(W2).length === 0, armedFile(W2).join(", "));
  ok("nothing written", handoffs(W2).length === 0, handoffs(W2).join(", "));
}


console.log("\nA session that never reaches a Stop still hands off eventually:");
{
  // Arming must not become a way to never hand off. If no turn boundary arrives within the bound,
  // the heartbeat fires it directly and says that is what happened.
  const W3 = makeWorld();
  // RELAY_HEARTBEAT_MS too: the hook throttles itself per session, so without shortening that
  // window the second tick returns before any of the baton logic runs.
  const e = { ...env(W3), TRANTOR_BATON_ARM_MAX_MS: "1200", RELAY_HEARTBEAT_MS: "200" };
  const run = () => new Promise((resolve) => {
    const kid = spawn(process.execPath, [join(ROOT, "hooks", "heartbeat.mjs")], { cwd: ROOT, stdio: ["pipe", "ignore", "pipe"], env: e });
    let se = ""; kid.stderr.on("data", d => (se += d));
    kid.on("close", () => resolve(se));
    kid.stdin.end(JSON.stringify({ session_id: "s-3", cwd: W3.proj, transcript_path: W3.transcript }));
    setTimeout(() => { try { kid.kill("SIGKILL"); } catch {} }, 15000).unref?.();
  });
  const first = await run();
  ok("the first heartbeat arms, it does not fire", /arming the baton/.test(first) && handoffs(W3).length === 0, first.slice(0, 120));
  await sleep(1600);                                   // let the arm age past the bound
  const second = await run();
  await sleep(2500);
  ok("a heartbeat past the bound fires it anyway", /firing anyway/.test(second), second.slice(0, 140));
  ok("…and the handoff exists", handoffs(W3).length === 1, `${handoffs(W3).length}`);
  ok("…and the arming is cleared, so it cannot fire twice", armedFile(W3).length === 0, armedFile(W3).join(", "));
}

// ---- the dial's DEFAULT is ask (#5509 W2): past the warn line, nothing arms, nothing fires ----
{
  const W4 = makeWorld();
  writeFileSync(join(W4.BUS, "autonomy.json"), JSON.stringify({ version: 1, defaults: {}, projects: {} }));
  const r = await runHook("heartbeat.mjs", W4, { session_id: "s-ask", cwd: W4.proj, transcript_path: W4.transcript });
  await sleep(1200);
  ok("ask (default): past the warn line the heartbeat says the banner offers", /dial is 'ask'/.test(r.se), r.se.slice(0, 160));
  ok("ask (default): nothing armed", armedFile(W4).length === 0, armedFile(W4).join(", "));
  ok("ask (default): no handoff written", handoffs(W4).length === 0, `${handoffs(W4).length}`);
}

console.log(`\n${fail === 0 ? "✅" : "❌"} baton-turn-boundary: ${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
