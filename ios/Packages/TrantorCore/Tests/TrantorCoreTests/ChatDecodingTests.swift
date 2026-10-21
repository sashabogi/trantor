import XCTest
@testable import TrantorCore

final class ChatDecodingTests: XCTestCase {
    func testDesktopMirrorFixtureToleratesExtraAndMissingFields() throws {
        let fixture = #"{"session":"s1","total":"2","host":"mac","updatedAt":"1234","meta":{"working":1,"model":"Claude","context":{"tokens":"42000","window":200000,"frac":0.21}},"turns":[{"idx":"0","role":"user","blocks":[{"kind":"text","text":"hello"}],"queued":true},{"idx":1,"role":"assistant","blocks":[{"kind":"tool","tool":"AskUserQuestion","ask":[{"question":"Which project?","options":[{"label":"Trantor","description":"Continue"}],"multiSelect":false}],"extra":"ignored"},42,{"kind":"text","text":"Ready"}]}],"unknown":true}"#
        let chat = try JSONDecoder().decode(ChatSnapshot.self, from: Data(fixture.utf8))
        XCTAssertEqual(chat.total, 2)
        XCTAssertEqual(chat.host, "mac")
        XCTAssertTrue(chat.meta.working)
        XCTAssertEqual(chat.meta.context.fraction, 0.21)
        XCTAssertTrue(chat.turns[0].queued)
        XCTAssertEqual(chat.turns[1].blocks.count, 2)
        XCTAssertTrue(chat.turns[1].blocks[0].isQuestion)
        XCTAssertEqual(chat.turns[1].blocks[0].ask[0].options[0].label, "Trantor")
        XCTAssertEqual(chat.turns[1].text, "Ready")
    }

    func testBadTurnDoesNotReplaceZeroAndAbsentContextIsUnknown() throws {
        let fixture = #"{"turns":[null,{}, {"idx":-1},{"idx":"bad"},{"idx":0,"role":"user","blocks":null}],"meta":{"context":{"frac":null}}}"#
        let chat = try JSONDecoder().decode(ChatSnapshot.self, from: Data(fixture.utf8))
        XCTAssertEqual(chat.turns.map(\.idx), [0])
        XCTAssertNil(chat.meta.context.fraction)
        XCTAssertEqual(chat.host, "")
        XCTAssertFalse(chat.meta.working)
    }

    func testPromptFixturePreservesFailureReasonAndScalarID() throws {
        let receipt = try JSONDecoder().decode(PromptStatus.self, from: Data(#"{"id":42,"status":"failed","outcome":"blocked","error":"Answer the question on your Mac"}"#.utf8))
        XCTAssertEqual(receipt.id, "42")
        XCTAssertEqual(receipt.failureReason, "Answer the question on your Mac")
        XCTAssertTrue(PromptStatus(status: "expired").failureReason.contains("Is the Trantor app open?"))
    }

    func testAskWireFieldsAndCacheRoundTrip() throws {
        let fixture = #"{"kind":"ask","tool_id":"tool-7","questions":[{"header":"Scope","question":"Which?","multiSelect":1,"options":[{"label":"A","description":"First"},null,{"label":"B"}]}],"answer":"A, B"}"#
        let block = try JSONDecoder().decode(ChatBlock.self, from: Data(fixture.utf8))
        XCTAssertTrue(block.isQuestion)
        XCTAssertEqual(block.toolID, "tool-7")
        XCTAssertEqual(block.answer, "A, B")
        XCTAssertEqual(block.ask.first?.header, "Scope")
        XCTAssertEqual(block.ask.first?.multiSelect, true)
        XCTAssertEqual(block.ask.first?.options.map(\.label), ["A", "B"])
        XCTAssertEqual(try JSONDecoder().decode(ChatBlock.self, from: JSONEncoder().encode(block)), block)
        let absent = try JSONDecoder().decode(ChatBlock.self, from: Data(#"{"kind":"ask","questions":null,"answer":null}"#.utf8))
        XCTAssertNil(absent.answer)
        XCTAssertTrue(absent.ask.isEmpty)
        let empty = try JSONDecoder().decode(ChatBlock.self, from: Data(#"{"kind":"ask","answer":""}"#.utf8))
        XCTAssertEqual(empty.answer, "")
        XCTAssertEqual(PromptStatus(status: "failed", outcome: "stale").failureReason, "That question was already answered or replaced.")
    }

    func testContextDerivesOnlyFromKnownUsage() {
        XCTAssertEqual(ChatContext(tokens: 200, window: 1000).fraction, 0.2)
        XCTAssertNil(ChatContext(tokens: 200, window: 0).fraction)
        XCTAssertNil(ChatContext(frac: .infinity).fraction)
    }
}
