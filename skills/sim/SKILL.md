---
name: trantor-sim
description: Drive the iOS Simulator on a Mac through Trantor's guarded AXe wrapper for companion app drills and screenshot evidence.
---

# Trantor iOS Simulator

Use this skill when an iOS task needs a live simulator. The stable interface is `trantor sim`; do not call raw `xcrun simctl` or `axe` for interactive actions. The wrapper tracks the simulator owned by this session, refuses a conflicting booted simulator, and prints JSON results.

This requires a Mac with Xcode and an available iOS Simulator runtime. It cannot drive an iOS Simulator from Linux. If AXe is missing, install the pinned release from the Trantor repository root:

```bash
bash bin/install-axe.sh
```

The installer downloads AXe v2.1.1 from its official GitHub release and checks the published SHA-256 before extracting it. Ensure `$HOME/.local/bin` is on `PATH`; `trantor doctor` reports whether the pinned version is present.

## Run a drill

1. Build the iOS app using the task's requested drill and retain the built `.app` path.
2. Boot one simulator by its exact name or UDID. If another simulator is already booted, stop and coordinate; do not shut down a simulator you did not start.
3. Install and launch the app, then inspect the screen and accessibility elements.
4. Interact using an element label/identifier when available. Use point coordinates from the `screen` output only when no stable element selector exists. `screen` writes a PNG under `.agent-bus-out/sim/` and returns its path plus screen-scaled accessibility elements.
5. Open/read the returned PNG as visual evidence. Capture a new screen after each meaningful action and record screenshots and the observed result in the drill report.
6. Always call `trantor sim shutdown` in a `finally`/cleanup step, including after a failed build or interaction. Verify the JSON result says `shutdown: true` or the session owns no simulator.

Example:

```bash
trantor sim boot "iPhone 17 Pro"
trantor sim install .agent-bus-out/ios/Trantor.app
trantor sim launch ai.trantor.companion
trantor sim screen
trantor sim tap --label "Continue"
trantor sim screen
trantor sim shutdown
```

Commands:

```text
trantor sim boot <device-name-or-udid>
trantor sim install <app-path>
trantor sim launch <bundle-id>
trantor sim screen [--out <png-path>]
trantor sim tap --label <text> | --id <identifier> | --xy x,y
trantor sim swipe --from x,y --to x,y
trantor sim type <text>
trantor sim shutdown
```

Coordinates are logical points, matching the screenshot dimensions and AXe frames. `shutdown` is safe and idempotent: it shuts down only the simulator registered to the current session. Do not replace it with `xcrun simctl shutdown all`.

The wrapper owns local simulator exploration; existing `ios/` build and XCTest drills remain the required deterministic test gate. Turn confirmed exploratory findings into a focused regression test when practical.
