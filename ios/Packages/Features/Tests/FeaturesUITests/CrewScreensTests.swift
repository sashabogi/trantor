import XCTest

final class CrewScreensTests: XCTestCase {
    @MainActor private func openCrew() -> XCUIApplication {
        let app = XCUIApplication()
        app.launchArguments = ["-demo", "-project", "trantor"]
        app.launch()
        XCTAssertTrue(app.buttons["Crew"].waitForExistence(timeout: 10))
        app.buttons["Crew"].tap()
        XCTAssertTrue(app.buttons["crew.add"].waitForExistence(timeout: 5))
        return app
    }

    @MainActor func testAddSubscriptionSeatShowsResultAndStopRemovesSeat() {
        let app = openCrew()
        defer { app.terminate() }
        XCTAssertTrue(app.staticTexts["codex-4"].waitForExistence(timeout: 5))
        XCTAssertFalse(app.staticTexts["claude"].exists)
        app.buttons["crew.add"].tap()
        let glm = app.buttons["crew.roster.glm"]
        XCTAssertTrue(glm.waitForExistence(timeout: 5))
        XCTAssertFalse(app.buttons["crew.roster.deepseek"].isEnabled)
        glm.tap()
        app.buttons["crew.submit"].tap()
        XCTAssertFalse(app.alerts["This seat costs money per token"].exists)
        XCTAssertTrue(app.staticTexts["Done"].waitForExistence(timeout: 12))
        app.buttons["CLI output"].firstMatch.tap()
        XCTAssertTrue(app.textFields.matching(NSPredicate(format: "value CONTAINS %@", "Demo: crew command completed.")).firstMatch.exists ||
                      app.textViews.matching(NSPredicate(format: "value CONTAINS %@", "Demo: crew command completed.")).firstMatch.exists)
        capture("crew-command-done")
        let stop = app.buttons["crew.stop.glm"]
        for _ in 0..<5 where !stop.isHittable { app.swipeUp() }
        XCTAssertTrue(stop.isHittable)
        stop.tap()
        let removed = NSPredicate(format: "exists == false")
        expectation(for: removed, evaluatedWith: stop)
        waitForExpectations(timeout: 12)
    }

    @MainActor func testMeteredConfirmationAndSwapPickerAndStopCrewConfirmation() {
        let app = openCrew()
        defer { app.terminate() }
        XCTAssertTrue(app.buttons["crew.swap.codex-4"].waitForExistence(timeout: 5))
        app.buttons["crew.swap.codex-4"].tap()
        XCTAssertTrue(app.buttons["crew.roster.kimi"].waitForExistence(timeout: 5))
        app.buttons["crew.roster.kimi"].tap()
        app.buttons["crew.submit"].tap()
        let cost = app.alerts["This seat costs money per token"]
        XCTAssertTrue(cost.waitForExistence(timeout: 5))
        capture("crew-cost-confirm")
        cost.buttons["Cancel"].tap()
        XCTAssertTrue(app.buttons["crew.submit"].exists)
        app.buttons["crew.submit"].tap()
        cost.buttons["Confirm cost and continue"].tap()
        XCTAssertTrue(app.staticTexts["Done"].waitForExistence(timeout: 12))
        XCTAssertFalse(app.buttons["crew.swap.codex-4"].exists)
        app.buttons["crew.stopAll"].tap()
        let stop = app.alerts["Stop the crew?"]
        XCTAssertTrue(stop.waitForExistence(timeout: 5))
        stop.buttons["Stop the crew"].tap()
        XCTAssertTrue(app.staticTexts["No crew seats"].waitForExistence(timeout: 12))
    }

    @MainActor private func capture(_ name: String) {
        let attachment = XCTAttachment(screenshot: XCUIScreen.main.screenshot())
        attachment.name = name; attachment.lifetime = .keepAlways
        add(attachment)
    }
}
