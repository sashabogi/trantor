import XCTest
import HubClient
import TrantorCore
@testable import TrantorStore

@MainActor
final class OtherStoreTests: XCTestCase {
    func testFeedDedupesOrdersAndFilters() {
        let feed = FeedStore()
        feed.ingest([HubEvent(id: 3, type: "message", project: "a"), HubEvent(id: 1, type: "card.moved", project: "a")])
        feed.ingest([HubEvent(id: 3, type: "message", project: "a"), HubEvent(id: 2, type: "hold.opened", project: "b")])
        XCTAssertEqual(feed.events.map(\.id), [1, 2, 3])
        XCTAssertEqual(feed.filtered.map(\.id), [3, 2, 1], "newest first")
        feed.activeChips = ["Holds", "Messages"]
        XCTAssertEqual(feed.filtered.map(\.id), [3, 2])
        feed.projectFilter = "b"
        XCTAssertEqual(feed.filtered.map(\.id), [2])
    }

    func testFeedFollowsAScriptedStream() async throws {
        let feed = FeedStore()
        feed.start { since in
            AsyncStream { c in
                c.yield(.connected)
                c.yield(.event(HubEvent(id: since + 1, type: "message")))
                c.yield(.disconnected(retryIn: 2))
                c.finish()
            }
        }
        for _ in 0..<200 where feed.connection != .reconnecting(2) { try await Task.sleep(nanoseconds: 5_000_000) }
        XCTAssertEqual(feed.events.map(\.id), [1])
        XCTAssertEqual(feed.connection, .reconnecting(2))
        feed.stop()
        XCTAssertEqual(feed.connection, .idle)
    }

    func testBoardGroupsCardsIntoLanes() async {
        let hub = StubHub()
        hub.cardsData = [Card(id: 1, project: "p", status: "doing", updated: 5), Card(id: 2, project: "p", status: "done"),
                         Card(id: 3, project: "p", status: "blocked"), Card(id: 4, project: "p", status: "doing", updated: 9),
                         Card(id: 5, project: "p", status: "weird")]
        let board = BoardStore(api: hub, identity: "ios")
        await board.load(project: "p")
        XCTAssertEqual(board.lanes.map(\.status), ["blocked", "doing", "done", "other"])
        XCTAssertEqual(board.lanes[1].cards.map(\.id), [4, 1], "most recently updated first")
    }

    func testBoardWriteWaitsForTheHubAndReloads() async {
        let hub = StubHub()
        hub.cardsData = [Card(id: 1, project: "p", status: "doing")]
        let board = BoardStore(api: hub, identity: "ios")
        await board.load(project: "p")
        hub.writeError = .conflict("assignee is frozen")
        await board.move(Card(id: 1, project: "p"), to: "done")
        XCTAssertEqual(board.writeError, "assignee is frozen")
        hub.writeError = nil
        await board.toggle(Card(id: 1, project: "p"), index: 0, done: true)
        XCTAssertNil(board.writeError)
        XCTAssertTrue(hub.calls.contains("tick:1:0:true"))
    }

    func testInboxThreadsGroupByCounterpart() async {
        let hub = StubHub()
        hub.inboxData = [BusMessage(id: 1, ts: 10, from: "codex", text: "a"), BusMessage(id: 2, ts: 30, from: "kimi", text: "b"),
                         BusMessage(id: 3, ts: 20, from: "codex", text: "c")]
        let inbox = InboxStore(api: hub, identity: "ios")
        await inbox.refresh()
        XCTAssertEqual(inbox.threads.map(\.counterpart), ["kimi", "codex"])
        await inbox.reply(to: inbox.threads[1], text: "thanks")
        XCTAssertTrue(hub.calls.contains("send:codex:re=3:thanks"), "replies thread under the latest message from them")
        XCTAssertEqual(inbox.threads.first?.counterpart, "codex")
    }

    func testPairingLinkParsing() {
        let ok = PairingLink.parse(URL(string: "trantor://enroll?hub=http://100.79.242.104:4477&token=abc123")!)
        XCTAssertEqual(ok, PairingLink(hub: "http://100.79.242.104:4477", token: "abc123"))
        XCTAssertNil(PairingLink.parse(URL(string: "trantor://enroll?hub=x")!))
        XCTAssertNil(PairingLink.parse(URL(string: "https://enroll?hub=x&token=y")!))
        XCTAssertNil(PairingLink.parse(URL(string: "trantor://other?hub=x&token=y")!))
    }

    func testHubAddressNormalizing() {
        XCTAssertEqual(SettingsStore.normalizeHub("100.79.242.104:4477/")?.absoluteString, "http://100.79.242.104:4477")
        XCTAssertEqual(SettingsStore.normalizeHub(" http://hub.local:4477 ")?.absoluteString, "http://hub.local:4477")
        XCTAssertNil(SettingsStore.normalizeHub(""))
        XCTAssertEqual(SettingsStore.defaultDeviceName("iPhone 17 Pro"), "ios-iphone17pro")
    }

    func testPairingStoresIdentityAndKey() async {
        let defaults = UserDefaults(suiteName: "test-\(UUID().uuidString)")!
        let keys = InMemoryKeyStore()
        let hub = StubHub()
        let settings = SettingsStore(defaults: defaults, keyStore: keys, makeAPI: { _, _ in hub })
        XCTAssertFalse(settings.isPaired)
        await settings.pair(hub: "100.79.242.104:4477", token: "tok", deviceName: "ios-phone")
        XCTAssertTrue(settings.isPaired)
        XCTAssertEqual(settings.identityName, "ios-phone")
        XCTAssertEqual(settings.scopes.first?.role, "owner")
        XCTAssertNotNil(try? keys.loadKey())
        XCTAssertEqual(settings.publicKeyHex?.count, 64)
        guard case .paired = settings.pairing else { return XCTFail("expected paired") }

        settings.unpair()
        XCTAssertFalse(settings.isPaired)
        XCTAssertNil(try? keys.loadKey())
    }

    func testPairingRejectsBadInputWithoutTouchingTheNetwork() async {
        let hub = StubHub()
        let settings = SettingsStore(defaults: UserDefaults(suiteName: "test-\(UUID().uuidString)")!, keyStore: InMemoryKeyStore(), makeAPI: { _, _ in hub })
        await settings.pair(hub: "", token: "t", deviceName: "x")
        guard case .failed = settings.pairing else { return XCTFail() }
        await settings.pair(hub: "h:1", token: " ", deviceName: "x")
        guard case .failed = settings.pairing else { return XCTFail() }
        XCTAssertTrue(hub.calls.isEmpty)
    }
}
