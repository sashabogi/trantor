// Per-document completion truth for the editor status line (#6041). The LSP request still rides
// lspDocuments; this small owner records whether one is in flight and the last concrete answer.
import { lspCompletion } from "./lspDocuments";

export type CompletionItem = { label?: string };
export type CompletionResponse = CompletionItem[] | { items?: CompletionItem[] } | null;
export type CompletionActivity = {
  pending: boolean;
  answeredAt: number | null;
  itemCount: number | null;
};
type MutableActivity = CompletionActivity & { inFlight: number };
type RequestCompletion = (
  uri: string,
  languageId: string,
  lineNumber: number,
  column: number,
) => Promise<CompletionResponse>;

function filePath(uri: string): string | null {
  if (!uri.startsWith("file://")) return null;
  return decodeURIComponent(uri.slice("file://".length));
}

export class CompletionActivityTracker {
  private readonly activityByUri = new Map<string, MutableActivity>();
  private readonly listeners = new Set<() => void>();

  constructor(private readonly request: RequestCompletion, private readonly now = Date.now) {}

  onChange(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => { this.listeners.delete(listener); };
  }

  activityForPath(root: string | null, path: string | null): CompletionActivity | null {
    if (!root || !path) return null;
    const target = `${root}/${path}`;
    for (const [uri, activity] of this.activityByUri) {
      if (filePath(uri) !== target) continue;
      return {
        pending: activity.inFlight > 0,
        answeredAt: activity.answeredAt,
        itemCount: activity.itemCount,
      };
    }
    return null;
  }

  async complete(uri: string, languageId: string, lineNumber: number, column: number): Promise<CompletionResponse> {
    const activity = this.activityByUri.get(uri) ?? {
      inFlight: 0,
      pending: false,
      answeredAt: null,
      itemCount: null,
    };
    activity.inFlight += 1;
    activity.pending = true;
    this.activityByUri.set(uri, activity);
    this.notify();
    try {
      const result = await this.request(uri, languageId, lineNumber, column);
      activity.answeredAt = this.now();
      activity.itemCount = Array.isArray(result) ? result.length : (result?.items?.length ?? 0);
      return result;
    } finally {
      activity.inFlight -= 1;
      activity.pending = activity.inFlight > 0;
      this.notify();
    }
  }

  private notify(): void {
    for (const listener of this.listeners) listener();
  }
}

const tracker = new CompletionActivityTracker(async (uri, languageId, lineNumber, column) => {
  // SAFETY: lspDocuments returns only the LSP completion union consumed by toMonacoSuggestions:
  // a list, an {items} list, or null after its request boundary catches transport failures.
  return await lspCompletion(uri, languageId, lineNumber, column) as CompletionResponse;
});

export const trackedLspCompletion = tracker.complete.bind(tracker);
export const onCompletionChange = tracker.onChange.bind(tracker);
export const completionActivityForPath = tracker.activityForPath.bind(tracker);

export function formatCompletionActivity(activity: CompletionActivity | null, now: number): string | null {
  if (!activity) return null;
  if (activity.pending) return "asking…";
  if (activity.answeredAt === null || activity.itemCount === null) return null;
  const ageMs = Math.max(0, now - activity.answeredAt);
  const age = ageMs < 60_000
    ? `${(ageMs / 1_000).toFixed(1)}s`
    : ageMs < 3_600_000
      ? `${Math.floor(ageMs / 60_000)}m`
      : `${Math.floor(ageMs / 3_600_000)}h`;
  const noun = activity.itemCount === 1 ? "item" : "items";
  return `completion answered ${age} ago (${activity.itemCount} ${noun})`;
}
