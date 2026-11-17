// #13474: a cut or parked seat's uncommitted work is committed on its own branch so the next seat
// starts from it. Never pushes, never touches main, and a clean tree makes no commit.
import { spawnSync } from "node:child_process";

const git = (cwd, args) => spawnSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], timeout: 20000 });

/** The new sha, or "" when nothing was saved (clean tree, detached HEAD, main, or a git failure). */
export function saveWip(cwd, card) {
  const branch = String(git(cwd, ["rev-parse", "--abbrev-ref", "HEAD"]).stdout || "").trim();
  if (!branch || branch === "HEAD" || branch === "main" || branch === "master") return "";
  if (!String(git(cwd, ["status", "--porcelain"]).stdout || "").trim()) return "";
  if (git(cwd, ["add", "-A"]).status !== 0) return "";
  const msg = `WIP(#${card}): saved at cut`;
  const c = git(cwd, ["-c", "user.name=trantor-seat", "-c", "user.email=seat@trantor.local", "commit", "--no-verify", "-qm", msg]);
  return c.status === 0 ? String(git(cwd, ["rev-parse", "HEAD"]).stdout || "").trim() : "";
}
