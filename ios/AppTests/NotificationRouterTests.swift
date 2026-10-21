import UserNotifications
import XCTest
@testable import Trantor

final class NotificationRouterTests: XCTestCase {
    func testCategoriesCarryTheRightButtons() {
        let cats = Dictionary(uniqueKeysWithValues: NotificationRouter.categories().map { ($0.identifier, $0) })
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

    func testMissingIdOrUnknownActionDoesNothing() {
        XCTAssertNil(NotificationRouter.command(actionIdentifier: "HOLD_GO", userInfo: [:]))
        XCTAssertNil(NotificationRouter.command(actionIdentifier: "SOMETHING_ELSE", userInfo: ["id": 1]))
    }

    func testRegistrationUploadIsOffUntilTheHubRouteExists() {
        XCTAssertFalse(PushRegistrar.hubSupportsDeviceRegistration)
    }
}
