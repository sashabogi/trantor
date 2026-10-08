import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { setTimeout } from "node:timers/promises";
import { call, commandExists } from "./core.mjs";
import { resolveSpec } from "./models.mjs";
import { runnerRecord, seatProcesses, signalProcesses } from "./processes.mjs";
import { down, readRows, writeRows } from "./state.mjs";
import { providerStatus } from "../../lib/providers.mjs";
import { lookup } from "../../lib/model-catalog.mjs";
import { resolveKeys } from "../../lib/provider-keys.mjs";
import { resolveSecrets } from "../../lib/secrets.mjs";
import { signedGet, signedPost } from "../../hooks/lib/api.mjs";

const NATIVE = new Set(["codex", "kimi", "claude", "gemini", "dsh"]);

export function swapOptions(args) {
  const positional = [];
  const options = { task: "code", difficulty: "medium", provider: "", model: "" };
  for (let i = 0; i < args.length; i++) {
    const key = { "--task": "task", "--difficulty": "difficulty", "--diff": "difficulty", "--provider": "provider", "--model": "model" }[args[i]];
    if (key) {
      if (!args[i + 1] || args[i + 1].startsWith("--")) throw new Error(`missing value for ${args[i]}`);
      options[key] = args[++i];
    } else if (args[i].startsWith("--")) throw new Error(`unknown swap flag ${args[i]}`);
    else positional.push(args[i]);
  }
  const [from, replacement = options.provider ? from : ""] = positional;
  if (!from || !replacement || positional.length > 2) throw new Error("usage: trantor swap <old> [new[:provider/model]] [--provider P] [--model M] [--json]");
  const agent = replacement.split(":")[0];
  if (![from, agent].every(value => /^[A-Za-z0-9_-]+$/.test(value))) throw new Error("invalid seat name");
  return { ...options, from, replacement, agent };
}

export async function validateReplacement(ctx, options, status = providerStatus) {
  const explicit = options.provider;
  const field = options.replacement.split(":").slice(1).join(":");
  const native = NATIVE.has(options.agent) && !explicit;
  const provider = native ? options.agent : (explicit || field.split("/")[0] || (options.agent === "glm" ? "zai-coding-plan" : options.agent));
  const binary = native ? options.agent : "opencode";
  if (!commandExists(binary, ctx.env)) throw new Error(`${binary} CLI not found on PATH; old seat unchanged`);
  const registryName = provider === "zai-coding-plan" ? "zai" : provider;
  const env = resolveKeys(ctx.env, [join(ctx.home, ".token-scrooge/.env"), join(ctx.home, ".agent-bus/.env")], resolveSecrets(ctx.env));
  const rows = await status({ env, path: env.PATH, only: [registryName] });
  const row = rows[0];
  if (!row || row.state !== "connected") throw new Error(`${provider}: ${row?.reason || "no credential validator available"}; old seat unchanged`);
  const spec = explicit ? `${options.agent}-provider:${provider}${options.model ? `/${options.model}` : ""}` : options.model ? `${options.agent}:${options.model}` : options.replacement;
  const skipped = [];
  const seat = resolveSpec({ ...ctx, env }, spec, options.task, options.difficulty, skipped);
  if (!seat) throw new Error(skipped.join("; "));
  if (native && seat.model && !lookup(seat.model).found) {
    let models = [];
    const cache = join(ctx.home, ".codex/models_cache.json");
    if (options.agent === "codex" && existsSync(cache)) models = JSON.parse(readFileSync(cache, "utf8")).models || [];
    if (!models.some(model => model.slug === seat.model)) throw new Error(`cannot validate native model ${seat.model}; old seat unchanged`);
  }
  if (!native) {
    const catalog = call("opencode", ["models", provider], { env });
    const models = catalog.stdout.split(/\s+/).filter(Boolean).map(m => m.startsWith(`${provider}/`) ? m : `${provider}/${m}`);
    if (!catalog.ok || !models.includes(seat.model)) throw new Error(`model ${seat.model} is not in ${provider}'s available catalog; old seat unchanged`);
  }
  return { ...seat, agent: options.agent, driver: native ? "" : "opencode" };
}

export function pendingPath(ctx, agent) { return join(ctx.home, ".agent-bus", `pending-${agent}-${ctx.project}.json`); }

function readPending(ctx, agent) {
  const file = pendingPath(ctx, agent);
  if (!existsSync(file)) return { wake: [], bcast: [], seen: [], ask: 0, askTo: "" };
  return JSON.parse(readFileSync(file, "utf8"));
}

function savePending(ctx, agent, pending) {
  const file = pendingPath(ctx, agent);
  writeFileSync(`${file}.swap`, JSON.stringify({ ...pending, agent, project: ctx.project, ts: Date.now() }));
  renameSync(`${file}.swap`, file);
}

async function hubRequest(ctx, path, body) {
  const response = body
    ? await signedPost(`${ctx.hub}${path}`, body, { project: ctx.project })
    : await signedGet(`${ctx.hub}${path}`, { project: ctx.project });
  if (!response.ok || !response.json?.ok) throw new Error(response.json?.error || response.reason || `hub handoff failed (${response.status})`);
  return response.json;
}

export function swapRuntime(ctx, adapters, spawn) {
  let pids = [];
  let replacementPid;
  return {
    validate: options => {
      if (options.agent !== options.from && readRows(ctx).some(row => row.project === ctx.project && row.agent === options.agent)) throw new Error(`replacement seat ${options.agent} already exists; old seat unchanged`);
      return validateReplacement(ctx, options);
    },
    async start(seat, stage) {
      const staged = { ...ctx, swap: { ...stage, agent: seat.agent, driver: seat.driver } };
      spawn(staged, { ...seat, agent: stage.label });
    },
    async ready(stage) {
      const deadline = Date.now() + 30000;
      while (!existsSync(`${stage.path}.ready`)) {
        if (Date.now() > deadline) throw new Error("replacement did not join the bus within 30s; old seat unchanged");
        await setTimeout(100);
      }
      const ready = JSON.parse(readFileSync(`${stage.path}.ready`, "utf8"));
      const response = await signedGet(`${ctx.hub}/peers?project=${encodeURIComponent(ctx.project)}`, { project: ctx.project });
      if (!response.ok || !response.json?.peers?.some(p => p.session === ready.session)) throw new Error("replacement registration is not visible on the bus");
      process.kill(ready.pid, 0);
      replacementPid = ready.pid;
      return ready.session;
    },
    freeze(agent) { pids = seatProcesses(ctx, ctx.project, agent); signalProcesses(pids, "SIGSTOP"); },
    resume() { signalProcesses(pids, "SIGCONT"); },
    transfer: body => hubRequest(ctx, "/contracts/transfer", body),
    async stop(agent) {
      process.kill(replacementPid, 0);
      await down(ctx, [agent], adapters);
      signalProcesses(pids, "SIGKILL");
    },
    async cancel(stage) { await down(ctx, [stage.label], adapters); },
    release(stage, agent, cursor) {
      writeRows(ctx, readRows(ctx).map(row => row.project === ctx.project && row.agent === stage.label ? { ...row, agent } : row));
      writeFileSync(runnerRecord(ctx, ctx.project, agent), JSON.stringify({ label: stage.label, dir: ctx.dir }));
      writeFileSync(`${stage.path}.release`, JSON.stringify({ agent, cursor }));
    },
  };
}

export async function performSwap(ctx, options, runtime) {
  const result = { ok: false, action: "swap", seat: options.from, to: options.agent, moved: [] };
  let stage, frozen = false, transferred = false;
  try {
    const seat = await runtime.validate(options);
    const label = `${options.agent}-swap-${randomUUID().slice(0, 8)}`;
    mkdirSync(ctx.seatDir, { recursive: true });
    stage = { label, path: join(ctx.seatDir, label) };
    await runtime.start(seat, stage);
    const readySession = await runtime.ready(stage);
    frozen = true;
    await runtime.freeze(options.from);
    const pending = readPending(ctx, options.from);
    const target = options.agent === options.from ? pending : readPending(ctx, options.agent);
    const from = `${options.from}:${ctx.project}`, to = `${options.agent}:${ctx.project}`;
    const handoff = await runtime.transfer({ from, to, project: ctx.project, readySession, _op: `swap-${stage.label}`, heldAsk: pending.ask || 0, pendingIds: pending.wake.map(m => m.id) });
    transferred = true;
    result.moved = [...new Set([...pending.wake.map(m => m.id), ...handoff.moved])];
    const wake = new Map([...target.wake, ...pending.wake, ...handoff.messages].map(m => [m.id, { ...m, to }]));
    savePending(ctx, options.agent, { ...target, wake: [...wake.values()], bcast: [...new Map([...target.bcast, ...pending.bcast].map(m => [m.id, m])).values()], ask: handoff.messages.some(m => m.re === pending.ask) ? 0 : pending.ask || target.ask, askTo: pending.askTo || target.askTo });
    await runtime.stop(options.from);
    frozen = false;
    if (options.agent !== options.from) savePending(ctx, options.from, { ...pending, wake: [], bcast: [], ask: 0, askTo: "" });
    await runtime.release(stage, options.agent, handoff.cursor);
    return { ...result, ok: true };
  } catch (error) {
    if (!transferred) {
      if (frozen) await runtime.resume();
      if (stage) await runtime.cancel(stage);
    }
    result.reason = error.message;
    if (transferred) result.reason += "; handoff recorded on hub; old seat held for recovery";
    return result;
  }
}
