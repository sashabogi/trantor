import HubClient
import SwiftUI
import TrantorCore
import TrantorStore

/// Stub hub data for SwiftUI previews.
@MainActor
enum PreviewData {
    static func hub() -> StubHub {
        let hub = StubHub()
        hub.holdsData = [Hold(id: 1, project: "trantor", file: "hub.mjs", session: "kimi:trantor", other: "codex:trantor", status: "pending", ts: 1_760_000_000_000)]
        hub.gatesData = [VerifyGate(id: 2, project: "crm", claim: "Signing matches the hub", why: "401s at runtime otherwise", howToVerify: "Run verify-vector.mjs", ts: 1_760_000_100_000)]
        hub.proposalsData = [Proposal(id: 3, session: "glm:trantor", project: "trantor", scope: "Reap orphaned panes", condition: "Idle over 1h", exclusions: "Live seats", ts: 1_760_000_200_000)]
        hub.inboxData = [BusMessage(id: 4, ts: 1_760_000_300_000, from: "claude:trantor", to: "ios-preview", text: "Ship the release?", project: "trantor", kind: "ask")]
        hub.projectsData = [Project(project: "trantor", brief: "The bus", phase: "building: ios scaffold", counts: ["doing": 2, "done": 40, "blocked": 1])]
        hub.cardsData = [Card(id: 12079, project: "trantor", title: "iOS companion", status: "doing", assignee: "claude:trantor", checklist: [ChecklistItem(text: "Builds", done: true), ChecklistItem(text: "Drilled")]),
                         Card(id: 12080, project: "trantor", title: "Push", status: "todo")]
        hub.peersData = [Peer(session: "claude:trantor", online: true, status: "working", project: "trantor", model: "opus", kind: "claude"),
                         Peer(session: "codex:trantor", online: false, project: "trantor", llm: "codex")]
        hub.balancesData = [BalanceEntry(provider: "deepseek", label: "DeepSeek", remaining: 3.2, low: true), BalanceEntry(provider: "glm", label: "GLM", kind: "subscription", plan: "max")]
        hub.eventsData = [HubEvent(id: 1, ts: 1_760_000_000_000, type: "card.moved", project: "trantor", by: "codex", taskId: 12079, payload: .object(["title": .string("iOS companion")])),
                          HubEvent(id: 2, ts: 1_760_000_050_000, type: "message", project: "trantor", by: "kimi", payload: .object(["text": .string("done with the models")]))]
        return hub
    }

    static func model() -> AppModel {
        let m = AppModel(stub: hub())
        Task {
            await m.refreshAll()
            await m.board.load(project: "trantor")
        }
        return m
    }
}

#Preview("Root, phone") { RootView().environment(PreviewData.model()) }
#Preview("Pairing") { NavigationStack { PairingView() }.environment(AppModel(settings: SettingsStore(keyStore: InMemoryKeyStore()))) }
#Preview("Board") { NavigationStack { BoardView(project: "trantor") }.environment(PreviewData.model()) }
#Preview("Fleet") { NavigationStack { FleetView() }.environment(PreviewData.model()) }
