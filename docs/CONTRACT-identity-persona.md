# Seat personas (#11369)

A persona is a stable seat name within a project. The bus session and durable
identity name are `<persona>:<project>`. The agent selects the harness; the model
selects what that harness runs. A seat record carries `{persona, agent, model}`.

`trantor up glm glm` allocates `glm` and `glm-2`; further instances take the next
available numeric suffix. `trantor up glm --as reviewer` allocates `reviewer`.
Explicit names use letters, digits, underscores and hyphens. An active persona
cannot be started twice. Allocation is persisted before spawning and retries
reuse the allocated persona rather than creating another identity.

Keys remain in the existing identity store, indexed by the full bus session.
Each persona enrolls independently. Legacy seats default to persona `<agent>`:
their existing key path and enrollment are unchanged. No key rotation or
re-enrollment is part of migration.

Worktrees, pending queues, runner state, logs, process lookup and terminal
handles belong to the persona. Agent-specific CLI selection, provider checks
and branding belong to the agent. Launcher rows retain persona in the historic
seat-name column and append agent/model metadata; old rows infer agent=persona.

`trantor swap reviewer kimi` keeps `reviewer:<project>`, its key, history,
worktree and pending work. The replacement is staged before the old process is
stopped; only after handoff may it run under the persona. Desktop tabs use the
persona label and current agent mark, keyed by the stable session.

Acceptance runs only against a disposable enforce hub: two same-brand personas
have different enrolled public keys and both sign successful requests; swapping
a persona retains session/key/history; an enrolled legacy seat still signs
without another enrollment. No live crew or hub is modified by these drills.
