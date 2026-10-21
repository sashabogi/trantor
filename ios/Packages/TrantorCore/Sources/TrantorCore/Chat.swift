import Foundation

public struct ChatBlock: Codable, Equatable, Sendable {
    public var kind: String
    public var text: String
    public var tool: String
    public var ask: [ChatQuestion]

    public init(kind: String = "text", text: String = "", tool: String = "", ask: [ChatQuestion] = []) {
        self.kind = kind; self.text = text; self.tool = tool; self.ask = ask
    }
    enum CodingKeys: String, CodingKey { case kind, text, tool, ask }
    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        kind = c.lenientString(.kind); text = c.lenientString(.text); tool = c.lenientString(.tool)
        ask = c.lenientArray(ChatQuestion.self, .ask)
    }
    public var isQuestion: Bool { kind == "ask" || tool == "AskUserQuestion" }
}

public struct ChatQuestion: Codable, Equatable, Sendable {
    public var question: String
    public var options: [ChatOption]
    public init(question: String, options: [ChatOption] = []) { self.question = question; self.options = options }
    enum CodingKeys: String, CodingKey { case question, options }
    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        question = c.lenientString(.question); options = c.lenientArray(ChatOption.self, .options)
    }
}

public struct ChatOption: Codable, Equatable, Sendable {
    public var label: String
    public var description: String
    public init(label: String, description: String = "") { self.label = label; self.description = description }
    enum CodingKeys: String, CodingKey { case label, description }
    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        label = c.lenientString(.label); description = c.lenientString(.description)
    }
}

public struct ChatTurn: Codable, Equatable, Identifiable, Sendable {
    public var idx: Int
    public var role: String
    public var blocks: [ChatBlock]
    public var queued: Bool
    public var id: Int { idx }
    public var text: String { blocks.filter { $0.kind == "text" }.map(\.text).joined(separator: "\n") }

    public init(idx: Int, role: String, blocks: [ChatBlock], queued: Bool = false) {
        self.idx = idx; self.role = role; self.blocks = blocks; self.queued = queued
    }
    enum CodingKeys: String, CodingKey { case idx, role, blocks, queued }
    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        // A missing index cannot safely replace an existing turn zero.
        guard c.contains(.idx), let idx = Int(c.lenientString(.idx)), idx >= 0 else {
            throw DecodingError.dataCorruptedError(forKey: .idx, in: c, debugDescription: "Missing turn index")
        }
        self.idx = idx; role = c.lenientString(.role)
        blocks = c.lenientArray(ChatBlock.self, .blocks); queued = c.lenientBool(.queued)
    }
}

public struct ChatContext: Codable, Equatable, Sendable {
    public var tokens: Double?
    public var window: Double?
    public var frac: Double?
    public init(tokens: Double? = nil, window: Double? = nil, frac: Double? = nil) {
        self.tokens = tokens; self.window = window; self.frac = frac
    }
    enum CodingKeys: String, CodingKey { case tokens, window, frac }
    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        tokens = Double(c.lenientString(.tokens)); window = Double(c.lenientString(.window)); frac = Double(c.lenientString(.frac))
    }
    public var fraction: Double? {
        if let frac, frac.isFinite, frac >= 0 { return frac }
        if let tokens, let window, tokens.isFinite, window.isFinite, tokens >= 0, window > 0 { return tokens / window }
        return nil
    }
}

public struct ChatMeta: Codable, Equatable, Sendable {
    public var working: Bool
    public var model: String
    public var context: ChatContext
    public init(working: Bool = false, model: String = "", context: ChatContext = .init()) {
        self.working = working; self.model = model; self.context = context
    }
    enum CodingKeys: String, CodingKey { case working, model, context }
    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        working = c.lenientBool(.working); model = c.lenientString(.model)
        context = c.lenient(ChatContext.self, .context) ?? .init()
    }
}

public struct ChatSnapshot: Codable, Equatable, Sendable {
    public var session: String
    public var total: Int
    public var turns: [ChatTurn]
    public var meta: ChatMeta
    public var updatedAt: Double
    public var host: String
    public init(session: String = "", total: Int = 0, turns: [ChatTurn] = [], meta: ChatMeta = .init(), updatedAt: Double = 0, host: String = "") {
        self.session = session; self.total = total; self.turns = turns; self.meta = meta; self.updatedAt = updatedAt; self.host = host
    }
    enum CodingKeys: String, CodingKey { case session, total, turns, meta, updatedAt, host }
    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        session = c.lenientString(.session); total = c.lenientInt(.total)
        turns = c.lenientArray(ChatTurn.self, .turns); meta = c.lenient(ChatMeta.self, .meta) ?? .init()
        updatedAt = c.lenientDouble(.updatedAt); host = c.lenientString(.host)
    }
}

public struct PromptStatus: Codable, Equatable, Sendable {
    public var id: String
    public var status: String
    public var outcome: String
    public var error: String
    public init(id: String = "", status: String = "", outcome: String = "", error: String = "") {
        self.id = id; self.status = status; self.outcome = outcome; self.error = error
    }
    enum CodingKeys: String, CodingKey { case id, status, outcome, error }
    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        id = c.lenientString(.id); status = c.lenientString(.status)
        outcome = c.lenientString(.outcome); error = c.lenientString(.error)
    }
    public var failureReason: String {
        if !error.isEmpty { return error }
        switch outcome {
        case "blocked": return "The session is waiting for a response on the Mac."
        case "not_ready": return "The session is not ready. Open it on the Mac."
        case "stalled": return "The session stopped responding. Check it on the Mac."
        case "no_agent": return "No agent is running for this project."
        default: return status == "expired" ? "No Mac is relaying this project. Is the Trantor app open?" : "The prompt could not be delivered."
        }
    }
}

public struct ChatSignal: Equatable, Sendable {
    public var project: String
    public var promptID: String?
    public init(project: String, promptID: String? = nil) { self.project = project; self.promptID = promptID }
}
