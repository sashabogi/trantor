import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, utimesSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildDiskReport, hasActiveHeavyGate, runClean, scanSharedBuildCache } from "../../lib/disk.mjs";

test("disk janitor sees old shared caches, prunes them, and protects active gates", async () => {
  const home = mkdtempSync(join(tmpdir(), "trantor-cache-"));
  try {
    const cache = join(home, ".agent-bus", "cache", "trantor", "cargo-target");
    mkdirSync(cache, { recursive: true });
    writeFileSync(join(cache, "artifact"), "compiled");
    const now = Date.now();
    const old = new Date(now - 4 * 24 * 60 * 60 * 1000);
    utimesSync(join(cache, "artifact"), old, old);
    utimesSync(cache, old, old);
    const dep = { home, now, isPidAlive: () => false };
    const report = scanSharedBuildCache(dep);
    assert.equal(report.plan.length, 1);
    assert.equal(report.plan[0].path, cache);
    const results = await runClean({ plan: report.plan }, dep);
    assert.equal(results[0].ok, true);
    assert.equal(existsSync(cache), false);

    mkdirSync(cache, { recursive: true });
    writeFileSync(join(cache, "artifact"), "compiled");
    const gate = join(home, ".agent-bus", "heavy-gate");
    mkdirSync(gate, { recursive: true });
    writeFileSync(join(gate, "slot-0.json"), JSON.stringify({ pid: 123 }));
    const held = { ...dep, isPidAlive: (pid) => pid === 123 };
    assert.equal(hasActiveHeavyGate(held), true);
    assert.equal(scanSharedBuildCache(held).plan.length, 0);
    const blocked = await runClean({ plan: [{ type: "shared-cache", path: cache }] }, held);
    assert.equal(blocked[0].ok, false);
    assert.equal(existsSync(cache), true);
    assert.equal(buildDiskReport(held).kept.some((row) => row.reason.includes("heavy-gate")), true);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});
