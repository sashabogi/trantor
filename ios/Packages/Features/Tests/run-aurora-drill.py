#!/usr/bin/env python3
"""Run Aurora's app, design and existing UI drills serially on one simulator."""
import argparse
import json
import os
from pathlib import Path
import subprocess
import sys

ROOT = Path(__file__).resolve().parents[4]
OUT = ROOT / ".agent-bus-out/12228"


def load_gate():
    load = os.getloadavg()[0]
    if load > 40:
        raise SystemExit(f"iOS run deferred: 1-minute load {load:.2f} exceeds 40")


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--device", required=True)
    parser.add_argument("--phase", choices=["app", "design", "ui", "screens"], required=True)
    parser.add_argument("--only", action="append", default=[])
    args = parser.parse_args()
    load_gate()
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
    load_gate()
    devices = json.loads(subprocess.check_output(["xcrun", "simctl", "list", "devices", "--json"]))
    booted = [device["udid"] for runtime in devices["devices"].values() for device in runtime if device["state"] == "Booted"]
    if any(device != args.device for device in booted):
        raise SystemExit("Another simulator is booted; coordinate before running this drill")
    selection = {"app": "AuroraAppTests", "design": "AuroraDesignTests", "ui": "AuroraUITests",
                 "screens": "AuroraAppTests/AuroraScreenCaptureTests"}[args.phase]
    result = OUT / f"{args.phase}.xcresult"
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
    try:
        with (OUT / f"{args.phase}.log").open("w") as log:
            completed = subprocess.run(command, cwd=ROOT, stdout=log, stderr=subprocess.STDOUT)
        print(f"{args.phase}: exit {completed.returncode}; {result}", flush=True)
        return completed.returncode
    finally:
        subprocess.run(["xcrun", "simctl", "shutdown", "all"], cwd=ROOT, check=False)


if __name__ == "__main__":
    sys.exit(main())
