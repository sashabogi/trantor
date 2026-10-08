import assert from "node:assert/strict";
import { createOverseer } from "../../hub/overseer.mjs";
import { routeAdmin } from "../../hub/routes/admin.mjs";

let passed = 0;
async function test(name, run) {
  await run();
  console.log(`ok ${++passed} - ${name}`);
}
const evidence = (number = 7, repo = "acme/widgets") => ({ repo, number, author: "alice",
  url: `https://github.com/${repo}/pull/${number}`, files: ["src/x.ts"] });
function harness(level = 3) {
  let at = 1_000_000;
  const messages = [], events = [], fileClaims = new Map();
  const state = { peers: {}, tasks: [], verifyGateSeq: 0, orgPolicy: { autonomy: { "*": level } } };
  const ctx = { state, fileClaims, now: () => at, markDirty() {},
    appendEvent: (...event) => events.push(event),
    duty: { session: "", hubSend: (...message) => messages.push(message) },
    CLAIM_TTL_MS: 600_000, canon: value => value, body: async req => req.payload,
    json: (_, status, data) => ({ status, ...data }),
    touch: session => { state.peers[session] ??= { kind: "agent" }; },
    pruneClaims() {
      for (const [key, claim] of fileClaims) if (at - claim.ts > ctx.CLAIM_TTL_MS) fileClaims.delete(key);
    },
  };
  ctx.overseer = createOverseer(ctx);
  return { ctx, state, fileClaims, events,
    warnings: () => messages.filter(([, text]) => text.includes("OVERSEER remote-overlap")),
    remoteActive: () => [...ctx.overseer.active.values()].filter(entry => entry.kind === "remote-overlap"),
    advance: ms => { at += ms; },
    restart: () => { ctx.overseer = createOverseer(ctx); },
    claim: (patch = {}, path = "/claim") => routeAdmin({ req: {method: "POST", payload: {
      project: "alpha", session: "one:alpha", gitRoot: "/checkout/alpha", file: "src/x.ts", ...patch,
    }}, res: {}, q: {}, P: path, auth: null, ctx }),
  };
}

await test("claim route validates and bounds advisory evidence", async () => {
  const h = harness();
  await h.claim({ remote: [null, {}, evidence(), {...evidence(), number: "8"},
    {...evidence(), repo: "https://github.com/acme/widgets"}, {...evidence(), number: -1},
    {...evidence(), url: "javascript:alert(1)"}, {...evidence(), files: ["elsewhere.ts"]}] });
  assert.deepEqual([...h.fileClaims.values()][0].remote, [evidence()]);
  await h.claim({remote: Array.from({length: 30}, (_, i) => evidence(i + 1))});
  assert.equal([...h.fileClaims.values()][0].remote.length, 25);
  await h.claim({remote: {...evidence()}});
  assert.deepEqual([...h.fileClaims.values()][0].remote, []);
});

await test("sole claimant receives PR author/file warning without a hold", async () => {
  const h = harness();
  const result = await h.claim({remote: [evidence()]});
  assert.equal(result.status, 200);
  assert.equal(result.hold, null);
  assert.equal(h.warnings().length, 1);
  assert.equal(h.warnings()[0][0], "one:alpha");
  assert.match(h.warnings()[0][1], /open PR #7 by alice in acme\/widgets also changes src\/x.ts/);
});

await test("repeat claims, hold checks and restart preserve one warning", async () => {
  const h = harness();
  await h.claim({remote: [evidence()]});
  await h.claim({remote: [evidence()]});
  await h.claim({}, "/hold/check");
  assert.deepEqual([...h.fileClaims.values()][0].remote, [evidence()]);
  h.restart();
  h.ctx.overseer.overseerTick();
  assert.equal(h.warnings().length, 1);
});

await test("two PRs on one file have independent episodes", async () => {
  const h = harness();
  await h.claim({remote: [evidence(7), evidence(8)]});
  assert.equal(h.warnings().length, 2);
  assert.equal(h.remoteActive().length, 2);
  await h.claim({remote: [evidence(8)]});
  assert.equal(h.remoteActive().length, 1);
  await h.claim({remote: [evidence(7), evidence(8)]});
  assert.equal(h.warnings().length, 3);
});

await test("different repo or project cannot inherit a PR episode", async () => {
  const h = harness();
  await h.claim({remote: [evidence()]});
  await h.claim({session: "two:alpha", gitRoot: "/checkout/other", remote: []});
  assert.equal(h.warnings().length, 1);
  await h.claim({session: "two:alpha", gitRoot: "/checkout/other", remote: [evidence(7, "acme/other")]});
  await h.claim({session: "three:beta", project: "beta", gitRoot: "/checkout/beta", remote: [evidence()]});
  assert.equal(h.warnings().length, 3);
  assert.equal(h.remoteActive().length, 3);
});

await test("projects sharing a checkout keep remote episodes and recipients separate", async () => {
  const h = harness();
  await h.claim({remote: [evidence()]});
  await h.claim({project: "beta", session: "two:beta", remote: [evidence()]});
  assert.equal(h.remoteActive().length, 2);
  assert.deepEqual(h.warnings().map(([session]) => session), ["one:alpha", "two:beta"]);
  await h.claim({remote: []});
  assert.equal(h.remoteActive().length, 1);
  await h.claim({remote: [evidence()]});
  assert.deepEqual(h.warnings().map(([session]) => session), ["one:alpha", "two:beta", "one:alpha"]);
});

await test("new claimant receives one warning for an existing episode", async () => {
  const h = harness();
  await h.claim({remote: [evidence()]});
  await h.claim({session: "two:alpha", remote: [evidence()]});
  await h.claim({session: "two:alpha", remote: [evidence()]});
  assert.equal(h.warnings().length, 2);
  assert.equal(h.warnings()[1][0], "two:alpha");
});

await test("empty or missing evidence ends the episode immediately", async () => {
  const h = harness();
  await h.claim({remote: [evidence()]});
  await h.claim({remote: []});
  assert.equal(h.remoteActive().length, 0);
  await h.claim({remote: [evidence()]});
  assert.equal(h.warnings().length, 2);
  await h.claim();
  assert.equal(h.remoteActive().length, 0);
});

await test("claim expiry ends the remote episode without a clear-window delay", async () => {
  const h = harness();
  await h.claim({remote: [evidence()]});
  h.advance(600_001);
  h.ctx.overseer.overseerTick();
  assert.equal(h.remoteActive().length, 0);
  await h.claim({remote: [evidence()]});
  assert.equal(h.warnings().length, 2);
});

await test("observe records evidence without notifying claimants", async () => {
  const h = harness(1);
  await h.claim({remote: [evidence()]});
  assert.equal(h.warnings().length, 0);
  assert.equal(h.events.filter(([type, , , data]) => type === "overseer.warn" && data.kind === "remote-overlap").length, 1);
});
console.log(`${passed} passed`);
