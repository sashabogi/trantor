#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";

const AXE_INSTALL = `bash ${join(dirname(fileURLToPath(import.meta.url)), "install-axe.sh")}`;
const [, , verb, ...args] = process.argv;
const owner = process.env.RELAY_SESSION || process.env.CLAUDE_SESSION_ID || process.cwd();
const ownerId = createHash("sha256").update(owner).digest("hex").slice(0, 16);
const registryPath = process.env.TRANTOR_SIM_REGISTRY || join(tmpdir(), "trantor-sim-registry.json");
const outputRoot = process.env.TRANTOR_SIM_OUTPUT || join(process.cwd(), ".agent-bus-out", "sim");

function fail(reason) {
  console.error(String(reason).trim() || "simulator command failed");
  process.exit(1);
}

function command(file, argv, { optional = false } = {}) {
  const result = spawnSync(file, argv, { encoding: "utf8", maxBuffer: 32 * 1024 * 1024 });
  if (result.error?.code === "ENOENT" && optional) return null;
  if (result.error) fail(`${file} failed: ${result.error.message}`);
  if (result.status !== 0) fail((result.stderr || result.stdout || `${file} exited ${result.status}`).trim());
  return result.stdout || "";
}

function axe(args) {
  const result = spawnSync("axe", args, { encoding: "utf8", maxBuffer: 32 * 1024 * 1024 });
  if (result.error?.code === "ENOENT") fail(`AXe is missing. Install the pinned release with: ${AXE_INSTALL}`);
  if (result.error) fail(`axe failed: ${result.error.message}`);
  if (result.status !== 0) fail((result.stderr || result.stdout || `axe exited ${result.status}`).trim());
  return result.stdout || "";
}

function registry() {
  try { return JSON.parse(readFileSync(registryPath, "utf8")); }
  catch (error) {
    if (error.code === "ENOENT") return { owners: {} };
    fail(`cannot read simulator registry: ${error.message}`);
  }
}

function saveRegistry(value) {
  mkdirSync(dirname(registryPath), { recursive: true });
  const temp = `${registryPath}.${process.pid}.tmp`;
  writeFileSync(temp, JSON.stringify(value));
  renameSync(temp, registryPath);
}

function simulators() {
  let list;
  try { list = JSON.parse(command("xcrun", ["simctl", "list", "devices", "--json"])); }
  catch (error) { fail(`could not read Simulator devices: ${error.message}`); }
  return Object.values(list.devices || {}).flat();
}

function selected() {
  const id = registry().owners[ownerId]?.udid;
  if (!id) fail("this session has no simulator; run trantor sim boot <device> first");
  const device = simulators().find((item) => item.udid === id);
  if (!device || device.state !== "Booted") fail(`owned simulator ${id} is not booted; run trantor sim boot <device>`);
  return device;
}

function emit(value) { process.stdout.write(`${JSON.stringify(value)}\n`); }

function resolveDevice(name, devices) {
  const matches = devices.filter((device) => device.udid === name || device.name === name);
  if (matches.length === 0) fail(`simulator not found: ${name}`);
  if (matches.length > 1) fail(`simulator name is ambiguous: ${name}; pass its UDID`);
  return matches[0];
}

function parseTree(raw) {
  let tree;
  try { tree = JSON.parse(raw); }
  catch { fail("AXe returned invalid accessibility JSON"); }
  if (tree?.didError) fail(tree.error?.message || "AXe accessibility read failed");
  const root = tree?.data?.result ?? tree;
  const elements = [];
  let maxX = 0, maxY = 0;
  const visit = (node) => {
    if (Array.isArray(node)) { for (const child of node) visit(child); return; }
    if (!node || Object.getPrototypeOf(node) !== Object.prototype) return;
    const frame = node.frame || node.AXFrame;
    if (frame && Object.getPrototypeOf(frame) === Object.prototype) {
      const x = Number(frame.x ?? 0), y = Number(frame.y ?? 0);
      const width = Number(frame.width ?? 0), height = Number(frame.height ?? 0);
      if ([x, y, width, height].every(Number.isFinite)) {
        maxX = Math.max(maxX, x + width); maxY = Math.max(maxY, y + height);
        const label = node.AXLabel ?? node.label ?? node.title ?? node.AXValue ?? "";
        const role = node.role_description ?? node.role ?? node.type ?? node.AXRole ?? "";
        const id = node.AXUniqueId ?? node.identifier ?? node.id;
        if (label || role || id) {
          const element = { frame: { x, y, width, height }, enabled: node.enabled ?? node.isEnabled ?? true };
          if (label) element.label = String(label);
          if (id) element.id = String(id);
          if (role) element.role = String(role);
          elements.push(element);
        }
      }
    }
    for (const [key, value] of Object.entries(node)) if (key === "children" || key === "AXChildren") visit(value);
  };
  visit(root);
  if (maxX <= 0 || maxY <= 0) fail("AXe accessibility tree has no screen-sized frame");
  return { elements, widthPoints: Math.round(maxX), heightPoints: Math.round(maxY) };
}

function point(value, name) {
  const coords = String(value || "").split(",").map(Number);
  if (coords.length !== 2 || coords.some((part) => !Number.isFinite(part) || part < 0)) fail(`${name} must be x,y in simulator points`);
  return coords;
}

try {
  if (verb === "boot") {
    if (args.length !== 1 || !args[0]) fail("usage: trantor sim boot <device-name-or-udid>");
    const devices = simulators();
    const target = resolveDevice(args[0], devices);
    const shared = registry();
    const anotherOwner = Object.entries(shared.owners).find(([key, value]) => key !== ownerId && value.udid === target.udid);
    if (anotherOwner) fail(`simulator ${target.name} is owned by another agent session`);
    const bootedElsewhere = devices.find((device) => device.state === "Booted" && device.udid !== target.udid);
    if (bootedElsewhere) fail(`another simulator is already booted (${bootedElsewhere.name}, ${bootedElsewhere.udid}); shut it down before booting ${target.name}`);
    if (target.state !== "Booted") {
      command("xcrun", ["simctl", "boot", target.udid]);
      command("xcrun", ["simctl", "bootstatus", target.udid, "-b"]);
    }
    shared.owners[ownerId] = { udid: target.udid, name: target.name, startedAt: new Date().toISOString() };
    saveRegistry(shared);
    emit({ verb, udid: target.udid, device: target.name, reused: target.state === "Booted", state: "Booted" });
  } else if (verb === "install") {
    if (args.length !== 1) fail("usage: trantor sim install <app-path>");
    const device = selected(), app = resolve(args[0]);
    command("xcrun", ["simctl", "install", device.udid, app]);
    emit({ verb, udid: device.udid, app });
  } else if (verb === "launch") {
    if (args.length !== 1) fail("usage: trantor sim launch <bundle-id>");
    const device = selected();
    const result = command("xcrun", ["simctl", "launch", device.udid, args[0]]).trim();
    emit({ verb, udid: device.udid, bundle: args[0], result });
  } else if (verb === "screen") {
    const device = selected();
    const outAt = args.indexOf("--out");
    if (args.length && (outAt !== 0 || args.length !== 2 || !args[1])) fail("usage: trantor sim screen [--out <png-path>]");
    const path = resolve(outAt === 0 ? args[1] : join(outputRoot, `screen-${Date.now()}.png`));
    mkdirSync(dirname(path), { recursive: true });
    command("xcrun", ["simctl", "io", device.udid, "screenshot", path]);
    const tree = parseTree(axe(["describe-ui", "--minimal-keys", "--udid", device.udid]));
    const dimensions = command("sips", ["-g", "pixelWidth", "-g", "pixelHeight", path]);
    const pixelWidth = Number(dimensions.match(/pixelWidth:\s*(\d+)/)?.[1]);
    const pixelHeight = Number(dimensions.match(/pixelHeight:\s*(\d+)/)?.[1]);
    if (!pixelWidth || !pixelHeight) fail("could not read screenshot dimensions with sips");
    const scaledPath = `${path}.scaled.png`;
    command("sips", ["-z", String(tree.heightPoints), String(tree.widthPoints), path, "--out", scaledPath]);
    rmSync(path, { force: true });
    command("/bin/mv", [scaledPath, path]);
    emit({ verb, udid: device.udid, screenshot: path, dimensionsPoints: { width: tree.widthPoints, height: tree.heightPoints }, elements: tree.elements });
  } else if (verb === "tap") {
    const device = selected();
    const mode = args[0], value = args[1];
    if (args.length !== 2 || !["--label", "--id", "--xy"].includes(mode) || !value) fail("usage: trantor sim tap --label <text> | --id <identifier> | --xy x,y");
    const target = mode === "--xy" ? ["-x", String(point(value, "--xy")[0]), "-y", String(point(value, "--xy")[1])] : [mode, value];
    axe(["tap", ...target, "--udid", device.udid]);
    emit({ verb, udid: device.udid, selector: mode, target: value });
  } else if (verb === "swipe") {
    const device = selected();
    if (args.length !== 4 || args[0] !== "--from" || args[2] !== "--to") fail("usage: trantor sim swipe --from x,y --to x,y");
    const from = point(args[1], "--from"), to = point(args[3], "--to");
    axe(["swipe", "--start-x", String(from[0]), "--start-y", String(from[1]), "--end-x", String(to[0]), "--end-y", String(to[1]), "--udid", device.udid]);
    emit({ verb, udid: device.udid, from, to });
  } else if (verb === "type") {
    const device = selected(), value = args.join(" ");
    if (!value) fail("usage: trantor sim type <text>");
    axe(["type", value, "--udid", device.udid]);
    emit({ verb, udid: device.udid, characters: [...value].length });
  } else if (verb === "shutdown") {
    if (args.length) fail("usage: trantor sim shutdown");
    const shared = registry(), owned = shared.owners[ownerId];
    if (!owned) { emit({ verb, shutdown: false, reason: "this session owns no simulator" }); }
    else {
      const device = simulators().find((item) => item.udid === owned.udid);
      if (device?.state === "Booted") command("xcrun", ["simctl", "shutdown", owned.udid]);
      delete shared.owners[ownerId];
      saveRegistry(shared);
      emit({ verb, udid: owned.udid, shutdown: device?.state === "Booted", alreadyShutdown: device?.state !== "Booted" });
    }
  } else {
    fail("usage: trantor sim <boot|install|launch|screen|tap|swipe|type|shutdown>");
  }
} catch (error) {
  if (error?.message) fail(error.message);
  fail("simulator command failed");
}
