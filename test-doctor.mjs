#!/usr/bin/env node
// trantor doctor — the contract the desktop Agents view depends on.
// The app builds one harness card per crew-section entry by splitting "<brand>: <fact>". That grammar
// is load-bearing UI, not an internal detail: when the section also carried a colon-less aggregate
// ("no crew CLIs found"), the app rendered a phantom seat named "no" where a real harness belonged.
import { execFileSync } from "node:child_process";
import { join, dirname } from "node:path";
import { homedir } from "node:os";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
let pass = 0, fail = 0;
const ok = (n, c, e = "") => { if (c) { pass++; console.log(`  ✓ ${n}`); } else { fail++; console.log(`  ✗ ${n}${e ? " — " + e : ""}`); } };

// doctor exits non-zero when it finds issues, and "nothing installed" is precisely the case under
// test — so read stdout either way rather than treating a findings-exit as a harness failure.
const run = (path) => {
  const opts = { encoding: "utf8", env: { HOME: homedir(), PATH: path }, maxBuffer: 8 * 1024 * 1024 };
  try { return JSON.parse(execFileSync(process.execPath, [join(HERE, "bin", "doctor.mjs"), "--json"], opts)); }
  catch (e) { return JSON.parse(e.stdout); }
};
const crewOf = (r) => [...r.ok, ...r.issues, ...r.notes].filter(e => String(e.section || "").startsWith("crew"));
// The exact rule desktop/src/features/agents/Agents.tsx applies.
const brandsOf = (entries) => entries
  .map(e => { const i = e.message.indexOf(":"); return i > 0 ? e.message.slice(0, i).trim() : null; })
  .filter(Boolean);

console.log("\n# test-doctor — the harness grammar the Agents view parses");

// 1. A machine with seats installed: claude is one of them.
const rich = run(process.env.PATH);
const richBrands = brandsOf(crewOf(rich));
ok("claude is reported as a crew seat, not only as the orchestrator", richBrands.includes("claude"),
   `brands: ${richBrands.join(", ")}`);
ok("no brand is a bare English word from a sentence", !richBrands.some(b => ["no", "not", "none", "install"].includes(b.toLowerCase())),
   richBrands.join(", "));

// 2. A machine with NOTHING installed — the Finder-PATH case that produced the "no" card.
const bare = run("/usr/bin:/bin:/usr/sbin:/sbin");
const bareEntries = crewOf(bare);
const aggregate = bareEntries.find(e => /no crew CLIs found/.test(e.message));
ok("an empty machine still emits the aggregate warning", !!aggregate);
ok("the aggregate carries NO colon, so the view's rule can drop it", !!aggregate && !aggregate.message.includes(":"));
const bareBrands = brandsOf(bareEntries);
ok("parsing an empty machine invents no seat called 'no'", !bareBrands.includes("no"), bareBrands.join(", "));
ok("every surviving brand came from a real seat line", bareBrands.every(b => /^[a-z]/.test(b)), bareBrands.join(", "));

// 3. Key attribution. A provider key that authenticates BOTH the crew seats and Scrooge makes a
// spend spike unattributable — that is exactly how a $14 DeepSeek day (2026-08-25) took an
// investigation to explain, when Scrooge turned out to be 0.15% of the tokens on the key.
{
  const { mkdtempSync, mkdirSync, writeFileSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const runHome = (home) => {
    const opts = { encoding: "utf8", env: { HOME: home, PATH: "/usr/bin:/bin" }, maxBuffer: 8 * 1024 * 1024 };
    try { return JSON.parse(execFileSync(process.execPath, [join(HERE, "bin", "doctor.mjs"), "--json"], opts)); }
    catch (e) { return JSON.parse(e.stdout); }
  };
  const mkHome = (crew, scrooge) => {
    const h = mkdtempSync(join(tmpdir(), "trantor-keys-"));
    mkdirSync(join(h, ".agent-bus"), { recursive: true });
    mkdirSync(join(h, ".token-scrooge"), { recursive: true });
    if (crew !== null) writeFileSync(join(h, ".agent-bus", ".env"), crew);
    if (scrooge !== null) writeFileSync(join(h, ".token-scrooge", ".env"), scrooge);
    return h;
  };
  const keySection = (r) => [...r.ok, ...r.issues, ...r.notes].filter(e => String(e.section || "").startsWith("provider keys"));

  // (a) no crew layer at all — the seat falls through to Scrooge's key
  const SECRET = "sk-1111secretmiddle2222";
  let r = runHome(mkHome(null, `DEEPSEEK_API_KEY=${SECRET}\n`));
  let sec = keySection(r);
  ok("a crew seat falling through to Scrooge's key is reported as double duty",
    sec.some(e => /DEEPSEEK_API_KEY.*share ONE key/.test(e.message)), sec.map(e => e.message).join(" | "));
  ok("…and it raises exactly ONE issue, not one per provider",
    r.issues.filter(e => String(e.section || "").startsWith("provider keys")).length === 1);
  ok("the key itself is NEVER printed in full",
    !JSON.stringify(r).includes(SECRET), "the raw key leaked into the report");
  ok("…but enough of it shows to match a line item on the provider's bill",
    sec.some(e => e.message.includes("2222")));

  // (b) the crew has its OWN key — the whole point of the split
  r = runHome(mkHome(`DEEPSEEK_API_KEY=sk-9999crewkey8888\n`, `DEEPSEEK_API_KEY=${SECRET}\n`));
  sec = keySection(r);
  ok("a crew key of its own clears the double-duty finding",
    !sec.some(e => /share ONE key/.test(e.message)), sec.map(e => e.message).join(" | "));
  ok("…and doctor says the two are separately billable",
    sec.some(e => /separate keys/.test(e.message)), sec.map(e => e.message).join(" | "));
  ok("…naming the crew layer as the source, so precedence is legible",
    sec.some(e => /agent-bus\/\.env \(crew\)/.test(e.message)), sec.map(e => e.message).join(" | "));
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
