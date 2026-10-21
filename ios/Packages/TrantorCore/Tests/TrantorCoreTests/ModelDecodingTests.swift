import XCTest
@testable import TrantorCore

final class ModelDecodingTests: XCTestCase {
    private func decode<T: Decodable>(_ type: T.Type, _ json: String) throws -> T {
        try JSONDecoder().decode(type, from: Data(json.utf8))
    }

    func testProjectsResponseFromHubShape() throws {
        let json = #"""
        {"projects":[{"project":"trantor","brief":"the bus","agents":[
          {"session":"claude:trantor","online":true,"status":"working","health":"ok","llm":"claude","model":"opus","hookVersion":"0.18.109","staleHooks":false}],
         "tasks":{"todo":2,"doing":1,"testing":0,"failed":1,"done":40,"blocked":3},
         "doingTitles":["ios scaffold"],"lastActivity":1760000000000,"idle":false,"phase":"building: ios scaffold","newField":{"x":1}}]}
        """#
        let r = try decode(ProjectsResponse.self, json)
        XCTAssertEqual(r.projects.count, 1)
        let p = r.projects[0]
        XCTAssertEqual(p.id, "trantor")
        XCTAssertEqual(p.counts["done"], 40)
        XCTAssertEqual(p.agents.first?.model, "opus")
        XCTAssertEqual(p.openDecisionsHint, 4)
    }

    func testSlimCardAndFullCard() throws {
        let slim = try decode(TasksResponse.self, #"{"tasks":[{"id":12079,"project":"trantor","title":"ios","status":"doing","assignee":"claude:trantor","difficulty":"hard","logCount":7}],"fields":"slim"}"#)
        XCTAssertEqual(slim.tasks[0].logCount, 7)
        XCTAssertTrue(slim.tasks[0].log.isEmpty)

        let full = try decode(Card.self, #"""
        {"id":5,"title":"t","status":"testing","drill":"open the app","checklist":[{"text":"a","done":true},"junk",{"text":"b"}],
         "log":[{"ts":1,"by":"me","text":"started"},{"ts":"2","by":"you","text":"ok"}]}
        """#)
        XCTAssertEqual(full.checklist.count, 2)
        XCTAssertTrue(full.checklist[0].done)
        XCTAssertFalse(full.checklist[1].done)
        XCTAssertEqual(full.log.count, 2)
        XCTAssertEqual(full.log[1].ts, 2)
        XCTAssertEqual(full.logCount, 2)
        XCTAssertEqual(full.project, "")
    }

    func testEventIsFlatAndKeepsPayload() throws {
        let e = try decode(HubEvent.self, #"{"id":9,"ts":1760000000000,"type":"verify.gate.opened","project":"trantor","by":"codex","gateId":3,"claim":"signing matches","taskId":"41"}"#)
        XCTAssertEqual(e.id, 9)
        XCTAssertEqual(e.type, "verify.gate.opened")
        XCTAssertEqual(e.payload["gateId"]?.intValue, 3)
        XCTAssertEqual(e.summary, "signing matches")
        XCTAssertNil(e.taskId, "string taskId is not coerced; the row still decodes")
    }

    func testEventsResponseSkipsBadRows() throws {
        let r = try decode(EventsResponse.self, #"{"events":[{"id":1,"type":"a"},17,{"id":2,"type":"b"}],"cursor":2,"latest":5}"#)
        XCTAssertEqual(r.events.map(\.id), [1, 2])
        XCTAssertEqual(r.latest, 5)
    }

    func testHoldsProposalsGates() throws {
        let h = try decode(HoldsResponse.self, #"{"holds":[{"id":4,"project":"trantor","file":"hub.mjs","session":"kimi","other":"codex","status":"pending","ts":1}]}"#)
        XCTAssertTrue(h.holds[0].isPending)
        XCTAssertEqual(h.holds[0].other, "codex")

        let p = try decode(ProposalsResponse.self, #"{"proposals":[{"id":2,"session":"glm","project":"trantor","scope":"reap orphans","condition":"idle 1h","exclusions":"live seats","key":"patrol.reap","status":"pending","ts":9,"decidedTs":0,"decidedBy":"","note":""}],"pendingCount":1}"#)
        XCTAssertEqual(p.proposals[0].key, "patrol.reap")
        XCTAssertEqual(p.pendingCount, 1)

        let g = try decode(GatesResponse.self, #"{"gates":[{"id":1,"project":"trantor","claim":"c","why":"w","howToVerify":"run it","status":"open","by":"x","ts":3}]}"#)
        XCTAssertEqual(g.gates[0].howToVerify, "run it")
    }

    func testPeersAndBalances() throws {
        let peers = try decode(PeersResponse.self, #"{"hubVersion":"0.18.109","authMode":"enforce","peers":[{"session":"claude:trantor","lastSeen":5,"online":true,"status":"idle","health":"ok","project":"trantor","phase":"","phaseSince":0,"pubkey":"ab","identity":null,"authWarning":"","kind":"claude","llm":"claude","model":"opus","hookVersion":"x","staleHooks":false}]}"#)
        XCTAssertEqual(peers.peers[0].kind, "claude")
        XCTAssertEqual(peers.hubVersion, "0.18.109")

        let b = try decode(BalancesResponse.self, #"{"ts":1,"by":"mac","thresholds":{"USD":5},"entries":[{"provider":"deepseek","label":"DeepSeek","ok":true,"remaining":3.2,"currency":"USD","low":true},{"provider":"glm","kind":"subscription","plan":"max","ok":true,"remaining":null,"low":false}],"lowCount":1,"stale":false}"#)
        XCTAssertEqual(b.entries.count, 2)
        XCTAssertEqual(b.entries[0].remaining, 3.2)
        XCTAssertNil(b.entries[1].remaining)
        XCTAssertEqual(b.lowCount, 1)
    }

    func testInboxAndBusMessage() throws {
        let r = try decode(InboxResponse.self, #"{"messages":[{"id":10,"ts":1,"from":"codex","to":"ios-iphone","text":"approve?","project":"trantor","re":0,"kind":"ask"}],"cursor":10}"#)
        XCTAssertTrue(r.messages[0].isAsk)
        XCTAssertEqual(r.cursor, 10)
    }

    func testEnrollAndOverseer() throws {
        let e = try decode(EnrollResult.self, #"{"ok":true,"identity":{"name":"ios-iphone","kind":"human","pubkey":"ab"},"scopes":[{"project":"*","role":"owner"}]}"#)
        XCTAssertEqual(e.name, "ios-iphone")
        XCTAssertEqual(e.scopes.first?.role, "owner")
        let o = try decode(OverseerStatus.self, #"{"engine":true,"dutySession":"claude:trantor-duty","watching":{"sessions":3},"warnings":[{"file":"a.mjs","since":0}],"standing":1}"#)
        XCTAssertEqual(o.warnings.count, 1)
        XCTAssertEqual(o.standing, 1)
    }

    func testEmptyObjectsDecodeToDefaults() throws {
        XCTAssertEqual(try decode(Hold.self, "{}").id, 0)
        XCTAssertEqual(try decode(Peer.self, "{}").session, "")
        XCTAssertEqual(try decode(OpOutcome.self, "{}").isUnknown, true)
        XCTAssertEqual(try decode(OpOutcome.self, #"{"status":"rejected","code":409,"body":{}}"#).code, 409)
    }

    func testJSONValueRoundTrip() throws {
        let v = try decode(JSONValue.self, #"{"a":[1,"x",null,true],"b":{"c":2.5}}"#)
        let data = try JSONEncoder().encode(v)
        XCTAssertEqual(try JSONDecoder().decode(JSONValue.self, from: data), v)
        XCTAssertEqual(v["b"]?["c"]?.doubleValue, 2.5)
    }
}
