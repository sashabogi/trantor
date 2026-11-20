# Cloudflare Artifacts as a fork-per-contract seat backend — #13934

**Recommendation: adopt as an optional backend, not a replacement. Fix #13921 in place regardless — it is two small changes, it works for every user (netcup, GitHub, self-hosted, fully offline), and Artifacts cannot replace the parts of the seat flow that cause most of our operational pain (untracked provisioning, build disk). Artifacts genuinely fixes base drift and seat isolation *by construction* for remote seats, which is worth an opt-in backend once the beta settles.**

## Scope and reproducibility

Researched 2026-11-20 against Trantor base `e3041827bcb9b55f58a88fa4687cc93b960473d4` (this seat branch's HEAD; `git reset --hard` per contract was a no-op). No code changed, no accounts created, no repos provisioned, no Cloudflare credentials handled. One ad-hoc network probe was run from this seat host (see Latency).

Evidence notation:

- **CF/**: Cloudflare Artifacts documentation, all pages fetched 2026-11-20 via the [llms.txt index](https://developers.cloudflare.com/artifacts/llms.txt). Pages cited by their public URL.
- **Blog**: the announcement post [Artifacts: versioned storage that speaks Git](https://blog.cloudflare.com/artifacts-git-for-agents-beta/) (published 2026-04-16, page metadata says modified 2026-07-15).
- **T/**: this repository at the base above, relative paths.
- **Bus**: card notes on #13921 and #13934 read via `relay_board` on 2026-11-20 — operator-recorded incident evidence, not my observation.
- Local repo measurements (`git count-objects -vH`, `git rev-list --count HEAD`, `git remote -v`, run 2026-11-20): pack **11.54 MiB**, **15,722** packed objects, **1,736** commits, `origin = git@github.com:sashabogi/trantor.git`.

Anything I could not verify from a primary source is marked **[unverified]** inline.

## What Artifacts is, as of 2026-11-20

Git-compatible versioned storage: every repo is an isolated Git service with its own history, refs, remote URL, tokens, and lifecycle; repos live in namespaces (created implicitly, unlimited count) — [CF: How Artifacts works](https://developers.cloudflare.com/artifacts/concepts/how-artifacts-works/), [CF: Repositories](https://developers.cloudflare.com/artifacts/concepts/repositories/). Built on Durable Objects (SQLite storage, ~128 MB DO memory, Zig/WASM Git server, R2 for snapshots) — [Blog, "Under the hood"](https://blog.cloudflare.com/artifacts-git-for-agents-beta/). Data is replicated synchronously across data centers and asynchronously to object storage — [CF: How Artifacts works, "Durability"](https://developers.cloudflare.com/artifacts/concepts/how-artifacts-works/).

Facts that matter for this decision:

| Fact | Value | Source |
|---|---|---|
| Maturity | Open beta since 2026-10-01 (private beta from 2026-04-16) | [CF: Changelog](https://developers.cloudflare.com/artifacts/platform/changelog/) |
| Plan requirement | Workers Paid only, not available on Workers Free ($5/mo account minimum) | [CF: Artifacts index](https://developers.cloudflare.com/artifacts/), [CF: Workers pricing](https://developers.cloudflare.com/workers/platform/pricing/) |
| Billing | Started 2026-11-19 per the pricing page (page updated that day); the 2026-10-01 changelog entry had said 2026-10-14 — the date moved once already | [CF: Pricing](https://developers.cloudflare.com/artifacts/platform/pricing/), [CF: Changelog](https://developers.cloudflare.com/artifacts/platform/changelog/) |
| Ops price | $0.15/1,000; first 10,000/mo included. Pulls/pushes/creates/forks/deletes = 1 op; content reads 100:1; token ops 5:1 | [CF: Pricing](https://developers.cloudflare.com/artifacts/platform/pricing/) |
| Storage price | $0.50/GB-mo; first 1 GB/mo included; repos persist until explicitly deleted | [CF: Pricing](https://developers.cloudflare.com/artifacts/platform/pricing/) |
| Repo-count price | "Coming soon": first 100,000 repos/mo included, then $0.01/repo — not part of the 2026-11-19 billing start | [CF: Pricing](https://developers.cloudflare.com/artifacts/platform/pricing/) |
| Per-repo storage | 1 GB for repos created ≥ 2026-09-29 (10 GB before) — the limit was cut 10× during beta | [CF: Limits](https://developers.cloudflare.com/artifacts/platform/limits/), [CF: Changelog 2026-09-29](https://developers.cloudflare.com/artifacts/platform/changelog/) |
| Push limits | 64 MiB/push, 50,000 objects/push, 32 MiB/file | [CF: Limits](https://developers.cloudflare.com/artifacts/platform/limits/) |
| Git protocol | Smart HTTP; fetch v1+v2; **push v1 only**; optional capabilities incl. `filter` and `include-tag` not supported | [CF: Git protocol](https://developers.cloudflare.com/artifacts/api/git-protocol/) |
| Tokens | Repo-scoped `read`/`write`; carry `?expires=`; bearer secrets; minted via control plane | [CF: Git protocol](https://developers.cloudflare.com/artifacts/api/git-protocol/), [CF: Authentication](https://developers.cloudflare.com/artifacts/guides/authentication/) |
| Import | **Public HTTPS remotes only** (REST/binding), async (409 while in progress) | [CF: Import repositories](https://developers.cloudflare.com/artifacts/guides/import-repositories/) |
| Events | `repo.created/deleted/forked/imported`, repo-level `pushed` (with before/after/commits), `cloned`, `fetched`, `token.created/revoked`; consumed via Workers event subscriptions | [CF: Event subscriptions](https://developers.cloudflare.com/artifacts/guides/event-subscriptions/) |
| Data residency | Namespace-level jurisdiction `eu` or `us`, immutable after creation; omitted = unrestricted | [CF: Data localization](https://developers.cloudflare.com/artifacts/guides/data-localization/) |
| Management | REST API, Workers binding, Wrangler CLI (`wrangler artifacts repos …`), dashboard | [CF: Authentication](https://developers.cloudflare.com/artifacts/guides/authentication/), [CF: Changelog 2026-05-18 / 2026-06-17](https://developers.cloudflare.com/artifacts/platform/changelog/) |
| Local dev | Binding simulator only (loopback Git remote); no local REST API/CLI; local events exclude push/clone/fetch | [CF: Local development](https://developers.cloudflare.com/artifacts/guides/local-development/) |
| ArtifactFS | Open-source FUSE blobless-clone mount; guide itself says a regular clone is simpler for small repos | [CF: ArtifactFS](https://developers.cloudflare.com/artifacts/guides/artifact-fs/) |

## What our flow does today, and where it hurts

- **Seat worktrees** (T/lib/seat-worktree.mjs): one linked worktree per seat at `~/.agent-bus/worktrees/<project>/<agent>` on branch `seat/<agent>` (T/lib/seat-worktree.mjs:18-36), created at main HEAD after fast-forwarding the base (T/lib/seat-worktree.mjs:59-67), refreshed only when clean (T/lib/seat-worktree.mjs:42-51), re-created at its own tip when it holds unintegrated commits (T/lib/seat-worktree.mjs:69-98). Untracked files come from the project's declaration — sibling-checkout `link`s, `stub`/`link`/`operator` provisions, a `preflight` command (T/lib/seat-worktree.mjs:121-235).
- **Harvest** (#7748): a seat commit landed on main under a new sha (cherry-pick/squash) diverges the seat branch forever; receipts record seat sha → main sha → card (T/lib/harvest.mjs:30-43); `trantor sync` refuses rather than drop an unharvested commit, else `reset --keep` to the target (T/lib/harvest.mjs:79-96); `trantor integrate` commits dirty seat work per-seat, merges, verifies, pushes, writes receipts (T/bin/integrate.mjs:29-92).
- **Disk janitor**: per-seat build dirs, per-contract scratch (#11486: a 27 GB incident), stale worktrees (#12269), build junk in non-live seats (#12268) — T/lib/disk.mjs:12-29, T/lib/disk.mjs:165-367.
- **#13921** (Bus, todo): two failure modes. (a) A seat reset its branch to the *next* contract's base and dropped a finished, unharvested commit off every branch (codex-3, 000c42c, rescued as `harvest/13915`); remote seats are worse because the orchestrator fetches by branch name over SSH. (b) A contract header carried a stale base (94955e7 = an old release commit while origin/main was 10+ commits ahead); the seat trusted the header. Additionally the runner rules themselves warn that origin/main "trails the orchestrator's unpushed integration commits" (T/bin/crew-runner.mjs:312) — so "base" today has at least three disagreeing sources: the contract header, `origin/main`, and the orchestrator's local main. #13921's proposed in-place fix: before resetting to a new base, park the old head on `seat/<name>/<card>` or refuse until harvested; make the header's base come from the contract's stated base or current origin/main, never a cached value.
- **#12268** (Bus context): worktree disk — regenerable output pruned from non-live seat worktrees.

## The contract-to-fork mapping

Concrete walk-through of a card under an Artifacts backend. Naming: one namespace per Trantor project (`jurisdiction: "eu"` if chosen — immutable, so decided at first creation per [CF: Data localization](https://developers.cloudflare.com/artifacts/guides/data-localization/)); one repo per contract: `<project>-<card>-<seat>`.

1. **Contract time.** Orchestrator ensures a baseline repo `<project>` exists. Bootstrap: `import` cannot be used (our origin is a private SSH remote; import takes public HTTPS only — [CF: Import repositories](https://developers.cloudflare.com/artifacts/guides/import-repositories/)), so the orchestrator creates an empty repo and pushes main from its checkout. Measured pack: 11.54 MiB / 15,722 objects — one push, under both the 64 MiB and 50,000-object limits ([CF: Limits](https://developers.cloudflare.com/artifacts/platform/limits/)). Baseline repo is then read-only in practice; refresh by push after each integration.
2. **Fork per contract.** `fork` creates a new repo starting from the baseline repo's history ([CF: How Artifacts works](https://developers.cloudflare.com/artifacts/concepts/how-artifacts-works/)); the fork is created *at the contract's stated base* — either fork after pushing that exact sha to the baseline, or pin by forking at the current baseline tip. **[unverified]** whether the REST fork API can target an arbitrary ref/sha rather than the default branch head; the Workers-binding example forks a repo with a `readOnly` option but no rev parameter is shown ([Blog example](https://blog.cloudflare.com/artifacts-git-for-agents-beta/)). If not, push base → fork → verify forked sha by `repos get` before minting tokens.
3. **Tokens.** Mint a `write` repo-scoped token for the seat, `read` for the gate/orchestrator ([CF: Git protocol, "Token scopes"](https://developers.cloudflare.com/artifacts/api/git-protocol/)). Tokens are bearer secrets with in-band expiry ([CF: Git protocol, "Token format"](https://developers.cloudflare.com/artifacts/api/git-protocol/)).
4. **Contract payload.** Instead of `base: <sha>` + "reset your branch there", the contract carries the fork's remote URL (+ repo name) and the seat gets the write token. **Open design point:** putting the token in the contract message means it lands in the bus store (hub persistence on netcup) and in every seat's message log; alternatives are an `operator`-mode provisioned file (the declaration system already models this — T/lib/seat-worktree.mjs:179-182) or a hub endpoint the seat fetches with its existing bus identity. Decision needed before any implementation; do not ship tokens-in-contracts by default.
5. **Seat start.** `ensureSeatWorktree` (T/lib/seat-worktree.mjs:29) gains a backend branch: `git clone` the fork remote into the same seat dir path, then apply the project declaration and run preflight exactly as today. The whole reset/refresh/reuse block (T/lib/seat-worktree.mjs:36-101) — the #13921 blast zone — simply does not exist for this backend: there is nothing to reset, and a stale base is impossible because the fork *is* the pinned base.
6. **During the card.** Seat commits and pushes to its fork (`git push` over HTTPS with the write token; push is protocol v1 — [CF: Git protocol](https://developers.cloudflare.com/artifacts/api/git-protocol/)). Repo-scoped write means a compromised seat can push to exactly one contract's repo and nothing else — today a seat pushes `seat/<name>` to the shared origin and holds durable credentials to the whole remote (T/lib/seat-worktree.mjs:87-91 sets `push.autoSetupRemote`).
7. **Gate wake.** Keep the bus as the wake path (the runner already reports on the bus; no new infra). Optionally later: a Worker subscribed to `cf.artifacts.repo.pushed` posts into the hub ([CF: Event subscriptions](https://developers.cloudflare.com/artifacts/guides/event-subscriptions/)) — that is new always-on infra on the Cloudflare account, explicitly *not* required for v1.
8. **Harvest.** Orchestrator fetches the fork by repo name with its read token, runs the gate, cherry-picks/merges into main, pushes main to origin, records the same receipt as today (seat sha → main sha, T/lib/harvest.mjs:30-43) because integration still rewrites shas. Receipts are not made redundant by forks.
9. **Card close.** Delete the fork repo, revoke its tokens (both are billable/lifecycle ops — [CF: Pricing](https://developers.cloudflare.com/artifacts/platform/pricing/); repos persist until explicitly deleted). A fork that is still ahead of main is *kept* — that is the #13921(a) "park or refuse" rule implemented by storage layout: the unharvested work cannot fall off any branch because it has a whole repo to itself.

## What it fixes

1. **#13921(a), unharvested-commit loss — fixed by construction.** No branch is ever reset; each contract's history lives in its own repo until deliberately deleted. The current failure (reset to the next base, commit reachable only by sha) is structurally impossible.
2. **#13921(b), stale base headers — fixed by construction.** The fork pins the base commit at creation; the seat cannot see any other main. The contract stops instructing the seat to reset to a sha (three disagreeing base sources collapse into one).
3. **Remote-seat isolation.** Per-contract repos with repo-scoped tokens replace shared-remote branch namespaces. Blast radius of a bad or stalled seat = one fork. Fetch-by-repo-name (HTTPS + read token) replaces fetch-by-branch-name over SSH, so seats never receive the shared remote's host key or push credentials.
4. **Auditability.** Open contracts are listable via `wrangler artifacts repos list` / REST ([CF: Changelog 2026-05-18](https://developers.cloudflare.com/artifacts/platform/changelog/)); today "which seats hold unharvested work" requires walking worktrees and receipts.

## What it does not fix

1. **Untracked provisioning.** Forks carry only git-tracked content. Sibling-checkout links, `.env` stubs, operator-provisioned secrets (T/lib/seat-worktree.mjs:121-235) are untouched — the declaration system survives unchanged and still runs locally after the clone.
2. **Disk (#12268, #11486).** Builds still happen on seat hosts; `node_modules`/`.next`/`target` still accumulate in clones. The janitor (T/lib/disk.mjs) stays exactly as is. Artifacts stores source, not compute.
3. **Harvest receipts (#7748).** Integration still rewrites shas; receipts and `sync`'s refusal logic remain necessary.
4. **Seat collisions.** Two forks from the same base still conflict on the same lines at merge; Artifacts does not merge for you (the integrate conflict-stop stays, T/bin/integrate.mjs:43-64).

## Privacy and data residency

- Client code — including code of Trantor's *users*, if this became the default — leaves the operator's machines and is stored/processed by Cloudflare, replicated across its data centers plus object storage ([CF: How Artifacts works](https://developers.cloudflare.com/artifacts/concepts/how-artifacts-works/), [Blog](https://blog.cloudflare.com/artifacts-git-for-agents-beta/)).
- Jurisdiction can be pinned to `eu` or `us` per namespace, immutable after creation; omitted means unrestricted ([CF: Data localization](https://developers.cloudflare.com/artifacts/guides/data-localization/)). There is no self-hosted Artifacts and no jurisdiction outside those two — users with "code never leaves my box" constraints cannot use it.
- Tokens are bearer secrets ([CF: Authentication](https://developers.cloudflare.com/artifacts/guides/authentication/): "Treat `result.token` as a secret"); leaked write token = write access to exactly one contract repo until expiry/revocation.
- Forks persist until deleted ([CF: Pricing](https://developers.cloudflare.com/artifacts/platform/pricing/)) — for a client-code host, that makes delete-at-card-close a privacy obligation, not just hygiene. A missed cleanup leaves client code on third-party infrastructure indefinitely.

## Cost and limits at our scale

Rough crew-contract arithmetic (no human-time estimates by contract):

- **Operations per contract:** fork (1) + ~2 token mints (5:1 ratio ≈ 0.4) + seat clone (1) + ~3 seat pushes + ~2 orchestrator fetches + delete (1) ≈ **~9 billable ops** ([CF: Pricing](https://developers.cloudflare.com/artifacts/platform/pricing/)).
- **Volume:** a crew of 5–8 seats at 1–4 cards/seat/day → ~150–900 contracts/month → **~1,400–8,100 ops/month**, inside the 10,000 free tier; at double the top end, ~$1–2/mo.
- **Storage:** baseline ~12 MiB; live forks ≈ open contracts (say 10–30) → well under the free 1 GB *if forks are deleted at card close*. Hoarding (never deleting) ≈ 900 forks × 12 MiB ≈ 10.5 GB ≈ +$4.75/mo — cleanup is the cost control.
- **Repo-count billing** (coming soon): 100,000 free, then $0.01/repo — irrelevant at our scale ([CF: Pricing](https://developers.cloudflare.com/artifacts/platform/pricing/)).
- **The floor is the plan, not usage:** Workers Paid at $5/mo minimum per account ([CF: Workers pricing](https://developers.cloudflare.com/workers/platform/pricing/)) — for the operator that $5 likely already exists; for an adopting *user* it is a new hard dependency.
- **Limits fit measured repo:** 11.54 MiB pack / 15,722 objects / 1,736 commits vs 1 GB per repo, 64 MiB per push, 50k objects per push ([CF: Limits](https://developers.cloudflare.com/artifacts/platform/limits/)). Fine today; per-push limits would bite repos with large binaries — the janitor's junk list says our repos carry build output, but that is never committed (T/lib/disk.mjs prunes it precisely because it is regenerable).

## Beta risk

- Open beta since 2026-10-01; limits were already cut once during beta (10 GB → 1 GB per repo for new repos, 2026-09-29) and the billing start date moved (2026-10-14 per changelog → 2026-11-19 per pricing page) — cited in the table above. Pricing and limits are demonstrably still moving.
- Protocol gaps: push is v1-only; `filter`/`include-tag` unsupported ([CF: Git protocol](https://developers.cloudflare.com/artifacts/api/git-protocol/)). **[unverified/conflicting]** `filter` being unsupported argues partial clone from Artifacts should not work, yet the ArtifactFS guide (whose first step is a blobless clone) claims it works with Artifacts remotes ([CF: ArtifactFS](https://developers.cloudflare.com/artifacts/guides/artifact-fs/)). Irrelevant at our repo size (plain clone is right), but symptomatic of young docs.
- Local dev simulator omits push/clone/fetch events and any CLI ([CF: Local development](https://developers.cloudflare.com/artifacts/guides/local-development/)) — an opt-in backend's tests would need a fake control plane, not the simulator.
- Repo-count billing lands later with unknown interplay; the pricing page promises notice first ([CF: Pricing](https://developers.cloudflare.com/artifacts/platform/pricing/)).

## Users without Cloudflare: offline, self-hosted, no-account

Trantor's seat flow today needs only local git: `TRANTOR_NO_WORKTREE=1` and plain worktrees work with no remote at all (T/lib/seat-worktree.mjs:30-32), and origin is whatever the user has. An Artifacts *replacement* would break every user who: has no Cloudflare account / no Workers Paid plan ($5/mo, [CF: Workers pricing](https://developers.cloudflare.com/workers/platform/pricing/)); keeps code off third-party infrastructure; or runs air-gapped. This alone rules out replacement. As an *optional backend* it is additive: config gains `backend: artifacts` (+ account id, namespace, jurisdiction, API token), and everything else — including the entire #13921 in-place fix — still works for the default local backend.

## Latency

Ad-hoc probe, this seat host (linux, the machine hosting this worktree), 2026-11-20, 3 samples each: `artifacts.cloudflare.net` TLS complete ~0.23–0.27 s, TTFB ~0.25–0.29 s; `api.cloudflare.com` TTFB ~0.24 s. DNS dominated (~0.21 s); steady-state HTTPS RTT ≈ 25–40 ms above it. A per-contract clone is one negotiation plus an ~11.5 MiB pack — expect low single-digit seconds; **[unverified]** actual clone timing and whether control-plane `fork` of a 12 MiB repo is interactive or async (import is documented async with 409-retry; fork is not documented as either — [CF: Import repositories](https://developers.cloudflare.com/artifacts/guides/import-repositories/)). ArtifactFS is unnecessary at this size per Cloudflare's own guidance ([CF: ArtifactFS](https://developers.cloudflare.com/artifacts/guides/artifact-fs/)). Net: latency is not a blocker from this network; re-probe from the Mac before deciding.

## What Trantor code would change (relative sizes, no time estimates)

| Unit | Change | Size |
|---|---|---|
| NEW T/lib/artifacts.mjs | Control-plane client (create/fork/issue-token/delete/revoke + config) over REST or Wrangler | M |
| T/lib/seat-worktree.mjs | Backend branch: clone fork into seat dir; declaration + preflight unchanged; reset/reuse refresh path (lines 36-101) unused for this backend | S–M |
| Contract composition (base: line; exact emitter being located by #13921) | Carry fork remote + repo name; stop instructing reset-to-base | S |
| Token handoff | Open design: operator-provisioned file vs hub endpoint vs contract field (bus persistence makes contracts the worst default) | S–M + decision |
| T/lib/harvest.mjs, T/bin/sync.mjs | Receipts unchanged; fetch target becomes the fork repo; refusal audit kept as belt-and-braces | S |
| T/bin/integrate.mjs | Post-merge step: delete fork + revoke tokens behind the autonomy dial | S |
| T/bin/crew/state.mjs (down) | Same cleanup per seat on teardown | S |
| T/bin/crew-runner.mjs RULES (line 312) | Seat instructions: clone-the-fork instead of reset-to-base | S |
| T/lib/disk.mjs | Nothing — builds stay local | none |
| Tests | Drill for the backend flow with a fake control plane (local simulator can't cover push events) | M |

## Comparison against fixing #13921 in place

| Failure / concern | In-place fix (#13921) | Artifacts fork-per-contract |
|---|---|---|
| Unharvested commit dropped on re-base (#13921a) | Fixed by park-on-`seat/<name>/<card>` or refuse-until-harvested — small, local, proven pattern (sync already refuses the same way, T/lib/harvest.mjs:91) | Fixed by construction |
| Stale base in contract header (#13921b) | Fixed: header base from the contract's stated base or current origin/main | Fixed by construction (fork pins it) |
| Remote seats share branch namespace / hold shared-remote push credentials | Not fixed — still fetch-by-branch over SSH, per #13921's note | Fixed: repo-scoped tokens, per-contract repos |
| Untracked provisioning, sibling links | Unaffected (works today) | Unaffected (declaration still runs locally) |
| Disk (#12268, #11486) | Unaffected (janitor owns it) | Unaffected |
| Works offline / self-hosted / no Cloudflare | Yes | No — Workers Paid account + code on Cloudflare |
| New failure modes | None beyond the code touched | Beta pricing/limit drift; push v1-only; token secrecy; fork cleanup as a privacy obligation; private-origin bootstrap via push (import is public-only) |
| Cost | $0 | ~$5/mo plan floor + cents at our volume (see arithmetic) |
| Size to ship | S (two contained changes) | M+ (new backend module, contract/token changes, tests) |

The in-place fix and the backend are not competitors: the in-place fix must ship either way, because the default local backend keeps the reset path. The only real question is whether the fork model replaces the *shared-remote* flow for remote seats — and there the isolation win is real but the dependency cost is still moving under an open beta that started billing yesterday (2026-11-19, [CF: Pricing](https://developers.cloudflare.com/artifacts/platform/pricing/)).

## Verdict

**Adopt as an optional backend — after #13921 is fixed in place, not instead of it.**

1. **Now:** fix #13921 in place (park-or-refuse + truthful header base). Small, dependency-free, covers every backend including a future Artifacts one.
2. **Next (opt-in prototype):** `backend: artifacts` for remote/cross-machine seats, where shared-remote branch fetching is the actual weakness. EU jurisdiction namespace, delete-at-card-close enforced by integrate/down, tokens handed over out-of-band (not in contract messages), bus stays the wake path, no event-subscription Worker in v1.
3. **Revisit promotion when:** Artifacts leaves beta; repo-count billing has landed and stayed at the published 100k-free tier; the fork-at-sha question above is verified; and a full crew cycle has run on the backend for a non-sensitive project. If privacy-sensitive client projects are ever in scope, keep them on the local backend regardless.

## Unverified / open questions

- Whether the REST fork endpoint can fork at an arbitrary sha/ref, or only the default branch head (determines step 2 of the mapping's complexity).
- Whether `fork` of a ~12 MiB repo is synchronous or 409-async like import.
- Actual clone/push timings from the Mac orchestrator host (probe here was from the linux seat host only).
- Partial clone (`--filter`) from Artifacts: docs conflict with ArtifactFS's blobless claim; irrelevant at our size but worth knowing before any large-repo use.
- Whether the operator's existing Cloudflare account already carries Workers Paid (changes the cost line from "new $5/mo" to "already sunk").
