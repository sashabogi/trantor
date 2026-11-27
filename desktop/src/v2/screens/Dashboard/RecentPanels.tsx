import { useEffect, useState } from "react";
import type { Handoff, HubClient, LessonRec } from "../../../shared/api/client";
import type { Navigate } from "../../routes";
import { Section } from "../../ui/Section";
import { span } from "./model";

export function RecentPanels({ client, projects, onNavigate }: {
  client: HubClient; projects: string[]; onNavigate: Navigate;
}) {
  const [handoffs, setHandoffs] = useState<Handoff[]>([]);
  const [lessons, setLessons] = useState<LessonRec[]>([]);
  useEffect(() => {
    let alive = true;
    setHandoffs([]);
    setLessons([]);
    const pull = () => {
      // Query each local project so busy remote projects cannot crowd it out of the hub's limit.
      void Promise.all(projects.map(project => client.handoffs(project))).then(rows => {
        if (alive) setHandoffs(rows.flat().sort((a, b) => b.ts - a.ts).slice(0, 5));
      }).catch(() => {});
      void client.learning().then(learning => {
        const rows = [...learning.lessons.global, ...Object.values(learning.lessons.byAgent).flat()];
        if (alive) setLessons(rows.sort((a, b) => b.ts - a.ts).slice(0, 5));
      }).catch(() => {});
    };
    pull();
    const timer = setInterval(pull, 60_000);
    return () => { alive = false; clearInterval(timer); };
  }, [client, projects]);

  return (
    <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
      <Section title="Recent handoffs" flush>
        {handoffs.length === 0 && <p className="m-0 px-3.5 py-3 text-v2-base text-[var(--v2-muted)]">No handoffs yet.</p>}
        {handoffs.map((handoff, i) => (
          <button key={`${handoff.project}:${handoff.session}:${handoff.ts}:${i}`} type="button"
            onClick={() => onNavigate("workspace", handoff.project)}
            className="block w-full border-b border-[var(--v2-edge)] px-3.5 py-3 text-left hover:bg-[var(--v2-raised)] last:border-b-0">
            <span className="flex justify-between gap-3 text-v2-small text-[var(--v2-muted)]">
              <span>{handoff.project}</span><span>{span(handoff.ts)} ago</span>
            </span>
            <span className="mt-1 block truncate text-v2-base text-[var(--v2-text)]">
              {handoff.session}{handoff.trigger ? ` · ${handoff.trigger}` : ""}
            </span>
          </button>
        ))}
      </Section>
      <Section title="Latest lessons" flush>
        {lessons.length === 0 && <p className="m-0 px-3.5 py-3 text-v2-base text-[var(--v2-muted)]">No lessons yet.</p>}
        {lessons.map((lesson, i) => (
          <div key={`${lesson.scope}:${lesson.ts}:${i}`} className="border-b border-[var(--v2-edge)] px-3.5 py-3 last:border-b-0">
            <p className="m-0 text-v2-base text-[var(--v2-text)]">{lesson.text}</p>
            <div className="mt-1 flex justify-between gap-3 text-v2-small text-[var(--v2-muted)]">
              <span>{lesson.scope}</span><span>{span(lesson.ts)} ago</span>
            </div>
          </div>
        ))}
      </Section>
    </div>
  );
}
