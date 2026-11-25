// A file tab that is read, not edited (#14106): Markdown rendered, images fitted to the pane. Markdown and
// SVG keep a Source switch that hands the pane back to the normal editor, passed in as `source`.
import { useEffect, useState, type ReactNode } from "react";
import { readFile } from "../../../features/code/fileApi";
import { MarkdownText } from "../../../features/chat/MarkdownText";
import { readImage, type ImageBody } from "../../ui/explorerOps";
import { Seg } from "../../ui/Seg";
import { draftFor } from "./drafts";

export type PreviewKind = "markdown" | "image" | "svg";

const IMAGE_EXT = ["png", "jpg", "jpeg", "gif", "webp"];

export function previewKind(path: string): PreviewKind | null {
  const dot = path.lastIndexOf(".");
  const ext = dot < 0 ? "" : path.slice(dot + 1).toLowerCase();
  if (ext === "md" || ext === "markdown") return "markdown";
  if (ext === "svg") return "svg";
  return IMAGE_EXT.includes(ext) ? "image" : null;
}

export function sizeLabel(bytes: number): string {
  if (bytes < 1024) return `${bytes} bytes`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

const NOTE = "px-4 py-6 text-v2-base text-[var(--v2-muted)]";

function MarkdownPreview({ project, scope, path }: { project: string; scope: string | null; path: string }) {
  const [text, setText] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    let alive = true;
    setText(null); setError(null);
    readFile(project, path, scope ?? undefined)
      .then(b => { if (alive) setText(draftFor(project, scope, path) ?? b.text); })
      .catch(e => { if (alive) setError(e instanceof Error ? e.message : String(e)); });
    return () => { alive = false; };
  }, [project, scope, path]);
  if (error) return <div role="alert" className="px-4 py-6 text-v2-base text-[var(--v2-bad)]">{error}</div>;
  if (text === null) return <div className={NOTE}>Reading {path}</div>;
  return <div data-preview="markdown" className="min-h-0 flex-1 overflow-y-auto px-6 py-4 text-v2-base"><MarkdownText text={text} /></div>;
}

function ImagePreview({ project, scope, path }: { project: string; scope: string | null; path: string }) {
  const [body, setBody] = useState<ImageBody | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [pixels, setPixels] = useState<string | null>(null);
  useEffect(() => {
    let alive = true;
    setBody(null); setError(null); setPixels(null);
    readImage(project, path, scope ?? undefined)
      .then(b => { if (alive) setBody(b); })
      .catch(e => { if (alive) setError(e instanceof Error ? e.message : String(e)); });
    return () => { alive = false; };
  }, [project, scope, path]);
  if (error) return <div role="alert" className="px-4 py-6 text-v2-base text-[var(--v2-bad)]">{error}</div>;
  if (!body) return <div className={NOTE}>Reading {path}</div>;
  const info = [pixels, sizeLabel(body.bytes)].filter(Boolean).join(" · ");
  return (
    <div data-preview="image" className="flex min-h-0 flex-1 flex-col">
      <div data-image-info className="v2-mono border-b border-[var(--v2-edge)] px-3 py-1 text-v2-small text-[var(--v2-muted)]">{info}</div>
      {body.data === null
        ? <div className={NOTE}>This image is {sizeLabel(body.bytes)}, which is too large to preview here.</div>
        : (
          <div className="flex min-h-0 flex-1 items-center justify-center overflow-hidden p-4">
            <img alt={path} src={`data:${body.mime};base64,${body.data}`} className="max-h-full max-w-full object-contain"
              onLoad={e => { if (e.currentTarget.naturalWidth > 0) setPixels(`${e.currentTarget.naturalWidth} × ${e.currentTarget.naturalHeight} px`); }}
              onError={() => setError("This image could not be shown")} />
          </div>
        )}
    </div>
  );
}

export function FilePreview({ kind, project, scope, path, source }: {
  kind: PreviewKind; project: string; scope: string | null; path: string; source: ReactNode;
}) {
  const [view, setView] = useState<"preview" | "source">("preview");
  const switchable = kind !== "image";
  const shown = switchable && view === "source" ? source : kind === "markdown"
    ? <MarkdownPreview project={project} scope={scope} path={path} />
    : <ImagePreview project={project} scope={scope} path={path} />;
  return (
    <div className="flex min-h-0 min-w-0 flex-1 flex-col">
      {switchable && (
        <div className="flex items-center gap-3 border-b border-[var(--v2-edge)] px-3 py-1.5">
          <span className="v2-mono min-w-0 flex-1 truncate text-v2-body text-[var(--v2-muted)]">{path.split("/").join(" › ")}</span>
          <Seg label="View" value={view} onChange={setView}
            options={[{ value: "preview", label: "Preview" }, { value: "source", label: "Source" }]} />
        </div>
      )}
      {shown}
    </div>
  );
}
