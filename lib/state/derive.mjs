// Trantor State P4 — derive (TDD §4.5): a WorkingState for a handoff with no sidecar, from git and the
// model's own STATE block via applyTurn. A DERIVED STATE CARRIES NO CREDIT (docs/CONTRACT-state.md).
import { execFileSync } from "node:child_process";
import { CAPS, LISTS, emptyState, stateError } from "./schema.mjs";
import { applyTurn } from "./apply.mjs";
import { gitTouched } from "./store.mjs";

/** The line every derived state carries, so the successor reads the absence of credit as a fact
 *  rather than inferring it from an empty `verify`. */
export const DERIVED_NOTE = "derived: no gate ran at this handoff — every path is uncredited and nothing here is evidence";

/** `git diff --name-only HEAD`, NUL-separated. `-z` for the same reason the gate uses it: without
 *  it git C-quotes any path with a non-ASCII byte and `café.mjs` arrives as `caf\303\251.mjs`, a
 *  path that does not exist (#6901). */
export function gitDiffPaths(cwd) {
  if (!cwd) return [];
  try {
    const out = execFileSync("git", ["diff", "--name-only", "-z", "HEAD"], {
      cwd, encoding: "utf8", maxBuffer: 16 * 1024 * 1024, stdio: ["pipe", "pipe", "pipe"],
    });
    return out.split("\0").filter(Boolean);
  } catch {
    return [];   // no git, no repo, or no HEAD yet — a derived state without files is still valid
  }
}

/** Ground truth for `files`: every changed path, `touched: true` and `verified: false`. Harness facts
 *  ride `ctx.files` into applyTurn's runtime pass; a patch cannot write `files`.
 *  @returns {Record<string, { touched: boolean, verified: boolean }>} */
export function deriveFiles(worktree) {
  const out = {};
  for (const p of [...gitTouched(worktree), ...gitDiffPaths(worktree)]) {
    // A path over CAPS.PATH cannot be a key in a schema-valid state, and truncating it would
    // credit a file that is not there. Drop it; `files_count` is not the place to hide it either,
    // because nothing was compacted.
    if (!p || p.length > CAPS.PATH) continue;
    out[p] = { touched: true, verified: false };
  }
  return out;
}

/** Which of the handoff's sections a heading opens. Anchored at the front on purpose: the sections
 *  the Stop path asks for ("TASK (what we're doing + the goal)", "OPEN THREADS & NEXT STEPS") lead
 *  with their keyword and mention other keywords later in the same line. */
function sectionOf(heading) {
  const h = String(heading).trim().toLowerCase().replace(/^[^a-z]+/, "");
  if (/^(task|goal|objective)/.test(h)) return "task";
  if (/^(state|status|progress so far)/.test(h)) return "state";
  if (/^(done|completed|shipped|landed|delivered)/.test(h)) return "done";
  if (/^(in[ -]?progress|in[ -]?flight|wip|doing|current)/.test(h)) return "in_flight";
  if (/^(next|open thread|todo|to do|remaining|follow[ -]?up|upcoming)/.test(h)) return "next";
  if (/^(blocker|blocked|risk)/.test(h)) return "blockers";
  return "other";
}

/** A heading line: `## STATE`, `**STATE**`, or a bare `STATE:` / `STATE (done / in-progress)`. */
function headingText(line) {
  const hash = /^\s{0,3}#{1,6}\s+(.+?)\s*$/.exec(line);
  if (hash) return hash[1].replace(/[*_`]/g, "");
  const bold = /^\s{0,3}\*\*(.+?)\*\*\s*:?\s*$/.exec(line);
  if (bold) return bold[1];
  const bare = /^([A-Z][A-Z0-9 &'’(),./-]{2,})\s*:?\s*$/.exec(line);
  if (bare) return bare[1];
  return "";
}

const BULLET = /^\s*(?:[-*+•]|\d+[.)])\s+(.+)$/;
/** An inline label on a bullet overrides the section it sits in — "- done: wired the promoter". */
const INLINE_LABEL = /^(?:\*\*)?(done|completed|shipped|in[ -]?progress|in[ -]?flight|wip|doing|next|todo|blocked|blocker)(?:\*\*)?\s*[:\-–—]\s+/i;

/** The bucket a label word names. */
function bucketOfLabel(word) {
  const w = String(word).toLowerCase().replace(/[ -]/g, "");
  if (["done", "completed", "shipped"].includes(w)) return "done";
  if (["inprogress", "inflight", "wip", "doing"].includes(w)) return "in_flight";
  if (["next", "todo"].includes(w)) return "next";
  return "blockers";
}

/** Leading status glyphs carry the same meaning as a label and are stripped with it. */
function glyphBucket(text) {
  if (/^(?:✅|✔️?|☑️?|\[x\]|\[X\])\s*/.test(text)) return "done";
  if (/^(?:⛔|❌|🚫|🛑)\s*/.test(text)) return "blockers";
  if (/^(?:🚧|🔄|▶️?)\s*/.test(text)) return "in_flight";
  return "";
}

/** Strip markdown emphasis, glyphs and a trailing colon so the item reads as one claim. */
function cleanItem(raw) {
  return String(raw)
    .replace(/^(?:✅|✔️?|☑️?|\[[ xX]\]|⛔|❌|🚫|🛑|🚧|🔄|▶️?)\s*/, "")
    .replace(/\*\*/g, "")
    .replace(/^[*_`]+|[*_`]+$/g, "")
    .replace(/\s+/g, " ")
    .replace(/[:;,]$/, "")
    .trim();
}

/** Read the model's handoff into the four lists, bullets only. An unlabelled bullet lands in
 *  `in_flight`, never `done`: "still open" costs one re-check, "finished" is a claim nothing verified.
 *  @returns {{ done: string[], in_flight: string[], next: string[], blockers: string[], task: string }} */
export function parseHandoffState(text) {
  const out = { done: [], in_flight: [], next: [], blockers: [], task: "" };

  let section = "other";
  let bucket = "";
  // Anything that is not handoff markdown simply has no headings and no bullets, so it parses to
  // four empty lists — the same answer a null summary gives, without a shape check standing in for
  // a boundary this function does not have.
  for (const line of String(text ?? "").split(/\r?\n/)) {
    const heading = headingText(line);
    if (heading) {
      section = sectionOf(heading);
      bucket = LISTS.includes(section) ? section : section === "state" ? "in_flight" : "";
      continue;
    }
    const bullet = BULLET.exec(line);
    if (section === "task") {
      const t = cleanItem(bullet ? bullet[1] : line);
      if (t && !out.task) out.task = t;
      continue;
    }
    if (!bullet || !bucket) continue;

    let body = bullet[1].trim();
    let target = bucket;
    const glyph = glyphBucket(body);
    if (glyph) target = glyph;
    const labelled = INLINE_LABEL.exec(body.replace(/^(?:✅|✔️?|☑️?|\[[ xX]\]|⛔|❌|🚫|🛑|🚧|🔄|▶️?)\s*/, ""));
    if (labelled) {
      target = bucketOfLabel(labelled[1]);
      body = body.replace(/^(?:✅|✔️?|☑️?|\[[ xX]\]|⛔|❌|🚫|🛑|🚧|🔄|▶️?)\s*/, "").slice(labelled[0].length);
    }
    const item = cleanItem(body);
    if (item) out[target].push(item);
  }
  return out;
}

const ID_PREFIX = { done: "d", in_flight: "f", next: "n", blockers: "b" };

/** The parsed lists as `add` ops. Over-CAPS.LIST lines are dropped HERE with a notes line naming the
 *  count, since a working-list overflow in applyTurn rejects the whole patch (§3.1).
 *  @returns {{ ops: object[], dropped: string[] }} */
function itemOps(parsed) {
  const ops = [];
  const dropped = [];
  for (const list of LISTS) {
    const lines = parsed[list];
    if (lines.length > CAPS.LIST) {
      dropped.push(`derived: ${lines.length - CAPS.LIST} ${list} line(s) over CAPS.LIST (${CAPS.LIST}) were not carried`);
    }
    lines.slice(0, CAPS.LIST).forEach((text, n) => {
      ops.push({ add: { list, item: { id: `${ID_PREFIX[list]}${n + 1}`, text } } });
    });
  }
  return { ops, dropped };
}

/** Build a WorkingState for a handoff with no sidecar behind it. A rejected patch does not cost the
 *  state: git-derived files, the task and a notes line still make a schema-valid state.
 *  @returns {object|null} a state the validator accepts, or null — never a half-built one. */
export function deriveState({ project, seat, card, worktree, handoffText, cardTitle, now, by } = {}) {
  // The bus names a seat `<seat>:<project>`. A caller that passes the two halves separately (the
  // sidecar path's components) gets the same `cursor.by` the runner path would have written.
  const bare = String(seat || "");
  const author = String(by || (bare && project && !bare.includes(":") ? `${bare}:${project}` : bare));
  const base = emptyState(Number.isInteger(card) && card >= 0 ? card : 0, author);
  const ctx = {
    now: Number.isInteger(now) ? now : Math.floor(Date.now() / 1000),
    by: author,
    files: deriveFiles(worktree),
  };

  const parsed = parseHandoffState(handoffText);
  const task = String(cardTitle || parsed.task || "").replace(/\s+/g, " ").trim().slice(0, CAPS.TASK);
  const { ops, dropped } = itemOps(parsed);

  const setTask = task ? [{ set: { field: "task", value: task } }] : [];
  const notes = (lines) => ({ set: { field: "notes", value: [DERIVED_NOTE, ...lines].join("\n") } });

  let r = applyTurn(base, { patch: [...setTask, notes(dropped), ...ops], action: { continue: true } }, ctx);
  if (!r.ok) {
    const why = `derived: STATE block rejected (${r.code} at ${r.at}) — items dropped, files and task kept`;
    r = applyTurn(base, { patch: [...setTask, notes([why])], action: { continue: true } }, ctx);
  }
  if (!r.ok) return null;
  // The contract is "something the validator accepts, or nothing at all". applyTurn should never
  // hand back an invalid state; if it ever does, a derived handoff is the wrong place to find out.
  return stateError(r.state) === "" ? r.state : null;
}
