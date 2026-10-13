# Seat signal guard (#11585)

Trace: the card records BSD `pkill -f "claude" -0` treating the trailing
`-0` as a pattern rather than a signal option, sending the default SIGTERM
across operator sessions. The runner currently launches all providers through
one Bash command with an inherited environment and permission bypass flags.
No process ownership check exists at that launch boundary. Shell builtin
`kill` also bypasses a PATH-only wrapper.

Implementation plan: prepend guarded signal commands for every provider,
route Bash and Zsh builtin kill through those commands, resolve all targets
before signalling, and refuse any target outside the runner's descendants.
Reject ambiguous arguments rather than delegating to native pkill/killall.
Test with an unrelated decoy plus a seat-owned child and verify refusal is
atomic when a pattern includes both.

These inherited command guards prevent accidental broad shell cleanup. They
are not a kernel security boundary: explicit system binaries, cleared shell
environments, or code calling kill(2) can bypass them. A true hostile-code
boundary requires OS isolation.
