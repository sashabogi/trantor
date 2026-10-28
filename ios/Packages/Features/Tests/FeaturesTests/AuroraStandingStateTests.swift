import XCTest
import TrantorCore
import TrantorDesign
import TrantorStore
@testable import Features

@MainActor
final class AuroraStandingStateTests: XCTestCase {
    func testRunnerFailureOutranksPendingDecisionsAndWorkingStatus() {
        for peer in [
            Peer(session: "seat", online: true, status: "errored: auth"),
            Peer(session: "seat", online: true, status: "down: turn failed"),
            Peer(session: "seat", online: true, status: "working", health: "errored"),
            Peer(session: "seat", online: false, health: "failed")
        ] {
            let state = AuroraStandingState(peers: [peer], waiting: 2)
            XCTAssertEqual(state.wash, .failed)
            XCTAssertEqual(state.failed, 1)
            XCTAssertEqual(state.working, 0)
            XCTAssertEqual(state.idle, 0)
            XCTAssertTrue(state.headline.contains("1 failed"))
            XCTAssertTrue(AuroraStandingState.caption(peer).contains("Failed"))
        }
    }

    func testOfflineIsNotFailureAndWorkingTriggerCountsAsWorking() {
        let state = AuroraStandingState(peers: [
            Peer(session: "working", online: true, status: "working · bus"),
            Peer(session: "idle", online: true, status: "idle"),
            Peer(session: "offline", online: false, status: "stale")
        ], waiting: 0)
        XCTAssertEqual(state.wash, .clear)
        XCTAssertEqual(state.headline, "1 working · 1 idle")
    }

    func testCrewCountsOnlyTheSeatsShownInItsList() async {
        let hub = StubHub()
        hub.peersData = [
            Peer(session: "orchestrator:one", online: true, project: "one", kind: "claude"),
            Peer(session: "codex-1:one", online: true, status: "working", project: "one", kind: "agent"),
            Peer(session: "glm-1:one", online: true, status: "idle", project: "one", kind: "agent"),
            Peer(session: "codex-2:two", online: true, status: "working", project: "two", kind: "agent")
        ]
        let model = AppModel(stub: hub)
        await model.refreshAll()
        let state = model.standingState(for: model.crew(project: "one"))
        XCTAssertEqual(state.headline, "1 working · 1 idle")
        XCTAssertEqual(state.working + state.idle, model.crew(project: "one").seats.count)
    }

    func testStoreRefreshScopesStateAndClearsWaitingWithoutUsingFeedEvents() async {
        let hub = StubHub()
        hub.holdsData = [Hold(id: 1, project: "one", file: "app.swift", session: "seat:one")]
        hub.peersData = [
            Peer(session: "seat:one", online: true, status: "working", project: "one"),
            Peer(session: "seat:two", online: true, status: "errored: auth", project: "two")
        ]
        hub.eventsData = [HubEvent(id: 1, type: "crew.failed", project: "one")]
        let model = AppModel(stub: hub)
        await model.refreshAll()
        XCTAssertEqual(model.standingState().wash, .failed)
        XCTAssertEqual(model.standingState(project: "one").wash, .waiting)
        XCTAssertEqual(model.standingState(project: "one").waiting, 1)
        XCTAssertEqual(model.standingState(project: "two").waiting, 0)
        hub.holdsData = []
        hub.peersData = []
        await model.refreshAll()
        XCTAssertEqual(model.standingState().wash, .clear)
        XCTAssertEqual(model.standingState(project: "one", questions: 1).wash, .waiting)
    }
}
