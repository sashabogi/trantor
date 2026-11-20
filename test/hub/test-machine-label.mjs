import assert from "node:assert/strict";
import { startTestHub } from "../lib/test-hub.mjs";
import { machineLabel } from "../../lib/machine-label.mjs";

assert.equal(machineLabel({ machineLabel: "netcup" }), "netcup");
assert.equal(machineLabel({ machineLabel: "A hostname" }), "");
assert.equal(machineLabel({ machineLabel: "x".repeat(25) }), "");
assert.equal(machineLabel({}), "");

const hub = await startTestHub({ env: { RELAY_AUTH: "off" } });
const post = async (body) => fetch(`${hub.base}/register`, {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify(body),
});
const peers = async () => (await (await fetch(`${hub.base}/peers`)).json()).peers;
try {
  await post({ session: "seat:project", project: "project", machine: "netcup", host: "private-hostname" });
  let peer = (await peers()).find(row => row.session === "seat:project");
  assert.equal(peer.machine, "netcup");
  assert.equal("host" in peer, false);

  await post({ session: "seat:project", project: "project", machine: "invalid label" });
  await post({ session: "seat:project", project: "project" });
  peer = (await peers()).find(row => row.session === "seat:project");
  assert.equal(peer.machine, "netcup");
} finally {
  await hub.stop();
}
console.log("machine label peer tests passed");
