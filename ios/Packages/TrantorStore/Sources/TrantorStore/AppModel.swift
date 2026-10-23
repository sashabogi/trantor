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
    /// The segment that screen opens on (chat, board, crew); consumed once.
    public var openProjectSection: String?
    /// Running on canned data (previews, the `-demo` launch flag): no hub, no pairing.
    public private(set) var isDemo = false

    /// Paired with a hub, or running the demo.
    public var isReady: Bool { settings.isPaired || isDemo }

    public private(set) var isUnpairing = false
    public var unregisterDevice: (() async throws -> Void)?
    private let authenticator: any Authenticator
    private let cache: StoreCache
    private var client: HubServing?
    private var crews: [String: CrewStore] = [:]
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
        for crew in crews.values { crew.api = api }
    }

    public func crew(project: String) -> CrewStore {
        if let store = crews[project] { return store }
        let store = CrewStore(project: project, fleet: fleet, api: client, authenticator: authenticator)
        store.requiresAuthentication = { [weak settings] in settings?.requireBiometrics ?? true }
        store.mayControl = { [weak self] in
            guard let self else { return false }
            return self.isDemo || (self.settings.isPaired && CrewStore.allowsControl(scopes: self.settings.scopes, project: project))
        }
        crews[project] = store
        return store
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
        let crewStores = signal.map { crews[$0.project].map { [$0] } ?? [] } ?? Array(crews.values)
        for store in crewStores { Task { await store.refreshCommands() } }
    }

    public var isConnected: Bool { client != nil }

    /// The hub's public https address, offered when the paired hub is a tailnet (http 100.x) one
    /// and its `/health` advertises a `publicUrl`. Nil when there is nothing to gain.
    public func publicHubURL() async -> URL? {
        guard let current = settings.hubURL, HubNetwork.needsTailscale(current), let client,
              let health = try? await client.health(),
              let raw = health.publicUrl, !raw.isEmpty,
              let url = SettingsStore.normalizeHub(raw), url.scheme?.lowercased() == "https" else { return nil }
        return url
    }

    /// Move the pairing to the hub's public address, but only after the probe (a `/health` call
    /// against that address) answers — a failed probe leaves the pairing untouched. The key and
    /// identity carry over; stores re-bind to a fresh client and cached snapshots are cleared.
    @discardableResult
    public func switchHub(to url: URL, probe: (URL) async throws -> Void) async -> Bool {
        do { try await probe(url) } catch { return false }
        // the live feed holds a stream to the old address: stop it before the switch, restart after
        let feeding = feed.isRunning
        stopFeed()
        settings.setHub(url)
        cache.clear()
        connect()
        if feeding { startFeed() }
        return true
    }

    public func refreshAll() async {
        // calibrates the signing clock before anything else, and remembers the public address
        if let health = try? await client?.health() {
            if let raw = health.publicUrl, let url = SettingsStore.normalizeHub(raw), url.scheme == "https" {
                settings.knownPublicHub = url
            }
        } else if await moveToKnownPublicHub() {
            _ = try? await client?.health()
        }
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
    /// The paired (tailnet) hub didn't answer: if a public address is known and answers, move there.
    /// Same key, no re-pair. Returns whether it moved.
    public func moveToKnownPublicHub(probe: ((URL) async throws -> Void)? = nil) async -> Bool {
        guard let current = settings.hubURL, HubNetwork.needsTailscale(current),
              let target = settings.knownPublicHub, target != current else { return false }
        let check = probe ?? { url in
            var req = URLRequest(url: url.appendingPathComponent("health")); req.timeoutInterval = 5
            let (_, response) = try await URLSession.shared.data(for: req)
            guard (response as? HTTPURLResponse)?.statusCode == 200 else { throw HubError.offline(op: nil) }
        }
        return await switchHub(to: target, probe: check)
    }

    public func unpair() async {
        guard !isUnpairing else { return }
        isUnpairing = true
        defer { isUnpairing = false }
        // Telling the hub to stop pushing is best effort and gets 3 seconds: with Tailscale off a
        // tailnet hub never answers, and waiting out the network timeout froze the button.
        if let unregister = unregisterDevice {
            let work = Task { @MainActor in try? await unregister() }
            let deadline = Task { try? await Task.sleep(nanoseconds: 3_000_000_000); work.cancel() }
            await work.value
            deadline.cancel()
        }
        feed.stop()
        settings.unpair()
        client = nil
        for chat in chats.values { chat.disconnect() }
        chats.removeAll()
        for crew in crews.values { crew.disconnect() }
        crews.removeAll()
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
