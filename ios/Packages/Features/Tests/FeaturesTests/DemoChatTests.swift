import SwiftUI
import XCTest
import TrantorStore
@testable import Features

@MainActor
final class DemoChatTests: XCTestCase {
    func testDemoChatIsBoundAndCanSendAfterRefresh() async {
        let model = DemoData.model()
        let store = model.chat(project: "trantor")
        await store.refresh()
        XCTAssertEqual(store.turns.count, 4)
        XCTAssertNil(store.disabledReason)
        let sent = await store.send("Continue the demo")
        XCTAssertTrue(sent)
        XCTAssertEqual(store.outgoing.last?.delivery, .queued)
    }

    func testProjectViewLoadsDemoChatWhenPresentedBeforeSceneActivates() async throws {
        let model = DemoData.model()
        let view = ProjectView(project: "trantor")
            .environment(model)
            .environment(\.scenePhase, .inactive)
        let host = UIHostingController(rootView: view)
        let window = UIWindow(frame: UIScreen.main.bounds)
        window.rootViewController = host
        window.makeKeyAndVisible()
        defer { window.isHidden = true; window.rootViewController = nil }

        let store = model.chat(project: "trantor")
        for _ in 0..<100 where !store.hasLiveSnapshot {
            try await Task.sleep(for: .milliseconds(20))
        }
        XCTAssertEqual(store.turns.count, 4)
        XCTAssertNil(store.disabledReason)
        let sent = await store.send("Continue from ProjectView")
        XCTAssertTrue(sent)
        XCTAssertEqual(store.outgoing.last?.delivery, .queued)
    }
}
