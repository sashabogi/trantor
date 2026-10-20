#!/usr/bin/env node
// The doctor's herdr claude-integration decision, against captured `herdr integration status` output.
import { claudeIntegrationState, probeClaudeIntegration, HERDR_CLAUDE_INSTALL } from "../../lib/herdr-integration.mjs";
import { harness } from "../state/_helpers.mjs";

const { ok, done } = harness();
const wrap = (claude) => `pi: not installed (/h/.pi/x.ts)\n${claude}\ncodex: current (v8) (/h/.codex/x.sh)\n`;

const installed = claudeIntegrationState({ ran: true, stdout: wrap("claude: current (v8) (/h/.claude/hooks/herdr-agent-state.sh)") });
ok("current => installed", installed.state === "installed", JSON.stringify(installed));

const missing = claudeIntegrationState({ ran: true, stdout: wrap("claude: not installed (/h/.claude/hooks/herdr-agent-state.sh)") });
ok("not installed => missing", missing.state === "missing", JSON.stringify(missing));

ok("outdated => outdated", claudeIntegrationState({ ran: true, stdout: wrap("claude: outdated (v6) (/h/x.sh)") }).state === "outdated");
ok("herdr absent => absent", claudeIntegrationState({ ran: false }).state === "absent");
ok("non-zero exit => unknown", claudeIntegrationState({ ran: true, status: 2, stdout: "boom" }).state === "unknown");
ok("garbage => unknown", claudeIntegrationState({ ran: true, stdout: "\u0000\u0001 not a status table" }).state === "unknown");
ok("empty output => unknown", claudeIntegrationState({ ran: true, stdout: "" }).state === "unknown");
ok("no arguments at all => absent, no throw", claudeIntegrationState().state === "absent");
ok("an unrecognised claude status => unknown", claudeIntegrationState({ ran: true, stdout: "claude: ???" }).state === "unknown");
ok("a line for another agent does not count", claudeIntegrationState({ ran: true, stdout: "codex: current (v8) (/x)" }).state === "unknown");

ok("probe: ENOENT => absent", probeClaudeIntegration(() => ({ error: Object.assign(new Error("x"), { code: "ENOENT" }) })).state === "absent");
ok("probe: timeout => unknown", probeClaudeIntegration(() => ({ error: new Error("ETIMEDOUT"), status: null })).state === "unknown");
ok("probe: reads stdout", probeClaudeIntegration(() => ({ status: 0, stdout: "claude: current (v8) (/x)\n" })).state === "installed");
ok("the install command is the documented one", HERDR_CLAUDE_INSTALL === "herdr integration install claude");

done();
