import Foundation
import HubClient
import TrantorCore
import TrantorStore
import UserNotifications

/// Category and action identifiers. The hub's push payload sets `aps.category` to one of the
/// categories and carries `{"kind": "hold" | "proposal" | "gate", "id": <number>}` beside `aps`.
enum NotificationIDs {
    static let gateCategory = "GATE"
    static let gateVerified = "GATE_VERIFIED"
    static let gateFailed = "GATE_FAILED"
    static let holdCategory = "HOLD"
    static let proposalCategory = "PROPOSAL"
    static let holdGo = "HOLD_GO"
    static let holdNoGo = "HOLD_NOGO"
    static let proposalApprove = "PROPOSAL_APPROVE"
    static let proposalDeny = "PROPOSAL_DENY"
}

enum NotificationCommand: Equatable {
    case hold(id: Int, go: Bool)
    case proposal(id: Int, approve: Bool)
    case gate(id: Int, project: String, status: GateResolution)
    /// A plain tap: open the app on Decisions.
    case open
}

enum NotificationRouter {
    static func categories() -> Set<UNNotificationCategory> {
        let hold = UNNotificationCategory(
            identifier: NotificationIDs.holdCategory,
            actions: [
                UNNotificationAction(identifier: NotificationIDs.holdGo, title: "Go", options: [.authenticationRequired]),
                UNNotificationAction(identifier: NotificationIDs.holdNoGo, title: "No-go", options: [.authenticationRequired, .destructive]),
            ],
            intentIdentifiers: [], options: [])
        let proposal = UNNotificationCategory(
            identifier: NotificationIDs.proposalCategory,
            actions: [
                UNNotificationAction(identifier: NotificationIDs.proposalApprove, title: "Approve", options: [.authenticationRequired]),
                UNNotificationAction(identifier: NotificationIDs.proposalDeny, title: "Deny", options: [.authenticationRequired, .destructive]),
            ],
            intentIdentifiers: [], options: [])
        let gate = UNNotificationCategory(
            identifier: NotificationIDs.gateCategory,
            actions: [
                UNNotificationAction(identifier: NotificationIDs.gateVerified, title: "Verified", options: [.authenticationRequired]),
                UNNotificationAction(identifier: NotificationIDs.gateFailed, title: "Failed", options: [.authenticationRequired, .destructive]),
            ], intentIdentifiers: [], options: [])
        return [hold, proposal, gate]
    }

    static func command(actionIdentifier: String, userInfo: [AnyHashable: Any]) -> NotificationCommand? {
        let id = (userInfo["id"] as? Int) ?? (userInfo["id"] as? String).flatMap(Int.init)
        switch actionIdentifier {
        case NotificationIDs.holdGo: return id.map { .hold(id: $0, go: true) }
        case NotificationIDs.holdNoGo: return id.map { .hold(id: $0, go: false) }
        case NotificationIDs.proposalApprove: return id.map { .proposal(id: $0, approve: true) }
        case NotificationIDs.proposalDeny: return id.map { .proposal(id: $0, approve: false) }
        case NotificationIDs.gateVerified, NotificationIDs.gateFailed:
            guard let id, let project = userInfo["project"] as? String, !project.isEmpty else { return nil }
            return .gate(id: id, project: project,
                         status: actionIdentifier == NotificationIDs.gateVerified ? .verified : .failed)
        case UNNotificationDefaultActionIdentifier: return .open
        default: return nil
        }
    }
}

/// Receives notification taps and action buttons. Actions call the same non-optimistic decide
/// methods the Decisions screen uses.
final class NotificationCoordinator: NSObject, UNUserNotificationCenterDelegate, @unchecked Sendable {
    @MainActor weak var model: AppModel?

    @MainActor func install() {
        let center = UNUserNotificationCenter.current()
        center.delegate = self
        center.setNotificationCategories(NotificationRouter.categories())
    }

    func userNotificationCenter(_ center: UNUserNotificationCenter, willPresent notification: UNNotification) async -> UNNotificationPresentationOptions {
        [.banner, .sound, .list]
    }

    func userNotificationCenter(_ center: UNUserNotificationCenter, didReceive response: UNNotificationResponse) async {
        let command = NotificationRouter.command(actionIdentifier: response.actionIdentifier,
                                                 userInfo: response.notification.request.content.userInfo)
        guard let command else { return }
        await handle(command)
    }

    @MainActor func handle(_ command: NotificationCommand) async {
        guard let model else { return }
        switch command {
        case .open:
            model.selection = .decisions
        case .hold(let id, let go):
            await model.decisions.decideHold(Hold(id: id), go: go)
        case .gate(let id, let project, let status):
            await model.decisions.resolveGate(VerifyGate(id: id, project: project), as: status)
        case .proposal(let id, let approve):
            await model.decisions.decideProposal(Proposal(id: id), approve: approve)
        }
    }
}

struct NotificationClear: Equatable {
    let kind: String
    let id: Int

    init?(userInfo: [AnyHashable: Any]) {
        guard let aps = userInfo["aps"] as? [String: Any],
              aps["content-available"] as? Int == 1,
              let kind = userInfo["kind"] as? String, !kind.isEmpty,
              let id = Self.itemID(userInfo) else { return nil }
        self.kind = kind; self.id = id
    }

    func matches(_ userInfo: [AnyHashable: Any]) -> Bool {
        userInfo["kind"] as? String == kind && Self.itemID(userInfo) == id
    }

    private static func itemID(_ userInfo: [AnyHashable: Any]) -> Int? {
        (userInfo["id"] as? Int) ?? (userInfo["id"] as? String).flatMap(Int.init)
    }
}
