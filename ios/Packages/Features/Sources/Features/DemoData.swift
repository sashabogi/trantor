import Foundation
import HubClient
import TrantorCore
import TrantorStore

/// A believable fleet for the `-demo` launch flag and screenshots: no hub, no pairing.
@MainActor
public enum DemoData {
    public static func model() -> AppModel {
        let m = AppModel(stub: hub(), identity: "ios-sasha", demo: true)
        Task {
            await m.refreshAll()
            await m.board.load(project: "trantor")
        }
        return m
    }

    static func ago(_ minutes: Double) -> Double { (Date().timeIntervalSince1970 - minutes * 60) * 1000 }

    static func hub() -> StubHub {
        let hub = StubHub()
        hub.holdsData = [
            Hold(id: 881, project: "trantor", file: "hub/events.mjs", session: "kimi-8:trantor", other: "codex-4:trantor", ts: ago(2)),
        ]
        hub.gatesData = [
            VerifyGate(id: 412, project: "trantor", claim: "Approver role decides holds and proposals, nothing else",
                       why: "A phone key must never hold owner", howToVerify: "test/hub/test-approver-role.mjs, 35 passed",
                       by: "codex-4:trantor", ts: ago(6)),
        ]
        hub.proposalsData = [
            Proposal(id: 77, session: "glm-4:trantor", project: "trantor", scope: "Add qrcode to desktop/package.json",
                     condition: "Pair-a-phone dialog only", exclusions: "No other dependency changes", ts: ago(11)),
        ]
        hub.inboxData = [
            BusMessage(id: 29701, ts: ago(1), from: "codex-4:trantor", to: "ios-sasha",
                       text: "#12113 is in testing at b821f32. Want me to take the QR scanner next?", project: "trantor", kind: "ask"),
            BusMessage(id: 29688, ts: ago(14), from: "claude:trantor-duty", to: "ios-sasha",
                       text: "crebral-health has been idle 3h with 2 cards in doing.", project: "crebral-health"),
            BusMessage(id: 29650, ts: ago(48), from: "kimi-8:trantor", to: "all",
                       text: "APNs notifier wired to appendEvent; JWT reuse at 50 minutes.", project: "trantor"),
        ]
        hub.projectsData = [
            Project(project: "trantor", brief: "Cross-agent bus, board and fleet", phase: "building: iOS companion",
                    lastActivity: ago(1), counts: ["doing": 3, "testing": 4, "todo": 25, "done": 156, "blocked": 1],
                    doingTitles: ["iOS companion, full build", "APNs notifier", "Pair a phone"],
                    agents: [ProjectAgent(session: "codex-4:trantor", online: true, status: "working", llm: "codex", model: "gpt-5.5"),
                             ProjectAgent(session: "kimi-8:trantor", online: true, status: "working", llm: "kimi", model: "k3"),
                             ProjectAgent(session: "glm-4:trantor", online: true, status: "idle", llm: "glm", model: "glm-5.3")]),
            Project(project: "ibkr", brief: "Trading desk on the IBKR API", phase: "testing: layouts",
                    lastActivity: ago(35), counts: ["doing": 1, "testing": 2, "todo": 9, "done": 212],
                    doingTitles: ["Timeframe integration"]),
            Project(project: "crebral-health", brief: "Clinical intake", phase: "idle", idle: true,
                    lastActivity: ago(190), counts: ["doing": 2, "todo": 6, "done": 88]),
            Project(project: "crebral-legal", brief: "Contract review", phase: "handoff pending",
                    lastActivity: ago(70), counts: ["doing": 1, "testing": 1, "done": 41, "blocked": 1]),
        ]
        hub.cardsData = [
            Card(id: 12079, project: "trantor", title: "iOS companion: the full build", status: "doing", assignee: "MacBook-Pro-M1:trantor",
                 difficulty: "hard", phase: "building", updated: ago(1),
                 checklist: [ChecklistItem(text: "Design system from ibkr", done: true), ChecklistItem(text: "Live hub run"), ChecklistItem(text: "TestFlight")]),
            Card(id: 12114, project: "trantor", title: "Hub push: device registry and APNs notifier", status: "doing", assignee: "kimi-8:trantor", difficulty: "hard", updated: ago(3)),
            Card(id: 12115, project: "trantor", title: "Pair a phone from the desktop app", status: "doing", assignee: "glm-4:trantor", difficulty: "easy", updated: ago(4)),
            Card(id: 12113, project: "trantor", title: "Approver role between write and owner", status: "testing", assignee: "codex-4:trantor", difficulty: "medium", updated: ago(5)),
            Card(id: 12112, project: "trantor", title: "Scope-filter /stream", status: "done", assignee: "MacBook-Pro-M1:trantor", updated: ago(60)),
            Card(id: 12109, project: "trantor", title: "Plan approval in chat", status: "todo", difficulty: "medium"),
            Card(id: 12110, project: "trantor", title: "Clickable file and command chips", status: "todo", difficulty: "easy"),
            Card(id: 11585, project: "trantor", title: "Kill guard for runner suites", status: "blocked", assignee: "codex:trantor", difficulty: "medium"),
        ]
        hub.peersData = [
            Peer(session: "MacBook-Pro-M1:trantor", online: true, status: "orchestrating", project: "trantor", model: "opus-5.5", kind: "claude", lastSeen: ago(0.2)),
            Peer(session: "codex-4:trantor", online: true, status: "working", project: "trantor", llm: "codex", model: "gpt-5.5", lastSeen: ago(0.5)),
            Peer(session: "kimi-8:trantor", online: true, status: "working", project: "trantor", llm: "kimi", model: "k3", lastSeen: ago(0.4)),
            Peer(session: "glm-4:trantor", online: true, status: "idle", project: "trantor", llm: "glm", model: "glm-5.3-flash", lastSeen: ago(1)),
            Peer(session: "claude:trantor-duty", online: true, status: "on duty", project: "trantor-duty", model: "sonnet-5.5", kind: "claude", lastSeen: ago(0.3)),
            Peer(session: "codex:ibkr", online: false, status: "stale", project: "ibkr", llm: "codex", lastSeen: ago(40)),
        ]
        hub.balancesData = [
            BalanceEntry(provider: "deepseek", label: "DeepSeek", kind: "api", remaining: 3.21, low: true),
            BalanceEntry(provider: "openrouter", label: "OpenRouter", kind: "api", remaining: 41.80),
            BalanceEntry(provider: "glm", label: "GLM", kind: "subscription", plan: "coding max", remainingPct: 72),
            BalanceEntry(provider: "kimi", label: "Kimi", kind: "subscription", plan: "coding", remainingPct: 54),
            BalanceEntry(provider: "codex", label: "Codex", kind: "subscription", plan: "plus", remainingPct: 88),
        ]
        hub.eventsData = [
            HubEvent(id: 9, ts: ago(0.5), type: "message", project: "trantor", by: "codex-4:trantor",
                     payload: .object(["text": .string("#12113 testing, 35 passed")])),
            HubEvent(id: 8, ts: ago(2), type: "hold.opened", project: "trantor", by: "kimi-8:trantor",
                     payload: .object(["file": .string("hub/events.mjs")])),
            HubEvent(id: 7, ts: ago(5), type: "moved", project: "trantor", by: "codex-4:trantor", taskId: 12113,
                     payload: .object(["title": .string("Approver role"), "to": .string("testing")])),
            HubEvent(id: 6, ts: ago(9), type: "presence.online", project: "trantor", by: "glm-4:trantor"),
            HubEvent(id: 5, ts: ago(22), type: "verify.gate.opened", project: "trantor", by: "codex-4:trantor",
                     payload: .object(["claim": .string("Approver role decides holds")])),
            HubEvent(id: 4, ts: ago(61), type: "moved", project: "trantor", by: "MacBook-Pro-M1:trantor", taskId: 12112,
                     payload: .object(["title": .string("Scope-filter /stream"), "to": .string("done")])),
        ]
        return hub
    }
}
