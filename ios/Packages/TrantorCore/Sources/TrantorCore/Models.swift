import Foundation

// Shapes mirror hub/routes/*.mjs. Every field is optional or defaulted and unknown keys are ignored.

public struct ChecklistItem: Codable, Equatable, Sendable, Hashable {
    public var text: String
    public var done: Bool
    public init(text: String = "", done: Bool = false) { self.text = text; self.done = done }
    enum CodingKeys: String, CodingKey { case text, done }
    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        text = c.lenientString(.text); done = c.lenientBool(.done)
    }
}

public struct LogEntry: Codable, Equatable, Sendable, Hashable {
    public var ts: Double
    public var by: String
    public var text: String
    public init(ts: Double = 0, by: String = "", text: String = "") { self.ts = ts; self.by = by; self.text = text }
    enum CodingKeys: String, CodingKey { case ts, by, text }
    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        ts = c.lenientDouble(.ts); by = c.lenientString(.by); text = c.lenientString(.text)
    }
}

public struct Card: Codable, Equatable, Sendable, Identifiable, Hashable {
    public var id: Int
    public var project: String
    public var title: String
    public var status: String
    public var assignee: String
    public var difficulty: String
    public var drill: String
    public var phase: String
    public var model: String
    public var updated: Double
    public var checklist: [ChecklistItem]
    public var log: [LogEntry]
    /// Slim rows drop `log` and send only a count.
    public var logCount: Int

    public init(id: Int, project: String = "", title: String = "", status: String = "todo", assignee: String = "",
                difficulty: String = "", drill: String = "", phase: String = "", model: String = "",
                updated: Double = 0, checklist: [ChecklistItem] = [], log: [LogEntry] = [], logCount: Int = 0) {
        self.id = id; self.project = project; self.title = title; self.status = status; self.assignee = assignee
        self.difficulty = difficulty; self.drill = drill; self.phase = phase; self.model = model
        self.updated = updated; self.checklist = checklist; self.log = log; self.logCount = logCount
    }

    enum CodingKeys: String, CodingKey {
        case id, project, title, status, assignee, difficulty, drill, phase, model, updated, checklist, log, logCount
    }
    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        id = c.lenientInt(.id); project = c.lenientString(.project); title = c.lenientString(.title)
        status = c.lenientString(.status); assignee = c.lenientString(.assignee)
        difficulty = c.lenientString(.difficulty); drill = c.lenientString(.drill)
        phase = c.lenientString(.phase); model = c.lenientString(.model); updated = c.lenientDouble(.updated)
        checklist = c.lenientArray(ChecklistItem.self, .checklist)
        log = c.lenientArray(LogEntry.self, .log)
        let n = c.lenientInt(.logCount)
        logCount = n > 0 ? n : log.count
    }
}

public struct ProjectAgent: Codable, Equatable, Sendable, Hashable {
    public var session: String
    public var online: Bool
    public var status: String
    public var health: String
    public var llm: String
    public var model: String
    public init(session: String = "", online: Bool = false, status: String = "", health: String = "", llm: String = "", model: String = "") {
        self.session = session; self.online = online; self.status = status; self.health = health; self.llm = llm; self.model = model
    }
    enum CodingKeys: String, CodingKey { case session, online, status, health, llm, model }
    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        session = c.lenientString(.session); online = c.lenientBool(.online); status = c.lenientString(.status)
        health = c.lenientString(.health); llm = c.lenientString(.llm); model = c.lenientString(.model)
    }
}

public struct Project: Codable, Equatable, Sendable, Identifiable, Hashable {
    public var project: String
    public var brief: String
    public var phase: String
    public var idle: Bool
    public var lastActivity: Double
    public var counts: [String: Int]
    public var doingTitles: [String]
    public var agents: [ProjectAgent]
    public var id: String { project }

    public init(project: String, brief: String = "", phase: String = "", idle: Bool = false, lastActivity: Double = 0,
                counts: [String: Int] = [:], doingTitles: [String] = [], agents: [ProjectAgent] = []) {
        self.project = project; self.brief = brief; self.phase = phase; self.idle = idle
        self.lastActivity = lastActivity; self.counts = counts; self.doingTitles = doingTitles; self.agents = agents
    }

    enum CodingKeys: String, CodingKey { case project, brief, phase, idle, lastActivity, tasks, doingTitles, agents }
    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        project = c.lenientString(.project); brief = c.lenientString(.brief); phase = c.lenientString(.phase)
        idle = c.lenientBool(.idle); lastActivity = c.lenientDouble(.lastActivity)
        counts = c.lenient([String: Int].self, .tasks) ?? [:]
        doingTitles = c.lenient([String].self, .doingTitles) ?? []
        agents = c.lenientArray(ProjectAgent.self, .agents)
    }
    public func encode(to encoder: Encoder) throws {
        var c = encoder.container(keyedBy: CodingKeys.self)
        try c.encode(project, forKey: .project); try c.encode(brief, forKey: .brief); try c.encode(phase, forKey: .phase)
        try c.encode(idle, forKey: .idle); try c.encode(lastActivity, forKey: .lastActivity)
        try c.encode(counts, forKey: .tasks); try c.encode(doingTitles, forKey: .doingTitles); try c.encode(agents, forKey: .agents)
    }

    public var openDecisionsHint: Int { (counts["blocked"] ?? 0) + (counts["failed"] ?? 0) }
}

/// One row of the unified event log. Hub events are flat: type-specific fields sit beside the
/// common ones, so the whole object is kept as `payload` as well.
public struct HubEvent: Codable, Equatable, Sendable, Identifiable, Hashable {
    public var id: Int
    public var ts: Double
    public var type: String
    public var project: String
    public var by: String
    public var taskId: Int?
    public var payload: JSONValue

    public init(id: Int, ts: Double = 0, type: String = "", project: String = "", by: String = "",
                taskId: Int? = nil, payload: JSONValue = .null) {
        self.id = id; self.ts = ts; self.type = type; self.project = project; self.by = by
        self.taskId = taskId; self.payload = payload
    }

    enum CodingKeys: String, CodingKey { case id, ts, type, project, by, taskId }
    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        id = c.lenientInt(.id); ts = c.lenientDouble(.ts); type = c.lenientString(.type)
        project = c.lenientString(.project); by = c.lenientString(.by)
        taskId = c.lenient(Int.self, .taskId)
        payload = (try? JSONValue(from: decoder)) ?? .null
    }
    public func encode(to encoder: Encoder) throws {
        try payload.encode(to: encoder)
    }

    /// A short human line for the feed.
    public var summary: String {
        for key in ["text", "title", "claim", "scope", "file", "note"] {
            if let s = payload[key]?.stringValue, !s.isEmpty { return s }
        }
        return type
    }
}

public struct Hold: Codable, Equatable, Sendable, Identifiable, Hashable {
    public var id: Int
    public var project: String
    public var file: String
    public var session: String
    public var other: String
    public var status: String
    public var ts: Double
    public init(id: Int, project: String = "", file: String = "", session: String = "", other: String = "",
                status: String = "pending", ts: Double = 0) {
        self.id = id; self.project = project; self.file = file; self.session = session
        self.other = other; self.status = status; self.ts = ts
    }
    enum CodingKeys: String, CodingKey { case id, project, file, session, other, status, ts }
    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        id = c.lenientInt(.id); project = c.lenientString(.project); file = c.lenientString(.file)
        session = c.lenientString(.session); other = c.lenientString(.other)
        status = c.lenientString(.status); ts = c.lenientDouble(.ts)
    }
    public var isPending: Bool { status == "pending" || status == "" || status == "open" }
}

public struct Proposal: Codable, Equatable, Sendable, Identifiable, Hashable {
    public var id: Int
    public var session: String
    public var project: String
    public var scope: String
    public var condition: String
    public var exclusions: String
    public var key: String
    public var status: String
    public var ts: Double
    public var decidedBy: String
    public var note: String
    public init(id: Int, session: String = "", project: String = "", scope: String = "", condition: String = "",
                exclusions: String = "", key: String = "", status: String = "pending", ts: Double = 0,
                decidedBy: String = "", note: String = "") {
        self.id = id; self.session = session; self.project = project; self.scope = scope
        self.condition = condition; self.exclusions = exclusions; self.key = key; self.status = status
        self.ts = ts; self.decidedBy = decidedBy; self.note = note
    }
    enum CodingKeys: String, CodingKey { case id, session, project, scope, condition, exclusions, key, status, ts, decidedBy, note }
    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        id = c.lenientInt(.id); session = c.lenientString(.session); project = c.lenientString(.project)
        scope = c.lenientString(.scope); condition = c.lenientString(.condition)
        exclusions = c.lenientString(.exclusions); key = c.lenientString(.key)
        status = c.lenientString(.status); ts = c.lenientDouble(.ts)
        decidedBy = c.lenientString(.decidedBy); note = c.lenientString(.note)
    }
}

public struct VerifyGate: Codable, Equatable, Sendable, Identifiable, Hashable {
    public var id: Int
    public var project: String
    public var claim: String
    public var why: String
    public var howToVerify: String
    public var status: String
    public var by: String
    public var ts: Double
    public init(id: Int, project: String = "", claim: String = "", why: String = "", howToVerify: String = "",
                status: String = "open", by: String = "", ts: Double = 0) {
        self.id = id; self.project = project; self.claim = claim; self.why = why
        self.howToVerify = howToVerify; self.status = status; self.by = by; self.ts = ts
    }
    enum CodingKeys: String, CodingKey { case id, project, claim, why, howToVerify, status, by, ts }
    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        id = c.lenientInt(.id); project = c.lenientString(.project); claim = c.lenientString(.claim)
        why = c.lenientString(.why); howToVerify = c.lenientString(.howToVerify)
        status = c.lenientString(.status); by = c.lenientString(.by); ts = c.lenientDouble(.ts)
    }
}

public struct Peer: Codable, Equatable, Sendable, Identifiable, Hashable {
    public var session: String
    public var online: Bool
    public var status: String
    public var health: String
    public var project: String
    public var phase: String
    public var llm: String
    public var model: String
    public var kind: String
    public var lastSeen: Double
    public var id: String { session }
    public init(session: String, online: Bool = false, status: String = "", health: String = "", project: String = "",
                phase: String = "", llm: String = "", model: String = "", kind: String = "", lastSeen: Double = 0) {
        self.session = session; self.online = online; self.status = status; self.health = health
        self.project = project; self.phase = phase; self.llm = llm; self.model = model; self.kind = kind
        self.lastSeen = lastSeen
    }
    enum CodingKeys: String, CodingKey { case session, online, status, health, project, phase, llm, model, kind, lastSeen }
    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        session = c.lenientString(.session); online = c.lenientBool(.online); status = c.lenientString(.status)
        health = c.lenientString(.health); project = c.lenientString(.project); phase = c.lenientString(.phase)
        llm = c.lenientString(.llm); model = c.lenientString(.model); kind = c.lenientString(.kind)
        lastSeen = c.lenientDouble(.lastSeen)
    }
}

public struct BalanceEntry: Codable, Equatable, Sendable, Identifiable, Hashable {
    public var provider: String
    public var label: String
    public var kind: String
    public var plan: String
    public var ok: Bool
    public var remaining: Double?
    public var remainingPct: Double?
    public var currency: String
    public var low: Bool
    public var id: String { provider + "/" + label }
    public init(provider: String, label: String = "", kind: String = "", plan: String = "", ok: Bool = true,
                remaining: Double? = nil, remainingPct: Double? = nil, currency: String = "USD", low: Bool = false) {
        self.provider = provider; self.label = label; self.kind = kind; self.plan = plan; self.ok = ok
        self.remaining = remaining; self.remainingPct = remainingPct; self.currency = currency; self.low = low
    }
    enum CodingKeys: String, CodingKey { case provider, label, kind, plan, ok, remaining, remainingPct, currency, low }
    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        provider = c.lenientString(.provider); label = c.lenientString(.label); kind = c.lenientString(.kind)
        plan = c.lenientString(.plan); ok = c.lenient(Bool.self, .ok) ?? true
        remaining = c.lenient(Double.self, .remaining); remainingPct = c.lenient(Double.self, .remainingPct)
        currency = c.lenient(String.self, .currency) ?? "USD"; low = c.lenientBool(.low)
    }
}

public struct BusMessage: Codable, Equatable, Sendable, Identifiable, Hashable {
    public var id: Int
    public var ts: Double
    public var from: String
    public var to: String
    public var text: String
    public var project: String
    public var re: Int
    public var kind: String
    public init(id: Int, ts: Double = 0, from: String = "", to: String = "all", text: String = "",
                project: String = "", re: Int = 0, kind: String = "") {
        self.id = id; self.ts = ts; self.from = from; self.to = to; self.text = text
        self.project = project; self.re = re; self.kind = kind
    }
    enum CodingKeys: String, CodingKey { case id, ts, from, to, text, project, re, kind }
    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        id = c.lenientInt(.id); ts = c.lenientDouble(.ts); from = c.lenientString(.from)
        to = c.lenientString(.to); text = c.lenientString(.text); project = c.lenientString(.project)
        re = c.lenientInt(.re); kind = c.lenientString(.kind)
    }
    public var isAsk: Bool { kind == "ask" }
}

// MARK: - Response envelopes

public struct HealthInfo: Codable, Equatable, Sendable {
    public var ok: Bool
    public var authMode: String
    public var peers: Int
    public var messages: Int
    public init(ok: Bool = false, authMode: String = "", peers: Int = 0, messages: Int = 0) {
        self.ok = ok; self.authMode = authMode; self.peers = peers; self.messages = messages
    }
    enum CodingKeys: String, CodingKey { case ok, authMode, peers, messages }
    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        ok = c.lenientBool(.ok); authMode = c.lenientString(.authMode)
        peers = c.lenientInt(.peers); messages = c.lenientInt(.messages)
    }
}

public struct Scope: Codable, Equatable, Sendable, Hashable {
    public var project: String
    public var role: String
    public init(project: String = "", role: String = "") { self.project = project; self.role = role }
    enum CodingKeys: String, CodingKey { case project, role }
    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        project = c.lenientString(.project); role = c.lenientString(.role)
    }
}

public struct EnrollResult: Decodable, Equatable, Sendable {
    public var ok: Bool
    public var name: String
    public var scopes: [Scope]
    public init(ok: Bool = false, name: String = "", scopes: [Scope] = []) { self.ok = ok; self.name = name; self.scopes = scopes }
    enum CodingKeys: String, CodingKey { case ok, identity, scopes }
    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        ok = c.lenientBool(.ok)
        name = (c.lenient(JSONValue.self, .identity))?["name"]?.stringValue ?? ""
        scopes = c.lenientArray(Scope.self, .scopes)
    }
}

public struct ProjectsResponse: Decodable, Sendable {
    public var projects: [Project]
    enum CodingKeys: String, CodingKey { case projects }
    public init(from decoder: Decoder) throws {
        projects = try decoder.container(keyedBy: CodingKeys.self).lenientArray(Project.self, .projects)
    }
}

public struct TasksResponse: Decodable, Sendable {
    public var tasks: [Card]
    enum CodingKeys: String, CodingKey { case tasks }
    public init(from decoder: Decoder) throws {
        tasks = try decoder.container(keyedBy: CodingKeys.self).lenientArray(Card.self, .tasks)
    }
}

public struct CardDetail: Decodable, Sendable {
    public var task: Card?
    public var events: [HubEvent]
    public var messages: [BusMessage]
    enum CodingKeys: String, CodingKey { case task, events, messages }
    public init(task: Card? = nil, events: [HubEvent] = [], messages: [BusMessage] = []) { self.task = task; self.events = events; self.messages = messages }
    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        task = c.lenient(Card.self, .task)
        events = c.lenientArray(HubEvent.self, .events)
        messages = c.lenientArray(BusMessage.self, .messages)
    }
}

public struct EventsResponse: Decodable, Sendable {
    public var events: [HubEvent]
    public var cursor: Int
    public var latest: Int
    enum CodingKeys: String, CodingKey { case events, cursor, latest }
    public init(events: [HubEvent] = [], cursor: Int = 0, latest: Int = 0) { self.events = events; self.cursor = cursor; self.latest = latest }
    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        events = c.lenientArray(HubEvent.self, .events); cursor = c.lenientInt(.cursor); latest = c.lenientInt(.latest)
    }
}

public struct InboxResponse: Decodable, Sendable {
    public var messages: [BusMessage]
    public var cursor: Int
    enum CodingKeys: String, CodingKey { case messages, cursor }
    public init(messages: [BusMessage] = [], cursor: Int = 0) { self.messages = messages; self.cursor = cursor }
    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        messages = c.lenientArray(BusMessage.self, .messages); cursor = c.lenientInt(.cursor)
    }
}

public struct Catchup: Decodable, Sendable {
    public var project: String
    public var brief: String
    public var counts: [String: Int]
    public var total: Int
    public var lastActivity: Double
    enum CodingKeys: String, CodingKey { case project, brief, counts, total, lastActivity }
    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        project = c.lenientString(.project); brief = c.lenientString(.brief)
        counts = c.lenient([String: Int].self, .counts) ?? [:]
        total = c.lenientInt(.total); lastActivity = c.lenientDouble(.lastActivity)
    }
}

public struct HoldsResponse: Decodable, Sendable {
    public var holds: [Hold]
    enum CodingKeys: String, CodingKey { case holds }
    public init(from decoder: Decoder) throws { holds = try decoder.container(keyedBy: CodingKeys.self).lenientArray(Hold.self, .holds) }
}

public struct ProposalsResponse: Decodable, Sendable {
    public var proposals: [Proposal]
    public var pendingCount: Int
    enum CodingKeys: String, CodingKey { case proposals, pendingCount }
    public init(proposals: [Proposal] = [], pendingCount: Int = 0) { self.proposals = proposals; self.pendingCount = pendingCount }
    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        proposals = c.lenientArray(Proposal.self, .proposals); pendingCount = c.lenientInt(.pendingCount)
    }
}

public struct GatesResponse: Decodable, Sendable {
    public var gates: [VerifyGate]
    enum CodingKeys: String, CodingKey { case gates }
    public init(from decoder: Decoder) throws { gates = try decoder.container(keyedBy: CodingKeys.self).lenientArray(VerifyGate.self, .gates) }
}

public struct PeersResponse: Decodable, Sendable {
    public var peers: [Peer]
    public var hubVersion: String
    enum CodingKeys: String, CodingKey { case peers, hubVersion }
    public init(peers: [Peer] = [], hubVersion: String = "") { self.peers = peers; self.hubVersion = hubVersion }
    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        peers = c.lenientArray(Peer.self, .peers); hubVersion = c.lenientString(.hubVersion)
    }
}

public struct BalancesResponse: Decodable, Sendable {
    public var ts: Double
    public var entries: [BalanceEntry]
    public var lowCount: Int
    public var stale: Bool
    enum CodingKeys: String, CodingKey { case ts, entries, lowCount, stale }
    public init(ts: Double = 0, entries: [BalanceEntry] = [], lowCount: Int = 0, stale: Bool = false) { self.ts = ts; self.entries = entries; self.lowCount = lowCount; self.stale = stale }
    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        ts = c.lenientDouble(.ts); entries = c.lenientArray(BalanceEntry.self, .entries)
        lowCount = c.lenientInt(.lowCount); stale = c.lenientBool(.stale)
    }
}

/// `/overseer/status`: the Mac-side watcher, including level-3 file collisions.
public struct OverseerStatus: Decodable, Sendable {
    public var engine: Bool
    public var dutySession: String
    public var warnings: [JSONValue]
    public var standing: Int
    enum CodingKeys: String, CodingKey { case engine, dutySession, warnings, standing }
    public init(engine: Bool = false, dutySession: String = "", warnings: [JSONValue] = [], standing: Int = 0) { self.engine = engine; self.dutySession = dutySession; self.warnings = warnings; self.standing = standing }
    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        engine = c.lenientBool(.engine); dutySession = c.lenientString(.dutySession)
        warnings = c.lenientArray(JSONValue.self, .warnings); standing = c.lenientInt(.standing)
    }
}

/// `/_op?id=`: what the hub recorded for an earlier POST. status is committed, rejected or unknown.
public struct OpOutcome: Decodable, Sendable {
    public var status: String
    public var code: Int
    public var body: JSONValue
    enum CodingKeys: String, CodingKey { case status, code, body }
    public init(status: String, code: Int = 0, body: JSONValue = .null) { self.status = status; self.code = code; self.body = body }
    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        status = c.lenientString(.status); code = c.lenientInt(.code)
        body = c.lenient(JSONValue.self, .body) ?? .null
    }
    public var isUnknown: Bool { status == "unknown" || status.isEmpty }
    public var isCommitted: Bool { status == "committed" }
    public var isRejected: Bool { status == "rejected" }
}
