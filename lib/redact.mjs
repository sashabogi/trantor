// #5869 — key-material redaction for everything a seat runner writes at rest.
//
// A CLI that echoes its environment or dumps a config puts live provider keys into the seat's
// err log (err-<agent>-<project>.txt), and any seat on the machine can read ~/.agent-bus. So the
// runner scrubs known key shapes to `<redacted:NAME>` before the bytes land:
//
//   sk-… / sk-sp-… / sk-ws-…   → <redacted:SK>      (every OpenAI-style prefix is sk-)
//   AIza…                      → <redacted:AIZA>    (Google)
//   xai-…                      → <redacted:XAI>     (xAI)
//   ghp_…                      → <redacted:GHP>     (GitHub PAT)
//   <VAR>_KEY=… / <VAR>_TOKEN=… with a 32+-char hex/base64 value
//                              → <VAR>=<redacted:VAR>  (the variable NAME is not secret)
//   Authorization: Bearer …    → Authorization: Bearer <redacted:BEARER>
//
// Ordinary lines are byte-identical: every rule anchors on a key prefix or a KEY=/TOKEN=/Bearer
// position, never on "looks long". The function is idempotent (already-redacted text passes
// through unchanged), so callers can scrub in the write path AND again on read-back.
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

// The runner's tee replacement. Modes:
//   --tee  <file>  stdin → STDOUT verbatim (the live window), redacted → <file> (append)
//   --tee2 <file>  stdin → STDERR verbatim (the live window), redacted → <file> (append)
// The redacted append is LINE-BUFFERED: chunks can split a match mid-token (a 100-char bearer
// JWT straddling a 64KB read boundary would otherwise leak its tail), but keys never span LINES.
// Complete lines go out redacted; a partial trailing line waits for its newline. Every byte is
// appended exactly once, in order, so the file stays verbatim apart from redactions.
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
