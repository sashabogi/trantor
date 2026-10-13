// Load an npm dependency from code that may run inside the Claude plugin snapshot, which ships
// no node_modules: plain import first, then borrow from the globally installed trantor (as mcp.mjs does).
import { execSync } from "node:child_process";
import { existsSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const req = createRequire(import.meta.url);
let fallbackRoots = null;

function borrowRoots() {
  if (fallbackRoots) return fallbackRoots;
  const roots = [];
  const add = p => { if (p && !roots.includes(p)) roots.push(p); };
  if (process.env.npm_config_prefix) add(join(process.env.npm_config_prefix, "lib", "node_modules"));
  add(join(dirname(process.execPath), "..", "lib", "node_modules"));
  for (const prefix of ["/opt/homebrew", "/usr/local"]) add(join(prefix, "lib", "node_modules"));
  if (!roots.some(r => existsSync(join(r, "trantor")))) {
    try { add(execSync("npm root -g", { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"], timeout: 5000 }).trim()); } catch {}
  }
  fallbackRoots = roots.flatMap(r => [join(r, "trantor"), r]);
  return fallbackRoots;
}

export async function dep(spec) {
  try {
    return await import(spec);
  } catch (error) {
    if (error?.code !== "ERR_MODULE_NOT_FOUND" && error?.code !== "ERR_PACKAGE_PATH_NOT_EXPORTED") throw error;
  }
  for (const path of [HERE, ...borrowRoots()]) {
    try { return await import(pathToFileURL(req.resolve(spec, { paths: [path] })).href); } catch {}
  }
  throw new Error(`cannot resolve '${spec}': this plugin snapshot has no node_modules and no global trantor install to borrow from (npm i -g trantor)`);
}
