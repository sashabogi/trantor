import XCTest

// Needs run-duo-drill.py --half-fold: scrolling screens span the fold, Reply clears it (#12347).
final class DuoHalfFoldTests: XCTestCase {
    @MainActor func testScreensSpanTheFoldAndReplyClearsIt() {
        continueAfterFailure = false
        let app = XCUIApplication()
        defer { app.terminate() }
        for landscape in [true, false] {
            launch(app, tab: "feed", landscape: landscape)
            let headline = app.staticTexts.matching(NSPredicate(format: "label CONTAINS %@", "events")).firstMatch
            XCTAssertTrue(headline.waitForExistence(timeout: 10))
            let full = app.windows.firstMatch.frame
            if landscape {
                XCTAssertLessThan(headline.frame.minX, full.width * 0.25, "Feed must not move right of the fold")
            } else {
                XCTAssertLessThan(headline.frame.minY, full.height * 0.4, "Feed must not move below the fold")
            }
            app.terminate()

            launch(app, tab: "inbox", landscape: landscape)
            let thread = app.buttons.matching(NSPredicate(format: "label CONTAINS %@", "Want me to take the QR scanner next?")).firstMatch
            XCTAssertTrue(thread.waitForExistence(timeout: 10))
            thread.tap()
            let reply = app.textViews["thread.reply"].exists ? app.textViews["thread.reply"] : app.textFields["thread.reply"]
            XCTAssertTrue(reply.waitForExistence(timeout: 5))
            if landscape { XCTAssertGreaterThanOrEqual(reply.frame.minX, full.midX, "Reply belongs right of the fold") }
            XCTAssertTrue(app.buttons["Send"].isHittable)
            app.terminate()
        }
    }

    @MainActor private func launch(_ app: XCUIApplication, tab: String, landscape: Bool) {
        app.launchArguments = ["-demo", "-tab", tab]
        app.launch()
        for _ in 0..<4 {
            let frame = app.windows.firstMatch.frame
            if (frame.width > frame.height) == landscape { break }
            print("DUO_ROTATE")
            Thread.sleep(forTimeInterval: 3)
        }
    }
}
