import XCTest

final class AuroraChatPhotoScreensTests: XCTestCase {
    @MainActor func testPhotoPickerAttachmentQueuesWithMessage() {
        continueAfterFailure = false
        let app = XCUIApplication()
        app.launchArguments = ["-demo", "-project", "trantor"]
        app.launch()
        defer { app.terminate() }
        let attach = app.buttons["chat.attach"]
        XCTAssertTrue(attach.waitForExistence(timeout: 10))
        attach.tap()
        let photo = app.images.matching(NSPredicate(format: "label BEGINSWITH %@", "Photo,")).firstMatch
        XCTAssertTrue(photo.waitForExistence(timeout: 10), "The drill simulator must contain a library photo")
        photo.tap()
        let pickerShot = XCTAttachment(screenshot: XCUIScreen.main.screenshot())
        pickerShot.name = "photo-picker-selection"
        pickerShot.lifetime = .keepAlways
        add(pickerShot)
        let addButton = app.buttons["Done"]
        XCTAssertTrue(addButton.waitForExistence(timeout: 5))
        addButton.tap()
        let remove = app.buttons["Remove photo.jpg"]
        XCTAssertTrue(remove.waitForExistence(timeout: 10))
        let composer = app.textFields["chat.composer"].exists ? app.textFields["chat.composer"] : app.textViews["chat.composer"]
        composer.tap()
        composer.typeText("Review this attached photo")
        XCTAssertTrue(app.buttons["chat.send"].isEnabled)
        app.buttons["chat.send"].tap()
        XCTAssertTrue(app.staticTexts["Queued"].waitForExistence(timeout: 5))
        XCTAssertFalse(remove.exists)
        let attachment = XCTAttachment(screenshot: XCUIScreen.main.screenshot())
        attachment.name = "aurora-photo-queued"
        attachment.lifetime = .keepAlways
        add(attachment)
    }
}
