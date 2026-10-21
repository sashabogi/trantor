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
    /// A project screen to open on its own (debug `-project <name>`, and later deep links).
    public var openProject: String?
    /// Running on canned data (previews, the `-demo` launch flag): no hub, no pairing.
    public private(set) var isDemo = false

    /// Paired with a hub, or running the demo.
    public var isReady: Bool { settings.isPaired || isDemo }

    public private(set) var isUnpairing = false
    public var unregisterDevice: (() async throws -> Void)?
    private let authenticator: any Authenticator
    private let cache: StoreCache
    private var client: HubServing?
    private var chats: [String: ChatStore] = [:]
    @ObservationIgnored private var widgetSyncStarted = false

    public init(settings: SettingsStore = SettingsStore(), cache: StoreCache = .default,
                authenticator: any Authenticator = DeviceAuthenticator()) {
        self.authenticator = authenticator
        self.settings = settings; self.cache = cache
        decisions = DecisionsStore(cache: cache, authenticator: authenticator)
        decisions.requiresAuthentication = { [weak settings] in settings?.requireBiometrics ?? true }
        projects = ProjectsStore(cache: cache)
        board = BoardStore(cache: cache)
        feed = FeedStore(cache: cache)
        inbox = InboxStore(cache: cache)
        fleet = FleetStore(cache: cache)
        cost = CostStore(cache: cache)
        if settings.isPaired { connect() }
    }

    /// Previews and tests: every store talks to `hub`.
    public init(stub hub: HubServing, identity: String = "ios-preview", demo: Bool = false,
                authenticator: any Authenticator = DeviceAuthenticator()) {
        self.authenticator = authenticator
        isDemo = demo
        settings = SettingsStore(defaults: UserDefaults(suiteName: "preview-\(UUID().uuidString)") ?? .standard, keyStore: InMemoryKeyStore())
        cache = StoreCache(directory: nil)
        decisions = DecisionsStore(cache: cache, authenticator: authenticator); projects = ProjectsStore(cache: cache); board = BoardStore(cache: cache)
        feed = FeedStore(cache: cache); inbox = InboxStore(cache: cache); fleet = FleetStore(cache: cache); cost = CostStore(cache: cache)
        decisions.requiresAuthentication = { [weak settings] in settings?.requireBiometrics ?? true }
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
        for chat in chats.values { chat.api = api }
    }

    public func chat(project: String) -> ChatStore {
        if let store = chats[project] { return store }
        let store = ChatStore(project: project, api: client, cache: cache, authenticator: authenticator)
        store.requiresAuthentication = { [weak settings] in settings?.requireBiometrics ?? true }
        store.mayWrite = { [weak self] in
            guard let self else { return false }
            return self.isDemo || (self.settings.isPaired && ChatStore.allowsWriting(scopes: self.settings.scopes, project: project))
        }
        chats[project] = store
        return store
    }

    private func refreshChat(_ signal: ChatSignal?) {
        let stores = signal.map { chats[$0.project].map { [$0] } ?? [] } ?? Array(chats.values)
        for store in stores { Task { await store.refresh() } }
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
        feed.start(updates: { stream.updates(since: $0) }, onChat: { [weak self] signal in self?.refreshChat(signal) })
    }

    public func stopFeed() { feed.stop() }

    // MARK: Widget snapshot

    /// Writes the home-screen widget's snapshot now and re-writes it whenever the decisions
    /// queue changes. Call once from the app root; a no-op after the first call.
    public func startWidgetSnapshotSync() {
        guard !widgetSyncStarted else { return }
        widgetSyncStarted = true
        publishWidgetSnapshot()
        trackDecisionsForWidget()
    }

    /// Snapshot the current queue into the App Group container and reload the widget timeline.
    public func publishWidgetSnapshot() {
        // unpaired: no snapshot, so the widget says "Not paired" rather than "0 waiting"
        guard isReady else { WidgetSnapshotStore().clearAndReload(); return }
        WidgetSnapshotStore().publish(.derive(from: decisions.items))
    }

    private func trackDecisionsForWidget() {
        withObservationTracking {
            _ = decisions.items
        } onChange: { [weak self] in
            Task { @MainActor in
                guard let self else { return }
                self.publishWidgetSnapshot()
                self.trackDecisionsForWidget()
            }
        }
    }

    /// Forgetting the hub always works, even when the hub can't be reached: telling it to stop
    /// pushing is best effort, and a later pair from this phone replaces the old registration.
    public func unpair() async {
        guard !isUnpairing else { return }
        isUnpairing = true
        defer { isUnpairing = false }
        try? await unregisterDevice?()
        feed.stop()
        settings.unpair()
        client = nil
        for chat in chats.values { chat.disconnect() }
        chats.removeAll()
        decisions.api = nil; projects.api = nil; board.api = nil; feed.api = nil
        inbox.api = nil; fleet.api = nil; cost.api = nil
        cache.clear()
        WidgetSnapshotStore().clearAndReload()
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
