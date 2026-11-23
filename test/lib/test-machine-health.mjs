// #13920: the heartbeat payload from a fake os — pure arithmetic, no /proc, no shell-outs.
import assert from "node:assert/strict";
import { healthPayload, defaultOs, HEALTH_BEAT_MS, HEALTH_STALE_MS } from "../../lib/machine-health.mjs";

// netcup's shape per the operator: 16 cores, 62 GB. loadavg 5.5 over 16 cores = 34%.
const GiB = 2 ** 30;
const fakeOs = {
  cpus: () => Array.from({ length: 16 }, () => ({})),
  loadavg: () => [5.5, 4.25, 3.1],
  totalmem: () => 62 * GiB,
  freemem: () => 41 * GiB,
};

const ts = 1_700_000_000_000;
const p = healthPayload(fakeOs, "netcup", () => ts);

assert.equal(p.machine, "netcup");
assert.equal(p.cpuPct, 34, `1-min loadavg / cores as a rounded percent (got ${p.cpuPct})`);
assert.equal(p.memUsed, 21 * GiB, "used = total - free");
assert.equal(p.memTotal, 62 * GiB);
assert.equal(p.ts, ts, "the caller's clock stamps ts");

// A machine oversubscribed past its cores must NOT cap at 100 — that would hide the overload.
const hot = healthPayload({ ...fakeOs, loadavg: () => [24, 20, 18] }, "netcup", () => ts);
assert.equal(hot.cpuPct, 150, "load above the core count reads above 100%");

// An os that answers nothing usable degrades to nulls, never to invented numbers.
const blind = healthPayload({ cpus: () => [], loadavg: () => [NaN], totalmem: () => NaN, freemem: () => NaN }, "netcup", () => ts);
assert.equal(blind.cpuPct, null);
assert.equal(blind.memUsed, null);
assert.equal(blind.memTotal, null);

// The runner calls it with no clock argument; that default path took a seat runner down on
// 0.18.131 ("now is not a function"). The real os module and the default clock must work.
const before = Date.now();
const live = healthPayload(defaultOs, "netcup");
assert.ok(live.ts >= before && live.ts <= Date.now(), "default clock stamps the current time");
assert.ok(live.memTotal > 0 && Number.isFinite(live.cpuPct), "real os numbers come through");

// The cadence contract: three beats fit inside the stale window, so one lost beat never reads stale.
assert.ok(HEALTH_BEAT_MS * 3 <= HEALTH_STALE_MS && HEALTH_STALE_MS > HEALTH_BEAT_MS,
  `30s beat must fit 3x in the ${HEALTH_STALE_MS}ms stale window`);

console.log("test-machine-health (payload): all assertions passed");
