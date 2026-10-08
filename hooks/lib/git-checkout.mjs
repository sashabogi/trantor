import { execFileSync } from "node:child_process";
import { realpathSync } from "node:fs";

export function gitCheckoutRoot(directory) {
  try {
    const root = execFileSync("git", ["-C", directory, "rev-parse", "--show-toplevel"],
      { encoding: "utf8", timeout: 1000, stdio: ["ignore", "pipe", "ignore"] }).trim();
    return realpathSync(root);
  } catch { return ""; }
}
