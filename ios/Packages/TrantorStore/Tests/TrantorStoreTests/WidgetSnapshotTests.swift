import TrantorCore
import XCTest
@testable import TrantorStore

@MainActor
final class WidgetSnapshotTests: XCTestCase {

    // MARK: Derivation from DecisionItems

    func testDeriveCountsByKind() {
        let items = DecisionsStore.merge(
            holds: [Hold(id: 1, project: "trantor", file: "hub.mjs", ts: 100),
                    Hold(id: 2, project: "trantor", file: "lib/x.mjs", ts: 90)],
            proposals: [Proposal(id: 7, project: "trantor", scope: "deploy anytime", ts: 80)],
            gates: [VerifyGate(id: 3, project: "trantor", claim: "widget renders", ts: 70)],
            asks: [BusMessage(id: 4, ts: 60, from: "codex", text: "ship it?", kind: "ask")],
            answeredAsks: [])
        let snap = WidgetSnapshot.derive(from: items)
        XCTAssertEqual(snap.count, 5)
        XCTAssertEqual(snap.holds, 2)
        XCTAssertEqual(snap.gates, 1)
        XCTAssertEqual(snap.proposals, 1)
        XCTAssertEqual(snap.asks, 1)
    }

    func testDeriveTopIsHighestPriorityThenOldest() {
        let items = DecisionsStore.merge(
            holds: [Hold(id: 1, project: "trantor", file: "hub.mjs", ts: 100),
                    Hold(id: 2, project: "trantor", file: "lib/older.mjs", ts: 90)],
            proposals: [Proposal(id: 7, project: "trantor", scope: "deploy anytime", ts: 10)],
            gates: [VerifyGate(id: 3, project: "trantor", claim: "widget renders", ts: 5)],
            asks: [],
            answeredAsks: [])
        let top = WidgetSnapshot.derive(from: items).top
        XCTAssertEqual(top?.kind, "hold")
        XCTAssertEqual(top?.title, "lib/older.mjs")
        XCTAssertEqual(top?.project, "trantor")
        XCTAssertEqual(top?.ts, 90)
    }

    func testDeriveTopTitlesPerKind() {
        let gate = WidgetSnapshot.derive(from: DecisionsStore.merge(
            holds: [], proposals: [], gates: [VerifyGate(id: 1, claim: "a claim", ts: 1)], asks: [], answeredAsks: []))
        XCTAssertEqual(gate.top?.kind, "gate")
        XCTAssertEqual(gate.top?.title, "a claim")

        let proposal = WidgetSnapshot.derive(from: DecisionsStore.merge(
            holds: [], proposals: [Proposal(id: 1, scope: "some scope", ts: 1)], gates: [], asks: [], answeredAsks: []))
        XCTAssertEqual(proposal.top?.kind, "proposal")
        XCTAssertEqual(proposal.top?.title, "some scope")

        let ask = WidgetSnapshot.derive(from: DecisionsStore.merge(
            holds: [], proposals: [], gates: [],
            asks: [BusMessage(id: 1, ts: 1, from: "glm-4", text: "which build?", kind: "ask")], answeredAsks: []))
        XCTAssertEqual(ask.top?.kind, "ask")
        XCTAssertEqual(ask.top?.title, "which build?")
    }

    func testDeriveEmptyQueue() {
        let snap = WidgetSnapshot.derive(from: [])
        XCTAssertEqual(snap.count, 0)
        XCTAssertNil(snap.top)
        XCTAssertEqual(snap.holds + snap.gates + snap.proposals + snap.asks, 0)
    }

    // MARK: Encode / decode

    func testEncodeDecodeRoundTrip() throws {
        let snap = WidgetSnapshot(
            count: 2, holds: 1, gates: 0, proposals: 0, asks: 1,
            top: .init(kind: "hold", title: "hub.mjs", project: "trantor", ts: 123.5),
            savedAt: Date(timeIntervalSince1970: 1_760_000_000))
        let enc = JSONEncoder(); enc.dateEncodingStrategy = .secondsSince1970
        let data = try enc.encode(snap)
        let dec = JSONDecoder(); dec.dateDecodingStrategy = .secondsSince1970
        let back = try dec.decode(WidgetSnapshot.self, from: data)
        XCTAssertEqual(back, snap)
    }

    // MARK: The App Group file

    func testStoreSaveLoadClear() {
        let dir = FileManager.default.temporaryDirectory.appendingPathComponent("widget-snap-\(UUID().uuidString)")
        let store = WidgetSnapshotStore(directory: dir)
        XCTAssertNil(store.load())

        let snap = WidgetSnapshot(count: 1, holds: 1, gates: 0, proposals: 0, asks: 0,
                                  top: .init(kind: "hold", title: "a.mjs", project: "p", ts: 1),
                                  savedAt: Date(timeIntervalSince1970: 1_760_000_000))
        store.save(snap)
        XCTAssertEqual(store.load(), snap)

        store.clear()
        XCTAssertNil(store.load())
    }

    func testStoreWithoutDirectoryIsInert() {
        let store = WidgetSnapshotStore(directory: nil)
        store.save(WidgetSnapshot(count: 1, holds: 0, gates: 0, proposals: 0, asks: 0, top: nil, savedAt: Date()))
        XCTAssertNil(store.load())
        store.clear()
    }
}
