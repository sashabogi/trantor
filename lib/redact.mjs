// #5869 — key-material redaction for everything a seat runner writes at rest: known key shapes become
// `<redacted:NAME>` (rules in docs/CONTRACT-lib.md §redaction); ordinary lines stay byte-identical.
const RULES = [
  // VAR=value first, so the surviving name is the env var and short values after KEY=/TOKEN=
  // still fall through to the bare-prefix rules below.
  { re: /\b([A-Za-z0-9_.-]*(?:KEY|TOKEN))=(["']?)[A-Za-z0-9+/_=-]{32,}\2/g, sub: (m, name, q) => `${name}=${q}<redacted:${name}>` },
  { re: /\bsk-[A-Za-z0-9][A-Za-z0-9_-]{7,}/g, sub: () => "<redacted:SK>" },
  { re: /\bAIza[0-9A-Za-z_-]{30,}/g, sub: () => "<redacted:AIZA>" },
  { re: /\bxai-[A-Za-z0-9][A-Za-z0-9_-]{9,}/g, sub: () => "<redacted:XAI>" },
  { re: /\bghp_[A-Za-z0-9]{20,}/g, sub: () => "<redacted:GHP>" },
  { re: /(Authorization:\s*Bearer\s+)[A-Za-z0-9._+/=-]{16,}/gi, sub: (m, p) => `${p}<redacted:BEARER>` },
];

export function redactKeys(text) {
  if (text == null) return text;
  let out = String(text);
  for (const { re, sub } of RULES) out = out.replace(re, sub);
  return out;
}

// The runner's tee replacement: --tee/--tee2 <file> echo stdin verbatim to stdout/stderr and append
// redacted bytes LINE-BUFFERED, since a chunk can split a match but keys never span lines.
if (process.argv[1] && process.argv[1].endsWith("redact.mjs") && (process.argv[2] === "--tee" || process.argv[2] === "--tee2")) {
  const { appendFileSync } = await import("node:fs");
  const target = process.argv[3];
  const passthrough = process.argv[2] === "--tee"
    ? (c) => process.stdout.write(c)
    : (c) => process.stderr.write(c);
  let carry = "";
  process.stdin.on("data", (chunk) => {
    passthrough(chunk);
    const lines = (carry + chunk.toString("utf8")).split("\n");
    carry = lines.pop();   // the partial trailing line — or "" when the chunk ended on a newline
    if (lines.length) {
      try { appendFileSync(target, redactKeys(lines.join("\n")) + "\n"); } catch {}
    }
  });
  process.stdin.on("end", () => {
    if (carry) { try { appendFileSync(target, redactKeys(carry)); } catch {} }
  });
  process.stdin.resume();
}
