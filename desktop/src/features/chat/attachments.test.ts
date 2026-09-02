// attachments.ts drills (#6070): the chip model is the composer's attach contract — drop, paste
// and picker all produce chips, the text area never holds a path nobody typed, and at SEND the
// chips serialize into exactly the bytes the delivery path has always shipped (#5507 splice shape,
// #5709 one-path-per-line). Pure module, node environment: no React, no DOM, no mocks.
import { describe, expect, it } from "vitest";
import {
  addChips, baseName, chipKind, formatBytes, makeChip, removeChip, serializeForSend,
  type AttachmentChip,
} from "./attachments";
import { normalizeAttachments } from "./streaming";

const A = "/tmp/CleanShot 2026-09-02 at 11.44.35.png";
const B = "/Users/op/Desktop/screenshot.jpeg";
const F = "/Users/op/notes.md";

const chip = (path: string, id?: string, size: number | null = null): AttachmentChip =>
  makeChip(id ?? `id-${path}`, path, size);

describe("chipKind — what wears a thumbnail", () => {
  it("counts the raster formats (and heic) as images, case-insensitively", () => {
    expect(chipKind(A)).toBe("image");
    expect(chipKind(B)).toBe("image");
    expect(chipKind("/x/anim.gif")).toBe("image");
    expect(chipKind("/x/shot.webp")).toBe("image");
    expect(chipKind("/x/photo.HEIC")).toBe("image");
    expect(chipKind("/x/SHOT.PNG")).toBe("image");
  });

  it("counts everything else as a file — including pdf, which cannot thumbnail", () => {
    expect(chipKind(F)).toBe("file");
    expect(chipKind("/x/spec.pdf")).toBe("file");
    expect(chipKind("/x/noext")).toBe("file");
  });
});

describe("baseName", () => {
  it("keeps the basename, spaces included", () => {
    expect(baseName(A)).toBe("CleanShot 2026-09-02 at 11.44.35.png");
    expect(baseName("bare.txt")).toBe("bare.txt");
  });
});

describe("makeChip", () => {
  it("derives kind and name, carries id and size through", () => {
    const c = makeChip("k1", A, 1234);
    expect(c).toEqual({ id: "k1", path: A, kind: "image", name: "CleanShot 2026-09-02 at 11.44.35.png", size: 1234 });
    expect(makeChip("k2", F, null).kind).toBe("file");
  });
});

describe("addChips / removeChip", () => {
  it("appends in arrival order", () => {
    expect(addChips([], [chip(A), chip(B)]).map(c => c.path)).toEqual([A, B]);
  });

  it("a double-drop of the same path is ONE chip", () => {
    const once = addChips([chip(A, "first")], [chip(A, "second")]);
    expect(once).toHaveLength(1);
    expect(once[0]?.id).toBe("first");
  });

  it("removes by id only", () => {
    const cs = [chip(A, "i1"), chip(B, "i2")];
    expect(removeChip(cs, "i1").map(c => c.id)).toEqual(["i2"]);
    expect(removeChip(cs, "nope")).toHaveLength(2);
  });
});

describe("serializeForSend — the delivery contract (#5507, #5709)", () => {
  it("no chips: the draft passes through untouched", () => {
    expect(serializeForSend([], "hello")).toBe("hello");
    expect(serializeForSend([], "")).toBe("");
  });

  it("one chip with prose stays INLINE — the single-path shape the receipts pin", () => {
    expect(serializeForSend([chip(A)], "compare this")).toBe(`${A} compare this`);
  });

  it("one chip alone is the bare path", () => {
    expect(serializeForSend([chip(A)], "")).toBe(A);
    expect(serializeForSend([chip(A)], "   ")).toBe(A);
  });

  it("two or more chips go one path per line before the prose", () => {
    expect(serializeForSend([chip(A), chip(B)], "diff these")).toBe(`${A}\n${B}\ndiff these`);
    expect(serializeForSend([chip(A), chip(B)], "")).toBe(`${A}\n${B}`);
  });

  it("a file chip rides along the same serialization — paths are paths", () => {
    expect(serializeForSend([chip(F)], "read this")).toBe(`${F} read this`);
  });

  it("N images still arrive as N attachments after normalization (#5709 regression guard)", () => {
    const sent = normalizeAttachments(serializeForSend([chip(A), chip(B)], "compare these"));
    const lines = sent.split("\n");
    expect(lines[0]).toBe(A);
    expect(lines[1]).toBe(B);
    expect(sent).toContain("compare these");
  });

  it("single-chip sends normalize byte-identical (they have never dropped)", () => {
    const serialized = serializeForSend([chip(A)], "look");
    expect(normalizeAttachments(serialized)).toBe(serialized);
  });
});

describe("formatBytes", () => {
  it("rounds to a human size", () => {
    expect(formatBytes(0)).toBe("0B");
    expect(formatBytes(812)).toBe("812B");
    expect(formatBytes(96 * 1024)).toBe("96KB");
    expect(formatBytes(1.4 * 1024 * 1024)).toBe("1.4MB");
    expect(formatBytes(1024)).toBe("1.0KB");
  });
});
