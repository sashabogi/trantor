/*
 * Trantor – lib/scrub.mjs
 * Why: Trantor's event log is append-only; once a secret enters it, it can never be deleted.
 * This module detects and redacts credential-shaped strings before they are logged.
 * Pure functions, no I/O, no dependencies, never throws.
 */

// ── Detection patterns (case-sensitive where shown) ──────────────────────────
const patterns = [
  { regex: /sk-[A-Za-z0-9_-]{16,}/g,                    kind: 'openai-key' },
  { regex: /(?:sk_live_|pk_live_|rk_live_)[A-Za-z0-9]{16,}/g, kind: 'stripe-key' },
  { regex: /xai-[A-Za-z0-9]{16,}/g,                     kind: 'xai-key' },
  { regex: /AKIA[A-Z0-9]{16}/g,                         kind: 'aws-access-key-id' },
  { regex: /(?:ghp_|gho_|ghs_|ghu_|ghr_|github_pat_)[A-Za-z0-9_]{20,}/g, kind: 'github-token' },
  { regex: /AIza[A-Za-z0-9_-]{35}/g,                    kind: 'google-api-key' },
  { regex: /xox[baprs]-[A-Za-z0-9-]{10,}/g,             kind: 'slack-token' },
  { regex: /eyJ[A-Za-z0-9_-]{5,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/g, kind: 'jwt' },
  { regex: /Bearer [A-Za-z0-9._-]{20,}/g,               kind: 'bearer-token' },
  { regex: /-----BEGIN\s(?:[A-Za-z]+\s)*PRIVATE KEY-----/g,      kind: 'pem-private-key' },
  // 64-char lowercase hex is an Ed25519 PRIVATE key — but it is ALSO the exact shape of an Ed25519
  // PUBLIC key and of a sha256 digest, and Trantor emits both constantly: /enroll carries a pubkey,
  // /peers returns them, and the canonical request string is built on a sha256 body hash. A bare
  // shape match therefore blocks the protocol's own legitimate traffic (verified: it flagged a real
  // pubkey and a real body hash). Shape alone cannot separate them, so require an INTENT word
  // within the preceding 40 chars — which is how a leak actually looks (`"privkey": "…"`), while a
  // bare pubkey or digest passes.
  { regex: /(?:priv(?:ate)?|secret|seed)[^\n]{0,40}?\b([0-9a-f]{64})\b/gi, kind: 'hex64-private' },
];

export function findSecrets(text) {
  const s = String(text ?? '');
  const all = [];
  for (const p of patterns) {
    p.regex.lastIndex = 0;
    let m;
    while ((m = p.regex.exec(s)) !== null) {
      all.push({ kind: p.kind, index: m.index, length: m[0].length });
    }
  }
  all.sort((a, b) => a.index - b.index);
  const selected = [];
  let lastEnd = -1;
  for (const m of all) {
    if (m.index >= lastEnd) { selected.push(m); lastEnd = m.index + m.length; }
  }
  return selected;
}

export function redact(text) {
  const s = String(text ?? '');
  const secrets = findSecrets(s);
  if (secrets.length === 0) return s;
  let result = '', last = 0;
  for (const sec of secrets) {
    result += s.slice(last, sec.index) + `[REDACTED:${sec.kind}]`;
    last = sec.index + sec.length;
  }
  return result + s.slice(last);
}

export function assertNoSecrets(text) {
  const s = String(text ?? '');
  const secrets = findSecrets(s);
  if (secrets.length === 0) return { ok: true };
  const uniqueKinds = [...new Set(secrets.map(x => x.kind))];
  return { ok: false, kinds: uniqueKinds, message: `Found secrets: ${uniqueKinds.join(', ')}` };
}
