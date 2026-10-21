import XCTest

final class ChatScreensTests: XCTestCase {
    @MainActor func testProjectDefaultsToChatAndCanQueueMessageThenOpenBoard() {
        let app = XCUIApplication()
        app.launchArguments = ["-demo", "-tab", "projects"]
        app.launch()
        let project = app.buttons.matching(NSPredicate(format: "label BEGINSWITH %@", "trantor")).firstMatch
        XCTAssertTrue(project.waitForExistence(timeout: 10))
        project.tap()
        let composer = app.textFields["chat.composer"].exists ? app.textFields["chat.composer"] : app.textViews["chat.composer"]
        XCTAssertTrue(composer.waitForExistence(timeout: 8))
        XCTAssertTrue(app.staticTexts["Context 21%"].exists)
        XCTAssertTrue(app.staticTexts["Answer it on the Mac"].exists)
        XCTAssertFalse(app.buttons["chat.send"].isEnabled)
        capture("project-chat")
        composer.tap()
        composer.typeText("Please continue with the chat drill")
        XCTAssertTrue(app.buttons["chat.send"].isEnabled)
        app.buttons["chat.send"].tap()
        XCTAssertTrue(app.staticTexts["Queued"].waitForExistence(timeout: 5))
        capture("prompt-queued")
        app.buttons["chat.hide-keyboard"].tap()
        app.buttons["Board"].tap()
        XCTAssertTrue(app.buttons.matching(NSPredicate(format: "label CONTAINS %@", "iOS companion: the full build")).firstMatch.waitForExistence(timeout: 8))
        app.terminate()
    }

    @MainActor func testNoRelayDisablesComposerWithReason() {
        let app = XCUIApplication()
        app.launchArguments = ["-demo", "-tab", "projects"]
        app.launch()
        let project = app.buttons.matching(NSPredicate(format: "label BEGINSWITH %@", "ibkr")).firstMatch
        XCTAssertTrue(project.waitForExistence(timeout: 10))
        project.tap()
        XCTAssertTrue(app.staticTexts["No Mac is relaying this project. Open Trantor on your Mac."].waitForExistence(timeout: 8))
        XCTAssertFalse(app.buttons["chat.send"].isEnabled)
        app.terminate()
    }

    @MainActor private func capture(_ name: String) {
        let attachment = XCTAttachment(screenshot: XCUIScreen.main.screenshot())
        attachment.name = name; attachment.lifetime = .keepAlways
        add(attachment)
    }
}
