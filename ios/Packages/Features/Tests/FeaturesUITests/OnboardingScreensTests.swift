import XCTest

final class OnboardingScreensTests: XCTestCase {
    @MainActor func testWelcomePasteInvalidInviteAndRetryStayReachable() {
        let app = XCUIApplication()
        app.launch()
        let primary = app.buttons["onboarding.primary"]
        XCTAssertTrue(primary.waitForExistence(timeout: 10))
        XCTAssertTrue(app.staticTexts["Turn on Tailscale on this phone first."].exists)
        XCTAssertTrue(primary.isHittable)
        capture("welcome")
        primary.tap()
        XCTAssertTrue(app.staticTexts["Scan your invite"].waitForExistence(timeout: 5))
        primary.tap()
        let input = app.textFields["onboarding.invite"]
        XCTAssertTrue(input.waitForExistence(timeout: 5))
        input.tap()
        input.typeText("not-an-invite")
        XCTAssertTrue(primary.isHittable)
        primary.tap()
        XCTAssertTrue(app.staticTexts["That isn't a valid Trantor invite. Copy the full pairing link from your Mac."].exists)
        input.tap()
        input.typeText(String(repeating: XCUIKeyboardKey.delete.rawValue, count: "not-an-invite".count))
        input.typeText("trantor://enroll?hub=http%3A%2F%2F100.64.0.1%3A1&token=drill")
        primary.tap()
        XCTAssertTrue(app.staticTexts["Can't reach your hub. Turn on Tailscale, then Retry"].waitForExistence(timeout: 8))
        XCTAssertEqual(primary.label, "Retry")
        XCTAssertTrue(primary.isHittable)
        capture("connect-retry")
        primary.tap()
        XCTAssertTrue(app.staticTexts["Can't reach your hub. Turn on Tailscale, then Retry"].waitForExistence(timeout: 8))
        app.buttons["Back"].tap()
        XCTAssertTrue(input.waitForExistence(timeout: 5))
        app.terminate()
    }

    @MainActor func testDemoStillOpensDecisions() {
        let app = XCUIApplication()
        app.launchArguments = ["-demo"]
        app.launch()
        XCTAssertTrue(app.staticTexts.matching(NSPredicate(format: "label CONTAINS %@", "waiting on you")).firstMatch.waitForExistence(timeout: 10))
        XCTAssertFalse(app.buttons["onboarding.primary"].exists)
        app.terminate()
    }

    @MainActor private func capture(_ name: String) {
        let attachment = XCTAttachment(screenshot: XCUIScreen.main.screenshot())
        attachment.name = name
        attachment.lifetime = .keepAlways
        add(attachment)
    }
}
