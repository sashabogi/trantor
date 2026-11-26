// One place a chat link goes to when clicked (#14327): a url opens in the browser, a path opens in
// Code (at its line, or revealed when it is a folder), a commit opens in History, a card opens in
// the card sheet. Every effect is a dependency, so the routing is testable without a shell.
import { invoke } from "@tauri-apps/api/core";
import { openPath, openUrl } from "@tauri-apps/plugin-opener";
import type { Link } from "../../shared/linkify";
import type { Navigate } from "../routes";
import { openCardSheet } from "./cardIntent";
import { setOpenIntent, type OpenIntent } from "./openIntent";

/** Where a confirmed path lives: checkout-relative when `inside`, else absolute (under home). */
export type ResolvedPath = { path: string; dir: boolean; inside: boolean };

export type OpenLinkDeps = {
  navigate: Navigate;
  openUrl: (url: string) => void | Promise<void>;
  openExternalPath: (absolute: string) => void | Promise<void>;
  setIntent: (project: string, intent: OpenIntent) => void;
  openCard: (project: string, id: number) => void;
  resolvePath: (project: string, raw: string) => Promise<ResolvedPath | null>;
};

export function openLinkDeps(navigate: Navigate): OpenLinkDeps {
  return {
    navigate,
    openUrl,
    openExternalPath: openPath,
    setIntent: setOpenIntent,
    openCard: openCardSheet,
    resolvePath: (project, path) => invoke<ResolvedPath | null>("resolve_link_path", { project, path }),
  };
}

/** `seat` names the worktree the link came from, so a seat's file opens in that seat's copy. */
export async function openLink(project: string, link: Link, deps: OpenLinkDeps, seat?: string): Promise<void> {
  if (link.kind === "url") { await deps.openUrl(link.href); return; }
  if (link.kind === "card") { deps.openCard(project, Number(link.href)); return; }
  if (link.kind === "commit") {
    deps.setIntent(project, { kind: "commit", sha: link.href, seat });
    deps.navigate("code", project);
    return;
  }
  const where = await deps.resolvePath(project, link.href);
  if (!where) return;
  if (!where.inside) { await deps.openExternalPath(where.path); return; }
  deps.setIntent(project, where.dir
    ? { kind: "folder", path: where.path, seat }
    : { kind: "file", path: where.path, line: link.line, col: link.col, seat });
  deps.navigate("code", project);
}
