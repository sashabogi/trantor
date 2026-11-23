# Research: mobile-agent-testers

**Reviewed:** 2026-11-23  
**Repository revision reviewed:** [`fff09ea`](https://github.com/pierridotite/mobile-agent-testers/commit/fff09ea08d161be36bbb1b13875a285acbbc7202)  
**Scope:** Phase 1 research only. No install or product adoption performed.

## Verdict

**Ready with caveats** as an optional exploratory testing lane for the iOS companion, after a Mac operator validates the workflow against Trantor. It is not a substitute for our existing iOS drills and is not directly usable by an agent attached to a local simulator. Keep the current drills as the deterministic build, unit/UI, and visual evidence gate; use this project to find unanticipated paths and persona-specific layout, locale, accessibility, and usability problems before a release.

The project is compelling and unusually complete for a young repository: it has a working Actions pipeline, encrypted outputs, a setup skill, and offline tests. But it was created on November 16, released v0.1.0 on November 19, and is still changing daily. Its automated tests do not boot a simulator, and this research was done on Linux without a Mac drill. Trantor's own built artifact and drill are therefore still unverified. The card's existing drill line appropriately requires a Mac run before the orchestrator can close the card.

## What it does

`mobile-agent-testers` is a GitHub repository template. A manually dispatched Actions workflow builds an app, starts one Android emulator or iOS Simulator for each selected persona, and gives each device to a headless Claude Code process. Agents explore a new-user or supplied feature/bug-reproduction brief, interact by screenshots and coordinate gestures, and return findings with screenshots. The workflow encrypts build logs, app artifacts, and reports before uploading them; a user runs `scripts/collect.sh` locally to download/decrypt reports and produce a grouped summary.

It includes 20 device/persona configurations and detects Flutter, React Native/Expo, native Kotlin/Swift, Kotlin Multiplatform, Capacitor/Ionic, and beta .NET MAUI builds. It also accepts custom build commands or prebuilt apps. Its use cases include exploratory testing, a directed feature brief, bug reproduction, usability/improvement reports, and comparing two versions. Findings are stochastic and need a human to inspect screenshots. The project itself says some agents misread simulator UI and that this is not repeatable regression coverage.

Primary source: [README](https://github.com/pierridotite/mobile-agent-testers/blob/main/README.md), [workflow](https://github.com/pierridotite/mobile-agent-testers/blob/main/.github/workflows/agent-testers.yml), [agent briefs](https://github.com/pierridotite/mobile-agent-testers/tree/main/briefs).

## How an agent drives it

There is **no MCP server** and no standalone interactive CLI that attaches an agent to a developer's running simulator. The invocation surface is a GitHub Actions workflow (`gh workflow run agent-testers.yml ...`). Its `mobile-agent-testers` Claude Code plugin and plain Agent Skill are setup instructions: they guide an agent through creating/configuring a testers repo and choosing inputs; actual test runs still happen in GitHub Actions.

Within a job, `claude -p` runs with an allowlist for shell calls to `scripts/ios/{screen.py,gesture.sh,type.py}` (or Android equivalents). On iOS, `screen.py` captures via `xcrun simctl`, gets the accessibility tree with AXe, scales screenshots to point coordinates, and reports accessibility/crash information. `gesture.sh` delegates taps, swipes and typing to AXe and `simctl`. The simulator is created and configured in the workflow, then installed/launched by `run_agent.sh`. This is useful source material for an agent-driven testing harness, but it is coupled to its Actions job layout, Claude CLI, and a prepared simulator.

Sources: [Claude plugin README](https://github.com/pierridotite/mobile-agent-testers/tree/main/plugins/mobile-agent-testers), [setup skill](https://github.com/pierridotite/mobile-agent-testers/blob/main/plugins/mobile-agent-testers/skills/setup/SKILL.md), [standalone skill](https://github.com/pierridotite/mobile-agent-testers/blob/main/skills/mobile-agent-testers/SKILL.md), [iOS agent runner](https://github.com/pierridotite/mobile-agent-testers/blob/main/scripts/ios/run_agent.sh), [iOS screen capture](https://github.com/pierridotite/mobile-agent-testers/blob/main/scripts/ios/screen.py), [iOS gestures](https://github.com/pierridotite/mobile-agent-testers/blob/main/scripts/ios/gesture.sh).

## Platform and host requirements

| Question | Finding |
|---|---|
| iOS | iOS Simulator only. The iOS build and test jobs use `macos-15`, Xcode, `xcrun simctl`, and a Simulator `.app`; the workflow selects the latest installed Xcode. It builds for simulator/arm64. |
| Android | Android emulators on `ubuntu-latest`, using the Android emulator runner and KVM. |
| Physical devices | No workflow or scripts for attached iPhones/Android devices were found. The documented target is simulator/emulator. |
| Can the initiating host be Linux? | Yes, for dispatch/collection: README requires `gh` and a Claude subscription/API credential configured in the GitHub repository. GitHub-hosted jobs supply the platform-specific machines. A Linux runner cannot build/boot iOS Simulator; iOS still requires a macOS runner. |
| Can we use it locally on this Linux seat? | No iOS drill here. An agent can dispatch the workflow from a Linux machine, but the app test runs remotely on GitHub-hosted macOS. For a local iOS Simulator, use a Mac and adapt the workflow/scripts; that is not the shipped interface. |

The workflow needs repository secrets for Claude authentication and result encryption; a private app repo also needs a read-only source token. Public workflow logs are visible, so the project encrypts sensitive artifacts and reports. The setup skill warns that GitHub-hosted runner terms expect use for the repository's own project, so a public testers repo should not simply pull a closed-source app to obtain free Macs. Private repositories use their own Actions minutes; the README notes macOS billing multipliers. Validate current GitHub policies/costs at adoption time.

Sources: [workflow](https://github.com/pierridotite/mobile-agent-testers/blob/main/.github/workflows/agent-testers.yml), [README host/limits/FAQ](https://github.com/pierridotite/mobile-agent-testers/blob/main/README.md#limits), [privacy model](https://github.com/pierridotite/mobile-agent-testers/blob/main/PRIVACY.md).

## Maturity and maintenance signals

Observed from the cloned repository and GitHub API on 2026-11-23:

- Repository created **2026-11-16**; reviewed HEAD [`fff09ea`](https://github.com/pierridotite/mobile-agent-testers/commit/fff09ea08d161be36bbb1b13875a285acbbc7202), pushed 2026-11-23. Git history had **61 commits total**, all in the first week of activity, including multiple changes on the review date. This is high initial activity, not evidence yet of sustained maintenance.
- Latest and only release/tag: [`v0.1.0`, 2026-11-19](https://github.com/pierridotite/mobile-agent-testers/releases/tag/v0.1.0). The release notes describe initial delivery; there is also an active Unreleased changelog section.
- **0 open issues** at review time ([issues](https://github.com/pierridotite/mobile-agent-testers/issues)). This is not a meaningful maturity signal for a new project and should be rechecked later.
- **MIT** license ([LICENSE](https://github.com/pierridotite/mobile-agent-testers/blob/main/LICENSE)).
- Own tests: 11 Python unittest modules in `tests/`, running on pushes/PRs under Python 3.9 and 3.13; they cover scripts such as accessibility checks, setup, persona matrix, report processing, encryption/result pipeline, and skill-copy parity. CI also compiles Python and runs shell syntax/ShellCheck. These tests are documented as offline/no-phone/no-model. There is no test that builds Trantor or proves the iOS simulator workflow end to end.
- The README presents real app runs (LocalSend, AnkiDroid, Flutter sample), with screenshots, findings, and rerun commands. These are useful demonstrations, but are project-authored examples, not independent validation or a guarantee for Trantor.
- The workflow pins GitHub Actions to major tags such as `@v4`, while installing the latest Claude CLI and AXe through npm/Homebrew and selecting latest Xcode. For an adopted production workflow, pin dependencies and toolchain versions/SHAs where practical and keep an upgrade path.

Sources: [commit history](https://github.com/pierridotite/mobile-agent-testers/commits/main), [releases](https://github.com/pierridotite/mobile-agent-testers/releases), [issues](https://github.com/pierridotite/mobile-agent-testers/issues), [tests workflow](https://github.com/pierridotite/mobile-agent-testers/blob/main/.github/workflows/tests.yml), [test directory](https://github.com/pierridotite/mobile-agent-testers/tree/main/tests), [examples](https://github.com/pierridotite/mobile-agent-testers/blob/main/docs/examples.md).

## Comparison with Trantor's current iOS testing

Trantor's `ios/Packages/Features/Tests/run-aurora-drill.py` generates a local Xcode project, builds the actual companion and selected XCTest targets, and runs on an assigned simulator with load checks, result bundles/logs, concurrency protection, and simulator shutdown in `finally`. Focused scripts such as `run-onboarding-drill.py` and `run-stage-drill.py` target particular UI areas. The app and UI tests under `ios/` provide deterministic assertions and capture known views. Agents also use `xcrun simctl` by hand when diagnosing a specific screen.

| Need | Trantor today | mobile-agent-testers |
|---|---|---|
| Build/test the current Trantor checkout | Direct local build and XCTest/UI tests in purpose-built drills | Can build from a source ref or custom command, but requires configuring its GitHub workflow and running remotely; must prove the Trantor scheme/build adaptation on Mac |
| Repeatable regression | Yes, named XCTest assertions/result bundles | No, exploratory model decisions vary |
| Persona diversity / unanticipated exploration | Mostly hand-directed and specific simulator drills | Strong fit: persona/device/locale/text-size/theme matrix and open-ended/briefed Claude exploration |
| Interactive local debugging | `simctl` commands against the current simulator | Not provided; tools run inside each Actions job |
| Evidence | XCTest results, logs, screenshots/artifacts in `.agent-bus-out` | Per-action screenshots, findings, optional video, encrypted reports and grouped summary |
| Operational risk | Local simulator ownership/contention; scripts guard against other booted simulators and usually shut their own down | GitHub credentials/secrets, repository workflow setup, macOS queue/cost, model spend; each job creates its own simulator |

The best fit is additive: first let existing drills establish the build and deterministic checks; then run a small exploratory persona set for paths and presentation variations that the current suite does not cover. Convert confirmed findings into focused XCTest/UI tests or fixes. This avoids treating a model's report as a passing regression gate.

Local references: [`run-aurora-drill.py`](../../ios/Packages/Features/Tests/run-aurora-drill.py), [`run-onboarding-drill.py`](../../ios/Packages/Features/Tests/run-onboarding-drill.py), [`run-stage-drill.py`](../../ios/Packages/Features/Tests/run-stage-drill.py), [`FeaturesUITests`](../../ios/Packages/Features/Tests/FeaturesUITests).

## If the operator approves a later adoption phase

1. Create a dedicated **private** Trantor-owned tester repository (or put a carefully scoped workflow in the app repository); do not publish the private app source, credentials, or reports in a public template repo. Have the operator configure secrets themselves.
2. Vendor from a reviewed immutable commit/tag (currently the only release is `v0.1.0`) and pin workflow actions, AXe, Claude CLI, and Xcode selection. Do not use a floating `main` template as the ongoing dependency.
3. Add a Trantor-specific build path for `ios/` and verify scheme, bundle ID, test account/backend setup, analytics blocking, and artifact handling on a Mac. The stock workflow's generic native Swift path may not automatically match Trantor's generated multi-package project and drill architecture.
4. Give seats/Claude agents a short project skill or card contract that dispatches a small selected persona set with `gh workflow run`, records the workflow URL/run ID, then collects/decrypts and reviews the screenshots/findings. Agents need scoped repo Actions permissions and access to the result private key; keep key handling operator-owned. This is workflow dispatch, not an MCP tool call to a local device.
5. On Mac, run the card's real drill on the built Trantor artifact, confirm findings/artifacts are readable only by the intended operator, and check `xcrun simctl list devices` after completion to ensure no simulator remains booted. Keep the deterministic drill as the required gate.

**Mac drill required:** validate the actual Trantor iOS build path, a small workflow-dispatched persona run, screenshot/result collection and privacy, and simulator cleanup. None of those were executed from this Linux seat.
