import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

// A standalone suite gets the same isolation as a runner child, before app imports cache paths.
const out = fileURLToPath(new URL("../.agent-bus-out/", import.meta.url));
mkdirSync(out, { recursive: true });
process.env.GIT_CEILING_DIRECTORIES = out.replace(/\/$/, "");
const home = mkdtempSync(join(out, "test-home-"));
process.env.HOME = home;
process.env.TMPDIR = join(home, "tmp");
mkdirSync(process.env.TMPDIR, { recursive: true });
process.env.AGENT_BUS_DIR = join(home, ".agent-bus");
process.env.TRANTOR_NO_KEYCHAIN = "1";
process.env.TRANTOR_SECRETS_BACKEND = "file";
mkdirSync(process.env.AGENT_BUS_DIR, { recursive: true });
process.once("exit", () => rmSync(home, { recursive: true, force: true }));
