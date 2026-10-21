#!/usr/bin/env python3
"""Run only onboarding's package and UI tests on the iPad simulator."""
import json
from pathlib import Path
import subprocess

ROOT = Path(__file__).resolve().parents[4]
OUT = ROOT / ".agent-bus-out/12131"
OUT.mkdir(parents=True, exist_ok=True)
DEVICE = "D46A687C-C315-4307-8150-4BC1E9F3E2E1"
packages = {name: {"path": str(ROOT / "ios/Packages" / name)}
            for name in ["TrantorCore", "HubClient", "TrantorStore", "Features", "TrantorDesign"]}
spec = {
    "name": "OnboardingDrill",
    "options": {"deploymentTarget": {"iOS": "17.0"}},
    "packages": packages,
    "settings": {"base": {"SWIFT_VERSION": "5.0", "SWIFT_STRICT_CONCURRENCY": "complete", "CODE_SIGNING_ALLOWED": "NO"}},
    "targets": {
        "OnboardingApp": {
            "type": "application", "platform": "iOS",
            "sources": [{"path": str(ROOT / "ios/App"), "excludes": ["Info.plist", "TrantorCompanion.entitlements"]}],
            "dependencies": [{"package": name} for name in packages],
            "settings": {"base": {
                "PRODUCT_BUNDLE_IDENTIFIER": "ai.trantor.onboarding-drill", "PRODUCT_NAME": "OnboardingApp",
                "TARGETED_DEVICE_FAMILY": "2", "INFOPLIST_FILE": str(ROOT / "ios/App/Info.plist"),
                "GENERATE_INFOPLIST_FILE": "NO", "ASSETCATALOG_COMPILER_APPICON_NAME": "AppIcon",
            }},
        },
        "OnboardingUnitTests": {
            "type": "bundle.unit-test", "platform": "iOS",
            "sources": [str(Path(__file__).parent / "FeaturesTests/OnboardingTests.swift")],
            "dependencies": [{"target": "OnboardingApp"}] + [{"package": name} for name in packages],
            "settings": {"base": {"GENERATE_INFOPLIST_FILE": "YES", "PRODUCT_BUNDLE_IDENTIFIER": "ai.trantor.onboarding-unit"}},
        },
        "OnboardingUITests": {
            "type": "bundle.ui-testing", "platform": "iOS",
            "sources": [str(Path(__file__).parent / "FeaturesUITests/OnboardingScreensTests.swift")],
            "dependencies": [{"target": "OnboardingApp"}],
            "settings": {"base": {
                "PRODUCT_BUNDLE_IDENTIFIER": "ai.trantor.onboarding-ui", "GENERATE_INFOPLIST_FILE": "YES",
                "TEST_TARGET_NAME": "OnboardingApp",
            }},
        },
    },
    "schemes": {"OnboardingDrill": {
        "build": {"targets": {"OnboardingApp": "all", "OnboardingUnitTests": "test", "OnboardingUITests": "test"}},
        "test": {"targets": ["OnboardingUnitTests", "OnboardingUITests"]},
    }},
}
project = OUT / "test-project.json"
project.write_text(json.dumps(spec, indent=2))
subprocess.run(["xcodegen", "generate", "--spec", str(project)], check=True, cwd=ROOT)
command = ["xcodebuild", "-project", str(OUT / "OnboardingDrill.xcodeproj"), "-scheme", "OnboardingDrill",
           "-destination", f"platform=iOS Simulator,id={DEVICE}", "-derivedDataPath", str(OUT / "TestDerivedData"),
           "-parallel-testing-enabled", "NO", "CODE_SIGNING_ALLOWED=NO", "test"]
with (OUT / "tests.log").open("w") as log:
    result = subprocess.run(command, cwd=ROOT, stdout=log, stderr=subprocess.STDOUT)
print(f"Onboarding tests exit {result.returncode}; log: {OUT / 'tests.log'}")
raise SystemExit(result.returncode)
