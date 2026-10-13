# Hindsight assessment — card #11669

Research in progress, 2026-10-13. Trantor base: `d748debf3afefd08e0b2659b2f69cb15df1d0689`. Hindsight source revision: `610c135b6f2d0d8b972da94146ae635943f36271`.

Initial source findings:

- Installed Foundation 4.0.1 `node_modules/@sashabogi/foundation/dist/tools/gaia/index.js:964-978` routes `gaia_search` directly to `MemoriaStorage.search`; `storage.js:213-286` uses FTS5 followed by composite scoring. Foundation `README.md:127-162` describes a separate optional Open Brain semantic layer; documentation is not proof that this path runs it.
- Foundation `hooks/sessionstart.mjs:142-147` supplies a project path, but `src/memory/gaia.mjs:42-46` forwards only tiers and limit. This is a concrete scoping weakness to address without changing memory engines.
- Trantor `lib/memory-pins.mjs:67-91` compares source-symbol fingerprints. Hindsight's semantic, keyword, graph and temporal retrieval (`hindsight-api-slim/hindsight_api/engine/search/retrieval.py:114-222`) serves a different purpose.

No installs, memory-data reads, settings edits, containers or servers. The upstream checkout is a separate git repository inside ignored `.agent-bus-out/hindsight`, following the seat's scratch-path rule.
