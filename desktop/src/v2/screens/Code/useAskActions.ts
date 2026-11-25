// Registers "Ask about this" and "Send to a seat" in Monaco's right-click menu and palette (#14073).
import { useEffect, useRef, type MutableRefObject } from "react";
import type { editor as MonacoEditor } from "monaco-editor";
import { contextFromEditor } from "./askContext";

export type AskCallbacks = {
  path: string; scope: string | null; seats: { seat: string }[]; openMenu: () => void;
  onAsk?: (text: string) => void; onSendToSeat?: (seat: string, text: string) => void;
};

/** `version` bumps whenever a new editor instance is mounted, so the actions move to it. */
export function useAskActions(editorRef: MutableRefObject<MonacoEditor.IStandaloneCodeEditor | null>, version: number, cb: AskCallbacks) {
  const latest = useRef(cb);
  latest.current = cb;
  const hasSeat = cb.seats.length > 0;
  useEffect(() => {
    const ed = editorRef.current;
    if (!ed) return;
    const text = () => contextFromEditor(ed, latest.current.path, latest.current.scope);
    const subs = [ed.addAction({
      id: "trantor.askAboutThis", label: "Ask about this", contextMenuGroupId: "navigation", contextMenuOrder: 0.1,
      run: () => latest.current.onAsk?.(text()),
    })];
    if (hasSeat) subs.push(ed.addAction({
      id: "trantor.sendToSeat", label: "Send to a seat", contextMenuGroupId: "navigation", contextMenuOrder: 0.2,
      run: () => {
        const { seats, onSendToSeat, openMenu } = latest.current;
        if (seats.length === 1) onSendToSeat?.(seats[0].seat, text()); else openMenu();
      },
    }));
    return () => subs.forEach(s => s.dispose());
  }, [editorRef, version, hasSeat]);
}
