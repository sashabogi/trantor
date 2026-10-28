import SwiftUI
import UIKit
import XCTest
import TrantorCore
import TrantorDesign
import TrantorStore
@testable import Features

@MainActor
final class AuroraScreenCaptureTests: XCTestCase {
    func testClosedPhoneTabsInMintAndAmber() async throws {
        let scene = try XCTUnwrap(UIApplication.shared.connectedScenes.first as? UIWindowScene)
        XCTAssertLessThan(scene.screen.bounds.width, scene.screen.bounds.height, "Use the closed Duo display")
        XCTAssertEqual(scene.traitCollection.horizontalSizeClass, .compact, "Open-display captures do not satisfy this drill")
        for waiting in [false, true] {
            let hub = DemoData.hub()
            hub.holdsData = waiting ? [Hold(id: 1, project: "trantor", file: "Sources/Chat.swift", session: "codex-4:trantor",
                                           ts: Date().timeIntervalSince1970 * 1000 - 120_000)] : []
            hub.proposalsData = []
            hub.gatesData = []
            hub.inboxData = hub.inboxData.filter { !$0.isAsk }
            if var chat = hub.chatsData["trantor"] {
                chat.turns = chat.turns.filter { !$0.blocks.contains(where: \.isQuestion) }
                hub.chatsData["trantor"] = chat
            }
            let model = AppModel(stub: hub, identity: "ios-sasha", demo: true)
            await model.refreshAll()
            XCTAssertEqual(model.standingState().wash, waiting ? .waiting : .clear)
            for tab in AppSection.tabs {
                model.selection = tab
                try await capture(model, scene: scene, name: "\(waiting ? "amber" : "mint")-\(tab.rawValue)")
            }
            for section in ["chat", "board", "crew"] {
                model.selection = .projects
                model.openProject = "trantor"
                model.openProjectSection = section
                try await capture(model, scene: scene, name: "\(waiting ? "amber" : "mint")-project-\(section)")
                model.openProject = nil
            }
        }
    }

    func testFailedSeatMakesRedEvenWithWaitingDecision() async throws {
        let hub = DemoData.hub()
        hub.peersData.append(Peer(session: "failed-seat:trantor", status: "errored: authentication", project: "trantor", kind: "agent"))
        let model = AppModel(stub: hub, demo: true)
        await model.refreshAll()
        XCTAssertEqual(model.standingState().wash, .failed)
        model.selection = .fleet
        let scene = try XCTUnwrap(UIApplication.shared.connectedScenes.first as? UIWindowScene)
        try await capture(model, scene: scene, name: "red-fleet")
    }

    private func capture(_ model: AppModel, scene: UIWindowScene, name: String) async throws {
        let previous = scene.windows.first(where: \.isKeyWindow)
        let window = UIWindow(windowScene: scene)
        window.frame = scene.screen.bounds
        let host = UIHostingController(rootView: RootView().environment(model).trantorTheme())
        window.rootViewController = host
        window.makeKeyAndVisible()
        defer {
            window.isHidden = true
            window.rootViewController = nil
            previous?.makeKeyAndVisible()
        }
        try await Task.sleep(for: .seconds(2))
        window.layoutIfNeeded()
        let renderer = UIGraphicsImageRenderer(bounds: window.bounds)
        var rendered = false
        let shot = renderer.image { _ in rendered = window.drawHierarchy(in: window.bounds, afterScreenUpdates: true) }
        XCTAssertTrue(rendered, "The real window must render before capture")
        let attachment = XCTAttachment(image: shot)
        attachment.name = name
        attachment.lifetime = .keepAlways
        add(attachment)
    }
}
