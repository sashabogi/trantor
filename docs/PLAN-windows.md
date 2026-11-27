# Plan: Trantor on Windows

Status: planned, testing starts the week of 2026-11-30 on the operator's office Windows machine.
Card: see the "Windows" phase on the trantor board.

## Where it stands (measured 2026-11-26 on main 5bb6f60f)

Trantor is Mac-only today. Nothing in the design ties it to macOS, but nothing has been built or
tested anywhere else.

- **CI and releases** run only on `macos-latest` (`.github/workflows/ci.yml`, `release.yml`). There
  is no Windows build, installer or code signing.
- **Desktop app (Rust).** `cargo check --target x86_64-pc-windows-gnu` fails with 12 errors in 7
  files, all Unix-only calls with standard Windows equivalents:

  | File | What breaks |
  |---|---|
  | `identity.rs`, `setup.rs` | `std::os::unix` file modes (`Permissions::mode`, `OpenOptions::mode`) |
  | `ci_status.rs`, `graft_cli.rs` | `Command::process_group`, `std::os::unix` |
  | `app.rs` | `libc::kill`, `as_raw_fd` |
  | `herdr.rs` | `UnixStream` to `~/.config/herdr/herdr.sock` |
  | `local_hub.rs` | `std::os::unix` |

  There is no `cfg(windows)` code anywhere yet.
- **Terminals.** Seats run inside herdr; panes use `portable-pty` (ConPTY on Windows) running
  `herdr agent attach <target>`. herdr has native Windows support (ConPTY), but its docs list some
  attach and handoff features as unsupported there, and our client speaks to it over a Unix socket.
  Whether `agent attach` and the socket API work on Windows can only be answered on a real machine.
- **CLI, crew runner, hooks** are the most Mac-bound part:

  | Dependency | Files | Used for |
  |---|---|---|
  | `/bin/bash` | 11 | the crew runner runs every turn through bash |
  | `osascript` | 13 | opening Terminal windows, notifications |
  | `launchctl` | 6 | duty and wake keepalives |
  | `lsof` / `ps` | 6 | seat liveness |
  | DMG + `/Applications` | `bin/app.mjs` | `trantor app install/update` |

  The hub is plain Node and should be close to portable.
- **Browser pane.** Tauri uses WebView2 (Edge Chromium) on Windows, not WebKit. The in-app
  browser needs a WebView2 backend behind the same agent tools; WebView2 also exposes the DevTools
  Protocol.

## Steps

1. **The app builds on Windows** (about one session).
   - Fix the 12 compile errors with `cfg(unix)` / `cfg(windows)` pairs.
   - herdr client: Windows transport (named pipe or whatever herdr uses there).
   - Add a `windows-latest` job to CI running cargo check, vitest and the desktop build.
   - Produce an unsigned NSIS/MSI installer from `pnpm tauri build` on Windows.
2. **CLI and crew run on Windows** (two to three sessions). Decide first between:
   - **Native:** Node `child_process` instead of bash in the runner, Task Scheduler or a service
     instead of `launchctl`, no `osascript`, cross-platform liveness instead of `lsof`/`ps`,
     `trantor app` installing the Windows installer.
   - **WSL:** CLI, hub client and crew inside WSL, only the desktop app native. Cheaper, but seats
     and the app then live in two filesystems.
3. **Real-machine drill** on the office Windows machine:
   - install the app, first-run setup, hub auto-start, project resolution
   - a herdr seat in a pane, typing, Stop, handoff
   - Source Control on a real repo, Code editor saves
   - the in-app update check finding a newer release
   - the browser pane on WebView2
4. **Windows code signing.** A Windows code-signing certificate (separate from the Apple
   Developer ID) so SmartScreen does not warn on install, plus a signed release step.

## What to bring to the office machine

- The machine's Windows version and whether WSL2 is installed.
- Node (LTS), Git for Windows, Rust (MSVC toolchain), pnpm.
- Agent CLIs to test: Claude Code, Codex.
- Tailscale, if the machine should reach the netcup hub.
