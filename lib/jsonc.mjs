// JSON with comments and trailing commas (opencode, gemini and kimi configs are often written that way).
// Strict JSON is tried first, so a plain file is parsed exactly as before. Throws on genuinely bad input.
export function stripJsonc(text) {
  let out = "", i = 0, inStr = false;
  while (i < text.length) {
    const c = text[i], n = text[i + 1];
    if (inStr) {
      out += c;
      if (c === "\\") { out += n ?? ""; i += 2; continue; }
      if (c === '"') inStr = false;
      i++; continue;
    }
    if (c === '"') { inStr = true; out += c; i++; continue; }
    if (c === "/" && n === "/") { while (i < text.length && text[i] !== "\n") i++; continue; }
    if (c === "/" && n === "*") { i += 2; while (i < text.length && !(text[i] === "*" && text[i + 1] === "/")) i++; i += 2; continue; }
    out += c; i++;
  }
  // trailing commas: a comma followed only by whitespace and a closing bracket (outside strings)
  let res = "", s = false;
  for (let j = 0; j < out.length; j++) {
    const c = out[j];
    if (s) { res += c; if (c === "\\") { res += out[++j] ?? ""; } else if (c === '"') s = false; continue; }
    if (c === '"') { s = true; res += c; continue; }
    if (c === ",") {
      let k = j + 1;
      while (k < out.length && /\s/.test(out[k])) k++;
      if (out[k] === "}" || out[k] === "]") continue;
    }
    res += c;
  }
  return res;
}

export function parseJsonc(text) {
  try { return JSON.parse(text); } catch {}
  return JSON.parse(stripJsonc(text));
}
