import UserNotifications
import HubClient
import TrantorCore
import TrantorStore
import XCTest
@testable import Trantor

final class NotificationRouterTests: XCTestCase {
    func testCategoriesCarryTheRightButtons() {
        let cats = Dictionary(uniqueKeysWithValues: NotificationRouter.categories().map { ($0.identifier, $0) })
        XCTAssertEqual(cats["GATE"]?.actions.map(\.title), ["Verified", "Failed"])
        for category in cats.values {
            XCTAssertTrue(category.actions.allSatisfy { $0.options.contains(.authenticationRequired) })
        }
        XCTAssertEqual(cats["HOLD"]?.actions.map(\.title), ["Go", "No-go"])
        XCTAssertEqual(cats["PROPOSAL"]?.actions.map(\.title), ["Approve", "Deny"])
    }

    func testActionsMapToDecisions() {
        let info: [AnyHashable: Any] = ["kind": "hold", "id": 7]
        XCTAssertEqual(NotificationRouter.command(actionIdentifier: "HOLD_GO", userInfo: info), .hold(id: 7, go: true))
        XCTAssertEqual(NotificationRouter.command(actionIdentifier: "HOLD_NOGO", userInfo: info), .hold(id: 7, go: false))
        XCTAssertEqual(NotificationRouter.command(actionIdentifier: "PROPOSAL_APPROVE", userInfo: ["id": "12"]), .proposal(id: 12, approve: true))
        XCTAssertEqual(NotificationRouter.command(actionIdentifier: "PROPOSAL_DENY", userInfo: info), .proposal(id: 7, approve: false))
        XCTAssertEqual(NotificationRouter.command(actionIdentifier: UNNotificationDefaultActionIdentifier, userInfo: [:]), .open)
    }

    @MainActor func testAskTapOpensProjectChatAndTargetsQuestion() async {
        let info: [AnyHashable: Any] = ["kind": "ask", "project": "trantor", "toolId": "tool-7"]
        let command = NotificationRouter.command(actionIdentifier: UNNotificationDefaultActionIdentifier, userInfo: info)
        XCTAssertEqual(command, .ask(project: "trantor", toolId: "tool-7"))
        let model = AppModel(stub: StubHub())
        model.selection = .feed
        let coordinator = NotificationCoordinator()
        coordinator.model = model
        await coordinator.handle(command!)
        XCTAssertEqual(model.selection, .projects)
        XCTAssertEqual(model.openProject, "trantor")
        XCTAssertEqual(model.chat(project: "trantor").focusedToolID, "tool-7")
        XCTAssertNil(model.chat(project: "another").focusedToolID)
        for payload: [AnyHashable: Any] in [["kind": "ask"], ["kind": "ask", "project": "trantor"], ["kind": "ask", "project": "", "toolId": "tool-7"]] {
            XCTAssertNil(NotificationRouter.command(actionIdentifier: UNNotificationDefaultActionIdentifier, userInfo: payload))
        }
    }

    func testAskSilentClearMatchesProjectAndTool() throws {
        let clear = try XCTUnwrap(NotificationClear(userInfo: ["aps": ["content-available": 1], "kind": "ask", "project": "trantor", "toolId": "tool-7"]))
        XCTAssertTrue(clear.matches(["kind": "ask", "project": "trantor", "toolId": "tool-7"]))
        XCTAssertFalse(clear.matches(["kind": "ask", "project": "another", "toolId": "tool-7"]))
        XCTAssertFalse(clear.matches(["kind": "ask", "project": "trantor", "toolId": "tool-8"]))
        XCTAssertNil(NotificationClear(userInfo: ["aps": ["content-available": 1], "kind": "ask", "project": "trantor"]))
    }

    func testMissingIdOrUnknownActionDoesNothing() {
        XCTAssertNil(NotificationRouter.command(actionIdentifier: "HOLD_GO", userInfo: [:]))
        XCTAssertNil(NotificationRouter.command(actionIdentifier: "SOMETHING_ELSE", userInfo: ["id": 1]))
    }

    func testGateRoutingRequiresProjectAndPreservesResolution() {
        let info: [AnyHashable: Any] = ["kind": "gate", "id": 9, "project": "trantor"]
        XCTAssertEqual(NotificationRouter.command(actionIdentifier: "GATE_VERIFIED", userInfo: info),
                       .gate(id: 9, project: "trantor", status: .verified))
        XCTAssertEqual(NotificationRouter.command(actionIdentifier: "GATE_FAILED", userInfo: info),
                       .gate(id: 9, project: "trantor", status: .failed))
        XCTAssertNil(NotificationRouter.command(actionIdentifier: "GATE_VERIFIED", userInfo: ["id": 9]))
    }

    @MainActor func testGateCommandCallsResolveGate() async {
        let hub = StubHub()
        let model = AppModel(stub: hub, authenticator: ConfirmedAuthenticator())
        model.settings.requireBiometrics = true
        let coordinator = NotificationCoordinator()
        coordinator.model = model
        await coordinator.handle(.gate(id: 9, project: "trantor", status: .verified))
        await coordinator.handle(.gate(id: 10, project: "trantor", status: .failed))
        XCTAssertTrue(hub.calls.contains("resolveGate:9:verified"))
        XCTAssertTrue(hub.calls.contains("resolveGate:10:failed"))
    }

    func testSilentClearMatchesOnlyTheSameKindAndID() throws {
        let clear = try XCTUnwrap(NotificationClear(userInfo: ["aps": ["content-available": 1], "kind": "hold", "id": 7]))
        XCTAssertTrue(clear.matches(["kind": "hold", "id": 7]))
        XCTAssertTrue(clear.matches(["kind": "hold", "id": "7"]))
        XCTAssertFalse(clear.matches(["kind": "gate", "id": 7]))
        XCTAssertFalse(clear.matches(["kind": "hold", "id": 8]))
        XCTAssertFalse(clear.matches(["kind": "hold"]))
        XCTAssertNil(NotificationClear(userInfo: ["kind": "hold", "id": 7]))
        XCTAssertNil(NotificationClear(userInfo: ["aps": ["content-available": 0], "kind": "hold", "id": 7]))
        XCTAssertNil(NotificationClear(userInfo: ["aps": ["content-available": 1], "kind": "hold"]))
    }
}

private struct ConfirmedAuthenticator: Authenticator {
    func authenticate() async -> Bool { true }
}
