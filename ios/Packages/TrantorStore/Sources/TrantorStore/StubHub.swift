import Foundation
import HubClient
import TrantorCore

/// An in-memory hub for previews and tests. Reads return what you set; writes are recorded and
/// can be made to fail or to wait.
public final class StubHub: HubServing, @unchecked Sendable {
    private let lock = NSLock()

    private var _projects: [Project] = []
    private var _cards: [Card] = []
    private var _events: [HubEvent] = []
    private var _inbox: [BusMessage] = []
    private var _peers: [Peer] = []
    private var _holds: [Hold] = []
    private var _gates: [VerifyGate] = []
    private var _proposals: [Proposal] = []
    private var _balances: [BalanceEntry] = []
    private var _calls: [String] = []
    private var _writeError: HubError?
    private var _readError: HubError?
    private var _outcome: OpOutcome?
    private var _gate: CheckedContinuation<Void, Never>?
    private var _holdWrites = false

    public init() {}

    private func locked<T>(_ body: () -> T) -> T { lock.lock(); defer { lock.unlock() }; return body() }

    public var projectsData: [Project] { get { locked { _projects } } set { locked { _projects = newValue } } }
    public var cardsData: [Card] { get { locked { _cards } } set { locked { _cards = newValue } } }
    public var eventsData: [HubEvent] { get { locked { _events } } set { locked { _events = newValue } } }
    public var inboxData: [BusMessage] { get { locked { _inbox } } set { locked { _inbox = newValue } } }
    public var peersData: [Peer] { get { locked { _peers } } set { locked { _peers = newValue } } }
    public var holdsData: [Hold] { get { locked { _holds } } set { locked { _holds = newValue } } }
    public var gatesData: [VerifyGate] { get { locked { _gates } } set { locked { _gates = newValue } } }
    public var proposalsData: [Proposal] { get { locked { _proposals } } set { locked { _proposals = newValue } } }
    public var balancesData: [BalanceEntry] { get { locked { _balances } } set { locked { _balances = newValue } } }
    public var calls: [String] { locked { _calls } }
    /// Thrown by every write until cleared.
    public var writeError: HubError? { get { locked { _writeError } } set { locked { _writeError = newValue } } }
    public var readError: HubError? { get { locked { _readError } } set { locked { _readError = newValue } } }
    /// What `reconcile(op:)` answers.
    public var outcome: OpOutcome? { get { locked { _outcome } } set { locked { _outcome = newValue } } }

    /// Make writes wait until `releaseWrites()`, so a test can observe the pending state.
    public func holdWrites() { locked { _holdWrites = true } }
    public func releaseWrites() {
        let c: CheckedContinuation<Void, Never>? = locked { _holdWrites = false; let c = _gate; _gate = nil; return c }
        c?.resume()
    }

    private func record(_ s: String) { locked { _calls.append(s) } }

    private func read<T>(_ name: String, _ value: @autoclosure () -> T) async throws -> T {
        record(name)
        if let e = readError { throw e }
        return value()
    }

    private func write(_ name: String) async throws {
        record(name)
        if locked({ _holdWrites }) {
            await withCheckedContinuation { c in
                let resumeNow: Bool = locked { if _holdWrites { _gate = c; return false } else { return true } }
                if resumeNow { c.resume() }
            }
        }
        if let e = writeError { throw e }
    }

    public func health() async throws -> HealthInfo { try await read("health", HealthInfo(ok: true, authMode: "enforce", peers: 3, messages: 10)) }
    public func enroll(token: String, name: String) async throws -> EnrollResult {
        try await write("enroll")
        return EnrollResult(ok: true, name: name, scopes: [Scope(project: "*", role: "owner")])
    }
    public func projects() async throws -> [Project] { try await read("projects", projectsData) }
    public func catchup(project: String) async throws -> Catchup { throw HubError.notFound("") }
    public func tasks(project: String) async throws -> [Card] { try await read("tasks", cardsData.filter { $0.project == project || project.isEmpty }) }
    public func card(id: Int) async throws -> CardDetail {
        try await read("card", CardDetail(task: cardsData.first { $0.id == id }))
    }
    public func events(project: String?, since: Int, limit: Int) async throws -> EventsResponse {
        let rows = eventsData.filter { $0.id > since && (project == nil || $0.project == project) }
        return try await read("events", EventsResponse(events: rows, cursor: rows.last?.id ?? since, latest: eventsData.last?.id ?? 0))
    }
    public func inbox(session: String, since: Int) async throws -> InboxResponse {
        let rows = inboxData.filter { $0.id > since }
        return try await read("inbox", InboxResponse(messages: rows, cursor: rows.last?.id ?? since))
    }
    public func send(from: String, to: String, text: String, project: String?, re: Int?) async throws -> Int {
        try await write("send:\(to):re=\(re ?? 0):\(text)"); return 1
    }
    public func delivered(session: String, upTo: Int) async throws { try await write("delivered:\(upTo)") }
    public func peers() async throws -> PeersResponse { try await read("peers", PeersResponse(peers: peersData, hubVersion: "0.0.0")) }
    public func holds(status: String?) async throws -> [Hold] { try await read("holds", holdsData) }
    public func decideHold(id: Int, go: Bool) async throws { try await write("decideHold:\(id):\(go ? "go" : "nogo")") }
    public func verifyGates(project: String?) async throws -> [VerifyGate] { try await read("gates", gatesData) }
    public func resolveGate(id: Int, project: String, status: GateResolution, note: String, by: String) async throws {
        try await write("resolveGate:\(id):\(status.rawValue)")
    }
    public func proposals(status: String?) async throws -> ProposalsResponse {
        try await read("proposals", ProposalsResponse(proposals: proposalsData, pendingCount: proposalsData.count))
    }
    public func decideProposal(id: Int, approve: Bool, note: String) async throws {
        try await write("decideProposal:\(id):\(approve ? "approved" : "denied"):\(note)")
    }
    public func balances(machine: String?) async throws -> BalancesResponse {
        try await read("balances", BalancesResponse(ts: 1, entries: balancesData, lowCount: balancesData.filter(\.low).count))
    }
    public func overseerStatus() async throws -> OverseerStatus { try await read("overseer", OverseerStatus(engine: true)) }
    public func moveCard(id: Int, to status: String, note: String?, drill: String?, by: String) async throws {
        try await write("move:\(id):\(status)")
    }
    public func addNote(id: Int, note: String, by: String) async throws { try await write("note:\(id)") }
    public func toggleChecklist(id: Int, index: Int, done: Bool) async throws { try await write("tick:\(id):\(index):\(done)") }
    public func reconcile(op: String) async throws -> OpOutcome {
        record("reconcile:\(op)")
        if let o = outcome { return o }
        return try JSONDecoder().decode(OpOutcome.self, from: Data(#"{"status":"unknown"}"#.utf8))
    }
}
