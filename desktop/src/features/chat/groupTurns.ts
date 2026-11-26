// GROUP TURNS: consecutive turns from one speaker render as one group, and consecutive tool blocks batch together.
// Shared by the classic Chat and the 2.0 transcript so neither owns the other's import.
import type { Block, Turn } from "./streaming";

/** Consecutive turns from the same speaker render as one group; the transcript splits them on
 *  every tool call. */
/** Consecutive tool blocks batch into one array; an AskUserQuestion never joins a neighbour
 *  (#6094): kept singleton, so ToolRun's single-block path always routes it straight to AskCard. */
export function batch(blocks: Block[]): Array<Block | Block[]> {
  const out: Array<Block | Block[]> = [];
  const isAsk = (b: Block) => b.kind === "tool" && b.tool === "AskUserQuestion";
  for (const b of blocks) {
    if (isAsk(b)) { out.push([b]); continue; }
    const last = out[out.length - 1];
    if (b.kind === "tool") {
      if (Array.isArray(last) && !(last.length === 1 && isAsk(last[0]))) last.push(b);
      else out.push([b]);
    } else out.push(b);
  }
  return out;
}

export function group(turns: Turn[]): Turn[] {
  const out: Turn[] = [];
  for (const t of turns) {
    const last = out[out.length - 1];
    // A queued turn never merges into a seen one (or vice versa) — merging would erase the one
    // flag that tells the operator "the session has not read this yet".
    if (last && last.role === t.role && !!last.queued === !!t.queued) {
      last.blocks = [...last.blocks, ...t.blocks];
      // #14250: the folded rows' last timestamp survives, so worked time spans the whole reply.
      if (t.ts !== undefined) last.endTs = t.ts;
    } else out.push({ role: t.role, blocks: [...t.blocks], queued: t.queued, ts: t.ts, endTs: t.ts });
  }
  return out;
}

