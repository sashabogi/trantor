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
        defer { app.terminate() }
        for landscape in [true, false] {
            app.launchArguments = ["-demo"] + arguments
            app.launch()
            for _ in 0..<4 {
                let frame = app.windows.firstMatch.frame
                if (frame.width > frame.height) == landscape { break }
                print("DUO_ROTATE")
                Thread.sleep(forTimeInterval: 3)
            }
            prepare(app)
            let field = app.textViews[composer].exists ? app.textViews[composer] : app.textFields[composer]
            XCTAssertTrue(field.waitForExistence(timeout: 5))
            let pose = landscape ? "landscape" : "portrait"
            XCTAssertFalse(app.keyboards.firstMatch.exists, "The plain pose must have its keyboard hidden")
            capture("\(screen)-\(pose)")
            assertGroundReachesEdges(app, pose: pose)
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
            if screen == "project" && !landscape {
                let summary = app.otherElements["crew.summary"]
                XCTAssertTrue(summary.waitForExistence(timeout: 5))
                XCTAssertLessThanOrEqual(summary.frame.maxY, app.staticTexts["Context use"].frame.minY + 1,
                                         "Portrait typing keeps the crew strip above the chat")
            }
            app.terminate()
        }
    }

    // Black above or below the panes means the wash stopped at the split (#12300).
    @MainActor private func assertGroundReachesEdges(_ app: XCUIApplication, pose: String) {
        guard let image = app.windows.firstMatch.screenshot().image.cgImage else { return XCTFail("No screenshot") }
        for (edge, y) in [("top", 0.02), ("bottom", 0.985)] {
            var pixel = [UInt8](repeating: 0, count: 4)
            let context = CGContext(data: &pixel, width: 1, height: 1, bitsPerComponent: 8, bytesPerRow: 4,
                                    space: CGColorSpaceCreateDeviceRGB(), bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue)
            let sample = CGRect(x: CGFloat(image.width) * 0.1, y: CGFloat(image.height) * y, width: 1, height: 1)
            guard let dot = image.cropping(to: sample) else { return XCTFail("No \(edge) sample") }
            context?.draw(dot, in: CGRect(x: 0, y: 0, width: 1, height: 1))
            XCTAssertGreaterThan(pixel[0...2].max() ?? 0, 5, "\(pose) \(edge) edge is black")
        }
    }

    @MainActor private func capture(_ name: String) {
        // The open display is primary-1; XCUIScreen.main captures the inactive closed display.
        let acknowledgment = FileManager.default.temporaryDirectory.appendingPathComponent("duo-captured-\(name)")
        try? FileManager.default.removeItem(at: acknowledgment)
        print("DUO_CAPTURE \(name)")
        fflush(stdout)
        let deadline = Date().addingTimeInterval(30)
        while !FileManager.default.fileExists(atPath: acknowledgment.path) && Date() < deadline {
            Thread.sleep(forTimeInterval: 0.1)
        }
        XCTAssertTrue(FileManager.default.fileExists(atPath: acknowledgment.path), "The host must capture this pose before the UI advances")
    }
}
