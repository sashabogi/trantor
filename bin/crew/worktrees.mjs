import { basename, join } from "node:path";
import { existsSync } from "node:fs";
import { call } from "./core.mjs";

function gitRoot(dir) {
  const result = call("git", ["-C", dir, "rev-parse", "--show-toplevel"]);
  return result.ok ? result.stdout : "";
}

export function resolveOrchestratorDir(ctx, projectArg) {
  const target = projectArg || ctx.project;
  const badge = ctx.env.TRANTOR_ORCH || ctx.env.TRANTOR_SEAT || "";
  const root = gitRoot(ctx.dir);
  const here = root ? basename(root) : "";
  if (badge && badge !== target) {
    throw new Error(`trantor open: refused — this shell is badged for '${badge}', not '${target}'; open it from the target project's shell`);
  }
  if (here && here !== target) {
    throw new Error(`trantor open: refused — cwd belongs to project '${here}', not '${target}'; cd to the target checkout first`);
  }
  if (!projectArg || target === here) return { dir: ctx.dir, project: target };
  const devRoot = ctx.env.TRANTOR_DEV_ROOT || join(ctx.home, "development");
  const targetDir = join(devRoot, target);
  if (existsSync(targetDir)) {
    console.error(`— opening ${target} in its checkout: ${targetDir} —`);
    return { dir: targetDir, project: target };
  }
  throw new Error(`trantor open: '${target}' has no checkout at ${targetDir} — cd into the project first`);
}

function linkedByTest(env, badge, project) {
  if (!("CREW_TEST_POLICY_LINKS" in env)) return null;
  const links = String(env.CREW_TEST_POLICY_LINKS).split(",");
  return links.includes(`${badge}:${project}`) || links.includes(`${project}:${badge}`);
}

export function guardCrossProjectUp(ctx) {
  const badge = ctx.env.TRANTOR_ORCH || ctx.env.TRANTOR_SEAT || "";
  if (!badge || badge === ctx.project) return true;
  let linked = linkedByTest(ctx.env, badge, ctx.project);
  if (linked === null) linked = call(process.execPath, [join(ctx.root, "bin/policy.mjs"), "check", badge, ctx.project], { env: ctx.env }).ok;
  if (!linked) {
    console.error(`trantor: refused — this shell is badged for '${badge}', not '${ctx.project}'.`);
    console.error("  Cross-project action is a breach unless the operator linked the projects.");
    console.error(`  Run: trantor policy link ${badge} ${ctx.project} --reason \"<why>\"`);
    return false;
  }
  console.error(`trantor: '${badge}' ↔ '${ctx.project}' is policy-linked — proceeding.`);
  return true;
}
