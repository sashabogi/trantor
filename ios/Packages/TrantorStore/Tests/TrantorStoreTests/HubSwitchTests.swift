import XCTest
import HubClient
import TrantorCore
@testable import TrantorStore

@MainActor
final class HubSwitchTests: XCTestCase {
    private let tailnet = "http://100.79.242.104:4477"
    private let publicURL = URL(string: "https://netcup-qdrant.tail0f2afd.ts.net")!

    /// A SettingsStore paired against `hub`; records every URL a client is built against.
    private func pair(hub: StubHub, address: String, bound: Locked<[URL]>, defaults: UserDefaults) async -> SettingsStore {
        let settings = SettingsStore(defaults: defaults, keyStore: InMemoryKeyStore(),
                                     makeAPI: { url, _ in bound.append(url); return hub })
        await settings.pair(hub: address, token: "tok", deviceName: "ios-phone")
        XCTAssertTrue(settings.isPaired)
        return settings
    }

    private func freshDefaults() -> UserDefaults { UserDefaults(suiteName: "test-\(UUID().uuidString)")! }

    func testSetHubKeepsTheKeyAndIdentityAndRebinds() async {
        let hub = StubHub()
        let bound = Locked<[URL]>([])
        let defaults = freshDefaults()
        let settings = await pair(hub: hub, address: tailnet, bound: bound, defaults: defaults)
        let keyBefore = settings.publicKeyHex

        settings.setHub(publicURL)

        XCTAssertEqual(settings.hubURL, publicURL)
        XCTAssertEqual(settings.identityName, "ios-phone", "the identity is untouched")
        XCTAssertEqual(settings.publicKeyHex, keyBefore, "the same key signs on the new address")
        XCTAssertNotNil(settings.makeClient(), "a client can still be built")
        XCTAssertEqual(bound.value.last, publicURL, "makeClient re-points at the new address")
        XCTAssertEqual(defaults.string(forKey: "hubURL"), publicURL.absoluteString, "the switch persists")
    }

    func testPublicHubURLOnlyForTailnetPairingsThatAdvertiseOne() async {
        let hub = StubHub()
        hub.healthData = HealthInfo(ok: true, publicUrl: "https://netcup-qdrant.tail0f2afd.ts.net")
        let bound = Locked<[URL]>([])
        let settings = await pair(hub: hub, address: tailnet, bound: bound, defaults: freshDefaults())
        let model = AppModel(settings: settings, cache: StoreCache(directory: nil))
        let offer = await model.publicHubURL()
        XCTAssertEqual(offer, publicURL)

        // Already on a public (https) hub: nothing to offer.
        let httpsSettings = await pair(hub: hub, address: "https://netcup-qdrant.tail0f2afd.ts.net",
                                       bound: bound, defaults: freshDefaults())
        let httpsModel = AppModel(settings: httpsSettings, cache: StoreCache(directory: nil))
        let httpsOffer = await httpsModel.publicHubURL()
        XCTAssertNil(httpsOffer)

        // A hub that does not report a publicUrl offers nothing.
        hub.healthData = HealthInfo(ok: true)
        let noOffer = await model.publicHubURL()
        XCTAssertNil(noOffer)
    }

    func testSwitchHubMovesOnlyWhenThePublicHealthCheckAnswers() async {
        let hub = StubHub()
        let bound = Locked<[URL]>([])
        let settings = await pair(hub: hub, address: tailnet, bound: bound, defaults: freshDefaults())
        let model = AppModel(settings: settings, cache: StoreCache(directory: nil))

        // The public address does not answer: the switch is refused, the pairing is untouched.
        let refused = await model.switchHub(to: publicURL) { _ in throw HubError.offline(op: nil) }
        XCTAssertFalse(refused)
        XCTAssertEqual(settings.hubURL?.absoluteString, tailnet)
        XCTAssertTrue(settings.isPaired)

        // It answers: the pairing moves and the model re-binds to a client on the new address.
        let moved = await model.switchHub(to: publicURL) { _ in }
        XCTAssertTrue(moved)
        XCTAssertEqual(settings.hubURL, publicURL)
        XCTAssertEqual(bound.value.last, publicURL, "connect() rebuilt the client against the public address")
    }
}

/// A tiny Sendable box for capturing values out of @Sendable closures in tests.
private final class Locked<Value>: @unchecked Sendable {
    private let lock = NSLock()
    private var storage: Value
    init(_ value: Value) { storage = value }
    var value: Value { lock.lock(); defer { lock.unlock() }; return storage }
    func append(_ element: Value.Element) where Value: RangeReplaceableCollection {
        lock.lock(); defer { lock.unlock() }; storage.append(element)
    }
}
