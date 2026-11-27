import { useState } from "react";
import { openInBrowserTab } from "../../shell/openInBrowserTab";
import { previewStore, type SeatPreview } from "./previewStore";

export function PreviewChip({ project, preview, open = openInBrowserTab }: { project: string; preview: SeatPreview; open?: typeof openInBrowserTab }) {
  const [error, setError] = useState(false);
  const [busy, setBusy] = useState(false);
  return <button type="button" disabled={busy} title={error ? "Could not open preview. Try again." : `${preview.label}: ${preview.url}`}
    className="v2-hover mx-1 shrink-0 rounded-md border border-[var(--v2-edge-2)] px-2 py-1 text-v2-small text-[var(--v2-text)]"
    onClick={() => {
      setBusy(true);
      void open(project, preview.url).then(() => previewStore.opened(project, preview.seat, preview.url))
        .catch(() => setError(true)).finally(() => setBusy(false));
    }}>{error ? "Retry opening preview" : "Open in Browser tab"}</button>;
}
