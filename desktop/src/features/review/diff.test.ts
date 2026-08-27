// parsePatch is the review lens's only pure logic, so it carries the lens's whole test weight.
// The fixture is a hand-written but faithful `git diff` capture: two files (one modified, one
// new), multi-hunk, with the awkward corners — /dev/null paths, "\ No newline", a context line
// that lost its leading space.
import { describe, expect, it } from "vitest";
import { parsePatch } from "./diff";

const FIXTURE = `diff --git a/desktop/src/app/AppShell.tsx b/desktop/src/app/AppShell.tsx
index 1111111..2222222 100644
--- a/desktop/src/app/AppShell.tsx
+++ b/desktop/src/app/AppShell.tsx
@@ -10,7 +10,8 @@ import { Home } from "../features/home/Home";
 import { Board } from "../features/board/Board";
 import { Workspace } from "../features/workspace/Workspace";
-import { Old } from "./old";
+import { Review } from "../features/review/Review";
+import { Feed } from "../features/feed/Feed";
 import { Agents } from "../features/agents/Agents";
@@ -360,4 +361,5 @@ export function AppShell() {
           : pane.lens === "workspace" ? <Workspace client={client} project={active} lens={pane.lens} onLens={l => setPane({ kind: "project", lens: l })} />
           : pane.lens === "board" ? <Board client={client} project={active} lens={pane.lens} onLens={l => setPane({ kind: "project", lens: l })} />
+          : pane.lens === "review" ? <Review client={client} project={active} lens={pane.lens} onLens={l => setPane({ kind: "project", lens: l })} />
           : <Feed client={client} project={active} lens={pane.lens} onLens={l => setPane({ kind: "project", lens: l })} />}
diff --git a/desktop/src/features/review/diff.ts b/desktop/src/features/review/diff.ts
new file mode 100644
index 0000000..3333333
--- /dev/null
+++ b/desktop/src/features/review/diff.ts
@@ -0,0 +1,3 @@
+export function parsePatch(patch: string) {
+  return patch.split("\\n");
+}
\\ No newline at end of file
`;

describe("parsePatch", () => {
  it("splits the patch into files with their hunks", () => {
    const p = parsePatch(FIXTURE);
    expect(p.files.map(f => f.path)).toEqual([
      "desktop/src/app/AppShell.tsx",
      "desktop/src/features/review/diff.ts",
    ]);
    expect(p.files[0].hunks).toHaveLength(2);
    expect(p.files[1].hunks).toHaveLength(1);
  });

  it("counts adds and dels per file and in total", () => {
    const p = parsePatch(FIXTURE);
    expect([p.files[0].adds, p.files[0].dels]).toEqual([3, 1]);
    expect([p.files[1].adds, p.files[1].dels]).toEqual([3, 0]);
    expect(p.adds).toBe(6);
    expect(p.dels).toBe(1);
  });

  it("parses @@ headers into old/new starts and keeps the raw header for display", () => {
    const p = parsePatch(FIXTURE);
    const [h1, h2] = p.files[0].hunks;
    expect([h1.oldStart, h1.newStart]).toEqual([10, 10]);
    expect([h2.oldStart, h2.newStart]).toEqual([360, 361]);
    expect(h1.header).toMatch(/^@@ -10,7 \+10,8 @@/);
  });

  it("numbers both sides of the gutter — adds have no old number, dels no new one", () => {
    const p = parsePatch(FIXTURE);
    const lines = p.files[0].hunks[0].lines;
    // ctx 10, ctx 11, del 12, add 12, add 13, ctx 14(new)/13(old)
    expect(lines[0]).toMatchObject({ kind: "ctx", oldNo: 10, newNo: 10 });
    expect(lines[2]).toMatchObject({ kind: "del", oldNo: 12, newNo: null });
    expect(lines[3]).toMatchObject({ kind: "add", oldNo: null, newNo: 12 });
    expect(lines[4]).toMatchObject({ kind: "add", oldNo: null, newNo: 13 });
  });

  it("marks new files from the /dev/null old path", () => {
    const p = parsePatch(FIXTURE);
    expect(p.files[1].isNew).toBe(true);
    expect(p.files[1].oldPath).toBeNull();
    expect(p.files[1].isDeleted).toBe(false);
  });

  it("marks deleted files and falls back to the old path", () => {
    const del = `diff --git a/old.ts b/old.ts
deleted file mode 100644
--- a/old.ts
+++ /dev/null
@@ -1,2 +0,0 @@
-export const a = 1;
-export const b = 2;
`;
    const p = parsePatch(del);
    expect(p.files[0].isDeleted).toBe(true);
    expect(p.files[0].path).toBe("old.ts");
    expect(p.dels).toBe(2);
  });

  it("drops the '\\ No newline at end of file' marker line", () => {
    const p = parsePatch(FIXTURE);
    const lines = p.files[1].hunks[0].lines;
    expect(lines[lines.length - 1]?.text).toBe("}");
  });

  it("an empty diff parses to nothing, not an error", () => {
    const p = parsePatch("");
    expect(p.files).toEqual([]);
    expect([p.adds, p.dels]).toEqual([0, 0]);
    expect(p.truncated).toBe(false);
  });

  it("carries seat_diff's truncated flag through untouched", () => {
    expect(parsePatch(FIXTURE, true).truncated).toBe(true);
  });

  it("drops mode-only/binary file headers that produced no hunks", () => {
    const bin = `diff --git a/logo.png b/logo.png
index 1111111..2222222 100644
Binary files a/logo.png and b/logo.png differ
`;
    expect(parsePatch(bin).files).toEqual([]);
  });
});
