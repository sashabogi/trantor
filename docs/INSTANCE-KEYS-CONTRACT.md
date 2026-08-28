# Session-instance keys — design contract (2026-07-31)

Read first: TDD §7 (identity), `lib/identity.mjs` (the frozen v1 interface this extends),
memory `trantor-agent-ux-gap` (the handoff-twin incident this fixes).

## Why

Three problems, one mechanism:

1. **The handoff-twin race.** A durable identity (`MacBook-Pro-M1:trantor`) is one keypair, one
   inbox cursor, one delivery ledger. A baton twin and its dying predecessor are therefore the
   SAME peer: whichever one's hooks fire first eats shared messages, and the hub cannot tell them
   apart (2026-07-30: the live update had to be relayed via `sasha@mac`).
2. **No per-restart freshness.** The durable key lives until rotated by hand. A leaked key is
   valid forever; there is no cheap revocation story.
3. **Teams needs short-lived credentials.** In an org, "a user's agent on a machine" is durable,
   but each login/session should carry a credential that expires with it, is individually
   auditable, and can be revoked without destroying the identity (maps 1:1 onto SSO sessions).

The mechanism: **a per-session-instance Ed25519 subkey, endorsed by the durable key.** The durable
identity keeps enrollment, grants, and attribution; the instance key signs the actual traffic and
dies with the session. (Signal's identity-key + ephemeral pattern; SSH host-key + session-key.)

Explicitly NOT in scope (see "Later phases"): end-to-end encryption of messages. The hub reading
plaintext is the product — board, FEED, overseer detection, narration all depend on it.

## Shapes (FROZEN for this build)

```js
// instance key file — ~/.agent-bus/keys/instances/<safe(durable)>@<safe(instanceId)>.json, 0600
{
  name: "<durable name>",            // e.g. "MacBook-Pro-M1:trantor"
  instanceId: "<opaque id>",          // hooks: the harness session_id; MCP server: random at boot
  pubkey: "<hex64>", privkey: "<hex64>",
  createdAt: <ms>,
  endorsement: "<base64 Ed25519 sig by the DURABLE key over endorsementString(...)>"
}

// endorsementString — newline-joined, fixed arity, no field may contain \n (same discipline as
// canonicalString): what the durable key attests.
["trantor-inst-v1", <durablePubkeyHex>, <instancePubkeyHex>, <instanceId>, <createdAtMs>].join("\n")

// wire: three headers IN ADDITION to the four v1 headers. The v1 signature (x-trantor-sig etc.)
// is made with the INSTANCE key when these are present; absent, v1 semantics are unchanged.
x-trantor-durable: <durablePubkeyHex>
x-trantor-inst:    <instanceId>
x-trantor-endorse: <base64 endorsement>

// hub state (persisted): state.instances[instancePubkey] = {
//   durable: <durablePubkeyHex>, instanceId, name, firstSeen, lastSeen,
//   superseded: false | <ms>,     // set by /instance/supersede — the claim, kept forever
//   supersededBy: <instanceId>,   // WHICH instance the claim spared, so liveness can be checked
// }
```

## Verification algorithm (hub, `checkAuth`)

1. Verify the v1 request signature exactly as today — against `x-trantor-pubkey` (which is the
   INSTANCE pubkey when endorsement headers are present). Nonce/skew/replay unchanged.
2. If the three instance headers are absent → legacy path, `findIdentity(pubkey)` as today.
   **Backward compatible: every 0.17.57-and-earlier client keeps working untouched.**
3. If present: rebuild `endorsementString` from the headers + the instance record's `createdAt`
   — createdAt travels in a fourth header? NO: the endorsement is verified against
   (`durable`, `instancePubkey`, `instanceId`, `createdAt`) where createdAt comes from the
   REGISTERED instance record if known, else from a `x-trantor-inst-ts` header on first sight.
   Verify the endorsement with the DURABLE pubkey. Fail → treat request as unsigned (soft under
   warn, 401 under enforce).
4. `findIdentity(durablePubkey)` — the DURABLE identity must be enrolled; grants and scope checks
   run against it. The instance never enrolls and mints no new authority: it is the durable
   identity, time-boxed.
5. Upsert `state.instances[instancePubkey]`, stamp `lastSeen`.
6. If the record is `superseded` AND the claim is still live (see below): the request still executes
   (never break a dying session's last report), but the auth object carries `superseded: true`, and
   `/inbox` + `/poll` responses include `"superseded": true` so the client's own hooks can tell its
   model to stand down.

## Supersession (the twin fix)

- Supersession is EXPLICIT, never automatic: two lineages of one session (the hook processes and
  the MCP server) legitimately run two live instances of one durable name concurrently — mere
  existence of a newer instance must not kill an older one.
- `POST /instance/supersede { name, exceptInstanceId }` (signed, and only accepted from an
  endorsed instance of the SAME durable identity, or the owner): marks every other instance of
  that durable name superseded. Called by the baton-claim path — the moment a fresh session
  consumes a `<trantor-handoff>`, its sessionstart hook fires this, and the old twin's next
  `/inbox` or `/poll` answer tells it to stand down.
- **The claim lapses when the claimant stops being seen.** Stored supersession is permanent; the
  *reported* boolean is not. `supersededBy` names the spared instance, and the hub reports
  `superseded: true` only while that instance's `lastSeen` is inside `RELAY_SUPERSEDE_GRACE_MS`
  (default `REAP_GRACE_MS`, 15m). A claimant with no record yet is honoured for one window from the
  claim, so a booting successor still lands its baton. If the claimant returns, the muzzle re-engages
  by itself — nothing is re-claimed, and no supersession is ever invented.
  Why this exists: the flag used to be "never unset", so a session that claimed the baton and then
  died left every twin muzzled forever, deferring to a process that no longer existed. Note the limit
  honestly: `lastSeen` only advances on a request and the heartbeat is PostToolUse, so an alive-but-idle
  claimant reads as gone after the window. That is the deliberate trade — the only session that ever
  asks is one a human is actively driving, and deferring to a claimant silent for longer than the
  window is worse than letting the driven session work.
- A superseded instance's model sees, via its own hooks (T1/T2 additionalContext):
  "a newer instance of this session claimed the baton — stand down; do not consume bus messages."
  Informational, never a hard block — same doctrine as file claims and warn mode.

## Client behavior

- **Hooks**: the harness hands every hook `session_id` on stdin — that IS the instanceId (stable
  across all hook invocations of one Claude Code session, distinct across twins). `hooks/lib/api.mjs`
  gains `instanceFor(session, instanceId)` (mint-or-load + endorse, atomic like loadOrCreate);
  `signedGet`/`signedPost` accept `{ instanceId }` and attach the three headers.
- **MCP server**: no session_id available → random instanceId at boot; its lifetime ≈ the session's.
- **Local inbox cursors become per-instance**: `inbox-cursor-<safe(session)>@<safe(instanceId)>.id`.
  T1 and T2 share it (same session_id); a twin gets its own — the local half of the race dies.
  The CLI (`trantor inbox`) keeps the durable-name file (peek by default; unchanged).
- **Hub delivery ledger stays session-level** (`deliveredUpTo`): "was this handed to ANYONE" is
  exactly what the T3 deferred waker needs. Twin dedup is solved by supersession + per-instance
  local cursors, not by forking the ledger.

## Teams relevance

The durable identity maps to "user's agent seat" (SSO principal); the instance key maps to a login
session: short-lived, per-session audit trail (`state.instances`), revocable one at a time
(supersede), no re-enrollment churn. The invite gate keeps meaning: invites mint DURABLE
identities only; instances ride on endorsements.

## Later phases (designed, not built here)

- **B — receiver-side verification**: hub relays the sender's signature envelope with each
  message; receiving hooks verify before injecting. Removes the hub from the authenticity TCB.
- **C — hardening**: durable private keys into macOS Keychain/Secure Enclave (non-exportable;
  everything asks for signatures, nothing can read the key). Optional sealed DMs (NaCl box to
  recipient pubkey) for hub-blind confidentiality — DMs only, never board/broadcast traffic.

## Test plan (`test-identity-instances.mjs`)

Unit: mint+endorse round-trip; endorsement rejects wrong durable key / tampered instanceId /
tampered pubkey. Hub (spawnHub, RELAY_AUTH=enforce): endorsed instance of an enrolled durable
identity passes where an un-endorsed unknown key 401s; instance inherits the durable identity's
grants (scope check); legacy 4-header requests still pass (compat); /instance/supersede flips the
flag and /inbox + /poll carry `superseded:true` for the old instance while the new one reads
clean; superseded write still lands (never break the last report).
