import Foundation
import HubClient
import Observation
import TrantorCore

public enum DecisionKind: Equatable, Sendable {
    case hold(Hold)
    case gate(VerifyGate)
    case proposal(Proposal)
    case ask(BusMessage)

    /// Lower sorts first: a hold blocks a seat right now, a relay ask is the least urgent.
    var priority: Int {
        switch self { case .hold: return 0; case .gate: return 1; case .proposal: return 2; case .ask: return 3 }
    }
}

public struct DecisionItem: Identifiable, Equatable, Sendable {
    public let id: String
    public let kind: DecisionKind
    public let project: String
    public let ts: Double

    public init(kind: DecisionKind) {
        self.kind = kind
        switch kind {
        case .hold(let h): id = "hold-\(h.id)"; project = h.project; ts = h.ts
        case .gate(let g): id = "gate-\(g.id)"; project = g.project; ts = g.ts
        case .proposal(let p): id = "proposal-\(p.id)"; project = p.project; ts = p.ts
        case .ask(let m): id = "ask-\(m.id)"; project = m.project; ts = m.ts
        }
    }
}

/// What the last tap on an item is doing. Never optimistic: an item stays in the queue as
/// `.pending` until the hub has answered.
public enum DecisionActionState: Equatable, Sendable {
    case pending
    case failed(String)
    case alreadyDecided(String)
}

@MainActor @Observable
public final class DecisionsStore {
    public private(set) var items: [DecisionItem] = []
    public private(set) var actions: [String: DecisionActionState] = [:]
    public private(set) var freshness = Freshness()
    public var isLoading = false
    /// Shown once when the hub says someone else decided first; the item is already gone from the queue.
    public var notice: String?

    public var api: HubServing?
    /// The phone's identity name: its mailbox, and the author on gate resolutions and replies.
    public var identity: String = ""

    private let cache: StoreCache

    public var pendingCount: Int { items.count }

    public init(api: HubServing? = nil, identity: String = "", cache: StoreCache = StoreCache(directory: nil)) {
        self.api = api; self.identity = identity; self.cache = cache
        if let c = cache.load([DecisionCacheRow].self, name: "decisions") {
            items = Self.merge(holds: c.value.compactMap(\.hold), proposals: c.value.compactMap(\.proposal),
                               gates: c.value.compactMap(\.gate), asks: c.value.compactMap(\.ask), answeredAsks: [])
            freshness.fromCache(savedAt: c.savedAt)
        }
    }

    // MARK: Merge

    /// One queue from four sources. Only open items count (pending hold, open gate, pending proposal,
    /// ask nobody has answered). Order: holds, gates, proposals, asks; oldest first within a kind.
    public static func merge(holds: [Hold], proposals: [Proposal], gates: [VerifyGate], asks: [BusMessage],
                             answeredAsks: Set<Int>) -> [DecisionItem] {
        var out: [DecisionItem] = []
        out += holds.filter(\.isPending).map { DecisionItem(kind: .hold($0)) }
        out += gates.filter { $0.status == "open" }.map { DecisionItem(kind: .gate($0)) }
        out += proposals.filter { $0.status == "pending" }.map { DecisionItem(kind: .proposal($0)) }
        out += asks.filter { $0.isAsk && !answeredAsks.contains($0.id) }.map { DecisionItem(kind: .ask($0)) }
        return out.sorted { a, b in
            if a.kind.priority != b.kind.priority { return a.kind.priority < b.kind.priority }
            if a.ts != b.ts { return a.ts < b.ts }
            return a.id < b.id
        }
    }

    // MARK: Refresh

    public func refresh() async {
        guard let api else { return }
        isLoading = true; defer { isLoading = false }
        do {
            async let h = api.holds(status: "pending")
            async let g = api.verifyGates(project: nil)
            async let p = api.proposals(status: "pending")
            let (holds, gates, proposals) = try await (h, g, p)
            // Asks live in the inbox. A missing inbox must not hide holds, so it degrades to none.
            let inbox = (try? await api.inbox(session: identity, since: 0))?.messages ?? []
            let asks = inbox.filter(\.isAsk)
            let answered = Set(inbox.filter { $0.re > 0 && $0.from == identity }.map(\.re))
            items = Self.merge(holds: holds, proposals: proposals.proposals, gates: gates, asks: asks, answeredAsks: answered)
            let live = Set(items.map(\.id))
            actions = actions.filter { live.contains($0.key) && $0.value == .pending }   // decided elsewhere: drop stale notes
            freshness.fresh()
            cache.save(items.map(DecisionCacheRow.init), name: "decisions")
        } catch {
            freshness.failed(Self.describe(error))
        }
    }

    // MARK: Decide (never optimistic)

    public func decideHold(_ hold: Hold, go: Bool) async {
        await perform("hold-\(hold.id)") { try await $0.decideHold(id: hold.id, go: go) }
    }

    public func decideProposal(_ proposal: Proposal, approve: Bool, note: String = "") async {
        await perform("proposal-\(proposal.id)") { try await $0.decideProposal(id: proposal.id, approve: approve, note: note) }
    }

    public func resolveGate(_ gate: VerifyGate, as status: GateResolution, note: String = "") async {
        let by = identity
        await perform("gate-\(gate.id)") { try await $0.resolveGate(id: gate.id, project: gate.project, status: status, note: note, by: by) }
    }

    public func reply(to ask: BusMessage, text: String) async {
        let me = identity
        await perform("ask-\(ask.id)") { _ = try await $0.send(from: me, to: ask.from, text: text, project: ask.project, re: ask.id) }
    }

    public func dismissNote(for id: String) {
        if case .pending? = actions[id] { return }
        actions[id] = nil
    }

    private func perform(_ id: String, _ action: @Sendable (HubServing) async throws -> Void) async {
        guard let api else { actions[id] = .failed("Not connected to a hub."); return }
        if case .pending? = actions[id] { return }          // a second tap while waiting does nothing
        actions[id] = .pending
        do {
            try await action(api)
            actions[id] = nil
            await refresh()                                  // the hub's answer, not our guess, decides what stays
        } catch let e as HubError {
            switch e {
            case .conflict(let m):
                actions[id] = .alreadyDecided(m.isEmpty ? "Already decided." : m)
                notice = "Already decided elsewhere. The queue has been refreshed."
                await refresh()
            case .offline(let op), .timeout(let op):
                await settle(id, op: op, original: e, api: api)
            default:
                actions[id] = .failed(e.userMessage)
            }
        } catch {
            actions[id] = .failed(Self.describe(error))
        }
    }

    /// The connection dropped mid-POST. Ask the hub what became of the `_op` before telling the
    /// operator anything, because the decision may well have landed.
    private func settle(_ id: String, op: String?, original: HubError, api: HubServing) async {
        guard let op, let outcome = try? await api.reconcile(op: op), !outcome.isUnknown else {
            actions[id] = .failed("No answer from the hub. Check before deciding again.")
            return
        }
        if outcome.isCommitted {
            actions[id] = nil
        } else if outcome.code == 409 {
            actions[id] = .alreadyDecided(outcome.body["error"]?.stringValue ?? "Already decided.")
            notice = "Already decided elsewhere. The queue has been refreshed."
        } else {
            actions[id] = .failed(outcome.body["error"]?.stringValue ?? original.userMessage)
        }
        await refresh()
    }

    static func describe(_ error: Error) -> String { (error as? HubError)?.userMessage ?? error.localizedDescription }
}

/// One cached queue row; a flat struct keeps the file format simple.
struct DecisionCacheRow: Codable {
    var hold: Hold?
    var gate: VerifyGate?
    var proposal: Proposal?
    var ask: BusMessage?

    init(_ item: DecisionItem) {
        switch item.kind {
        case .hold(let h): hold = h
        case .gate(let g): gate = g
        case .proposal(let p): proposal = p
        case .ask(let m): ask = m
        }
    }
}
