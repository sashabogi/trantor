// Vendored from Flare shared/review.ts (5adc94b), MIT License, Copyright (c) 2026 AlgoNoRhythm;
// the notice is graph/LICENSE.flare. Local edits (#7971): one file's inputs are read off
// code_graph (fileReview), coverage stays null until an lcov reader lands (blueprint §3), and
// the `blast:` line hollow-move.mjs writes on a card note (#7968) is read back (parseBlastLine).
import type { CodeGraph } from "./graph/graphApi";

export type ReviewTier = "careful" | "read" | "skim";

export type TierInput = {
  path: string;
  /** regression-risk composite, 0..100 within this repo; 0 until the Risk lens lands */
  risk: number;
  /** transitive dependents */
  blastRadius: number;
  /** direct importers */
  fanIn: number;
  coveragePct: number | null;
  testedBy: number;
  complexity: number;
  inCycle: boolean;
  isTest: boolean;
};

export type TierResult = {
  tier: ReviewTier;
  /** short, quantified, worst-first; shown next to the file */
  reasons: string[];
};

export const TIER_ORDER = { careful: 0, read: 1, skim: 2 };

export const TIER_LABEL = {
  careful: "Read carefully",
  read: "Read",
  skim: "Skim",
};

export const TIER_HINT = {
  careful: "load-bearing and under-protected, read the whole diff",
  read: "has real dependents or real complexity, read the diff",
  skim: "leaf, small or well covered, a glance is enough",
};

/** Nothing meaningful is checking this file. Null coverage falls back to testedBy, never to 0%. */
export function uncovered(f: TierInput): boolean {
  return f.coveragePct === null ? f.testedBy === 0 : f.coveragePct < 30;
}

export function reviewTier(f: TierInput): TierResult {
  const reasons: string[] = [];

  if (f.blastRadius >= 3) {
    reasons.push(`${f.blastRadius} file${f.blastRadius === 1 ? "" : "s"} break if this is wrong`);
  } else if (f.fanIn >= 1) {
    reasons.push(f.fanIn === 1 ? "1 file imports it" : `${f.fanIn} files import it`);
  }
  if (uncovered(f)) {
    reasons.push(f.coveragePct === null ? "no test covers it" : `only ${Math.round(f.coveragePct)}% covered`);
  }
  if (f.inCycle) reasons.push("sits in an import cycle");
  if (f.complexity >= 40) reasons.push(`complexity ${f.complexity}`);

  const careful =
    f.risk >= 60 ||
    f.blastRadius >= 10 ||
    (f.inCycle && f.fanIn >= 1) ||
    (uncovered(f) && f.fanIn >= 3);

  const read = f.risk >= 30 || f.blastRadius >= 3 || f.complexity >= 40 || f.fanIn >= 3;

  const tier: ReviewTier = careful ? "careful" : read ? "read" : "skim";

  if (tier === "skim" && reasons.length === 0) {
    reasons.push(f.isTest ? "a test, the suite checks it for you" : "nothing depends on it yet");
  }
  return { tier, reasons };
}

/** Every node with an import or call path INTO `path`: the files that break if it is wrong. */
export function dependentsOf(graph: CodeGraph, path: string): Set<string> {
  const importers = new Map<string, string[]>();
  for (const e of graph.edges) {
    const list = importers.get(e.target);
    if (list) list.push(e.source);
    else importers.set(e.target, [e.source]);
  }
  const seen = new Set<string>();
  const queue = [path];
  while (queue.length) {
    const at = queue.pop() ?? "";
    for (const from of importers.get(at) ?? []) {
      if (from === path || seen.has(from)) continue;
      seen.add(from);
      queue.push(from);
    }
  }
  return seen;
}

/** The chip on the Changes strip: the tier and its count, or the graph's own verdict that the
 *  path is not a node (a package.json change), which is never shown as a silent zero. */
export type FileReview =
  | { tier: ReviewTier; dependents: number; reasons: string[] }
  | { notInGraph: true };

export function fileReview(graph: CodeGraph, path: string): FileReview {
  const node = graph.nodes.find(n => n.id === path);
  if (!node) return { notInGraph: true };
  const dependents = dependentsOf(graph, path).size;
  // A test is checked by the suite that runs it: "no test covers it" on a test file is the
  // category error Flare names for documents, so a test never reads as uncovered here.
  const { tier, reasons } = reviewTier({
    path,
    risk: 0,
    blastRadius: dependents,
    fanIn: node.inDegree,
    coveragePct: null,
    testedBy: node.isTest ? Math.max(1, node.testedBy) : node.testedBy,
    complexity: 0,
    inCycle: node.cycleId !== null,
    isTest: node.isTest,
  });
  return { tier, dependents, reasons };
}

export function chipText(review: FileReview): string {
  if ("notInGraph" in review) return "not in the graph";
  return `${review.tier} · ${review.dependents} dependent${review.dependents === 1 ? "" : "s"}`;
}

/** The `blast:` line as hollow-move.mjs writes it, read back off a card note: measured, or one
 *  of its three honest non-answers. Null when the text carries no blast line at all. */
export type BlastNote =
  | { kind: "measured"; dependents: number; changed: number; unindexed: string[] }
  | { kind: "not-in-graph"; unindexed: string[] }
  | { kind: "no-changes"; base: string }
  | { kind: "unavailable" };

const BLAST_LINE = /^blast: (.*)$/m;
const MEASURED = /^(\d+) files? depends? on the (\d+) changed(?: \((.+) not in the graph\))?$/;
const NOT_IN_GRAPH = /^not in the graph \((.+)\)$/;
const NO_CHANGES = /^no committed changes since (\S*)$/;

const splitPaths = (s: string | undefined): string[] => (s ?? "").split(", ").map(p => p.trim()).filter(Boolean);

export function parseBlastLine(text: string): BlastNote | null {
  const lines = text.split("\n").filter(l => BLAST_LINE.test(l));
  const last = lines[lines.length - 1];
  if (!last) return null;
  const rest = last.slice("blast: ".length).trim();
  if (rest === "unavailable") return { kind: "unavailable" };
  const measured = MEASURED.exec(rest);
  if (measured) return { kind: "measured", dependents: Number(measured[1]), changed: Number(measured[2]), unindexed: splitPaths(measured[3]) };
  const notInGraph = NOT_IN_GRAPH.exec(rest);
  if (notInGraph) return { kind: "not-in-graph", unindexed: splitPaths(notInGraph[1]) };
  const noChanges = NO_CHANGES.exec(rest);
  if (noChanges) return { kind: "no-changes", base: noChanges[1] ?? "" };
  return null;
}

/** The tier a gate card wears when the only known input is the note's blast count: the same
 *  thresholds as reviewTier with nothing else claimed, so careful at 10, read at 3, else skim. */
export function blastTier(note: BlastNote): ReviewTier | null {
  if (note.kind !== "measured") return null;
  return reviewTier({
    path: "",
    risk: 0,
    blastRadius: note.dependents,
    fanIn: 0,
    coveragePct: null,
    testedBy: 0,
    complexity: 0,
    inCycle: false,
    isTest: false,
  }).tier;
}

/** The gate's card, as the orchestrator ruled on #7971: the #<id> the claim cites first (claims
 *  cite their card by convention), else the opening session's newest doing/testing card whose log
 *  carries a blast line, else no line at all, never a guessed one. */
export function claimCardId(claim: string): number | null {
  const m = /#(\d+)(?![0-9])/.exec(claim);
  return m ? Number(m[1]) : null;
}

export type GateCard = { id: number; project: string; status: string; assignee?: string; workedBy?: string; updated?: number; ts?: number };

export function fallbackCandidates<T extends GateCard>(by: string, project: string, cards: readonly T[]): T[] {
  if (!by) return [];
  return cards
    .filter(c => (!project || c.project === project) && (c.status === "doing" || c.status === "testing") && (c.assignee === by || c.workedBy === by))
    .sort((a, b) => (b.updated ?? b.ts ?? 0) - (a.updated ?? a.ts ?? 0));
}

/** The newest blast line on a card's log, or null when no entry carries one. */
export function blastFromLog(log: readonly { text: string }[]): BlastNote | null {
  for (let i = log.length - 1; i >= 0; i--) {
    const note = parseBlastLine(log[i]?.text ?? "");
    if (note) return note;
  }
  return null;
}

/** The line as hollow-move.mjs worded it, for the gate card. */
export function blastText(note: BlastNote): string {
  if (note.kind === "unavailable") return "blast: unavailable";
  if (note.kind === "no-changes") return `blast: no committed changes since ${note.base}`;
  if (note.kind === "not-in-graph") return `blast: not in the graph (${note.unindexed.join(", ")})`;
  const n = note.dependents;
  const tail = note.unindexed.length ? ` (${note.unindexed.join(", ")} not in the graph)` : "";
  return `blast: ${n} ${n === 1 ? "file depends" : "files depend"} on the ${note.changed} changed${tail}`;
}
