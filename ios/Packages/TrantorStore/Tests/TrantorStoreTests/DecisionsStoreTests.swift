import XCTest
import HubClient
import TrantorCore
@testable import TrantorStore

@MainActor
final class DecisionsStoreTests: XCTestCase {
    private func seededHub() -> StubHub {
        let hub = StubHub()
        hub.holdsData = [Hold(id: 2, project: "trantor", file: "b.mjs", session: "kimi", other: "codex", status: "pending", ts: 200),
                         Hold(id: 1, project: "trantor", file: "a.mjs", session: "glm", other: "codex", status: "pending", ts: 100),
                         Hold(id: 3, project: "trantor", file: "old.mjs", status: "go", ts: 50)]
        hub.gatesData = [VerifyGate(id: 9, project: "crm", claim: "coefficients", status: "open", ts: 10),
                         VerifyGate(id: 8, project: "crm", claim: "done one", status: "verified", ts: 5)]
        hub.proposalsData = [Proposal(id: 4, session: "codex", project: "trantor", scope: "reap", status: "pending", ts: 5),
                             Proposal(id: 5, session: "codex", project: "trantor", scope: "x", status: "approved", ts: 6)]
        hub.inboxData = [BusMessage(id: 30, ts: 300, from: "claude:trantor", to: "ios-phone", text: "ship it?", project: "trantor", kind: "ask"),
                         BusMessage(id: 31, ts: 310, from: "codex", to: "ios-phone", text: "fyi", kind: "")]
        return hub
    }

    func testMergeKeepsOnlyOpenItemsAndOrdersByKindThenAge() {
        let items = DecisionsStore.merge(
            holds: [Hold(id: 2, ts: 200), Hold(id: 1, ts: 100), Hold(id: 3, status: "go", ts: 1)],
            proposals: [Proposal(id: 4, status: "pending", ts: 5), Proposal(id: 5, status: "denied", ts: 6)],
            gates: [VerifyGate(id: 9, status: "open", ts: 10), VerifyGate(id: 8, status: "waived", ts: 5)],
            asks: [BusMessage(id: 30, ts: 300, kind: "ask"), BusMessage(id: 31, ts: 310, kind: "ask"), BusMessage(id: 32, ts: 1, kind: "")],
            answeredAsks: [31])
        XCTAssertEqual(items.map(\.id), ["hold-1", "hold-2", "gate-9", "proposal-4", "ask-30"])
    }

    func testRefreshBuildsOneQueueFromAllFourSources() async {
        let store = DecisionsStore(api: seededHub(), identity: "ios-phone")
        await store.refresh()
        XCTAssertEqual(store.items.map(\.id), ["hold-1", "hold-2", "gate-9", "proposal-4", "ask-30"])
        XCTAssertEqual(store.pendingCount, 5)
        XCTAssertNotNil(store.freshness.lastUpdated)
        XCTAssertFalse(store.freshness.isStale)
    }

    func testAnsweredAskLeavesTheQueue() async {
        let hub = seededHub()
        hub.inboxData.append(BusMessage(id: 40, ts: 400, from: "ios-phone", to: "claude:trantor", text: "yes", re: 30))
        let store = DecisionsStore(api: hub, identity: "ios-phone")
        await store.refresh()
        XCTAssertFalse(store.items.contains { $0.id == "ask-30" })
    }

    func testDecideIsNotOptimisticItStaysPendingUntilTheHubAnswers() async throws {
        let hub = seededHub()
        let store = DecisionsStore(api: hub, identity: "ios-phone")
        await store.refresh()
        let hold = try XCTUnwrap(store.items.compactMap { item -> Hold? in
            if case .hold(let h) = item.kind, h.id == 1 { return h } else { return nil } }.first)

        hub.holdWrites()
        let task = Task { await store.decideHold(hold, go: true) }
        // Wait until the write has reached the hub.
        for _ in 0..<200 where !hub.calls.contains("decideHold:1:go") { try await Task.sleep(nanoseconds: 5_000_000) }

        XCTAssertEqual(store.actions["hold-1"], .pending)
        XCTAssertTrue(store.items.contains { $0.id == "hold-1" }, "still in the queue while the hub has not answered")

        // The hub accepts and drops the hold from its list; only then does it leave the queue.
        hub.holdsData = hub.holdsData.filter { $0.id != 1 }
        hub.releaseWrites()
        await task.value
        XCTAssertNil(store.actions["hold-1"])
        XCTAssertFalse(store.items.contains { $0.id == "hold-1" })
    }

    func testSecondTapWhilePendingDoesNothing() async throws {
        let hub = seededHub()
        let store = DecisionsStore(api: hub, identity: "ios-phone")
        await store.refresh()
        let hold = Hold(id: 1)
        hub.holdWrites()
        let first = Task { await store.decideHold(hold, go: true) }
        for _ in 0..<200 where store.actions["hold-1"] != .pending { try await Task.sleep(nanoseconds: 5_000_000) }
        await store.decideHold(hold, go: false)
        hub.releaseWrites()
        await first.value
        XCTAssertEqual(hub.calls.filter { $0.hasPrefix("decideHold") }, ["decideHold:1:go"])
    }

    func testConflictMeansAlreadyDecidedAndRefreshes() async {
        let hub = seededHub()
        let store = DecisionsStore(api: hub, identity: "ios-phone")
        await store.refresh()
        hub.writeError = .conflict("hold already decided")
        hub.holdsData = hub.holdsData.filter { $0.id != 1 }       // the Mac decided it first
        let callsBefore = hub.calls.filter { $0 == "holds" }.count

        await store.decideHold(Hold(id: 1), go: true)

        XCTAssertEqual(store.actions["hold-1"], nil, "item is gone, so its note is dropped")
        XCTAssertNotNil(store.notice)
        XCTAssertFalse(store.items.contains { $0.id == "hold-1" })
        XCTAssertGreaterThan(hub.calls.filter { $0 == "holds" }.count, callsBefore, "refreshed after the 409")
    }

    func testFailureKeepsTheItemAndShowsTheReason() async {
        let hub = seededHub()
        let store = DecisionsStore(api: hub, identity: "ios-phone")
        await store.refresh()
        hub.writeError = .forbidden("operator permission required")
        await store.decideHold(Hold(id: 1), go: true)
        XCTAssertEqual(store.actions["hold-1"], .failed("operator permission required"))
        XCTAssertTrue(store.items.contains { $0.id == "hold-1" })
    }

    func testDroppedConnectionReconcilesBeforeReportingFailure() async {
        let hub = seededHub()
        let store = DecisionsStore(api: hub, identity: "ios-phone")
        await store.refresh()
        hub.writeError = .timeout(op: "op-1")
        hub.outcome = OpOutcome(status: "committed", code: 200)
        hub.holdsData = hub.holdsData.filter { $0.id != 1 }
        await store.decideHold(Hold(id: 1), go: true)
        XCTAssertTrue(hub.calls.contains("reconcile:op-1"))
        XCTAssertNil(store.actions["hold-1"], "the decision landed, so no error is shown")
        XCTAssertFalse(store.items.contains { $0.id == "hold-1" })
    }

    func testDroppedConnectionWithUnknownOutcomeIsAnHonestFailure() async {
        let hub = seededHub()
        let store = DecisionsStore(api: hub, identity: "ios-phone")
        await store.refresh()
        hub.writeError = .offline(op: "op-2")
        await store.decideHold(Hold(id: 1), go: false)
        guard case .failed(let msg)? = store.actions["hold-1"] else { return XCTFail("expected failure") }
        XCTAssertTrue(msg.contains("No answer"))
        XCTAssertTrue(store.items.contains { $0.id == "hold-1" })
    }

    func testProposalGateAndReplyCallTheRightEndpoints() async {
        let hub = seededHub()
        let store = DecisionsStore(api: hub, identity: "ios-phone")
        await store.refresh()
        await store.decideProposal(Proposal(id: 4), approve: false, note: "too broad")
        await store.resolveGate(VerifyGate(id: 9, project: "crm"), as: .waived, note: "n/a")
        await store.reply(to: BusMessage(id: 30, from: "claude:trantor", project: "trantor", kind: "ask"), text: "go")
        XCTAssertTrue(hub.calls.contains("decideProposal:4:denied:too broad"))
        XCTAssertTrue(hub.calls.contains("resolveGate:9:waived"))
        XCTAssertTrue(hub.calls.contains("send:claude:trantor:re=30:go"))
    }

    func testFailedRefreshKeepsDataAndMarksItStale() async {
        let hub = seededHub()
        let store = DecisionsStore(api: hub, identity: "ios-phone")
        await store.refresh()
        let count = store.items.count
        hub.readError = .offline(op: nil)
        await store.refresh()
        XCTAssertEqual(store.items.count, count)
        XCTAssertTrue(store.freshness.isStale)
        XCTAssertNotNil(store.freshness.staleSince)
    }

    func testCacheRestoresLastQueueMarkedStale() async throws {
        let dir = FileManager.default.temporaryDirectory.appendingPathComponent("trantor-cache-\(UUID().uuidString)")
        defer { try? FileManager.default.removeItem(at: dir) }
        let cache = StoreCache(directory: dir)
        let first = DecisionsStore(api: seededHub(), identity: "ios-phone", cache: cache)
        await first.refresh()

        let second = DecisionsStore(api: nil, identity: "ios-phone", cache: cache)
        XCTAssertEqual(second.items.map(\.id), first.items.map(\.id))
        XCTAssertTrue(second.freshness.isStale, "cached data is unconfirmed until the hub answers")
        XCTAssertNotNil(second.freshness.staleSince)
    }
}
