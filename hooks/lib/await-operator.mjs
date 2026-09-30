// Pure helpers for hooks/await-operator.mjs (#9814): read the turn's final assistant text from the
// transcript tail and decide whether it asks the OPERATOR a question. Kept pure and exported so the
// hook test drives the detector directly, without a harness or a hub.
import { closeSync, existsSync, openSync, readSync, statSync } from "node:fs";

// Transcripts grow to MBs; the final assistant message is at the END at Stop time, so a tail window
// is enough. 128 KiB covers a long closing reply; anything older is not the turn that just ended.
const TAIL_BYTES = 128 * 1024;

/** The verdict zone is the LAST paragraph. A "?" buried mid-reply — a regex like `a?b`, a
 *  rhetorical aside, a question the turn itself went on to answer — is not the session waiting on
 *  anyone; only a reply that ENDS on a question leaves the operator holding the turn. */
export function endsWithOperatorQuestion(text) {
  const t = String(text ?? "").replace(/\r\n/g, "\n");
  const paragraphs = t.split(/\n\s*\n/).map(p => p.trim()).filter(Boolean);
  const last = paragraphs[paragraphs.length - 1] || "";
  return last.endsWith("?");
}

/** The joined text of the LAST assistant message that carries any. A turn that ends on tool calls
 *  alone has no prose to judge, so it returns "". Every failure reads as "" — no transcript means
 *  no stamp, never a guessed one. */
export function lastAssistantText(transcriptPath) {
  try {
    if (!transcriptPath || !existsSync(transcriptPath)) return "";
    const size = statSync(transcriptPath).size;
    if (!size) return "";
    const want = Math.min(size, TAIL_BYTES);
    const f = openSync(transcriptPath, "r");
    let tail;
    try {
      const buf = Buffer.alloc(want);
      readSync(f, buf, 0, want, size - want);
      tail = buf.toString("utf8");
    } finally { closeSync(f); }
    const lines = tail.split("\n");
    if (want < size) lines.shift();   // the window can open mid-line; drop the partial
    let text = "";
    for (const line of lines) {
      let entry;
      try { entry = JSON.parse(line); } catch { continue; }
      if (entry?.type !== "assistant") continue;
      const parts = Array.isArray(entry.message?.content) ? entry.message.content : [];
      const joined = parts.filter(p => p?.type === "text").map(p => String(p.text ?? "")).join("\n").trim();
      if (joined) text = joined;
    }
    return text;
  } catch { return ""; }
}
