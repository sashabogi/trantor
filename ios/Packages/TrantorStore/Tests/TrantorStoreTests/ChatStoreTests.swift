import XCTest
import TrantorCore
import HubClient
@testable import TrantorStore

@MainActor
final class ChatStoreTests: XCTestCase {
    private func turn(_ index: Int, _ text: String, role: String = "assistant", queued: Bool = false) -> ChatTurn {
        ChatTurn(idx: index, role: role, blocks: [ChatBlock(text: text)], queued: queued)
    }
    private func snapshot(_ turns: [ChatTurn], session: String = "s1", total: Int? = nil, host: String = "mac") -> ChatSnapshot {
        ChatSnapshot(session: session, total: total ?? ((turns.map(\.idx).max() ?? -1) + 1), turns: turns, host: host)
    }
    private func store(_ hub: StubHub) -> ChatStore {
        let store = ChatStore(project: "trantor", api: hub)
        store.mayWrite = { true }
        store.merge(snapshot([]))
        return store
    }

    func testMergeReplacesGrowingTurnsDeduplicatesAndKeeps200() {
        let store = store(StubHub())
        store.merge(snapshot((0..<205).map { turn($0, "row \($0)") }))
        XCTAssertEqual(store.turns.count, 200)
        XCTAssertEqual(store.turns.first?.idx, 5)
        store.merge(snapshot([turn(204, "growing answer"), turn(204, "finished answer")]))
        XCTAssertEqual(store.turns.last?.text, "finished answer")
        XCTAssertEqual(store.turns.count, 200)
        store.merge(snapshot([turn(0, "new session")], session: "s2"))
        XCTAssertEqual(store.turns.map(\.text), ["new session"])
    }

    func testInitialCatchupWalks200TurnPagesAndRetainsLatest200() async {
        let hub = StubHub(), store = store(StubHub())
        store.api = hub
        hub.chatsData = ["trantor": snapshot((100..<500).map { turn($0, "row") })]
        await store.refresh()
        XCTAssertEqual(store.turns.first?.idx, 300)
        XCTAssertEqual(store.turns.last?.idx, 499)
        XCTAssertEqual(store.turns.count, 200)
        XCTAssertTrue(hub.calls.contains("chat:trantor:after=299"))
    }

    func testRefreshRecoversSessionReplacementEvenWhenOldCursorWasHigher() async {
        let hub = StubHub(), store = store(StubHub())
        store.api = hub
        store.merge(snapshot((100..<301).map { turn($0, "old") }))
        hub.chatsData = ["trantor": snapshot([turn(0, "new")], session: "replacement")]
        await store.refresh()
        XCTAssertEqual(store.turns.map(\.text), ["new"])
        XCTAssertTrue(hub.calls.contains("chat:trantor:after=-1"))
    }

    func testQueuedDeliveredSeenRequireANewUnqueuedUserTurn() async throws {
        let hub = StubHub(), store = store(StubHub())
        store.api = hub
        store.merge(snapshot([turn(0, "same message", role: "user")]))
        let sent = await store.send("same message")
        XCTAssertTrue(sent)
        let id = try XCTUnwrap(store.outgoing.first?.promptID)
        XCTAssertEqual(store.outgoing.first?.delivery, .queued)
        store.apply(PromptStatus(id: id, status: "claimed"))
        XCTAssertEqual(store.outgoing.first?.delivery, .queued)
        store.apply(PromptStatus(id: id, status: "delivered"))
        store.apply(PromptStatus(id: id, status: "queued"))
        XCTAssertEqual(store.outgoing.first?.delivery, .delivered)
        store.merge(snapshot([turn(1, "same message", role: "user", queued: true)]))
        XCTAssertEqual(store.outgoing.first?.delivery, .delivered)
        XCTAssertTrue(store.unmirroredOutgoing.isEmpty)
        XCTAssertEqual(store.delivery(for: store.turns.last!), .delivered)
        store.merge(snapshot([turn(1, "same message", role: "user")]))
        XCTAssertEqual(store.outgoing.first?.delivery, .seen)
        store.apply(PromptStatus(id: id, status: "delivered"))
        XCTAssertEqual(store.outgoing.first?.delivery, .seen)
    }

    func testRepeatedTextCannotReuseOneTranscriptTurnForTwoReceipts() async {
        let store = store(StubHub())
        _ = await store.send("repeat")
        _ = await store.send("repeat")
        store.merge(snapshot([turn(0, "repeat", role: "user")]))
        XCTAssertEqual(store.outgoing.map(\.delivery), [.seen, .queued])
        store.merge(snapshot([turn(1, "repeat", role: "user")]))
        XCTAssertEqual(store.outgoing.map(\.delivery), [.seen, .seen])
    }

    func testReceiptsSurfaceFailureReasonsAndExpiry() async throws {
        let hub = StubHub(), store = store(StubHub())
        store.api = hub
        _ = await store.send("continue")
        let id = try XCTUnwrap(store.outgoing.first?.promptID)
        hub.promptsData = [id: PromptStatus(id: id, status: "failed", outcome: "blocked", error: "Answer on the Mac first")]
        await store.refreshReceipts()
        XCTAssertEqual(store.outgoing.first?.delivery, .failed("Answer on the Mac first"))
        _ = await store.send("again")
        let second = try XCTUnwrap(store.outgoing.last?.promptID)
        hub.promptsData[second] = PromptStatus(id: second, status: "expired")
        await store.refreshReceipts()
        XCTAssertEqual(store.outgoing.last?.delivery, .failed("No Mac is relaying this project. Is the Trantor app open?"))
    }

    func testWriteFailuresKeepReasonAndTimeoutReconcilesWithoutDuplicatePost() async {
        let hub = StubHub(), store = store(StubHub())
        store.api = hub
        hub.writeError = .forbidden("This key cannot send prompts")
        let denied = await store.send("hello")
        XCTAssertFalse(denied)
        XCTAssertEqual(store.sendError, "This key cannot send prompts")
        hub.writeError = .timeout(op: "one-op")
        hub.outcome = OpOutcome(status: "committed", body: .object(["id": .string("prompt-recovered"), "status": .string("queued")]))
        let recovered = await store.send("second")
        XCTAssertTrue(recovered)
        XCTAssertEqual(store.outgoing.last?.promptID, "prompt-recovered")
        XCTAssertEqual(hub.calls.filter { $0 == "prompt:trantor:second" }.count, 1)
        XCTAssertTrue(hub.calls.contains("reconcile:one-op"))
        hub.outcome = OpOutcome(status: "unknown")
        let unknown = await store.send("third")
        XCTAssertFalse(unknown)
        XCTAssertTrue(store.sendError?.contains("Delivery is unconfirmed") == true)
    }

    func testMissingReceiptDoesNotStayQueuedForever() async {
        let hub = StubHub(), store = store(StubHub())
        store.api = hub
        _ = await store.send("continue")
        hub.readError = .notFound("prompt not found")
        await store.refreshReceipts()
        XCTAssertEqual(store.outgoing.first?.delivery, .failed("This prompt receipt is no longer available. Check the conversation on your Mac."))
    }

    func testNoHostNoWriteScopeAndOversizePreventAnySend() async {
        let hub = StubHub(), store = store(StubHub())
        store.api = hub
        store.mayWrite = { false }
        XCTAssertTrue(store.disabledReason?.contains("write access") == true)
        let denied = await store.send("hello")
        XCTAssertFalse(denied)
        store.mayWrite = { true }
        store.merge(snapshot([], host: ""))
        let noHost = await store.send("hello")
        XCTAssertFalse(noHost)
        XCTAssertTrue(store.disabledReason?.contains("No Mac") == true)
        store.merge(snapshot([]))
        let oversized = await store.send(String(repeating: "😀", count: 4001))
        XCTAssertFalse(oversized)
        XCTAssertFalse(hub.calls.contains { $0.hasPrefix("prompt:") })
        XCTAssertFalse(ChatStore.allowsWriting(scopes: [.init(project: "trantor", role: "read")], project: "trantor"))
        XCTAssertFalse(ChatStore.allowsWriting(scopes: [.init(project: "other", role: "owner")], project: "trantor"))
        XCTAssertTrue(ChatStore.allowsWriting(scopes: [.init(project: "*", role: "approver")], project: "trantor"))
    }

    func testCacheRestoresOnly200TurnsAsStaleAndCannotAuthorizeSend() throws {
        let directory = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        defer { try? FileManager.default.removeItem(at: directory) }
        let cache = StoreCache(directory: directory)
        let store = ChatStore(project: "trantor", cache: cache)
        store.merge(snapshot((0..<250).map { turn($0, "row") }))
        let restored = ChatStore(project: "trantor", api: StubHub(), cache: cache)
        restored.mayWrite = { true }
        XCTAssertEqual(restored.turns.count, 200)
        XCTAssertEqual(restored.turns.first?.idx, 50)
        XCTAssertTrue(restored.freshness.isStale)
        XCTAssertFalse(restored.hasLiveSnapshot)
        XCTAssertNotNil(restored.disabledReason)
    }

    func testSharedFeedRoutesLiveFramesAndReceiptEventsToChat() async {
        let feed = FeedStore()
        let received = expectation(description: "live chat callbacks")
        received.expectedFulfillmentCount = 3
        var signals: [ChatSignal?] = []
        feed.start(updates: { _ in AsyncStream { continuation in
            continuation.yield(.connected)
            continuation.yield(.chat(ChatSignal(project: "trantor")))
            continuation.yield(.event(HubEvent(id: 9, ts: 1, type: "chat.prompt.delivered", project: "trantor", payload: .object(["promptId": .string("p1")]))))
            continuation.finish()
        } }, onChat: { signal in signals.append(signal); received.fulfill() })
        await fulfillment(of: [received], timeout: 2)
        XCTAssertEqual(signals, [nil, ChatSignal(project: "trantor"), ChatSignal(project: "trantor", promptID: "p1")])
        feed.stop()
    }

    func testStoresAreSeparatePerProjectAndRefreshReplacesEarlierQueuedTurn() async {
        let hub = StubHub()
        let model = AppModel(stub: hub, demo: true)
        XCTAssertTrue(model.chat(project: "a") === model.chat(project: "a"))
        XCTAssertFalse(model.chat(project: "a") === model.chat(project: "b"))
        let store = model.chat(project: "a")
        store.merge(snapshot([turn(0, "first"), turn(1, "tail")]))
        hub.chatsData = ["a": snapshot([turn(0, "edited earlier"), turn(1, "tail changed")])]
        await store.refresh()
        XCTAssertEqual(store.turns.map(\.text), ["edited earlier", "tail changed"])
    }

    func testDraftLivesOnTheStoreSurvivesRefreshAndStaysPerProject() async {
        let hub = StubHub()
        let model = AppModel(stub: hub, demo: true)
        let store = model.chat(project: "a")
        store.draft = "fix the gate"
        model.chat(project: "b").draft = "ship it"
        hub.chatsData = ["a": snapshot([turn(0, "row")])]
        await store.refresh()
        store.merge(snapshot([turn(0, "row"), turn(1, "more")]))
        XCTAssertEqual(store.draft, "fix the gate")
        XCTAssertEqual(model.chat(project: "b").draft, "ship it")
        XCTAssertTrue(model.chat(project: "a") === store)
        store.disconnect()
        XCTAssertEqual(store.draft, "")
    }
}
