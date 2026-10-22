import Foundation

public struct RosterSeat: Codable, Equatable, Sendable, Identifiable {
    public var agent: String
    public var spec: String
    public var label: String
    public var plan: String
    public var metered: Bool
    public var available: Bool
    public var reason: String
    public var id: String { agent }
    public var launchSpec: String { spec.isEmpty ? agent : spec }

    public init(agent: String, spec: String = "", label: String = "", plan: String = "", metered: Bool = true,
                available: Bool = false, reason: String = "") {
        self.agent = agent; self.spec = spec; self.label = label; self.plan = plan
        self.metered = metered; self.available = available; self.reason = reason
    }

    enum CodingKeys: String, CodingKey { case agent, spec, label, plan, metered, available, reason }
    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        agent = c.lenientString(.agent); spec = c.lenientString(.spec); label = c.lenientString(.label); plan = c.lenientString(.plan)
        // An incomplete roster must never silently bypass a cost confirmation.
        metered = c.lenient(Bool.self, .metered) ?? true
        available = c.lenientBool(.available); reason = c.lenientString(.reason)
    }
}

public enum CrewAction: String, Codable, Sendable { case up, down, swap }

public struct CrewCommandStatus: Codable, Equatable, Sendable, Identifiable {
    public var id: String
    public var status: String
    public var outcome: String
    public var output: String
    public var error: String

    public init(id: String = "", status: String = "", outcome: String = "", output: String = "", error: String = "") {
        self.id = id; self.status = status; self.outcome = outcome; self.output = output; self.error = error
    }
    public var isFinal: Bool { ["done", "failed", "expired"].contains(status) }
    public var label: String { status == "claimed" ? "Running" : status.capitalized }

    enum CodingKeys: String, CodingKey { case id, status, outcome, output, error }
    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        id = c.lenientString(.id); status = c.lenientString(.status); outcome = c.lenientString(.outcome)
        output = c.lenientString(.output); error = c.lenientString(.error)
    }
}

public struct CrewRosterMachine: Codable, Equatable, Sendable, Identifiable {
    public var machine: String
    public var updatedAt: Double
    public var seats: [RosterSeat]
    public var id: String { machine }

    public init(machine: String, updatedAt: Double = 0, seats: [RosterSeat] = []) {
        self.machine = machine; self.updatedAt = updatedAt; self.seats = seats
    }
    enum CodingKeys: String, CodingKey { case machine, updatedAt, seats }
    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        machine = c.lenientString(.machine); updatedAt = c.lenientDouble(.updatedAt)
        seats = c.lenientArray(RosterSeat.self, .seats)
    }
}

public struct CrewRosterResponse: Decodable, Sendable {
    public var machines: [CrewRosterMachine]
    enum CodingKeys: String, CodingKey { case machines }
    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        machines = c.lenientArray(CrewRosterMachine.self, .machines)
    }
}
