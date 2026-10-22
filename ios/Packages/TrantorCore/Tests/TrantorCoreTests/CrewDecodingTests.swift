import XCTest
@testable import TrantorCore

final class CrewDecodingTests: XCTestCase {
    func testMachineRosterEnvelopeSkipsMalformedRows() throws {
        let payload = #"{"machines":[null,{"machine":"sasha@mac","updatedAt":"1000","seats":[false,{"agent":"glm","metered":false,"available":true,"reason":""}]}]}"#
        let roster = try JSONDecoder().decode(CrewRosterResponse.self, from: Data(payload.utf8))
        XCTAssertEqual(roster.machines.count, 1)
        XCTAssertEqual(roster.machines[0].machine, "sasha@mac")
        XCTAssertEqual(roster.machines[0].updatedAt, 1000)
        XCTAssertEqual(roster.machines[0].seats.map(\.agent), ["glm"])
    }

    func testRosterToleratesMissingFieldsWithoutAssumingFreeOrAvailable() throws {
        let seat = try JSONDecoder().decode(RosterSeat.self, from: Data(#"{"agent":"glm","label":42,"plan":null,"metered":"unknown","available":1,"reason":"No key","newField":true}"#.utf8))
        XCTAssertEqual(seat.agent, "glm")
        XCTAssertEqual(seat.label, "42")
        XCTAssertEqual(seat.plan, "")
        XCTAssertTrue(seat.metered)
        XCTAssertTrue(seat.available)
        XCTAssertEqual(seat.reason, "No key")
        let missing = try JSONDecoder().decode(RosterSeat.self, from: Data("{}".utf8))
        XCTAssertTrue(missing.metered)
        XCTAssertFalse(missing.available)
    }

    func testCommandNumericIDOutputAndTerminalStatuses() throws {
        for status in ["queued", "claimed", "done", "failed", "expired"] {
            let json = "{\"id\":42,\"status\":\"\(status)\",\"output\":\"last 2000 chars\",\"outcome\":\"done\"}"
            let receipt = try JSONDecoder().decode(CrewCommandStatus.self, from: Data(json.utf8))
            XCTAssertEqual(receipt.id, "42")
            XCTAssertEqual(receipt.output, "last 2000 chars")
            XCTAssertEqual(receipt.isFinal, ["done", "failed", "expired"].contains(status))
            XCTAssertEqual(receipt.label, status == "claimed" ? "Running" : status.capitalized)
        }
        let missing = try JSONDecoder().decode(CrewCommandStatus.self, from: Data("{}".utf8))
        XCTAssertEqual(missing.error, "")
        XCTAssertFalse(missing.isFinal)
    }
}
