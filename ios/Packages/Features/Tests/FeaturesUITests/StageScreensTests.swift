import XCTest

final class StageScreensTests: XCTestCase {
    @MainActor func testStageNavigationAndActions() throws {
        continueAfterFailure = false
        let app = XCUIApplication(bundleIdentifier: "ai.trantor.companion")
        app.launchArguments = ["-demo"]
        app.launch()
        XCTAssertTrue(app.staticTexts.matching(NSPredicate(format: "label CONTAINS %@", "waiting on you")).firstMatch.waitForExistence(timeout: 10))
        capture("decisions")

        if !app.buttons["Projects"].isHittable { app.buttons["Show Sidebar"].tap() }
        app.buttons["Projects"].tap()
        let project = app.buttons.matching(NSPredicate(format: "label CONTAINS %@", "building: iOS companion")).firstMatch
        XCTAssertTrue(project.waitForExistence(timeout: 5))
        capture("projects")
        project.tap()
        app.buttons["Board"].tap()
        let card = app.buttons.matching(NSPredicate(format: "label CONTAINS %@", "iOS companion: the full build")).firstMatch
        XCTAssertTrue(card.waitForExistence(timeout: 5))
        app.buttons["Doing"].tap()
        XCTAssertTrue(card.exists)
        XCTAssertFalse(app.buttons.matching(NSPredicate(format: "label CONTAINS %@", "Kill guard for runner suites")).firstMatch.exists)
        app.buttons["All"].tap()
        XCTAssertTrue(app.buttons.matching(NSPredicate(format: "label CONTAINS %@", "Kill guard for runner suites")).firstMatch.exists)
        capture("board")
        card.tap()
        XCTAssertTrue(app.buttons["Post note"].waitForExistence(timeout: 5))
        XCTAssertFalse(app.buttons["Post note"].isEnabled)
        XCTAssertTrue(app.buttons["Design system from ibkr, complete"].exists)
        app.buttons["Live hub run, incomplete"].tap()
        // StubHub records the write but returns the original card: keep the confirmed value.
        XCTAssertTrue(app.buttons["Live hub run, incomplete"].exists)
        capture("card-detail")

        app.buttons["Feed"].tap()
        XCTAssertTrue(app.staticTexts["hold.opened"].waitForExistence(timeout: 5))
        capture("feed")
        app.buttons["Holds"].tap()
        XCTAssertTrue(app.staticTexts["hold.opened"].exists)
        XCTAssertFalse(app.staticTexts["message"].exists)
        app.buttons["Messages"].tap()
        XCTAssertTrue(app.staticTexts["message"].exists)
        XCTAssertTrue(app.staticTexts["hold.opened"].exists)
        app.buttons["All"].tap()

        app.buttons.matching(NSPredicate(format: "label BEGINSWITH %@", "Inbox")).firstMatch.tap()
        let thread = app.buttons.matching(NSPredicate(format: "label CONTAINS %@", "Want me to take the QR scanner next?")).firstMatch
        XCTAssertTrue(thread.waitForExistence(timeout: 5))
        XCTAssertEqual(thread.value as? String, "Unread")
        capture("inbox")
        thread.tap()
        XCTAssertTrue(app.buttons["Send"].waitForExistence(timeout: 5))
        XCTAssertFalse(app.buttons["Send"].isEnabled)
        let reply = app.textViews.firstMatch.exists ? app.textViews.firstMatch : app.textFields.firstMatch
        reply.tap()
        reply.typeText("The stage screens are ready for review.")
        app.buttons["Send"].tap()
        XCTAssertTrue(app.staticTexts["The stage screens are ready for review."].waitForExistence(timeout: 5))
        app.swipeDown()   // the list dismisses the keyboard interactively; there is no keyboard toolbar
        capture("conversation")
        let back = app.buttons["BackButton"]
        XCTAssertTrue(back.waitForExistence(timeout: 5))
        back.tap()
        let readThread = app.buttons.matching(NSPredicate(format: "label CONTAINS %@", "The stage screens are ready for review.")).firstMatch
        XCTAssertEqual(readThread.value as? String, "Read")
        app.buttons["New"].tap()
        XCTAssertTrue(app.buttons["Send message"].waitForExistence(timeout: 5))
        XCTAssertFalse(app.buttons["Send message"].isEnabled)
        capture("compose")
        app.buttons["Cancel"].tap()

        app.buttons["Fleet"].tap()
        XCTAssertTrue(app.buttons["Seats"].waitForExistence(timeout: 5))
        capture("fleet")
        app.buttons.matching(NSPredicate(format: "label == %@", "Cost")).allElementsBoundByIndex.last?.tap()
        XCTAssertTrue(app.staticTexts["$3.21"].waitForExistence(timeout: 5))
        capture("fleet-cost")
        app.buttons["Seats"].tap()
        app.buttons.matching(identifier: "Cost").firstMatch.tap()
        XCTAssertTrue(app.staticTexts["$3.21"].waitForExistence(timeout: 5))
        capture("cost")

        app.buttons["Decisions"].tap()
        XCTAssertTrue(app.buttons["Settings"].waitForExistence(timeout: 5))
        app.buttons["Settings"].tap()
        XCTAssertTrue(app.switches["Holds"].waitForExistence(timeout: 5))
        capture("settings")
        app.terminate()
        app.launchArguments = []
        app.launch()
        XCTAssertTrue(app.buttons["onboarding.primary"].waitForExistence(timeout: 5))
        XCTAssertEqual(app.buttons["onboarding.primary"].label, "Get started")
        capture("pairing")
    }

    @MainActor private func capture(_ name: String) {
        let attachment = XCTAttachment(screenshot: XCUIScreen.main.screenshot())
        attachment.name = name
        attachment.lifetime = .keepAlways
        add(attachment)
        print("STAGE_CAPTURE \(name)")
        Thread.sleep(forTimeInterval: 3)
    }
}
