#!/usr/bin/env node
// #11854 drill - opencode seats load only the relay MCP server: the overlay builder, the config
// reader (fail open), and the merged OPENCODE_CONFIG_CONTENT the runner sets.
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { ocCompactionContent, readOpencodeUserConfig, seatMcpOverlay, seatPermissionOverlay, seatConfigContent } from "../../lib/seat-compaction.mjs";

let pass = 0, fail = 0;
const ok = (name, cond, extra) => { console.log(`  ${cond ? "PASS" : "FAIL"}  ${name}${cond || !extra ? "" : `\n          ${extra}`}`); cond ? pass++ : fail++; };

const user = { mcp: { pencil: { type: "local", enabled: true }, relay: { type: "local", enabled: true }, graft: { type: "local", enabled: true } }, theme: "x" };

const o = seatMcpOverlay(user, {});
ok("pencil and graft are disabled", o?.mcp?.pencil?.enabled === false && o?.mcp?.graft?.enabled === false, JSON.stringify(o));
ok("relay is left alone", !("relay" in o.mcp));
ok("nothing but mcp in the overlay", Object.keys(o).join() === "mcp");

ok("no config -> no overlay", seatMcpOverlay(null, {}) === null && seatMcpOverlay(undefined, {}) === null);
ok("no mcp block -> no overlay", seatMcpOverlay({ theme: "x" }, {}) === null);
ok("garbage mcp block -> no overlay", seatMcpOverlay({ mcp: "nope" }, {}) === null && seatMcpOverlay({ mcp: [1] }, {}) === null);
ok("only relay -> no overlay", seatMcpOverlay({ mcp: { relay: {} } }, {}) === null);
ok("TRANTOR_SEAT_MCP=all keeps every server", seatMcpOverlay(user, { TRANTOR_SEAT_MCP: "all" }) === null);

const dir = mkdtempSync(join(tmpdir(), "seat-mcp-"));
const home = join(dir, "home"); mkdirSync(join(home, ".config", "opencode"), { recursive: true });
ok("missing config file -> null", readOpencodeUserConfig({}, home) === null);
writeFileSync(join(home, ".config", "opencode", "opencode.json"), "{ not json");
ok("garbage config file -> null", readOpencodeUserConfig({}, home) === null);
writeFileSync(join(home, ".config", "opencode", "opencode.json"), JSON.stringify(user));
ok("default path is read", readOpencodeUserConfig({}, home)?.theme === "x");
const alt = join(dir, "alt.json"); writeFileSync(alt, JSON.stringify({ mcp: { only: {} } }));
ok("$OPENCODE_CONFIG wins", Object.keys(readOpencodeUserConfig({ OPENCODE_CONFIG: alt }, home).mcp).join() === "only");
const jc = join(home, ".config", "opencode"); writeFileSync(join(jc, "opencode.json"), "x"); writeFileSync(join(jc, "opencode.jsonc"), `{\n  // note\n  "mcp": { "a": {} }\n}`);
ok("opencode.jsonc with // comment lines is read", Object.keys(readOpencodeUserConfig({}, home)?.mcp || {}).join() === "a");

// TRANSPORT: the exact string the runner puts in OPENCODE_CONFIG_CONTENT
const both = JSON.parse(seatConfigContent(ocCompactionContent({}, 1_000_000), seatMcpOverlay(user, {})));
ok("merged content has compaction and mcp", !!both.compaction?.auto && both.mcp?.pencil?.enabled === false && both.mcp?.graft?.enabled === false, JSON.stringify(both));
ok("compaction block survives the merge", both.compaction.reserved === 900_000);
const mcpOnly = JSON.parse(seatConfigContent(ocCompactionContent({ TRANTOR_OC_COMPACTION: "off" }), seatMcpOverlay(user, {})));
ok("compaction off + servers -> mcp overlay alone", !mcpOnly.compaction && mcpOnly.mcp?.pencil?.enabled === false);
ok("compaction off + nothing to disable -> empty", seatConfigContent(ocCompactionContent({ TRANTOR_OC_COMPACTION: "off" }), null) === "");
ok("compaction only, no overlay -> unchanged", seatConfigContent('{"compaction":{"auto":true}}', null) === '{"compaction":{"auto":true}}');

// #14048: the heavy-gate shim folder sits on the seat's PATH outside its worktree; reading it must not end the turn.
const SHIM = "/usr/local/lib/node_modules/trantor/bin/heavy-gate-shim";
const rule = `${SHIM}/**`;
const p0 = seatPermissionOverlay(SHIM, null);
ok("no user config -> the shim folder is allowed", p0?.permission?.external_directory?.[rule] === "allow", JSON.stringify(p0));
ok("nothing else is opened", Object.keys(p0.permission.external_directory).join() === rule && Object.keys(p0.permission).join() === "external_directory");
ok("no shim folder -> no overlay", seatPermissionOverlay("", null) === null);
const p1 = seatPermissionOverlay(SHIM, { permission: { bash: { "rm *": "deny" }, external_directory: { "~/ref/**": "allow" } } });
ok("the user's other permission rules are carried", p1.permission.bash?.["rm *"] === "deny" && p1.permission.external_directory["~/ref/**"] === "allow" && p1.permission.external_directory[rule] === "allow", JSON.stringify(p1));
const p2 = seatPermissionOverlay(SHIM, { permission: { external_directory: "deny" } });
ok("a blanket deny stays the broad rule and the shim rule comes last", JSON.stringify(Object.entries(p2.permission.external_directory)) === JSON.stringify([["*", "deny"], [rule, "allow"]]), JSON.stringify(p2));
ok("a blanket allow needs nothing added", seatPermissionOverlay(SHIM, { permission: { external_directory: "allow" } }) === null);
const withPerm = JSON.parse(seatConfigContent(ocCompactionContent({}, 1_000_000), seatMcpOverlay(user, {}), p0));
ok("merged content carries compaction, mcp and the permission rule", !!withPerm.compaction?.auto && withPerm.mcp?.pencil?.enabled === false && withPerm.permission?.external_directory?.[rule] === "allow", JSON.stringify(withPerm));
const permOnly = JSON.parse(seatConfigContent(ocCompactionContent({ TRANTOR_OC_COMPACTION: "off" }), null, p0));
ok("compaction off, no servers to disable -> the permission rule alone", Object.keys(permOnly).join() === "permission");

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
