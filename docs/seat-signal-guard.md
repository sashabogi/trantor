# Seat signal guard (#11585)

Trace: the card records BSD `pkill -f "claude" -0` treating the trailing
`-0` as a pattern rather than a signal option, sending the default SIGTERM
across operator sessions. The runner currently launches all providers through
one Bash command with an inherited environment and permission bypass flags.
No process ownership check exists at that launch boundary. Shell builtin
`kill` also bypasses a PATH-only wrapper.

The runner prepends guarded signal commands after loading provider environment
files. All provider commands inherit them, including fresh and resumed turns.
Bash's BASH_ENV and Zsh's startup files disable builtin kill and restore the
guard PATH after loading the user's original startup files. The supervisor
keeps its own cleanup commands unchanged.

The guard resolves targets with read-only ps/pgrep, checks the entire set
against the runner's descendants, then checks ancestry again before sending
signals. The runner itself is excluded. An outside target refuses the whole
request. Orphaned processes are refused because ownership is no longer provable.
No native pkill or killall is ever executed.

Supported cleanup: kill with positive PIDs, killall with exact process names,
and pkill with one pattern and leading -f/-i/-x options. Signals may precede
targets as -TERM, -9, -0 or -s TERM. Ambiguous/trailing options, process groups,
job specs and unsupported switches are refused with one line.

Run `node test/crew/test-seat-signal.mjs`. It launches the real runner with fake
Codex, Claude and GLM CLIs, each exercising Bash and available Zsh against an
outside decoy named claude. The test checks the exact incident command, broad
matches, mixed PID sets, and successful cleanup of owned children. It asserts
shim resolution before any broad command and only cleans up PIDs it spawned.

The runner's VM-based turn-box and turn-state tests must inject the real
`seatSignalPrefix` helper when evaluating `runTurn`; omitting its imported
binding fails before a CLI starts. Turn-box also observes both shell contexts:
the CLI resolves kill to the guard, while the supervisor still reports its
native builtin after fast completion, a box cut, and a disabled box. Cut/park
passes unchanged on integration base d748deb with the guard present.

The guard directory ignores its own runtime files even when the repository has
no ignore rules. Otherwise the eight generated shims/startup files make an
untouched seat appear dirty and enter the runner's automatic cut snapshot.
The duty-seat fixture records launcher PIDs for cleanup instead of matching
process names, and stubs the production prior-seat sweep in its fresh fixture.

These inherited command guards prevent accidental broad shell cleanup. They
are not a kernel security boundary: explicit system binaries, cleared shell
environments, or code calling kill(2) can bypass them. A true hostile-code
boundary requires OS isolation.
