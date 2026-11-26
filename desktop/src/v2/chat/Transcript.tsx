// The 2.0 transcript (#14327): the turn loop the live chat and a sub-agent's tab both draw. The operator
// is a right-aligned bubble, the agent is plain text, its work is quiet rows that fold away once the
// reply lands, and "Worked for" closes a finished answer. It only draws; scrolling, status and the
// composer stay with the host.
import { memo, useMemo } from "react";
import { group } from "../../features/chat/groupTurns";
import { changedFiles, isDividerTurn, promptFacts, type ToolResult, type Turn } from "../../features/chat/streaming";
import { foldBeforeReply, groupBlocks } from "../../features/chat/toolGroups";
import { AssistantText } from "./Reply";
import { AskedRow, ItemView } from "./ToolItems";
import { UserMessage, type PromptData } from "./UserMessage";
import { WorkedFooter } from "./WorkedFooter";

const isAsk = (tool: string | undefined) => tool === "AskUserQuestion";

/** One agent turn: rows and groups, the prose, and the worked-time footer when the answer is done. */
const AgentTurn = memo(function AgentTurn({ turn, results, finished, workedMs }: {
  turn: Turn; results: Record<string, ToolResult>; finished: boolean; workedMs: number | undefined;
}) {
  const items = useMemo(() => foldBeforeReply(groupBlocks(turn.blocks, results), finished), [turn.blocks, results, finished]);
  const lastText = items.reduce((at, it, i) => (it.type === "block" && it.block.kind === "text" ? i : at), -1);
  const reply = turn.blocks.filter(b => b.kind === "text").map(b => b.text).join("\n\n");
  if (items.length === 0) return null;
  return (
    <div className="flex flex-col gap-2">
      {items.map((it, i) => {
        if (it.type === "block" && it.block.kind === "text") return <AssistantText key={i} text={it.block.text} copy={i === lastText ? reply : undefined} />;
        if (it.type === "block" && it.block.kind === "tool" && isAsk(it.block.tool)) {
          return <AskedRow key={i} block={it.block} result={it.block.tool_id ? results[it.block.tool_id] : undefined} />;
        }
        return <ItemView key={i} item={it} />;
      })}
      {finished && <WorkedFooter ms={workedMs} />}
    </div>
  );
});

export function Transcript({ turns, results, working = false, scale = 1 }: {
  turns: Turn[]; results: Record<string, ToolResult>;
  /** The newest turn is still being written: its work stays unfolded and it has no footer yet. */
  working?: boolean;
  /** The reading size: the whole transcript zooms, so the 2.0 type scale itself stays fixed. */
  scale?: number;
}) {
  const grouped = useMemo(() => group(turns), [turns]);
  const facts = useMemo(() => promptFacts(grouped), [grouped]);
  const changed = useMemo(() => changedFiles(grouped), [grouped]);
  // The answer a prompt got ends at its last agent turn; only that one carries the worked time.
  const lastAnswer = new Map<number, number>();
  let prompt = -1;
  grouped.forEach((t, i) => {
    if (t.role === "user") prompt = i;
    else if (t.role === "assistant") lastAnswer.set(prompt, i);
  });
  const answerOf = (i: number) => { let p = i; while (p >= 0 && grouped[p].role !== "user") p--; return p; };
  return (
    <div data-testid="transcript" className="@container" style={scale === 1 ? undefined : { zoom: scale }}>
      <div className="flex flex-col gap-2 px-3 pb-2 pt-3 @[420px]:px-4">
        {grouped.map((t, i) => {
          if (isDividerTurn(t)) {
            return (
              <div key={i}>
                {t.blocks.map((b, j) => <div key={j} title={b.text} className="v2-mono my-1 truncate text-center text-v2-small text-[var(--v2-muted)]">{b.text}</div>)}
              </div>
            );
          }
          if (t.role === "user") {
            return (
              <div key={i} className="flex flex-col gap-2">
                {t.blocks.map((b, j) => {
                  if (b.kind === "image") return <div key={j} className="text-v2-small text-[var(--v2-muted)]">[image]</div>;
                  if (b.kind !== "text") return null;
                  const data: PromptData = { id: `${i}.${j}`, ts: t.ts, reply: facts[i]?.reply, workedMs: facts[i]?.workedMs, files: changed[i] };
                  return <UserMessage key={j} text={b.text} queued={t.queued} prompt={data} />;
                })}
              </div>
            );
          }
          const owner = answerOf(i);
          const ends = lastAnswer.get(owner) === i;
          return (
            <AgentTurn key={i} turn={t} results={results} finished={!(working && i === grouped.length - 1)}
              workedMs={ends && owner >= 0 ? facts[owner]?.workedMs : undefined} />
          );
        })}
      </div>
    </div>
  );
}
