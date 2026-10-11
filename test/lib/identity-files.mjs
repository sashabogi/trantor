import { readdirSync } from "node:fs";
import { isTestIdentity } from "../../lib/key-prune.mjs";

// Live sessions can mint keys during a suite run; only known fixture identities indicate a leak.
export function testIdentityFiles(directory) {
  try {
    return readdirSync(directory).filter(name => name.endsWith(".json") && isTestIdentity(name.slice(0, -5))).sort();
  } catch (error) {
    if (error.code === "ENOENT") return [];
    throw error;
  }
}
