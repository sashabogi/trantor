// Attachments for Composer2 (#13984 drill: the 2.0 paperclip, drop and paste did nothing). Reuses the classic pure
// chip module and drop hit-testing; the Tauri drop subscription and paste/pick save are the same calls as classic.
import { useCallback, useEffect, useRef, useState, type ClipboardEvent, type RefObject } from "react";
import { invoke } from "@tauri-apps/api/core";
import { getCurrentWebview } from "@tauri-apps/api/webview";
import { attachmentInfo } from "../../shared/api/client";
import { describeHit, dropPointToCss } from "../../shared/dropPoint";
import { addChips, makeChip, removeChip, serializeForSend, type AttachmentChip } from "../../features/chat/attachments";
import { nextChipId } from "../../features/chat/composerDraft";
import { composerTakesDrop } from "../../features/chat/Composer";

export type AttachmentsApi = {
  chips: AttachmentChip[];
  /** The composer's root element: drops count only when they land inside it. */
  rootRef: RefObject<HTMLDivElement | null>;
  addPath: (path: string) => void;
  remove: (id: string) => void;
  clear: () => void;
  /** Paperclip door: the picked image files become chips. */
  pick: (files: File[]) => void;
  /** Paste door: an image on the clipboard becomes a chip, text pastes untouched. */
  onPaste: (e: ClipboardEvent<HTMLTextAreaElement>) => void;
  /** #14488: adopt a saved draft's chips — the restore path from composer_draft_get. */
  restore: (chips: AttachmentChip[]) => void;
  /** The classic wire text: chips ahead of the words (serializeForSend). */
  serialize: (draft: string) => string;
  error: string | null;
};

const traceDrop = (line: string) => { void invoke("app_log", { line: `drop #11513 ${line}` }).catch(() => {}); };

/** Writes a File's bytes to ~/.agent-bus/attachments via the classic save_pasted_image command (chunked base64). */
async function saveFile(file: File): Promise<string> {
  const u8 = new Uint8Array(await file.arrayBuffer());
  let bin = "";
  for (let i = 0; i < u8.length; i += 0x8000) bin += String.fromCharCode(...u8.subarray(i, i + 0x8000));
  return invoke<string>("save_pasted_image", { dataBase64: btoa(bin), kind: file.type });
}

export function useAttachments(): AttachmentsApi {
  const [chips, setChips] = useState<AttachmentChip[]>([]);
  const [error, setError] = useState<string | null>(null);
  const rootRef = useRef<HTMLDivElement | null>(null);

  const attach = useCallback((paths: string[], size: number | null) => {
    if (!paths.length) return;
    setChips(cs => addChips(cs, paths.map(p => makeChip(nextChipId(), p, size))));
    if (size !== null) return;
    for (const p of paths) {
      void attachmentInfo(p).then(info => {
        if (info) setChips(cs => cs.map(c => (c.path === p && c.size === null ? { ...c, size: info.bytes } : c)));
      });
    }
  }, []);

  // #13984 drill: Tauri swallows HTML5 drops, so onDragDropEvent is the only channel, same as classic.
  useEffect(() => {
    let alive = true;
    let off: (() => void) | undefined;
    try {
      getCurrentWebview().onDragDropEvent(ev => {
        if (ev.payload.type !== "drop" || !ev.payload.paths.length) return;
        const at = dropPointToCss(ev.payload.position);
        const hit = document.elementFromPoint(at.x, at.y);
        const takes = composerTakesDrop(hit, rootRef.current);
        traceDrop(`composer2 point=${at.x},${at.y} hit=${describeHit(hit)} takes=${takes}`);
        if (takes) attach(ev.payload.paths, null);
      }).then(un => { if (alive) off = un; else un(); }).catch(() => {});
    } catch { /* no webview under this window (tests) */ }
    return () => { alive = false; off?.(); };
  }, [attach]);

  const saveAll = (files: File[]) => {
    for (const file of files) {
      saveFile(file).then(path => { attach([path], file.size); setError(null); })
        .catch(err => setError(`attachment failed: ${err instanceof Error ? err.message : String(err)}`));
    }
  };
  const onPaste = (e: ClipboardEvent<HTMLTextAreaElement>) => {
    const img = Array.from(e.clipboardData?.items ?? []).find(i => i.kind === "file" && i.type.startsWith("image/"));
    const file = img?.getAsFile();
    if (!file) return;
    e.preventDefault();
    saveAll([file]);
  };
  // #13984 drill: a webview file input hands over bytes, never a path, so picked images are saved like pastes.
  const pick = (files: File[]) => saveAll(files.filter(f => f.type.startsWith("image/")));

  return {
    addPath: path => attach([path], null),
    chips, rootRef, error, onPaste, pick, restore: next => setChips(next),
    remove: id => setChips(cs => removeChip(cs, id)),
    clear: () => setChips([]),
    serialize: draft => serializeForSend(chips, draft),
  };
}
