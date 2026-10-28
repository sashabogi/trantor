#!/usr/bin/env python3
"""Run Aurora's app, design and existing UI drills serially on one simulator."""
import argparse
import json
import os
import plistlib
import signal
from pathlib import Path
import subprocess
import sys
import time

ROOT = Path(__file__).resolve().parents[4]
OUT = ROOT / ".agent-bus-out/12228"


def load_gate(wait_seconds=0):
    deadline = time.monotonic() + wait_seconds
    while os.getloadavg()[0] >= 40:
        load = os.getloadavg()[0]
        if time.monotonic() >= deadline:
            raise SystemExit(f"iOS run deferred: 1-minute load {load:.2f} is not below 40")
        print(f"Waiting to start iOS: load {load:.2f}", flush=True)
        time.sleep(min(30, max(0, deadline - time.monotonic())))


def run_monitored(command, device, log):
    device_state = Path.home() / "Library/Developer/CoreSimulator/Devices" / device / "device.plist"
    high_since = None
    with subprocess.Popen(command, cwd=ROOT, stdout=log, stderr=subprocess.STDOUT) as process:
        while process.poll() is None:
            try:
                with device_state.open("rb") as source:
                    booted = plistlib.load(source).get("state") == 3
            except (OSError, plistlib.InvalidFileException):
                booted = False
            load = os.getloadavg()[0]
            if booted and load > 150:
                high_since = high_since or time.monotonic()
                if time.monotonic() - high_since >= 120:
                    print(f"Stopping own test run: load stayed above 150 for two minutes ({load:.2f})", flush=True)
                    process.send_signal(signal.SIGINT)
                    try:
                        process.wait(timeout=30)
                    except subprocess.TimeoutExpired:
                        process.kill()
                        process.wait()
                    return 75
            else:
                high_since = None
            time.sleep(5)
        return process.returncode


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--device", required=True)
    parser.add_argument("--phase", choices=["app", "design", "ui", "screens"], required=True)
    parser.add_argument("--only", action="append", default=[])
    parser.add_argument("--wait-for-load", type=int, default=0)
    parser.add_argument("--result-name")
    parser.add_argument("--keep-simulator", action="store_true")
    args = parser.parse_args()
    load_gate(args.wait_for_load)
    OUT.mkdir(parents=True, exist_ok=True)
    packages = {name: {"path": str(ROOT / "ios/Packages" / name)}
                for name in ["TrantorCore", "HubClient", "TrantorStore", "Features", "TrantorDesign"]}
    targets = {
        "TrantorCompanion": {
            "type": "application", "platform": "iOS",
            "sources": [{"path": str(ROOT / "ios/App"), "excludes": ["Info.plist", "TrantorCompanion.entitlements"]}],
            "dependencies": [{"package": name} for name in packages],
            "settings": {"base": {"PRODUCT_BUNDLE_IDENTIFIER": "ai.trantor.companion", "PRODUCT_NAME": "Trantor",
                                    "PRODUCT_MODULE_NAME": "Trantor", "TARGETED_DEVICE_FAMILY": "1,2",
                                    "INFOPLIST_FILE": str(ROOT / "ios/App/Info.plist"), "GENERATE_INFOPLIST_FILE": "NO"}},
        },
    }
    sources = {
        "AuroraAppTests": [ROOT / "ios/AppTests", ROOT / "ios/Packages/Features/Tests/FeaturesTests"],
        "AuroraDesignTests": [ROOT / "ios/Packages/TrantorDesign/Tests/TrantorDesignTests"],
        "AuroraUITests": [ROOT / "ios/Packages/Features/Tests/FeaturesUITests"],
    }
    for name, paths in sources.items():
        targets[name] = {
            "type": "bundle.ui-testing" if name == "AuroraUITests" else "bundle.unit-test", "platform": "iOS",
            "sources": [str(path) for path in paths],
            "dependencies": [{"target": "TrantorCompanion"}] + [{"package": name} for name in packages],
            "settings": {"base": {"GENERATE_INFOPLIST_FILE": "YES", "TEST_TARGET_NAME": "TrantorCompanion",
                                    "PRODUCT_BUNDLE_IDENTIFIER": "ai.trantor." + name.lower()}},
        }
        if name != "AuroraUITests":
            targets[name]["settings"]["base"].update({
                "TEST_HOST": "$(BUILT_PRODUCTS_DIR)/Trantor.app/Trantor", "BUNDLE_LOADER": "$(TEST_HOST)"})
    spec = {
        "name": "AuroraDrill", "options": {"deploymentTarget": {"iOS": "17.0"}}, "packages": packages,
        "settings": {"base": {"SWIFT_VERSION": "5.0", "SWIFT_STRICT_CONCURRENCY": "complete", "CODE_SIGNING_ALLOWED": "NO"}},
        "targets": targets,
        "schemes": {"AuroraDrill": {"build": {"targets": {"TrantorCompanion": "all"}},
                                      "test": {"targets": list(sources)}}},
    }
    spec_path = OUT / "project.json"
    spec_path.write_text(json.dumps(spec, indent=2))
    subprocess.run(["xcodegen", "generate", "--spec", str(spec_path)], cwd=ROOT, check=True)
    load_gate(args.wait_for_load)
    devices = json.loads(subprocess.check_output(["xcrun", "simctl", "list", "devices", "--json"]))
    booted = [device["udid"] for runtime in devices["devices"].values() for device in runtime if device["state"] == "Booted"]
    if any(device != args.device for device in booted):
        raise SystemExit("Another simulator is booted; coordinate before running this drill")
    selection = {"app": "AuroraAppTests", "design": "AuroraDesignTests", "ui": "AuroraUITests",
                 "screens": "AuroraAppTests/AuroraScreenCaptureTests"}[args.phase]
    result_name = args.result_name or args.phase
    if Path(result_name).name != result_name:
        raise SystemExit("Result name must be a filename, not a path")
    result = OUT / f"{result_name}.xcresult"
    if result.exists():
        raise SystemExit(f"Keep the earlier evidence: move {result} aside before rerunning")
    command = ["xcodebuild", "-project", str(OUT / "AuroraDrill.xcodeproj"), "-scheme", "AuroraDrill",
               "-destination", f"platform=iOS Simulator,id={args.device}", "-derivedDataPath", str(OUT / "DerivedData"),
               "-resultBundlePath", str(result), "-parallel-testing-enabled", "NO", "-jobs", "2",
               "-collect-test-diagnostics", "never", "CODE_SIGNING_ALLOWED=NO", "test"]
    if args.phase == "design":
        subprocess.run(["xcodegen", "generate", "--spec", str(ROOT / "ios/project.yml")], cwd=ROOT, check=True)
        command[command.index("-project") + 1] = str(ROOT / "ios/TrantorCompanion.xcodeproj")
        command[command.index("-scheme") + 1] = "TrantorDesign"
        selection = "TrantorDesignTests"
    command += ["-only-testing:" + test for test in (args.only or [selection])]
    if args.phase == "app":
        command += ["-skip-testing:AuroraAppTests/AuroraScreenCaptureTests"]
    load_gate(args.wait_for_load)
    exit_code = 75
    try:
        with (OUT / f"{result_name}.log").open("w") as log:
            exit_code = run_monitored(command, args.device, log)
        print(f"{args.phase}: exit {exit_code}; {result}", flush=True)
        return exit_code
    finally:
        if exit_code != 0 or not args.keep_simulator:
            subprocess.run(["xcrun", "simctl", "shutdown", "all"], cwd=ROOT, check=False)


if __name__ == "__main__":
    sys.exit(main())
