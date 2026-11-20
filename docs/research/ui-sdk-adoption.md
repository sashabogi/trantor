# Should we adopt Vercel's UI SDK?

Research card #13936, 2026-11-20. Question: adopt [UI SDK](https://ui-sdk.dev/docs) ([github.com/vercel-labs/ui](https://github.com/vercel-labs/ui)) in crebral-health, builtbetter, stone-tracker and/or fleet-wide, teach it to our seats/orchestrators, and use its agent bridge for Trantor's desktop drills?

**Every claim below carries a citation**: `URL` for web sources, `path@sha` for repo sources. Sources read at:

- UI SDK repo: `vercel-labs/ui @ 855bc7fd4df3d61aee33d9d975dc3e4f71debc6c` (cloned 2026-11-20; 688 commits, version `0.1.0-beta.13` per `packages/react/package.json@855bc7fd`; 6.3k stars / 219 forks per github.com/vercel-labs/ui fetched 2026-11-20). The card note dates repo creation 2026-10-26 — **unverified** (I did not independently check the first-commit date).
- crebral-health `@ f9644cf` (2026-11-19), builtbetter `@ 40786c4` (2026-11-17), stone-tracker `@ 1a460a2` (2026-11-17), cloned read-only into `.agent-bus-out/scratch/` (not in the repo tree).
- Trantor repo itself at base `f0395214`.

## TL;DR

| Scope | Verdict |
|---|---|
| crebral-health | **Don't migrate.** Allow for brand-new interactive widgets only, after a pilot elsewhere proves the beta. |
| builtbetter | **No — blocked.** `@ui-sdk/react` peers on `react >= 19`; builtbetter is React 18. Revisit after a React 19 upgrade; its real problem is two overlapping headless layers already. |
| stone-tracker (admin/) | **Optional pilot: adopt for new components only.** Best technical fit (React 19.2, almost no legacy), but small upside on today's CRUD surface. |
| Trantor desktop drills | **Bridge is the right idea, wrong time.** It only sees ui-sdk-built components, so it pays off only if the desktop app adopts ui-sdk. Keep the existing DOM-probe seam; add data-testids where selectors drift. Re-evaluate alongside adoption. |
| Teach seats/orchestrators | **No fleet-wide install.** Install the skill per-project, only in a project that adopts UI SDK. |

**Fleet-wide: watch, pilot in stone-tracker, standardize on nothing yet.** The library's angle (agent bridge + ARIA checking) is exactly what our crew model values, but it is a month-old beta whose APIs "may still change" (banner on every docs page, https://ui-sdk.dev/docs), and our three frontends have three different, working component stacks.

## What UI SDK is

- A headless library of **behaviors** (focus, keyboard nav, selection, popups, drag-drop) composed into **primitives** via `definePrimitive`, rendered by per-framework adapters — React, Vue, Svelte, Solid, Web Components — with the same part shape everywhere; no styles beyond an optional `web.css`. (`README.md@855bc7fd`, `AGENTS.md@855bc7fd`)
- Ships ~90 React components built this way: select, combobox, menu, tabs, date-picker, tree, toolbar, token-input, timeline, resizable, scroll-area, etc. (directory list of `packages/react/src/@855bc7fd`)
- Engineering principles: **zero runtime dependencies**, SSR-safe, RTL without a provider, popups without portals. (`AGENTS.md@855bc7fd`, "Principles")
- License: **Apache-2.0** (`LICENSE@855bc7fd`). Beta status: the docs site links Vercel's Public Beta Agreement (https://vercel.com/docs/release-phases/public-beta-agreement); that agreement's §3 keeps OSS components under their OSS license, so the npm packages themselves stay Apache-2.0 — the beta language practically means **API churn risk**, plus beta terms if we used any Vercel-hosted service (we would not; the packages are self-hosted). The precise legal reading is the operator's call — **unverified by me**.
- The stated purpose is agent-first: agents assemble behaviors into components nobody ships (kanban, timelines, custom pickers) with the keyboard/ARIA support pre-tested. (`AGENTS.md@855bc7fd` "Why we're building it"; https://ui-sdk.dev/docs/agents)

Two capabilities matter beyond "another component library":

1. **Testing kit** — `@ui-sdk/core/testing` `checkPattern(root, pattern)` validates roles, names, states, part references and keyboard interactions against WAI-ARIA patterns (`listbox`, `menu`, `tabs`, `tree`, `dialog`, `combobox`, `slider`, `switch`, `checkbox`, … 15 patterns), stricter than the APG in places (requires Home/End, named tab lists). Plus `mount()` to drive a primitive with clicks/keys and inspect state changes. (`apps/docs/content/docs/core/testing.mdx@855bc7fd`)
2. **Agent bridge** — `createAgent()` from `@ui-sdk/<framework>/agent` exposes `snapshot()` (labeled components with refs, state, available actions), `act()` (call actions like `setValue`/`clear` by ref or label, multi-step, with `details.source === "agent"` callbacks and permission hooks) and `query()` (find choices within a component). `agentTools` packages these as JSON-Schema tool definitions; `registerTools` exposes them via the browser's `document.modelContext` (WebMCP). Components built with `definePrimitive` join the bridge automatically; methods named like changes (`setValue`, `toggle`) become actions without extra config. (https://ui-sdk.dev/docs/agents/connect-an-agent, `apps/docs/content/docs/agents/connect-an-agent/webmcp.mdx@855bc7fd`)

## Per-project assessment

### crebral-health (Next 15.3, React 19, Tailwind 4) @ f9644cf

**Today:** shadcn/ui new-york on the unified `radix-ui` package ^1.5.0, plus `cmdk`, `sonner`, `framer-motion`, `recharts`, `lucide` (`package.json@f9644cf`; `components.json@f9644cf`). 430 components / 68,662 LOC of `.tsx`, 115 test files including a design-system guard and rhythm-tokens tests (`src/components/**@f9644cf`).

**Complex / hand-rolled parts:**
- 40 hand-written ARIA `role=` attributes (listbox/menu/dialog/tablist/radiogroup/…) outside the shadcn primitives, in 8+ files including `ui/segmented-control.tsx`, `ui/typeahead-input.tsx`, `schedule/PatientPicker.tsx` (`grep` over `src/**@f9644cf`). Example: `segmented-control.tsx` (88 LOC) hand-maintains `role="radiogroup"`/`role="radio"` + `aria-checked`; ui-sdk ships `segmented-control` and `combobox` covering both it and `typeahead-input.tsx` (151 LOC).
- 28 keydown handlers (`grep` `src/**@f9644cf`) — duplicated roving-focus/typeahead behavior the behaviors layer would absorb.
- Big domain widgets (EncounterList 1,739 LOC, AssistantDock 1,343, ClaimsCard 1,039, BillingHub 940, OnboardingWizard 846, `src/components/**@f9644cf`).

**Replace vs add:** ui-sdk would *replace* roughly 6–10 small hand-rolled primitives (segmented control, typeahead, pickers, number/money fields) and *add a fourth layer* next to radix/shadcn everywhere else. Replacing working, tested components inside a beta's churn window is negative value now; the a11y quality of the hand-rolled widgets is the one real gap, and `checkPattern` would be the cheap win if adopted. A full primitive swap is a multi-contract migration touching most screens (~rough estimate: 4–8 crew contracts) for no user-visible gain.

**Verdict: don't migrate.** If/after a pilot elsewhere succeeds, allow ui-sdk for *new* interactive widgets only; first candidate: whatever replaces `typeahead-input` next.

### builtbetter (Next 14.2, React 18.2, Tailwind 4) @ 40786c4

**Today:** **two** headless layers at once — `@base-ui/react` ^1.3.0 *and* `radix-ui` ^1.4.3 — plus a 55-file shadcn-style `components/ui/` (`package.json@40786c4`, `components/ui/@40786c4`), plus `dnd-kit`, `cmdk`, `embla`, `vaul`, `react-resizable-panels`, `@tanstack/react-table`, `react-day-picker`, `input-otp`, `sonner`, `recharts`.

**Complex parts:** 412 `.tsx` / ~139.8k LOC; the mass sits in giant custom widgets — `plan-viewer.tsx` 3,458 LOC, `plan-3d-scene.tsx` 2,942 (three.js), `room-detail-panel.tsx` 2,904, `scope-unified-list.tsx` 2,325, `plan-viewer-toolbar.tsx` 2,199, `estimate-builder.tsx` 2,191, `gantt-chart.tsx` 1,662 (`wc -l` over `components/**@40786c4`). 64 keydown handlers (`grep` `components/**`, `app/**@40786c4`).

**Hard blocker:** `@ui-sdk/react` declares `"react": ">=19"`, `"react-dom": ">=19"` peer dependencies (`packages/react/package.json@855bc7fd`), and the docs quickstart states "It needs React 19 or newer" (https://ui-sdk.dev/docs). builtbetter is pinned to React 18.2 (`package.json@40786c4`). Forcing the install past the peer range on a beta is not a plan.

**Verdict: no.** Blocked by React 18 until a React 19 upgrade happens (that upgrade is its own multi-contract effort). Independent of UI SDK, the actual debt here is the base-ui + radix overlap — consolidating that pays off whether or not ui-sdk is ever in the picture.

### stone-tracker admin/ (Next 16.3, React 19.2.8, Tailwind 4) @ 1a460a2

**Today:** a young CRUD admin — 31 `.tsx` / 2,778 LOC (brands, products, devices, software, import pages; `src/app/(admin)/**@1a460a2`). Component layer is two hand-copied shadcn files (`button.tsx`, `input.tsx` on `@radix-ui/react-slot`, `src/components/ui/@1a460a2`), `lucide-react`, `class-variance-authority` (`package.json@1a460a2`). Zero hand-rolled ARIA roles so far (`grep` `src/**@1a460a2`). Note `admin/AGENTS.md@1a460a2` warns that Next 16 broke conventions vs training data — relevant context for how seat agents will work here regardless.

**Fit:** React 19.2 satisfies the peer range (`packages/react/package.json@855bc7fd` vs `admin/package.json@1a460a2`); almost nothing to migrate; the app will grow real lists/pickers (product editor exists already, `products/[id]/ProductEditor.tsx@1a460a2`).

**Replace vs add:** today ui-sdk would *add* a layer for little code removed (there is almost no hand-rolled interaction code to delete). The upside is forward-looking: `select`/`combobox`/`command` for the growing product editor, `checkPattern` tests for free, and — if we ever want chat-driven admin operations — the agent bridge. The downside is betting the app's growth years on a beta.

**Verdict: optional pilot, adopt-for-new-components.** One contract: install `@ui-sdk/core` + `@ui-sdk/react`, add the AGENTS.md note + skill (see below), build the next real picker with it, wire `checkPattern` in CI, and report back. If the pilot itches (API churn, style friction with Tailwind 4), drop it with almost nothing stranded — the shadcn base remains.

## Trantor desktop drills: agent bridge vs alternatives

**What drills do today:** Drill Mode (#6800) runs DOM probes over the live app document — `runAutoCheck(kind, doc)` looks for exact elements (`[data-testid="suggestion-chips"]`, `button[aria-label^="Jump to latest"]`, …), pure over a `Document` so tests inject happy-dom; a probe pre-fills the verdict, the operator still presses Pass. Drivers (`drive`: `post-key`, `seed-ask`) type into the terminal textarea / seed an ask. (`desktop/src/features/drill/drillChecks.ts@f0395214`, `drillApi.ts@f0395214`, `drillSteps.ts@f0395214`.)

**The pain is selector drift, not probe philosophy:** drillChecks already apologizes for it — the context gauge is found by scanning for a span whose text reads "context" because `Composer.tsx` had no test id that week (`desktop/src/features/drill/drillChecks.ts:22-25@f0395214`), and `keyDrill.ts` targets `.xterm-helper-textarea` (`desktop/src/features/workspace/keyDrill.ts:8@f0395214`).

**What the agent bridge would and would not fix:** `createAgent().snapshot()` returns *labeled* components with stable refs and callable actions, and `act()` drives them semantically instead of by CSS (https://ui-sdk.dev/docs/agents/connect-an-agent). But the bridge only registers components built with `definePrimitive` (same page, "Your Own Components") — the desktop app's hand-written React (chips, ask card, gauge, xterm) would be **invisible** to it. So the bridge is not a retrofit for drills; it is a *consequence* of adopting ui-sdk inside the desktop app (React 19.1 satisfies the peer range, `desktop/package.json@f0395214`).

**Alternatives, for the comparison the card asked for:**
- `@wdio/tauri-service` with the embedded WebDriver server — works on macOS/Windows/Linux, drives the real webview, can mock Tauri IPC; driven directly via `tauri-driver`, only Windows and Linux work ("macOS has no WKWebView driver tool available") (https://tauri.app/develop/tests/webdriver/, updated 2026-06-29). This is the heavyweight option: real end-to-end driving, but a WebDriver harness outside the app, still selector-based, and a new moving part per drill run. Overkill for pre-filling verdicts that a DOM probe already fills.
- macOS accessibility tree — OS-level reach (native menus included) but coarse for web content: we'd be matching on AX labels of divs, i.e. the same text-scraping fragility drillChecks.ts:22-25 already suffers, with a harder API. Not worth it for a React app we own the source of.
- Homegrown dev snapshot — this *is* `drillChecks.ts`: cheapest, already pure/testable, zero new deps. Its weakness is exactly the bespoke-selector drift above.

**Recommendation:** keep the DOM-probe seam; spend the fix on stable `data-testid`s (a lint or a note in the drill checklist: any element a probe reads gets a test id in the same contract that adds it — bounded, ~1 contract to codify + backfill the 3–4 drifted selectors visible in `drillChecks.ts@f0395214`). Revisit the agent bridge only if the desktop app adopts ui-sdk for its own interactive components; because `drillApi.ts` is already a seam, adding a snapshot-backed probe kind later is incremental, not a rewrite (`desktop/src/features/drill/drillApi.ts@f0395214`).

## Teaching the skill to seats and orchestrators

The skill ships in the repo (`packages/core/skills/ui-sdk/SKILL.md@855bc7fd`, 56 lines + 7 references) and inside every `@ui-sdk/core` install at `node_modules/@ui-sdk/core/skills/ui-sdk/SKILL.md` — that copy always matches the installed version (https://ui-sdk.dev/docs/agents/skills). It is well-built: read-the-installed-docs-first discipline (llms.txt index, don't read 300KB core.md whole), two paths (use shipped components vs build a custom primitive), and hard rules that match our own tastes — import from entries not package roots, name every control, no hand-rolled `role="listbox|menu|dialog|…"` next to an installed ui-sdk, key lists by value not index, `tsc -b` when tsconfig uses references, `test.fails` with a reason instead of a red suite, comment discipline. Its own trigger condition is "Use whenever a project has @ui-sdk/* installed" (`SKILL.md@855bc7fd`).

**Recommendation:** follow that trigger. Install the skill (`npx skills@latest add vercel-labs/ui --skill ui-sdk`, or just point seats at the node_modules copy) **per adopting project**, together with the AGENTS.md note the quickstart prescribes (before using ui-sdk, follow the skill and read `node_modules/@ui-sdk/react/docs/llms.txt`) (https://ui-sdk.dev/docs). Fleet-wide installation now — before any project adopts — would teach seats to reach for a library their projects don't have, which is how hollow "modernized the UI" diffs happen. Trantor orchestrators have no UI-building duties; no skill for them.

## Fleet-wide verdict

**Watch + one bounded pilot; standardize on nothing yet.** Reasons:

1. **Beta churn is real**: `0.1.0-beta.13`, APIs "may still change" (docs banner), repo roughly a month old by the card's dating (creation date itself unverified). Migrating stable, tested codebases onto that is churn without user-visible gain.
2. **Our stacks diverge**: radix+shadcn (crebral-health), base-ui+radix+shadcn (builtbetter), minimal shadcn (stone-tracker). UI SDK adoption is per-project, not fleet.
3. **The differentiators are aligned with us**: zero runtime deps, an ARIA checking kit, and a semantic agent interface to UIs are precisely what an agent-crew shop wants; if UI SDK reaches GA trajectory, it plausibly becomes our default for *new* interactive UI.
4. **Pilot where the blast radius is small**: stone-tracker admin/ (React 19.2 ✓, ~nothing to migrate), one contract, adopt-for-new-components, report back. crebral-health meanwhile writes the policy "new hand-rolled widgets need a ui-sdk-or-why-not note" only after the pilot; builtbetter waits for React 19.

**Relative size in crew contracts (not human time):** stone-tracker pilot ≈ 1 contract; drill selector-stabilization ≈ 1 contract (independent of UI SDK); desktop-app ui-sdk adoption + bridge-backed drill probe ≈ 2–3 contracts, only after the pilot; crebral-health migration (if ever forced) ≈ 4–8 contracts; builtbetter React 19 upgrade is a prerequisite measured in its own contracts and out of scope here.

## Sources

- https://ui-sdk.dev/docs (quickstart, React 19 requirement, beta banner) — fetched 2026-11-20
- https://ui-sdk.dev/docs/agents/skills, https://ui-sdk.dev/docs/agents/connect-an-agent (+ webmcp.mdx) — fetched 2026-11-20
- https://vercel.com/docs/release-phases/public-beta-agreement — fetched 2026-11-20
- https://tauri.app/develop/tests/webdriver/ — fetched 2026-11-20 (updated 2026-06-29)
- vercel-labs/ui @ 855bc7fd4df3d61aee33d9d975dc3e4f71debc6c: `README.md`, `AGENTS.md`, `LICENSE`, `packages/react/package.json`, `packages/core/package.json`, `packages/core/skills/ui-sdk/SKILL.md`, `apps/docs/content/docs/core/testing.mdx`, `apps/docs/content/docs/agents/*`
- crebral-health @ f9644cf: `package.json`, `components.json`, `src/components/**`
- builtbetter @ 40786c4: `package.json`, `components/ui/**`, `components/construction/**`, `app/**`
- stone-tracker @ 1a460a2: `admin/package.json`, `admin/src/**`, `admin/AGENTS.md`
- trantor @ f0395214: `desktop/package.json`, `desktop/src/features/drill/*`, `desktop/src/features/workspace/keyDrill.ts`

Unverified items are marked inline: repo creation date (from card note); the legal reading of the beta agreement for self-hosted npm packages (operator/legal call).
