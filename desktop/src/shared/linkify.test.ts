import { describe, expect, it } from "vitest";
import { createLinkResolver, tokenize, type Link, type LinkApi, type Segment } from "./linkify";

const links = (text: string): Link[] => tokenize(text).flatMap(s => ("link" in s ? [s.link] : []));
const rendered = (text: string) => tokenize(text).map(s => ("link" in s ? `[${s.link.kind}:${s.link.label}]` : s.text)).join("|");

describe("urls", () => {
  it.each([
    ["see https://a.dev/x.", "see |[url:https://a.dev/x]|."],
    ["(https://a.dev/x)", "(|[url:https://a.dev/x]|)"],
    ["https://en.wikipedia.org/wiki/Foo_(bar)", "[url:https://en.wikipedia.org/wiki/Foo_(bar)]"],
    ["[doc](https://a.dev/x)", "[doc](|[url:https://a.dev/x]|)"],
    ["go to https://a.dev/x?y=1&z=2, then", "go to |[url:https://a.dev/x?y=1&z=2]|, then"],
    ["**https://a.dev**", "**|[url:https://a.dev]|**"],
    ["http://localhost:3333/a#frag!", "[url:http://localhost:3333/a#frag]|!"],
    ["\"https://a.dev/x\"", "\"|[url:https://a.dev/x]|\""],
    ["https://", "https://"],
  ])("%s", (input, want) => {
    expect(rendered(input)).toBe(want);
  });

  it("urls are certain, not pending", () => {
    expect(links("https://a.dev")[0]).toMatchObject({ kind: "url", href: "https://a.dev", pending: false });
  });

  it("a path inside a url is part of the url", () => {
    expect(links("https://a.dev/src/a.ts").map(l => l.kind)).toEqual(["url"]);
  });
});

describe("paths", () => {
  it("finds absolute, home and relative paths as pending candidates", () => {
    const found = links("open /Users/me/app/a.ts and ~/notes/todo.md and src/b.ts and ./c.ts and ../d/e.ts");
    expect(found.map(l => l.href)).toEqual(["/Users/me/app/a.ts", "~/notes/todo.md", "src/b.ts", "./c.ts", "../d/e.ts"]);
    expect(found.every(l => l.kind === "path" && l.pending)).toBe(true);
  });

  it("finds bare file names with an extension", () => {
    expect(links("edit README.md and vitest.config.ts").map(l => l.href)).toEqual(["README.md", "vitest.config.ts"]);
  });

  it("finds dot folders and a folder path", () => {
    expect(links("see .github/workflows/ci.yml and desktop/src").map(l => l.href)).toEqual([".github/workflows/ci.yml", "desktop/src"]);
  });

  it("reads :line, :line:col and #L12 and #L12-L20", () => {
    expect(links("src/a.ts:42")[0]).toMatchObject({ href: "src/a.ts", label: "src/a.ts:42", line: 42, col: undefined });
    expect(links("src/a.ts:42:7")[0]).toMatchObject({ href: "src/a.ts", line: 42, col: 7 });
    expect(links("src/a.ts#L12")[0]).toMatchObject({ href: "src/a.ts", line: 12, endLine: undefined });
    expect(links("src/a.ts#L12-L20")[0]).toMatchObject({ href: "src/a.ts", line: 12, endLine: 20 });
    expect(links("/abs/a.ts:9")[0]).toMatchObject({ href: "/abs/a.ts", line: 9 });
  });

  it("leaves sentence punctuation outside the link", () => {
    expect(rendered("Edited src/a.ts.")).toBe("Edited |[path:src/a.ts]|.");
    expect(rendered("in src/a.ts, then")).toBe("in |[path:src/a.ts]|, then");
    expect(rendered("(src/a.ts)")).toBe("(|[path:src/a.ts]|)");
    expect(rendered("see src/a.ts: it works")).toBe("see |[path:src/a.ts]|: it works");
    expect(rendered("src/a.ts:12.")).toBe("[path:src/a.ts:12]|.");
  });

  it("finds a path inside inline code and a code span keeps its backticks as text", () => {
    expect(rendered("run `src/a.ts` now")).toBe("run `|[path:src/a.ts]|` now");
    expect(rendered("`/abs/b.rs:3`")).toBe("`|[path:/abs/b.rs:3]|`");
  });

  it("leaves Windows-looking strings as text", () => {
    expect(rendered("C:\\Users\\me\\file.ts")).toBe("C:\\Users\\me\\file.ts");
    expect(rendered("C:/Users/me/file.ts")).toBe("C:/Users/me/file.ts");
  });

  it("does not take words, fractions or emails for paths", () => {
    // "and/or" looks like a relative path, so it is a candidate the checkout then rejects; a fraction has no letter to be a name.
    expect(links("and/or 1/2 3/4/5").map(l => l.label)).toEqual(["and/or"]);
    expect(links("mail me@x.com").map(l => l.kind)).toEqual([]);
    expect(links("version 2.1.3 and 3.5k").map(l => l.kind)).toEqual([]);
    expect(links("a // comment").map(l => l.kind)).toEqual([]);
  });

  it("a path is not a card or a commit", () => {
    expect(links("abc1234.ts").map(l => l.kind)).toEqual(["path"]);
  });
});

describe("card ids", () => {
  it("links #1234 as a certain card link", () => {
    expect(links("see #14327 please")[0]).toMatchObject({ kind: "card", href: "14327", label: "#14327", pending: false });
  });

  it("works at the start of a line and before punctuation", () => {
    expect(rendered("#14327 The chat column")).toBe("[card:#14327]| The chat column");
    expect(rendered("(#123), #4567.")).toBe("(|[card:#123]|), |[card:#4567]|.");
  });

  it("needs three digits, a word boundary, and no heading or entity", () => {
    expect(links("#12 and #1").length).toBe(0);
    expect(links("issue#1234").length).toBe(0);
    expect(links("# 1234 heading").length).toBe(0);
    expect(links("## 1234").length).toBe(0);
    expect(links("##1234").length).toBe(0);
    expect(links("&#1234;").length).toBe(0);
    expect(links("#123abc").length).toBe(0);
    expect(links("https://a.dev/#1234").map(l => l.kind)).toEqual(["url"]);
  });
});

describe("commit hashes", () => {
  it("links 7 to 40 hex with a letter and a digit as pending", () => {
    const sha40 = "a1b2c3d4e5f60718293a4b5c6d7e8f9012345678";
    expect(links(`fixed in 9fabcb92 and ${sha40}`).map(l => [l.kind, l.href, l.pending])).toEqual([
      ["commit", "9fabcb92", true], ["commit", sha40, true],
    ]);
  });

  it("skips all-digit numbers, all-letter words and too-short or too-long runs", () => {
    expect(links("1234567 20261125 12345678901234567890").length).toBe(0);
    expect(links("deadbeef facade cafebabe").length).toBe(0);
    expect(links("abc123 a1b2c3").length).toBe(0);
    expect(links(`${"a1".repeat(21)}`).length).toBe(0);
  });

  it("does not take part of a longer word, id or version", () => {
    expect(links("xabc1234 abc1234x abc1234-def").length).toBe(0);
    expect(links("0x1234abcd").length).toBe(0);
    expect(links("see #abc1234").length).toBe(0);
  });

  it("allows sentence punctuation after the hash", () => {
    expect(rendered("fixed in abc1234.")).toBe("fixed in |[commit:abc1234]|.");
    expect(rendered("(abc1234)")).toBe("(|[commit:abc1234]|)");
  });
});

describe("tokenize rendered", () => {
  it("round-trips: the segments always rebuild the text", () => {
    const text = "Edited src/a.ts:12 in #14327 (9fabcb92), see https://a.dev/x. Also ~/n.md and C:\\x\\y.ts.";
    const back = tokenize(text).map(s => ("link" in s ? s.link.label : s.text)).join("");
    expect(back).toBe(text);
  });

  it("empty and plain text have no links", () => {
    expect(tokenize("")).toEqual([]);
    expect(tokenize("nothing here")).toEqual([{ text: "nothing here" }]);
  });

  it("caps how many links one text makes", () => {
    const many = Array.from({ length: 200 }, (_, i) => `#${1000 + i}`).join(" ");
    expect(links(many).length).toBe(60);
    const back = tokenize(many).map(s => ("link" in s ? s.link.label : s.text)).join("");
    expect(back).toBe(many);
  });
});

function fakeApi(existing: { paths?: string[]; commits?: string[] }) {
  const calls = { paths: new Array<string[]>(), commits: new Array<string[]>() };
  const api: LinkApi = {
    pathsExist: async (_p, paths) => { calls.paths.push(paths); return paths.map(p => (existing.paths ?? []).includes(p)); },
    commitsExist: async (_p, shas) => { calls.commits.push(shas); return shas.map(s => (existing.commits ?? []).includes(s)); },
  };
  return { api, calls };
}
const text = (segs: Segment[]) => segs.map(s => ("link" in s ? `[${s.link.kind}${s.link.pending ? "?" : ""}:${s.link.label}]` : s.text)).join("");

describe("confirm", () => {
  it("keeps existing paths and commits as links and turns the rest back into text, in one batch each", async () => {
    const { api, calls } = fakeApi({ paths: ["src/a.ts"], commits: ["abc1234"] });
    const r = createLinkResolver("p", api);
    const out = await r.confirm(tokenize("src/a.ts and src/gone.ts, #1234, abc1234 and def5678"));
    expect(text(out)).toBe("[path:src/a.ts] and src/gone.ts, [card:#1234], [commit:abc1234] and def5678");
    expect(calls.paths).toEqual([["src/a.ts", "src/gone.ts"]]);
    expect(calls.commits).toEqual([["abc1234", "def5678"]]);
  });

  it("merges the text a rejected candidate leaves behind", async () => {
    const { api } = fakeApi({});
    const out = await createLinkResolver("p", api).confirm(tokenize("see src/gone.ts now"));
    expect(out).toEqual([{ text: "see src/gone.ts now" }]);
  });

  it("makes no call when nothing needs checking", async () => {
    const { api, calls } = fakeApi({});
    const segs = tokenize("see #1234 and https://a.dev");
    expect(await createLinkResolver("p", api).confirm(segs)).toBe(segs);
    expect(calls.paths.length + calls.commits.length).toBe(0);
  });

  it("caches hits for good and asks only about what it has not seen", async () => {
    const { api, calls } = fakeApi({ paths: ["src/a.ts"] });
    const r = createLinkResolver("p", api);
    await r.confirm(tokenize("src/a.ts"));
    await r.confirm(tokenize("src/a.ts and src/b.ts"));
    expect(calls.paths).toEqual([["src/a.ts"], ["src/b.ts"]]);
  });

  it("asks again about a miss once it is old, so a new file becomes a link", async () => {
    let clock = 0;
    const existing = { paths: new Array<string>() };
    const { api, calls } = fakeApi(existing);
    const r = createLinkResolver("p", api, () => clock);
    expect(text(await r.confirm(tokenize("src/new.ts")))).toBe("src/new.ts");
    existing.paths.push("src/new.ts");
    clock = 5_000;
    expect(text(await r.confirm(tokenize("src/new.ts")))).toBe("src/new.ts");
    expect(calls.paths.length).toBe(1);
    clock = 20_000;
    expect(text(await r.confirm(tokenize("src/new.ts")))).toBe("[path:src/new.ts]");
    expect(calls.paths.length).toBe(2);
  });

  it("each resolver has its own cache", async () => {
    const { api, calls } = fakeApi({ paths: ["a.ts"] });
    await createLinkResolver("one", api).confirm(tokenize("a.ts"));
    await createLinkResolver("two", api).confirm(tokenize("a.ts"));
    expect(calls.paths.length).toBe(2);
  });

  it("an api failure leaves the candidates as text and is not cached", async () => {
    let fail = true;
    const api: LinkApi = {
      pathsExist: async (_p, paths) => { if (fail) throw new Error("down"); return paths.map(() => true); },
      commitsExist: async (_p, shas) => shas.map(() => true),
    };
    const r = createLinkResolver("p", api);
    expect(text(await r.confirm(tokenize("src/a.ts")))).toBe("src/a.ts");
    fail = false;
    expect(text(await r.confirm(tokenize("src/a.ts")))).toBe("[path:src/a.ts]");
  });

  it("keeps the line and column on a confirmed path", async () => {
    const { api } = fakeApi({ paths: ["src/a.ts"] });
    const [seg] = await createLinkResolver("p", api).confirm(tokenize("src/a.ts:42:7"));
    expect(seg && "link" in seg && seg.link).toMatchObject({ href: "src/a.ts", line: 42, col: 7, pending: false });
  });
});
