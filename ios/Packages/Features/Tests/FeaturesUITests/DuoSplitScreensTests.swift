import XCTest

final class DuoSplitScreensTests: XCTestCase {
    @MainActor func testProjectPosesKeepChatBesideCrewAndBoard() {
        capturePoses(screen: "project", arguments: ["-project", "trantor"], composer: "chat.composer", send: "chat.send") { app in
            XCTAssertTrue(app.buttons["crew.add"].waitForExistence(timeout: 10), "Use the open Duo display")
            app.buttons["Board"].tap()
            XCTAssertTrue(app.buttons.matching(NSPredicate(format: "label CONTAINS %@", "iOS companion: the full build")).firstMatch.waitForExistence(timeout: 5))
            XCTAssertTrue(app.buttons["chat.send"].exists)
            app.buttons["Crew"].tap()
            XCTAssertTrue(app.buttons["crew.add"].waitForExistence(timeout: 5))
        }
    }

    @MainActor func testDecisionsPosesKeepQueueBesideSelectedActions() {
        capturePoses(screen: "decisions", arguments: ["-tab", "decisions"], composer: "decision.note", send: nil) { app in
            let gate = app.buttons.matching(NSPredicate(format: "identifier BEGINSWITH %@", "decisions.select.gate-")).firstMatch
            XCTAssertTrue(gate.waitForExistence(timeout: 10), "Use the open Duo display")
            gate.tap()
            XCTAssertTrue(app.buttons["Verified"].waitForExistence(timeout: 5))
        }
    }

    @MainActor func testFleetPosesKeepSessionsBesideSeatMessage() {
        capturePoses(screen: "fleet", arguments: ["-tab", "fleet"], composer: "fleet.composer", send: "fleet.send") { app in
            let seats = app.buttons.matching(NSPredicate(format: "identifier BEGINSWITH %@", "fleet.select."))
            XCTAssertTrue(seats.firstMatch.waitForExistence(timeout: 10), "Use the open Duo display")
            if seats.count > 1 { seats.element(boundBy: 1).tap() }
        }
    }

    @MainActor private func capturePoses(screen: String, arguments: [String], composer: String, send: String?, prepare: (XCUIApplication) -> Void) {
        continueAfterFailure = false
        let app = XCUIApplication()
        defer { app.terminate(); XCUIDevice.shared.orientation = .portrait }
        for landscape in [true, false] {
            XCUIDevice.shared.orientation = landscape ? .landscapeLeft : .portrait
            app.launchArguments = ["-demo"] + arguments
            app.launch()
            prepare(app)
            let field = app.textViews[composer].exists ? app.textViews[composer] : app.textFields[composer]
            XCTAssertTrue(field.waitForExistence(timeout: 5))
            let pose = landscape ? "landscape" : "portrait"
            capture("\(screen)-\(pose)")
            let full = app.windows.firstMatch.frame
            if landscape {
                XCTAssertGreaterThan(full.width, full.height)
                XCTAssertGreaterThan(field.frame.midX, full.midX, "The interactive pane belongs right of the fold")
            } else {
                XCTAssertLessThan(full.width, full.height)
                XCTAssertGreaterThan(field.frame.midY, full.midY, "The interactive pane belongs below the fold")
            }
            field.tap()
            field.typeText("Review this layout")
            XCTAssertTrue(app.keyboards.firstMatch.waitForExistence(timeout: 5))
            XCTAssertLessThanOrEqual(field.frame.maxY, app.keyboards.firstMatch.frame.minY + 1)
            if let send {
                XCTAssertTrue(app.buttons[send].isHittable)
                XCTAssertLessThanOrEqual(app.buttons[send].frame.maxY, app.keyboards.firstMatch.frame.minY + 1)
            }
            capture("\(screen)-\(pose)-keyboard")
            app.terminate()
        }
    }

    @MainActor private func capture(_ name: String) {
        let attachment = XCTAttachment(screenshot: XCUIScreen.main.screenshot())
        attachment.name = name
        attachment.lifetime = .keepAlways
        add(attachment)
    }
}
