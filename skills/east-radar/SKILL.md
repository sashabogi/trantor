---
name: east-radar
description: |
  Standing East/West intelligence scan: go look at what's moving on the CHINESE side of AI — frontier
  models, dev tooling/open-source, social & product discourse, policy/industry — that the English-
  speaking world hasn't caught yet, and report only what's NEW since last time (a delta, not a firehose).
  Built on /trantor:research + a delta gate. Runs on-demand or as a loose cloud cron. Trigger:
  /trantor:east-radar
user-invocable: true
---

# East Radar — eyes over the wall

The West reads its own echo chamber (Twitter, HN, arXiv-in-English). Real progress on the Chinese
side — DeepSeek, Qwen, Kimi/Moonshot, GLM/Zhipu, MiniMax, Baidu, ByteDance, Tencent, Stepfun, and the
discourse on Bilibili / XiaoHongShu / Zhihu / Weibo / V2EX / Xueqiu — surfaces there **first**, often
weeks before it crosses over. This routine closes that blind spot. Signal, not noise: it reports only
what's **new since the last run** and **material enough to matter**.

## 0. Load memory (the delta engine)
```bash
trantor east-radar state          # prints what's already been surfaced (the "known" baseline)
```
Everything in there is OLD news — do not re-report it. Your job is the **delta** on top.

## 1. Fan out across the four scopes (use /trantor:research method)
Prefer Agent-Reach channels (`agent-reach doctor --json`) for the Chinese platforms; fall back to
web search in Chinese + your own tools. Push the cheap reading to Scrooge; keep judgment.

- **models** — new releases / open weights / papers / benchmarks from the CN labs above. The
  "how-far-ahead" signal. Sources: Exa (CN + EN queries), GitHub/HuggingFace/ModelScope, arXiv, lab blogs, Zhihu.
- **tooling** — agent frameworks, inference/training infra, repos trending on GitHub/Gitee we could adopt.
- **social** — what's actually going viral on Bilibili / XiaoHongShu / Zhihu / Weibo about AI:
  products, techniques, use-cases, opinions never heard in English.
- **policy** — funding, chips, regulation, company strategy that shapes where CN AI is heading.

Always pair a CN source with the Western view so you can state the **contrast** ("X is shipping in
production there; the EN world is still arguing about the demo").

## 2. Gate for significance
For each candidate, judge novelty × impact (have cheap models pre-score if the list is long). Drop
anything incremental, rumored-only, or already in `state`. Keep a tight set — a great week is 3–8 items,
a quiet week is zero (and zero is a valid, honest result — say so, don't pad).

## 3. Persist the delta
Write the surviving items to a JSON array and hand it to the recorder, which diffs against `state`,
writes the dated digest, and updates the baseline:
```bash
cat > /tmp/east-candidates.json <<'JSON'
[
  { "key": "deepseek-v4",          // stable id: model+version / repo / paper / canonical name
    "scope": "models",             // models | tooling | social | policy
    "title": "DeepSeek V4 open weights released",
    "significance": 9,             // 1-10; the recorder's --threshold drops the weak ones
    "url": "https://…",
    "what": "One-line: what it is.",
    "why":  "Why it matters / how far ahead.",
    "west": "Western equivalent or the contrast (what we're missing)." }
]
JSON
trantor east-radar record /tmp/east-candidates.json   # → writes digest, updates state, prints the path
```
Only **unseen** keys above the threshold make the digest; seen keys are silently skipped (that's the
"are we missing this" filter doing its job).

## 4. Surface it
```bash
trantor east-radar card <digest-path>   # posts a Trantor board card linking the digest (if a hub is reachable)
```
On a cloud-cron run (no local hub), skip the card — `git add radar/ && git commit` the digest + updated
state instead; the next LOCAL Trantor session picks it up via `trantor east-radar sync` and cards it.

## 5. Write the digest top-matter yourself
The recorder lays out the items; you write the 2-3 line **editor's note** at the top: the single most
important thing we were missing this run, and the one thing worth acting on. Lead with the blind spot.
