---
name: research
description: |
  Run a real multi-source web/social research pass with the crew's economics: fan out across the
  internet (Agent-Reach channels when installed — web/Jina, Exa search, GitHub, YouTube/Bilibili
  transcripts, Twitter, Reddit, RSS, plus the Chinese platforms — else your own web tools), push the
  cheap per-source reading to Scrooge, and synthesize a cited answer yourself. Use when the user wants
  to research / deep-dive / "search the web" / "see what people say about X" / look something up across
  many sources. Trigger: /trantor:research
user-invocable: true
---

# Trantor research — fetch wide, read cheap, synthesize sharp

You are the ARCHITECT of a research pass. The shape mirrors the crew playbook: **fan out to fetch,
delegate the cheap reading, keep the synthesis.** Never burn frontier tokens scrolling raw pages.

## 1. Scope the question
Restate the question in one line and list the **angles** that need coverage (e.g. official source,
practitioner discourse, dissent, recency). Underspecified question → ask 1–2 sharp clarifiers first.

## 2. Pick sources (capability, not habit)
Run `agent-reach doctor --json` if available to see which backends are live, then choose per angle:
- **Semantic web search** → `mcporter call 'exa.web_search_exa(query: "…", numResults: 5)'` (free, no key)
- **Read a page/article** → `curl -s "https://r.jina.ai/<URL>"` (clean markdown, no HTML soup)
- **Code / repos** → `gh search repos "…" --sort stars` · `gh repo view owner/repo`
- **Video** → `yt-dlp --write-sub --skip-download -o /tmp/%(id)s "<URL>"` (NEVER yt-dlp for Bilibili → `bili …`)
- **Discussion** → Twitter (`twitter search`), Reddit (`opencli reddit search` / `rdt search`), V2EX
- **Chinese platforms** (often weeks ahead on AI) → Bilibili, XiaoHongShu, Zhihu, Weibo, Xueqiu via Agent-Reach
- **No Agent-Reach?** Fall back to your own WebSearch/WebFetch — the method below still holds.

If Agent-Reach isn't installed and the user wants the full reach, tell them once:
`帮我安装 Agent Reach：https://raw.githubusercontent.com/Panniantong/agent-reach/main/docs/install.md`

## 3. Fan out + read cheap
Collect candidate sources **in parallel** across angles. For each non-trivial source, push the
read-and-extract to a cheap model instead of reading it yourself:
`scrooge -t summarize -d easy "<extract the claims + numbers + date relevant to: …>" < source.md`
(or `relay_scrooge` from inside the crew). Many independent small reads → add `--spread N`. The point:
frontier tokens go to judgment, cheap tokens go to reading. Announce it (`scrooge watch` shows the feed).
If the research feeds a build, the dispatch rule holds: the target project is confirmed from the
session's badge and cwd before any `relay_send`, `relay_task_add` or `trantor up` — a research
answer ("where the answers are stored") is not a project name — and a session that is asking the
operator a question never triggers a wake; its messages batch until the answer arrives.

## 4. Verify before you trust
Cross-check any load-bearing claim against a second independent source. Flag what's a single-source
claim, what's dated, what's contested. Translate non-English sources and keep the original link.

## 5. Synthesize (this part is yours)
Write a tight, **cited** answer: the finding, the evidence (with links + dates), the disagreements,
and the confidence. Lead with what the user didn't already know. End with the open questions a
follow-up pass should chase.
