import Foundation
import HubClient
import Observation
import TrantorCore

@MainActor @Observable
public final class ProjectsStore {
    public private(set) var projects: [Project] = []
    public private(set) var freshness = Freshness()
    public var api: HubServing?
    private let cache: StoreCache

    public init(api: HubServing? = nil, cache: StoreCache = StoreCache(directory: nil)) {
        self.api = api; self.cache = cache
        if let c = cache.load([Project].self, name: "projects") { projects = c.value; freshness.fromCache(savedAt: c.savedAt) }
    }

    public func refresh() async {
        guard let api else { return }
        do {
            let rows = try await api.projects()
            // "(unassigned)" is the hub's bucket for sessions with no project, not a project
            projects = rows.filter { !$0.project.hasPrefix("(") }.sorted { $0.lastActivity > $1.lastActivity }
            freshness.fresh(); cache.save(projects, name: "projects")
        } catch { freshness.failed(DecisionsStore.describe(error)) }
    }
}

public struct BoardLane: Identifiable, Equatable, Sendable {
    public let status: String
    public let cards: [Card]
    public var id: String { status }
}

@MainActor @Observable
public final class BoardStore {
    public static let laneOrder = ["blocked", "failed", "doing", "testing", "todo", "done"]

    public private(set) var project: String = ""
    public private(set) var cards: [Card] = []
    public private(set) var detail: CardDetail?
    public private(set) var freshness = Freshness()
    public private(set) var busy = false
    public var writeError: String?

    public var api: HubServing?
    public var identity: String = ""
    private let cache: StoreCache

    public init(api: HubServing? = nil, identity: String = "", cache: StoreCache = StoreCache(directory: nil)) {
        self.api = api; self.identity = identity; self.cache = cache
    }

    public var lanes: [BoardLane] {
        let order = Self.laneOrder
        let known = Set(order)
        var out = order.map { s in BoardLane(status: s, cards: cards.filter { $0.status == s }.sorted { $0.updated > $1.updated }) }
        let other = cards.filter { !known.contains($0.status) }
        if !other.isEmpty { out.append(BoardLane(status: "other", cards: other)) }
        return out.filter { !$0.cards.isEmpty }
    }

    public func load(project: String) async {
        if self.project != project {
            self.project = project; cards = []; detail = nil; freshness = Freshness()
            if let c = cache.load([Card].self, name: "board-\(project)") { cards = c.value; freshness.fromCache(savedAt: c.savedAt) }
        }
        guard let api else { return }
        do {
            cards = try await api.tasks(project: project)
            freshness.fresh(); cache.save(cards, name: "board-\(project)")
        } catch { freshness.failed(DecisionsStore.describe(error)) }
    }

    public func open(card id: Int) async {
        guard let api else { return }
        do { detail = try await api.card(id: id) }
        catch { writeError = DecisionsStore.describe(error) }
    }

    public func move(_ card: Card, to status: String, note: String? = nil, drill: String? = nil) async {
        await write(card.id) { try await $0.moveCard(id: card.id, to: status, note: note, drill: drill, by: self.identity) }
    }

    public func addNote(_ card: Card, _ text: String) async {
        await write(card.id) { try await $0.addNote(id: card.id, note: text, by: self.identity) }
    }

    public func toggle(_ card: Card, index: Int, done: Bool) async {
        await write(card.id) { try await $0.toggleChecklist(id: card.id, index: index, done: done) }
    }

    /// Board writes wait for the hub too; the screen shows what the hub says after the write.
    private func write(_ id: Int, _ action: (HubServing) async throws -> Void) async {
        guard let api else { writeError = "Not connected to a hub."; return }
        busy = true; writeError = nil; defer { busy = false }
        do {
            try await action(api)
            await load(project: project)
            await open(card: id)
        } catch { writeError = DecisionsStore.describe(error) }
    }
}

public enum FeedConnection: Equatable, Sendable { case idle, live, reconnecting(TimeInterval) }

@MainActor @Observable
public final class FeedStore {
    public static let maxEvents = 500
    /// Filter chips: label to type prefix.
    public static let chips: [(label: String, prefix: String)] = [
        ("Cards", "card."), ("Messages", "message"), ("Holds", "hold."),
        ("Gates", "verify."), ("Proposals", "proposal."), ("Presence", "presence."),
    ]

    public private(set) var events: [HubEvent] = []      // oldest first
    public private(set) var connection: FeedConnection = .idle
    public private(set) var freshness = Freshness()
    public var activeChips: Set<String> = []
    public var projectFilter: String?

    public var api: HubServing?
    private let cache: StoreCache
    private var task: Task<Void, Never>?

    public init(api: HubServing? = nil, cache: StoreCache = StoreCache(directory: nil)) {
        self.api = api; self.cache = cache
        if let c = cache.load([HubEvent].self, name: "feed") { events = c.value; freshness.fromCache(savedAt: c.savedAt) }
    }

    public var lastEventID: Int { events.last?.id ?? 0 }

    /// Newest first, narrowed by the chips and project filter.
    public var filtered: [HubEvent] {
        let prefixes = Self.chips.filter { activeChips.contains($0.label) }.map(\.prefix)
        return events.reversed().filter { e in
            (projectFilter == nil || e.project == projectFilter) &&
            (prefixes.isEmpty || prefixes.contains { e.type.hasPrefix($0) })
        }
    }

    public func ingest(_ incoming: [HubEvent]) {
        var seen = Set(events.map(\.id))
        for e in incoming where seen.insert(e.id).inserted { events.append(e) }
        events.sort { $0.id < $1.id }
        if events.count > Self.maxEvents { events.removeFirst(events.count - Self.maxEvents) }
    }

    /// One catch-up pass (also used by pull to refresh).
    public func refresh() async {
        guard let api else { return }
        do {
            let r = try await api.events(project: nil, since: lastEventID, limit: 300)
            ingest(r.events)
            freshness.fresh(); cache.save(events, name: "feed")
        } catch { freshness.failed(DecisionsStore.describe(error)) }
    }

    /// Follow the live stream. `updates` is built from the current `lastEventID`, so it can be a real
    /// `EventStream` or a scripted one in tests. Replaces any stream already running.
    public func start(updates: @escaping (Int) -> AsyncStream<StreamUpdate>, onChat: @escaping (ChatSignal?) -> Void = { _ in }) {
        stop()
        let since = lastEventID
        task = Task { [weak self] in
            for await u in updates(since) {
                guard let self, !Task.isCancelled else { return }
                switch u {
                case .connected: self.connection = .live; self.freshness.fresh(); onChat(nil)
                case .event(let e):
                    self.ingest([e])
                    if e.type.hasPrefix("chat.prompt.") { onChat(ChatSignal(project: e.project, promptID: e.payload["promptId"]?.stringValue)) }
                case .chat(let signal): onChat(signal)
                case .disconnected(let wait): self.connection = .reconnecting(wait); self.freshness.failed("Reconnecting")
                }
            }
        }
    }

    public func stop() {
        task?.cancel(); task = nil; connection = .idle
        cache.save(events, name: "feed")
    }
}

public struct InboxThread: Identifiable, Equatable, Sendable {
    public let counterpart: String
    public let messages: [BusMessage]
    public var id: String { counterpart }
    public var last: BusMessage? { messages.last }
}

@MainActor @Observable
public final class InboxStore {
    public private(set) var received: [BusMessage] = []
    public private(set) var sent: [BusMessage] = []
    public private(set) var freshness = Freshness()
    public private(set) var cursor = 0
    /// Highest message id the person has looked at on this device.
    public private(set) var readUpTo = 0
    public var sendError: String?

    public var api: HubServing?
    public var identity: String = ""
    private let cache: StoreCache

    public init(api: HubServing? = nil, identity: String = "", cache: StoreCache = StoreCache(directory: nil)) {
        self.api = api; self.identity = identity; self.cache = cache
        if let c = cache.load([BusMessage].self, name: "inbox") { received = c.value; freshness.fromCache(savedAt: c.savedAt) }
        if let r = cache.load(Int.self, name: "inbox-read") { readUpTo = r.value }
    }

    /// Messages addressed to this device that arrived after the last look.
    public var unreadCount: Int { received.filter { $0.id > readUpTo && $0.to == identity }.count }

    /// Conversations by the other party, newest activity first.
    public var threads: [InboxThread] {
        var by: [String: [BusMessage]] = [:]
        for m in received { by[m.from, default: []].append(m) }
        for m in sent { by[m.to, default: []].append(m) }
        return by.map { InboxThread(counterpart: $0.key, messages: $0.value.sorted { $0.ts < $1.ts }) }
            .sorted { ($0.last?.ts ?? 0) > ($1.last?.ts ?? 0) }
    }

    /// Peeks (never claims delivery); `markRead` records it once the person has looked.
    public func refresh() async {
        guard let api, !identity.isEmpty else { return }
        do {
            let r = try await api.inbox(session: identity, since: 0)
            received = r.messages; cursor = r.cursor
            freshness.fresh(); cache.save(received, name: "inbox")
        } catch { freshness.failed(DecisionsStore.describe(error)) }
    }

    public func markRead() async {
        let top = max(cursor, received.map(\.id).max() ?? 0)
        if top > readUpTo { readUpTo = top; cache.save(readUpTo, name: "inbox-read") }
        guard let api, cursor > 0 else { return }
        try? await api.delivered(session: identity, upTo: cursor)
    }

    public func reply(to thread: InboxThread, text: String, project: String? = nil) async {
        guard let api else { sendError = "Not connected to a hub."; return }
        sendError = nil
        let re = thread.messages.last { $0.from == thread.counterpart }?.id
        do {
            _ = try await api.send(from: identity, to: thread.counterpart, text: text, project: project ?? thread.last?.project, re: re)
            sent.append(BusMessage(id: -(sent.count + 1), ts: Date().timeIntervalSince1970 * 1000, from: identity,
                                   to: thread.counterpart, text: text, project: project ?? ""))
        } catch { sendError = DecisionsStore.describe(error) }
    }

    public func send(to seat: String, text: String, project: String? = nil) async {
        guard let api else { sendError = "Not connected to a hub."; return }
        sendError = nil
        do {
            _ = try await api.send(from: identity, to: seat, text: text, project: project, re: nil)
            sent.append(BusMessage(id: -(sent.count + 1), ts: Date().timeIntervalSince1970 * 1000, from: identity,
                                   to: seat, text: text, project: project ?? ""))
        } catch { sendError = DecisionsStore.describe(error) }
    }
}

@MainActor @Observable
public final class FleetStore {
    public private(set) var peers: [Peer] = []
    public private(set) var collisions: [JSONValue] = []
    public private(set) var freshness = Freshness()
    public var api: HubServing?
    private let cache: StoreCache

    public init(api: HubServing? = nil, cache: StoreCache = StoreCache(directory: nil)) {
        self.api = api; self.cache = cache
        if let c = cache.load([Peer].self, name: "fleet") { peers = c.value; freshness.fromCache(savedAt: c.savedAt) }
    }

    public var online: [Peer] { peers.filter(\.online) }

    public func refresh() async {
        guard let api else { return }
        do {
            let r = try await api.peers()
            peers = r.peers.sorted { ($0.online ? 0 : 1, $0.project, $0.session) < ($1.online ? 0 : 1, $1.project, $1.session) }
            collisions = (try? await api.overseerStatus())?.warnings ?? []
            freshness.fresh(); cache.save(peers, name: "fleet")
        } catch { freshness.failed(DecisionsStore.describe(error)) }
    }
}

@MainActor @Observable
public final class CostStore {
    public private(set) var entries: [BalanceEntry] = []
    public private(set) var freshness = Freshness()
    public var api: HubServing?
    public var machine: String?
    private let cache: StoreCache

    public init(api: HubServing? = nil, cache: StoreCache = StoreCache(directory: nil)) {
        self.api = api; self.cache = cache
        if let c = cache.load([BalanceEntry].self, name: "cost") { entries = c.value; freshness.fromCache(savedAt: c.savedAt) }
    }

    public var lowCount: Int { entries.filter(\.low).count }

    public func refresh() async {
        guard let api else { return }
        do {
            entries = try await api.balances(machine: machine).entries
            freshness.fresh(); cache.save(entries, name: "cost")
        } catch { freshness.failed(DecisionsStore.describe(error)) }
    }
}
