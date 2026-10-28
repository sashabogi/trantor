import XCTest

final class ChatAnswerScreensTests: XCTestCase {
    @MainActor func testSingleChoiceSendsAndPreventsSecondTap() {
        let app = XCUIApplication()
        app.launchArguments = ["-demo", "-project", "trantor"]
        app.launch()
        defer { app.terminate() }
        let option = app.buttons["chat.ask.option.demo-project-question.0"]
        XCTAssertTrue(option.waitForExistence(timeout: 10))
        option.tap()
        let status = app.staticTexts["chat.ask.status.demo-project-question"]
        XCTAssertTrue(status.waitForExistence(timeout: 5))
        XCTAssertEqual(status.label, "Sending…")
        XCTAssertFalse(option.isEnabled)
        let attachment = XCTAttachment(screenshot: XCUIScreen.main.screenshot())
        attachment.name = "answer-sending"; attachment.lifetime = .keepAlways
        add(attachment)
    }

    @MainActor func testSomethingElseRequiresTextThenSends() {
        let app = XCUIApplication()
        app.launchArguments = ["-demo", "-project", "trantor"]
        app.launch()
        defer { app.terminate() }
        let other = app.buttons["chat.ask.other.demo-project-question"]
        XCTAssertTrue(other.waitForExistence(timeout: 10))
        other.tap()
        let send = app.buttons["chat.ask.submit.demo-project-question"]
        XCTAssertFalse(send.isEnabled)
        let fieldID = "chat.ask.field.demo-project-question"
        let field = app.textFields[fieldID].exists ? app.textFields[fieldID] : app.textViews[fieldID]
        XCTAssertTrue(field.waitForExistence(timeout: 5))
        field.tap(); field.typeText("Review the companion app")
        XCTAssertTrue(send.isEnabled)
        // Keyboard resizing moves this card; do not tap its pre-keyboard coordinates.
        let aboveKeyboard = NSPredicate { _, _ in
            !app.keyboards.firstMatch.exists || send.frame.maxY <= app.keyboards.firstMatch.frame.minY
        }
        expectation(for: aboveKeyboard, evaluatedWith: send)
        waitForExpectations(timeout: 5)
        send.tap()
        let answerShot = XCTAttachment(screenshot: XCUIScreen.main.screenshot())
        answerShot.name = "free-text-answer-after-send"
        answerShot.lifetime = .keepAlways
        add(answerShot)
        let status = app.staticTexts["chat.ask.status.demo-project-question"]
        XCTAssertTrue(status.waitForExistence(timeout: 5))
        XCTAssertEqual(status.label, "Sending…")
    }
}
