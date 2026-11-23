import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, chmodSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { restoreCandidates, restoreOrchestrators } from "../../bin/crew/restore.mjs";

const rows = ["one\torch\t__orch__\tw1:p1", "two\torch\t__orch__\tw1:p2", "three\torch\t__orch__\tw1:p3", "four\torch\t__orch__\tw1:p4"].map(line => {
  const [project, kind, persona, handle] = line.split("\t");
  return { project, kind, persona, handle };
});

assert.deepEqual(restoreCandidates({
  rows, configured: ["one", "two", "three", "four"], frozen: ["three"],
  dismissed: [{ project: "two", sessionId: "s2" }],
  sessions: new Map([["one", "s1"], ["two", "s2"], ["three", "s3"], ["four", "s4"]]),
  live: new Set(["four"]),
}), ["one"]);

const root = mkdtempSync(join(tmpdir(), "trantor-restore-"));
try {
  const home = join(root, "home");
  const bus = join(home, ".agent-bus");
  const fakebin = join(root, "bin");
  mkdirSync(bus, { recursive: true });
  mkdirSync(fakebin, { recursive: true });
  writeFileSync(join(bus, "config.json"), JSON.stringify({ resumeOnRestore: ["one", "two", "three"], frozenProjects: ["three"], dismissedSessions: [{ project: "two", sessionId: "s2" }] }));
  writeFileSync(join(bus, "crew-windows.txt"), "one\torch\t__orch__\tw1:p1\ntwo\torch\t__orch__\tw1:p2\nthree\torch\t__orch__\tw1:p3\n");
  writeFileSync(join(bus, "orch-sessions.txt"), "one\ts1\ntwo\ts2\nthree\ts3\n");
  const herdr = join(fakebin, "herdr");
  writeFileSync(herdr, "#!/bin/sh\ncase \"$1 $2\" in\n  'agent list') echo '{\"result\":{\"agents\":[]}}' ;;\n  'pane read') exit 0 ;;\n  'pane process-info') echo '{\"result\":{\"process_info\":{\"foreground_processes\":[{\"name\":\"claude\"}]}}}' ;;\n  *) exit 1 ;;\nesac\n");
  chmodSync(herdr, 0o755);
  const opened = join(root, "opened.txt");
  const crew = join(fakebin, "crew.mjs");
  writeFileSync(crew, `import { appendFileSync } from 'node:fs'; appendFileSync(${JSON.stringify(opened)}, process.argv[3] + '\\n');\n`);
  const ctx = { home, root, project: "test", env: { ...process.env, PATH: `${fakebin}:${process.env.PATH}` }, have: { herdr: true }, dry: false, statePath: join(bus, "crew-windows.txt") };
  assert.equal(await restoreOrchestrators(ctx), 0);
  assert.equal(readFileSync(opened, "utf8"), "one\n");
  assert.equal(await restoreOrchestrators(ctx, ["--dry-run"]), 0);
  assert.equal(readFileSync(opened, "utf8"), "one\n", "dry-run does not open a pane");
} finally {
  rmSync(root, { recursive: true, force: true });
}
