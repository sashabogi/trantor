#!/usr/bin/env python3
"""Run the question-answering tests on the iPad simulator."""
import json
from pathlib import Path
import subprocess
import sys

ROOT = Path(__file__).resolve().parents[4]
OUT = ROOT / ".agent-bus-out/12138"
OUT.mkdir(parents=True, exist_ok=True)
DEVICE = "D46A687C-C315-4307-8150-4BC1E9F3E2E1"
packages = {name: {"path": str(ROOT / "ios/Packages" / name)}
            for name in ["TrantorCore", "HubClient", "TrantorStore", "Features", "TrantorDesign"]}
spec = {
    "name": "AnswerDrill",
    "options": {"deploymentTarget": {"iOS": "17.0"}},
    "packages": packages,
    "settings": {"base": {"SWIFT_VERSION": "5.0", "SWIFT_STRICT_CONCURRENCY": "complete", "CODE_SIGNING_ALLOWED": "NO"}},
    "targets": {
        "AnswerApp": {
            "type": "application", "platform": "iOS",
            "sources": [{"path": str(ROOT / "ios/App"), "excludes": ["Info.plist", "TrantorCompanion.entitlements"]}],
            "dependencies": [{"package": name} for name in packages],
            "settings": {"base": {
                "PRODUCT_BUNDLE_IDENTIFIER": "ai.trantor.answer-drill", "PRODUCT_NAME": "AnswerApp", "PRODUCT_MODULE_NAME": "Trantor",
                "TARGETED_DEVICE_FAMILY": "2", "INFOPLIST_FILE": str(ROOT / "ios/App/Info.plist"),
                "GENERATE_INFOPLIST_FILE": "NO", "ASSETCATALOG_COMPILER_APPICON_NAME": "AppIcon",
            }},
        },
        "AnswerUnitTests": {
            "type": "bundle.unit-test", "platform": "iOS",
            "sources": [str(ROOT / "ios/AppTests/NotificationRouterTests.swift"),
                        str(ROOT / "ios/Packages/TrantorStore/Tests/TrantorStoreTests/ChatAnswerTests.swift"),
                        str(ROOT / "ios/Packages/TrantorCore/Tests/TrantorCoreTests/ChatDecodingTests.swift"),
                        str(ROOT / "ios/Packages/HubClient/Tests/HubClientTests/ChatTransportTests.swift"),
                        str(ROOT / "ios/Packages/TrantorStore/Tests/TrantorStoreTests/ChatStoreTests.swift"),
                        str(ROOT / "ios/Packages/Features/Tests/FeaturesTests/DemoChatTests.swift")],
            "dependencies": [{"target": "AnswerApp"}] + [{"package": name} for name in packages],
            "settings": {"base": {"GENERATE_INFOPLIST_FILE": "YES", "PRODUCT_BUNDLE_IDENTIFIER": "ai.trantor.answer-unit"}},
        },
        "AnswerUITests": {
            "type": "bundle.ui-testing", "platform": "iOS",
            "sources": [str(Path(__file__).parent / "FeaturesUITests/ChatScreensTests.swift"),
                        str(Path(__file__).parent / "FeaturesUITests/ChatAnswerScreensTests.swift")],
            "dependencies": [{"target": "AnswerApp"}],
            "settings": {"base": {
                "PRODUCT_BUNDLE_IDENTIFIER": "ai.trantor.answer-ui", "GENERATE_INFOPLIST_FILE": "YES",
                "TEST_TARGET_NAME": "AnswerApp",
            }},
        },
    },
    "schemes": {"AnswerDrill": {
        "build": {"targets": {"AnswerApp": "all", "AnswerUnitTests": "test", "AnswerUITests": "test"}},
        "test": {"targets": ["AnswerUnitTests", "AnswerUITests"]},
    }},
}
project = OUT / "test-project.json"
project.write_text(json.dumps(spec, indent=2))
subprocess.run(["xcodegen", "generate", "--spec", str(project)], check=True, cwd=ROOT)
command = ["xcodebuild", "-project", str(OUT / "AnswerDrill.xcodeproj"), "-scheme", "AnswerDrill",
           "-destination", f"platform=iOS Simulator,id={DEVICE}", "-derivedDataPath", str(OUT / "TestDerivedData"),
           "-parallel-testing-enabled", "NO", "CODE_SIGNING_ALLOWED=NO", "test"] + sys.argv[1:]
with (OUT / "tests.log").open("w") as log:
    result = subprocess.run(command, cwd=ROOT, stdout=log, stderr=subprocess.STDOUT)
print(f"Answer tests exit {result.returncode}; log: {OUT / 'tests.log'}")
raise SystemExit(result.returncode)
