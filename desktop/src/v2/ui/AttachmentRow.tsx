// The chip row above the composer controls (#13984 drill). Thumbnails come from the same attachment_info
// command the classic chips use; classic's ChipThumb is not exported, so this is the minimal equivalent.
import { useEffect, useState } from "react";
import { FileText, Image as ImageIcon, X } from "lucide-react";
import { attachmentInfo } from "../../shared/api/client";
import { formatBytes, type AttachmentChip } from "../../features/chat/attachments";

function Thumb({ path }: { path: string }) {
  const [src, setSrc] = useState<string | null>(null);
  useEffect(() => {
    let alive = true;
    void attachmentInfo(path).then(info => { if (alive) setSrc(info?.thumb ?? null); });
    return () => { alive = false; };
  }, [path]);
  if (!src) return <span className="flex h-6 w-6 items-center justify-center text-[var(--v2-muted)]"><ImageIcon size={13} aria-hidden /></span>;
  return <img src={src} alt="" draggable={false} onError={() => setSrc(null)} className="h-6 w-6 rounded-sm object-cover" />;
}

export function AttachmentRow({ chips, onRemove }: { chips: AttachmentChip[]; onRemove: (id: string) => void }) {
  if (!chips.length) return null;
  return (
    <div data-testid="attachment-row" className="flex flex-nowrap items-center gap-1.5 overflow-x-auto">
      {chips.map(c => (
        <div key={c.id} data-chip title={c.path}
          className="flex shrink-0 items-center gap-1 rounded-lg border border-[var(--v2-edge-2)] bg-[var(--v2-raised)] p-1">
          {c.kind === "image"
            ? <Thumb path={c.path} />
            : <span className="flex h-6 w-6 items-center justify-center text-[var(--v2-muted)]"><FileText size={13} aria-hidden /></span>}
          {c.size !== null && <span className="text-v2-micro leading-none text-[var(--v2-muted)]">{formatBytes(c.size)}</span>}
          <button type="button" aria-label={`Remove ${c.name}`} title={`Remove ${c.name}`} onClick={() => onRemove(c.id)}
            className="v2-hover rounded p-0.5 text-[var(--v2-muted)]"><X size={11} strokeWidth={2.5} aria-hidden /></button>
        </div>
      ))}
    </div>
  );
}
