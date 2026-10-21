import Foundation
import HubClient
import Observation
import TrantorCore

/// Owns every store and points them at the paired hub.
@MainActor @Observable
public final class AppModel {
    public let settings: SettingsStore
    public let decisions: DecisionsStore
    public let projects: ProjectsStore
    public let board: BoardStore
    public let feed: FeedStore
    public let inbox: InboxStore
    public let fleet: FleetStore
    public let cost: CostStore

    /// Where a notification action or deep link wants the UI to go.
    public var selection: AppSection = .decisions
    /// A trantor://enroll link that arrived before pairing; the pairing screen consumes it.
    public var pendingLink: PairingLink?
    /// Keeps the pairing screen up after a successful pair so the person sees health and scope first.
    public var showPairingSummary = false
    /// Running on canned data (previews, the `-demo` launch flag): no hub, no pairing.
    public private(set) var isDemo = false

    /// Paired with a hub, or running the demo.
    public var isReady: Bool { settings.isPaired || isDemo }

    private let cache: StoreCache
    private var client: HubServing?

    public init(settings: SettingsStore = SettingsStore(), cache: StoreCache = .default) {
        self.settings = settings; self.cache = cache
        decisions = DecisionsStore(cache: cache)
        projects = ProjectsStore(cache: cache)
        board = BoardStore(cache: cache)
        feed = FeedStore(cache: cache)
        inbox = InboxStore(cache: cache)
        fleet = FleetStore(cache: cache)
        cost = CostStore(cache: cache)
        if settings.isPaired { connect() }
    }

    /// Previews and tests: every store talks to `hub`.
    public init(stub hub: HubServing, identity: String = "ios-preview", demo: Bool = false) {
        isDemo = demo
        settings = SettingsStore(defaults: UserDefaults(suiteName: "preview-\(UUID().uuidString)") ?? .standard, keyStore: InMemoryKeyStore())
        cache = StoreCache(directory: nil)
        decisions = DecisionsStore(cache: cache); projects = ProjectsStore(cache: cache); board = BoardStore(cache: cache)
        feed = FeedStore(cache: cache); inbox = InboxStore(cache: cache); fleet = FleetStore(cache: cache); cost = CostStore(cache: cache)
        bind(hub, identity: identity)
    }

    /// Build the client from the stored key and point every store at it.
    public func connect() {
        guard let api = settings.makeClient() else { return }
        bind(api, identity: settings.identityName)
    }

    func bind(_ api: HubServing, identity: String) {
        client = api
        decisions.api = api; decisions.identity = identity
        projects.api = api
        board.api = api; board.identity = identity
        feed.api = api
        inbox.api = api; inbox.identity = identity
        fleet.api = api
        cost.api = api
    }

    public var isConnected: Bool { client != nil }

    public func refreshAll() async {
        _ = try? await client?.health()          // calibrates the signing clock before anything else
        async let a: Void = decisions.refresh()
        async let b: Void = projects.refresh()
        async let c: Void = inbox.refresh()
        async let d: Void = fleet.refresh()
        async let e: Void = cost.refresh()
        async let f: Void = feed.refresh()
        _ = await (a, b, c, d, e, f)
    }

    /// Start the live feed. Needs the concrete hub address and key, so it only works on a paired model.
    public func startFeed() {
        guard let url = settings.hubURL, let signer = settings.signer(), let client else { return }
        let stream = EventStream(baseURL: url, signer: signer, api: client, sessionName: settings.identityName)
        feed.start { stream.updates(since: $0) }
    }

    public func stopFeed() { feed.stop() }

    public func unpair() {
        feed.stop()
        settings.unpair()
        client = nil
        decisions.api = nil; projects.api = nil; board.api = nil; feed.api = nil
        inbox.api = nil; fleet.api = nil; cost.api = nil
        cache.clear()
    }
}

public enum AppSection: String, CaseIterable, Identifiable, Sendable {
    case decisions, projects, feed, inbox, fleet, cost, settings
    public var id: String { rawValue }
    /// The phone's tab bar: five, so nothing hides behind "More". Cost lives inside Fleet and
    /// Settings behind the toolbar gear.
    public static let tabs: [AppSection] = [.decisions, .projects, .feed, .inbox, .fleet]
    public var title: String {
        switch self {
        case .decisions: return "Decisions"
        case .projects: return "Projects"
        case .feed: return "Feed"
        case .inbox: return "Inbox"
        case .fleet: return "Fleet"
        case .cost: return "Cost"
        case .settings: return "Settings"
        }
    }
    public var systemImage: String {
        switch self {
        case .decisions: return "checkmark.seal"
        case .projects: return "square.stack.3d.up"
        case .feed: return "list.bullet.rectangle"
        case .inbox: return "tray"
        case .fleet: return "person.3"
        case .cost: return "dollarsign.circle"
        case .settings: return "gearshape"
        }
    }
}
