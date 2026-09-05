import { call } from "./core.mjs";

export function epochMs() {
  return Date.now();
}

export function verifyCrew(ctx, agents, since) {
  const result = call(process.execPath, [
    `${ctx.root}/bin/crew-verify.mjs`, ctx.project, ...agents,
    "--since", String(since), "--timeout", "30",
  ], { env: ctx.env });
  if (result.stdout) console.log(result.stdout);
  return result.stdout;
}

export function failedAgents(output) {
  const line = String(output).split("\n").find(value => value.startsWith("FAILED:"));
  return line ? line.slice("FAILED:".length).split(",").map(value => value.trim()).filter(Boolean) : [];
}
