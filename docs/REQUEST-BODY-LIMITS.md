# Hub request body limits

Card #12161 measured the existing producers before setting private-listener exceptions to the 4 MiB streaming body limit. Sizes below are UTF-8 bytes, including JSON syntax, measured against `dea7b9f51360039d54f2902c975c457d4e17c3e6`.

| Producer / POST route | Measurement | Limit |
| --- | --- | --- |
| Desktop `Mirror.payload` / `/session/chat` | A real 10,780,402-byte transcript decoded to 316 turns and a 115,194-byte publish body. Repeating its longest decoded turn (2,313 serialized bytes) through the full 400-turn window produced 925,668 bytes. | 16 MiB for a signed project owner on the private listener |
| State adoption / `/import` | The real local state file was 10,659,828 bytes. Serializing all its importable rows (1,954 cards, 16,535 events, 4,920 messages) into the import request produced 7,719,098 bytes. The trantor-only request was 371,623 bytes. | 64 MiB for a signed project owner on the private listener |
| Handoff guard / `/handoff` | Largest reconstructed guard request in the local state: 95 bytes. The integration fixture is 64 bytes. This POST carries project, session and trigger, not the handoff narrative stored locally. | Explicit 4 MiB |
| Card create / `/task` | A request with a full 2,000-character note and 20 checklist items of 200 characters each is 6,130 bytes. | Explicit 4 MiB |
| Card update / `/task/update` | A request with a full 2,000-character note is 2,021 bytes. | Explicit 4 MiB |
| Phone images / `/session/prompt` | Existing envelope supports four base64 JPEGs, each up to 2 MiB decoded. | Existing 16 MiB exception on either listener |
| Other POST routes | No producer requiring an increased body budget was identified in this review. | 4 MiB |

The chat and import limits were selected with the orchestrator: 16 MiB is over 100 times the measured chat publish body, and 64 MiB is about six times the real state file. The 400-turn count does not bound text bytes; these are supported request envelopes, not mathematical maxima for arbitrary transcripts or state. Oversize requests receive 413. Card and handoff measurements likewise describe observed or supported-field fixtures, not arbitrary unsanitized input sizes.

The state used for measurement has SHA-256 `717bea9a5a514f523197979bd9fb23d674304d00f61fcb08c015c136fc045680`. The transcript was passed through the desktop's actual `Mirror.read` and `Mirror.payload` methods in a temporary targeted Rust test. No private transcript or state content is checked in. The regression test creates synthetic rows with the measured counts and wire size.

## Authentication boundary

Only the private listener considers the larger chat/import limits. All four signature headers and a known identity with an owner scope are required even to select that read budget. This header lookup is a hint, not authentication: the signature covers the body and can only be verified once the bounded body has arrived. A forged known-owner header can obtain a bounded read but cannot authorize a request.

For a body over the ordinary route limit, the handler verifies the signature, enrollment and nonce before JSON parsing, then checks owner scope against the destination project before dispatch. This strict path also applies when private authentication is configured as `off` or `warn`. Unknown identities, writers and unsigned requests keep the ordinary cap. UTF-8 decoding preserves characters split across network chunks so signatures verify against the original text.

The public listener never consults the private owner limits. It rejects missing signature headers before reading a protected route's body. The photo-upload endpoint additionally requires an enrolled, non-revoked pubkey with a write, approver or owner scope before reading any bytes. Target-project authorization still follows signature verification because the project is inside the JSON body. Enrollment is exempt from the enrolled-key check. This rejects dummy or unknown keys without buffering a 16 MiB upload; a known key header is still only a hint until the signature verifies. The existing route allowlist excludes `/import` and chat publishing. Allowed ordinary writes remain capped at 4 MiB even for owner identities. The existing phone-image exception remains 16 MiB.

## Regression coverage

`node test/hub/test-request-body-limits.mjs` exercises the actual HTTP entrypoint with an exact 16 MiB, 400-turn snapshot, a one-byte overflow, a 7,719,098-byte import, forged/unsigned/writer/cross-project requests, public listener requests, and strict owner checks under both permissive auth modes. It also checks the explicit route budgets and UTF-8 chunk boundaries. Each spawned hub is stopped by the test.
