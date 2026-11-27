#!/usr/bin/env node
import { strict as assert } from "node:assert";
import { createServer } from "node:net";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { once } from "node:events";
import { drillEnv } from "../drill-env.mjs";
import { createBrowserClient } from "../../lib/browser-client.mjs";
import { dep } from "../../lib/dep.mjs";

const ROOT = fileURLToPath(new URL("../../", import.meta.url));
const { Client } = await dep("@modelcontextprotocol/sdk/client/index.js");
const { StdioClientTransport } = await dep("@modelcontextprotocol/sdk/client/stdio.js");
const dir = await mkdtemp(join(ROOT, ".agent-bus-out", "b3-"));
const bus = join(dir, "bus");
await mkdir(bus);
const socketPath = join(bus, "browser.sock");
const requests = [], sockets = new Set(), clients = [];
let respond = () => ({}), passed = 0;
const fake = createServer(socket => {
  sockets.add(socket);
  socket.on("close", () => sockets.delete(socket));
  socket.on("error", () => {});
  socket.setEncoding("utf8");
  let buffer = "";
  socket.on("data", chunk => {
    buffer += chunk;
    const end = buffer.indexOf("\n");
    if (end < 0) return;
    const request = JSON.parse(buffer.slice(0, end));
    buffer = buffer.slice(end + 1);
    requests.push(request);
    const result = respond(request, socket);
    if (result !== undefined) socket.end(JSON.stringify({ id: request.id, ok: true, ...result }) + "\n");
  });
});
async function test(name, run) {
  await run();
  passed++;
  console.log(`  ✓ ${name}`);
}
function client(options = {}) {
  return createBrowserClient({ session: "codex-8:browser-test", label: "codex-8", project: "browser-test", busDir: bus, ...options });
}
async function mcp(overrides = {}) {
  const transport = new StdioClientTransport({ command: process.execPath, args: [join(ROOT, "mcp.mjs")], cwd: ROOT,
    env: drillEnv({ HOME: dir, AGENT_BUS_DIR: bus, CLAUDE_PROJECT_DIR: dir, RELAY_URL: "http://127.0.0.1:1",
      RELAY_PROJECT: "browser-test", RELAY_SESSION: "codex-8:browser-test", RELAY_AGENT: "wrong-agent", ...overrides }), stderr: "pipe" });
  const peer = new Client({ name: "browser-drill", version: "1" });
  clients.push(peer);
  await peer.connect(transport);
  return peer;
}
const call = (peer, name, args = {}) => peer.callTool({ name: `browser_${name}`, arguments: args });
const body = result => JSON.parse(result.content[0].text);

console.log("# browser socket and MCP tools");
try {
  await test("absent socket returns no_app and the required message", async () => {
    await assert.rejects(client()("read"), { code: "no_app", message: "Trantor's desktop app is not open on this machine" });
  });
  fake.listen(socketPath);
  await once(fake, "listening");

  await test("requests carry UUID, session, display label and project; responses may be split", async () => {
    respond = (req, socket) => {
      const bytes = Buffer.from(JSON.stringify({ id: req.id, ok: true, text: "café 🐈" }) + "\n");
      const split = bytes.indexOf(Buffer.from("🐈")) + 1;
      socket.write(bytes.subarray(0, split));
      setImmediate(() => socket.end(bytes.subarray(split)));
    };
    assert.deepEqual(await client()("read"), { text: "café 🐈" });
    const req = requests.at(-1);
    assert.match(req.id, /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
    assert.equal(req.session, "codex-8:browser-test");
    assert.equal(req.label, "codex-8");
    assert.equal(req.project, "browser-test");
  });
  await test("caller arguments cannot replace transport identity or op", async () => {
    respond = () => ({});
    await client()("read", { id: "forged", session: "forged", label: "forged", project: "forged", op: "evaluate" });
    assert.equal(requests.at(-1).op, "read");
    assert.equal(requests.at(-1).session, "codex-8:browser-test");
    assert.equal(requests.at(-1).project, "browser-test");
  });
  await test("server error codes preserve their exact messages", async () => {
    for (const code of ["denied", "not_found", "timeout", "bad_request", "unsupported", "future_code"]) {
      respond = () => ({ ok: false, error: code, message: `Exact ${code} message — untouched.` });
      await assert.rejects(client()("click"), { code, message: `Exact ${code} message — untouched.` });
    }
  });
  await test("held browser polls state without repeating an action until give-back", async () => {
    const start = requests.length, notices = [];
    let polls = 0, clicks = 0;
    respond = req => req.op === "state" ? { held_by_user: ++polls < 2 }
      : ++clicks === 1 ? { ok: false, error: "held_by_user", message: "Operator is driving" } : {};
    await client({ pollMs: 5 })("click", { ref: "b1", page: "p1" }, async message => notices.push(message));
    assert.deepEqual(requests.slice(start).map(r => r.op), ["click", "state", "state", "click"]);
    assert.ok(requests.slice(start).every(r => r.page === "p1"));
    assert.match(notices[0], /give back/);
    assert.equal(new Set(requests.slice(start).map(r => r.id)).size, 4);
  });
  await test("approval polls state then retries; denial propagates unchanged", async () => {
    let attempts = 0;
    const notices = [];
    respond = req => req.op === "state" ? { held_by_user: false }
      : ++attempts < 3 ? { ok: false, error: "waiting_for_approval", message: "Asked for example.com" }
        : { ok: false, error: "denied", message: "Access denied by operator" };
    await assert.rejects(client({ pollMs: 5 })("open", { url: "https://example.com" }, async message => notices.push(message)),
      { code: "denied", message: "Access denied by operator" });
    assert.equal(attempts, 3);
    assert.match(notices[0], /approve browser access/);
  });
  await test("both wait reasons expire with clear messages and a bounded deadline", async () => {
    for (const code of ["held_by_user", "waiting_for_approval"]) {
      respond = req => req.op === "state" ? { held_by_user: code === "held_by_user" }
        : { ok: false, error: code, message: "Still waiting" };
      const start = Date.now();
      await assert.rejects(client({ pollMs: 5, waitMs: 40 })("read"), error =>
        error.code === code && /Waited 0.04s for the operator/.test(error.message));
      assert.ok(Date.now() - start < 1000);
    }
  });
  await test("takeover during approval changes the reported wait reason", async () => {
    const notices = [];
    respond = req => req.op === "state" ? { held_by_user: true }
      : { ok: false, error: "waiting_for_approval", message: "Approval pending" };
    await assert.rejects(client({ pollMs: 5, waitMs: 40 })("read", {}, async message => notices.push(message)),
      error => error.code === "held_by_user" && /give back/.test(error.message));
    assert.equal(notices.length, 2);
  });
  await test("a silent socket times out and a silent state cannot extend the wait deadline", async () => {
    respond = () => undefined;
    await assert.rejects(client({ timeoutMs: 30 })("read"), { code: "timeout" });
    respond = req => req.op === "state" ? undefined : { ok: false, error: "held_by_user", message: "Taken over" };
    await assert.rejects(client({ pollMs: 5, waitMs: 40 })("read"), error => error.code === "held_by_user" && /Waited/.test(error.message));
  });
  await test("invalid JSON, wrong response IDs and truncated replies fail without retries", async () => {
    for (const reply of ["{broken\n", '{"id":"wrong","ok":true}\n', "{truncated"]) {
      const start = requests.length;
      respond = (_req, socket) => { socket.end(reply); };
      await assert.rejects(client()("read"), error => ["bad_response", "connection_closed"].includes(error.code));
      assert.equal(requests.length, start + 1);
    }
  });
  await test("AGENT_BUS_DIR defaults to the environment's socket location", async () => {
    const original = process.env.AGENT_BUS_DIR;
    process.env.AGENT_BUS_DIR = bus;
    respond = () => ({ title: "Env socket" });
    try {
      const read = createBrowserClient({ session: "s", label: "s", project: "p" });
      assert.equal((await read("read")).title, "Env socket");
    } finally { process.env.AGENT_BUS_DIR = original; }
  });

  const peer = await mcp();
  await test("MCP advertises all ten browser tools with optional page ids", async () => {
    const list = (await peer.listTools()).tools.filter(t => t.name.startsWith("browser_"));
    assert.deepEqual(list.map(t => t.name).sort(), ["open", "read", "click", "type", "scroll", "screenshot", "resize", "pages", "back", "forward"].map(t => `browser_${t}`).sort());
    assert.ok(list.every(t => t.inputSchema.properties.page && !t.inputSchema.required?.includes("page")));
  });
  const cases = [
    ["open", { url: "http://localhost:3000" }, "open", { url: "http://localhost:3000" }],
    ["open", { url: "https://example.com", new_page: true }, "new_page", { url: "https://example.com" }],
    ["read", { max_chars: 200 }, "read", { max_chars: 200 }],
    ["click", { ref: "b1" }, "click", { ref: "b1" }],
    ["click", { selector: "#go" }, "click", { selector: "#go" }],
    ["click", { x: 0, y: 12 }, "click", { x: 0, y: 12 }],
    ["type", { selector: "input", text: "hello\nworld", submit: true }, "type", { selector: "input", text: "hello\nworld", submit: true }],
    ["type", { ref: "field", text: "" }, "type", { ref: "field", text: "" }],
    ["scroll", { dy: -200 }, "scroll", { dy: -200 }],
    ["resize", { w: 1280, h: 800 }, "resize", { w: 1280, h: 800 }],
    ["resize", { device: "iPhone 15" }, "resize", { device: "iPhone 15" }],
    ["resize", {}, "resize", {}], ["pages", {}, "pages", {}], ["back", {}, "back", {}], ["forward", {}, "forward", {}],
  ];
  for (const [name, args, op, expected] of cases) {
    await test(`MCP ${name} maps ${JSON.stringify(args)} to the socket`, async () => {
      respond = () => ({ title: "Result", text: "Page text", outline: [{ ref: "b1", role: "button", name: "Go" }] });
      const result = await call(peer, name, { ...args, page: "page-2" });
      assert.equal(result.isError, undefined);
      assert.equal(body(result).title, "Result");
      const { id, session, label, project, ...sent } = requests.at(-1);
      assert.deepEqual(sent, { ...expected, page: "page-2", op });
      assert.equal(session, "codex-8:browser-test");
      assert.equal(label, "codex-8");
      assert.equal(project, "browser-test");
    });
  }
  await test("MCP screenshot returns exact PNG bytes and saved path, mapping ref to element", async () => {
    const path = join(bus, "browser-shots", "shot.png");
    await mkdir(join(bus, "browser-shots"));
    const png = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a3l8AAAAASUVORK5CYII=", "base64");
    await writeFile(path, png);
    respond = () => ({ path });
    for (const args of [{ ref: "b1" }, {}]) {
      const result = await call(peer, "screenshot", args);
      assert.equal(body(result).path, path);
      const image = result.content.find(c => c.type === "image");
      assert.equal(image.mimeType, "image/png");
      assert.deepEqual(Buffer.from(image.data, "base64"), png);
      assert.equal(requests.at(-1).element, args.ref);
      assert.equal(requests.at(-1).ref, undefined);
    }
  });
  await test("missing screenshot file is an MCP error", async () => {
    respond = () => ({ path: join(bus, "missing.png") });
    assert.equal((await call(peer, "screenshot")).isError, true);
  });
  await test("invalid targets and incomplete sizes never reach the socket", async () => {
    const start = requests.length;
    for (const [name, args] of [["click", {}], ["click", { x: 1 }], ["click", { ref: "a", selector: "b" }],
      ["click", { ref: "a", y: 2 }], ["type", { text: "x" }], ["resize", { w: 20 }],
      ["resize", { device: "iPhone 15", w: 10, h: 10 }], ["resize", { device: "unknown" }], ["read", { max_chars: -1 }]]) {
      assert.equal((await call(peer, name, args)).isError, true);
    }
    assert.equal(requests.length, start);
  });
  await test("MCP returns server errors verbatim and preserves the code", async () => {
    respond = () => ({ ok: false, error: "unsupported", message: "This operation is not supported here." });
    const result = await call(peer, "back");
    assert.equal(result.isError, true);
    assert.equal(result.content[0].text, "This operation is not supported here.");
    assert.equal(result.structuredContent.error, "unsupported");
  });
  await test("MCP reports approval progress and polls state at one-second intervals", async () => {
    const progress = [], times = [];
    let attempts = 0;
    respond = req => {
      times.push(Date.now());
      return req.op === "state" ? { held_by_user: false }
        : ++attempts === 1 ? { ok: false, error: "waiting_for_approval", message: "Asked about example.com" } : { title: "Approved" };
    };
    const result = await peer.callTool({ name: "browser_open", arguments: { url: "https://example.com" } }, undefined,
      { onprogress: update => progress.push(update) });
    assert.equal(body(result).title, "Approved");
    assert.match(progress[0].message, /approve browser access/);
    assert.ok(times[1] - times[0] >= 950);
  });
  await test("orchestrator sessions use the orchestrator display label", async () => {
    const orch = await mcp({ TRANTOR_ORCH: "browser-test", RELAY_SESSION: "my-host:browser-test" });
    respond = () => ({});
    await call(orch, "pages");
    assert.equal(requests.at(-1).label, "orchestrator");
    assert.equal(requests.at(-1).session, "my-host:browser-test");
  });
  await test("MCP reports no_app when the desktop socket disappears", async () => {
    for (const socket of sockets) socket.destroy();
    await new Promise(resolve => fake.close(resolve));
    const result = await call(peer, "read");
    assert.equal(result.isError, true);
    assert.equal(result.content[0].text, "Trantor's desktop app is not open on this machine");
    assert.equal(result.structuredContent.error, "no_app");
  });
  console.log(`ALL PASS — ${passed} browser checks`);
} catch (error) {
  console.error(`FAIL after ${passed} checks:`, error);
  process.exitCode = 1;
} finally {
  for (const peer of clients) await peer.close();
  for (const socket of sockets) socket.destroy();
  if (fake.listening) await new Promise(resolve => fake.close(resolve));
  await rm(dir, { recursive: true, force: true });
}
