# Graph Who lens (#11605)

Base 18fe0a94 is merged while preserving the three #11669 research commits; sync refused because those commits lack harvest receipts.

Implementation decision: Node computes git history attribution and joins card assignees through the existing signed hub client. A Tauri bridge invokes the CLI, keeping hub identity handling out of Rust. Cache per checkout HEAD under ignored `.trantor/`, including attribution coverage. The existing graph derivation and both renderers share the result; graphViewState keeps the lens and agent filter.

Evidence: harvest receipts contain seat/main/card/branch; branch containment can be ambiguous after merges, so ambiguous matches must fall through to card evidence. Card API exposes assignee; identity labels must come from evidence, with unresolved commits shown as unknown. Multiple conflicting card references must not select an arbitrary assignee. NUL-delimited git paths preserve whitespace and newlines.

Host load at reconnaissance: 198.86 / 210.61 / 203.66. The contract delegates the full npm gate to CI when load exceeds approximately 50; targeted gates remain local.

Measured on integration SHA `18fe0a94f9e0165b256759558190365ab3bc5558`: 1,477 commits and 1,170 historical file paths. First matching rule: harvest 106 (7.18%), card 101 (6.84%), seat author 16 (1.08%), Claude trailer 830 (56.19%), unknown 424 (28.71%). Card-assigned host identities remain their recorded names (82 commits attributed to MacBook-Pro-M1); they are not silently relabeled orchestrator. Deleted/renamed paths remain historical entries; the graph displays entries for its current files. Legend totals count commits once, while cluster hover totals count file changes.

Initial targeted tests exposed a refresh Promise return mismatch and a real border shorthand conflict that erased per-file agent color. Both fixed. Root dependencies were absent, so the first slop invocation could not run; installed locked dependencies and reran. No app, dev server, or container launched.

Final frontend gates: `pnpm -C desktop exec vitest run src/features/code --maxWorkers=2` passed 212/212 tests across 28 files, including six Who drills; `pnpm -C desktop exec tsc --noEmit` passed. Resolver: `node --test test/attribution/test-attribution.mjs` passed 4/4. Slop gate ran against the staged implementation and passed (one advisory warning). CLI dispatcher reproduced the committed coverage exactly: cold 7,966 ms, cached 1,241 ms under host load approximately 300; these are loaded-host observations, not a general latency guarantee. Cache writes are excluded from graph refresh. Who polls the HEAD cache every 12 seconds for commits that only touch `.git`, without overlapping a pending poll.
