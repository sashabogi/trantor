#!/usr/bin/env python3
"""Run the Features UI drill on the assigned iPad; keep artifacts outside sources."""
import datetime
import json
from pathlib import Path
import re
import subprocess
import sys

ROOT = Path(__file__).resolve().parents[4]
OUT = ROOT / ".agent-bus-out/12122"
OUT.mkdir(parents=True, exist_ok=True)
SIMULATOR = "iPad Pro 13-inch (M5)"
devices = json.loads(subprocess.check_output(["xcrun", "simctl", "list", "devices", "available", "--json"]))
device = next(d for runtime in devices["devices"].values() for d in runtime if d["name"] == SIMULATOR)
if device["state"] != "Booted":
    subprocess.run(["xcrun", "simctl", "boot", device["udid"]], check=True)
subprocess.run(["xcrun", "simctl", "bootstatus", device["udid"], "-b"], check=True)

packages = {name: {"path": str(ROOT / "ios/Packages" / name)}
            for name in ["TrantorCore", "HubClient", "TrantorStore", "Features", "TrantorDesign"]}
spec = {
    "name": "StageDrill", "options": {"deploymentTarget": {"iOS": "17.0"}},
    "packages": packages,
    "settings": {"base": {"SWIFT_VERSION": "5.0", "SWIFT_STRICT_CONCURRENCY": "complete", "CODE_SIGNING_ALLOWED": "NO"}},
    "targets": {
        "TrantorCompanion": {
            "type": "application", "platform": "iOS",
            "sources": [{"path": str(ROOT / "ios/App"), "excludes": ["Info.plist", "TrantorCompanion.entitlements"]}],
            "dependencies": [{"package": name} for name in packages],
            "settings": {"base": {
                "PRODUCT_BUNDLE_IDENTIFIER": "ai.trantor.companion", "PRODUCT_NAME": "Trantor",
                "TARGETED_DEVICE_FAMILY": "1,2", "INFOPLIST_FILE": str(ROOT / "ios/App/Info.plist"),
                "GENERATE_INFOPLIST_FILE": "NO", "ASSETCATALOG_COMPILER_APPICON_NAME": "AppIcon",
            }},
        },
        "StageScreensTests": {
            "type": "bundle.ui-testing", "platform": "iOS",
            "sources": [str(Path(__file__).parent / "FeaturesUITests")],
            "dependencies": [{"target": "TrantorCompanion"}],
            "settings": {"base": {
                "PRODUCT_BUNDLE_IDENTIFIER": "ai.trantor.stage-tests", "GENERATE_INFOPLIST_FILE": "YES",
                "TEST_TARGET_NAME": "TrantorCompanion",
            }},
        },
    },
    "schemes": {"StageDrill": {
        "build": {"targets": {"TrantorCompanion": "all", "StageScreensTests": "test"}},
        "test": {"targets": ["StageScreensTests"]},
    }},
}
project = OUT / "ui-project.json"
project.write_text(json.dumps(spec, indent=2))
subprocess.run(["xcodegen", "generate", "--spec", str(project)], check=True, cwd=ROOT)
stamp = datetime.datetime.now().strftime("%Y%m%d-%H%M%S")
result = OUT / f"stage-ui-{stamp}.xcresult"
shots = OUT / "screenshots"
shots.mkdir(exist_ok=True)
command = [
    "xcodebuild", "-project", str(OUT / "StageDrill.xcodeproj"), "-scheme", "StageDrill",
    "-destination", f"platform=iOS Simulator,id={device['udid']}",
    "-derivedDataPath", str(OUT / "UIDerivedData"), "-resultBundlePath", str(result),
    "-parallel-testing-enabled", "NO", "CODE_SIGNING_ALLOWED=NO", "test",
]
with (OUT / "ui-tests.log").open("w") as log:
    process = subprocess.Popen(command, cwd=ROOT, stdout=subprocess.PIPE, stderr=subprocess.STDOUT, text=True)
    for line in process.stdout:
        log.write(line)
        log.flush()
        match = re.search(r"STAGE_CAPTURE ([a-z-]+)", line)
        if match:
            subprocess.run(["xcrun", "simctl", "io", device["udid"], "screenshot", str(shots / (match[1] + ".png"))], check=True)
        elif "error:" in line or "** TEST" in line:
            print(line.strip(), flush=True)
    sys.exit(process.wait())
