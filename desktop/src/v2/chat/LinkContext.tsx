// What a chat link needs from its host (#14327): which project it belongs to, how to confirm a path
// or commit exists, and what a click does. The 2.0 workspace provides the real ones; anywhere else
// the default confirms nothing and opens nothing, so a bare transcript renders plain text and URLs.
import { createContext, useContext, useMemo, type ReactNode } from "react";
import type { Link, LinkResolver } from "../../shared/linkify";
import { linkResolverFor } from "../../shared/linkify";
import type { Navigate } from "../routes";
import { openLink, openLinkDeps, type OpenLinkDeps } from "../shell/openLink";
import { openInBrowserTab } from "../shell/openInBrowserTab";
import { setOpenIntent } from "../shell/openIntent";

export type LinkContextValue = {
  /** Confirms pending paths and commits; null keeps them as plain text. */
  resolver: LinkResolver | null;
  open: (link: Link, modifiers?: { metaKey: boolean }) => void;
  /** "Open diff" on an edit card: the change view for one path. */
  openDiff: (path: string) => void;
  /** Whether a path is inside this project's checkout. An edit to a file outside it (a scratch
   *  note, another repo) never shows in Source Control, so the card says so. */
  locate: (path: string) => Promise<"inside" | "outside" | "unknown">;
  /** The project's name, for the "outside <project>" label. */
  project: string;
};

const NONE: LinkContextValue = { resolver: null, open: () => {}, openDiff: () => {}, locate: async () => "unknown", project: "" };

const LinkContext = createContext<LinkContextValue>(NONE);

export const useLinks = (): LinkContextValue => useContext(LinkContext);

/** Provides an explicit context value: tests and previews inject fakes here. */
export function LinkProvider({ value, children }: { value: LinkContextValue; children: ReactNode }) {
  return <LinkContext.Provider value={value}>{children}</LinkContext.Provider>;
}

/** The workspace's links: the project's checkout confirms paths and commits, a click routes through
 *  openLink. `seat` names the worktree the chat belongs to, so its files open in that copy. */
export function ChatLinks({ project, navigate, seat, deps, browserOpen = openInBrowserTab, children }: {
  project: string; navigate: Navigate; seat?: string; deps?: OpenLinkDeps; browserOpen?: typeof openInBrowserTab; children: ReactNode;
}) {
  const value = useMemo<LinkContextValue>(() => {
    const wired = deps ?? openLinkDeps(navigate);
    return {
      resolver: linkResolverFor(project),
      open: (link, modifiers) => {
        const action = link.kind === "url" && /^https?:\/\//i.test(link.href) && !modifiers?.metaKey
          ? browserOpen(project, link.href)
          : openLink(project, link, wired, seat);
        void action.catch(() => {});
      },
      openDiff: path => { setOpenIntent(project, { kind: "change", path, seat }); navigate("code", project); },
      locate: async path => {
        try { return (await wired.resolvePath(project, path))?.inside ? "inside" : "outside"; }
        catch { return "unknown"; }
      },
      project,
    };
  }, [project, navigate, seat, deps, browserOpen]);
  return <LinkProvider value={value}>{children}</LinkProvider>;
}
