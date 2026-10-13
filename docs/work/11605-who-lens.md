# Graph Who lens (#11605)

Base 18fe0a94 is merged while preserving the three #11669 research commits; sync refused because those commits lack harvest receipts.

Implementation decision: Node computes git history attribution and joins card assignees through the existing signed hub client. A Tauri bridge invokes the CLI, keeping hub identity handling out of Rust. Cache per checkout HEAD under ignored `.trantor/`, including attribution coverage. The existing graph derivation and both renderers share the result; graphViewState keeps the lens and agent filter.

Evidence: harvest receipts contain seat/main/card/branch; branch containment can be ambiguous after merges, so ambiguous matches must fall through to card evidence. Card API exposes assignee; identity labels must come from evidence, with unresolved commits shown as unknown. Multiple conflicting card references must not select an arbitrary assignee. NUL-delimited git paths preserve whitespace and newlines.

Host load at reconnaissance: 198.86 / 210.61 / 203.66. The contract delegates the full npm gate to CI when load exceeds approximately 50; targeted gates remain local.
