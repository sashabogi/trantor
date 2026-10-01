#!/usr/bin/env node
// #9822 drills — relay_inbox must never again return a 197K-char backlog in one tool result.
// Pure tests against hooks/lib/inbox-page.mjs: 600 synthetic messages stay bounded, newest come
// first, repeated runner notices collapse to one line ×N, contracts and questions never collapse,
// and the before-cursor pages further back exactly the way mcp.mjs relay_inbox({before}) does.
import { formatInboxPage, collapseMessages, INBOX_PAGE_SIZE, INBOX_PAGE_CHARS } from "../../hooks/lib/inbox-page.mjs";

let pass = 0, fail = 0;
const ok = (name, cond) => { console.log(`  ${cond ? "PASS" : "FAIL"}  ${name}`); cond ? pass++ : fail++; };
console.log("# relay_inbox paging tests (#9822)");

const mk = (id, over = {}) => ({ id, ts: 1700000000000 + id * 1000, from: "runner:proj", to: "seat:proj", text: `notice ${id}`, ...over });

// --- the reported incident: 600 queued messages, mostly one repeated runner notice ---
{
  const msgs = [];
  for (let i = 1; i <= 600; i++) {
    msgs.push(mk(i, i % 10 === 0
      ? { from: "orch:proj", text: `contract: work card #${i}` }                       // wake (contract)
      : { text: `turn ended at 12:${String(i % 60).padStart(2, "0")} with ${i} notes`, wake: false }));
  }
  const page = formatInboxPage(msgs);
  ok("600-message backlog result stays under the char cap", page.text.length <= INBOX_PAGE_CHARS + 200);
  ok("page shows at most INBOX_PAGE_SIZE lines + footer", page.text.split("\n").length <= INBOX_PAGE_SIZE + 1);
  ok("newest message is shown first", page.text.startsWith(`#600 `));
  ok("repeated notice collapses to a ×N line", /\(×\d+\)/.test(page.text));
  ok("hidden count plus shown count is the whole backlog", page.shown + page.hidden === 600);
  ok("footer names how many older are hidden and the before-cursor",
    page.hidden > 0 && page.text.includes(`${page.hidden} older not shown`) && page.text.includes(`relay_inbox({before:${page.before}})`));
  ok("before-cursor is the oldest shown message id", page.before === 600 - page.shown + 1);

  // Paging back: exactly what relay_inbox({before}) does — peek all, keep id < before, format.
  const older = msgs.filter(m => m.id < page.before);
  const page2 = formatInboxPage(older);
  ok("second page shows messages older than the cursor", page2.text.startsWith(`#${page.before - 1} `));
  ok("second page overlaps nothing with the first", page2.shown > 0 && page.before > page2.before);
  // Walk to the end: eventually nothing is hidden and the footer disappears. Heavy collapse can
  // make the FIRST page cover almost everything, so assert coverage, not page count.
  let cursor = page.before, guard = 0, last = page, covered = page.shown;
  while (last.hidden > 0 && guard++ < 50) {
    last = formatInboxPage(msgs.filter(m => m.id < (cursor = last.before)));
    covered += last.shown;
  }
  ok("paging terminates with no footer at the oldest page", last.hidden === 0 && !last.text.includes("older not shown"));
  ok("paging covers the whole backlog exactly once", covered === 600);
}

// --- collapse rules ---
{
  const repeats = [1, 2, 3].map(i => mk(i, { text: `turn ${i} ended at 09:1${i}`, wake: false }));
  const collapsed = collapseMessages(repeats);
  ok("same sender + same text modulo times/counts collapses", collapsed.length === 1 && collapsed[0].n === 3);
  ok("the NEWEST repeat is the representative", collapsed[0].m.id === 3);

  const keep = collapseMessages([
    mk(1, { text: "same words", wake: false }),
    mk(2, { text: "same words", kind: "ask", wake: false }),
    mk(3, { text: "same words" }),                                  // wake absent = contract
    mk(4, { text: "same words?", wake: false }),                    // a question
    mk(5, { text: "same words", wake: false }),
  ]);
  ok("kind/wake/question messages each stay their own line", keep.filter(e => e.n === 1).length === 3);
  ok("the two plain context repeats still collapse", keep.some(e => e.n === 2));
}

// --- bounding edges ---
{
  const fortyOne = Array.from({ length: INBOX_PAGE_SIZE + 1 }, (_, i) => mk(i + 1, { text: `distinct ${i + 1}` }));
  const page = formatInboxPage(fortyOne);
  ok("distinct messages cap at INBOX_PAGE_SIZE", page.shown === INBOX_PAGE_SIZE && page.hidden === 1);

  const huge = [mk(1, { text: "x".repeat(INBOX_PAGE_CHARS * 2) })];
  const hugePage = formatInboxPage(huge);
  ok("a single oversized message still renders (never an empty page)", hugePage.text.includes("xxx") && hugePage.shown === 1);

  ok("empty inbox formats to empty text with nothing hidden", (() => { const p = formatInboxPage([]); return p.text === "" && p.hidden === 0 && p.before === 0; })());

  const tinyCap = formatInboxPage(Array.from({ length: 10 }, (_, i) => mk(i + 1, { text: `message number ${i + 1} with some body text` })), { capChars: 120 });
  ok("capChars is honoured (page well under the cap)", tinyCap.text.length < 240 && tinyCap.hidden > 0);
}

console.log(fail ? `\n${fail} FAILED` : "\nALL PASS");
process.exit(fail ? 1 : 0);
