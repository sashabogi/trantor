// The complexity drill fixture (#7978): every construct Flare's jsComplexity counts, beside the
// look-alikes it must not: keywords in comments and strings, `?.`, `??`, and `?:` in a type.
import { readFile } from "node:fs/promises"; // if this import were counted the strip is wrong
import type { Options } from "./if-options";

/* a block comment with if, for, while, case, catch, do and a ? mark: none of it counts */
// TODO: FIXME twice, HACK, XXX, and TODOS (no): four markers, the last is not a word
const NOT_CODE = "if (x) { for (;;) {} } while (y) do {} case 1: catch (e) {}";
const TEMPLATE = `while ${"for"} do ${1 ? "case" : "catch"} if`;

export async function classify(path: string, opts?: Options): Promise<number> {
  let score = 0;
  const name = opts?.name ?? path;
  if (name.length > 3 && name.startsWith("lib") || name === "hub.mjs") score += 1;
  for (const ch of name) {
    if (ch === "/") score += 1;
  }
  let i = 0;
  while (i < 3) {
    i += 1;
  }
  do {
    i -= 1;
  } while (i > 0);
  switch (score) {
    case 0:
      break;
    case 1:
      score = opts?.bonus ? 2 : 1;
      break;
  }
  try {
    await readFile(path);
  } catch {
    score = -1;
  }
  const label: string | undefined = score > 0 ? "hot" : undefined;
  const width: { w?: number } = { w: label ? 1 : 0 };
  return score + (width.w ?? 0);
}
