import Foundation
import TrantorCore

/// Everything the app asks of the hub. Stores depend on this, so tests can stub it.
public protocol HubServing: Sendable {
    func health() async throws -> HealthInfo
    func enroll(token: String, name: String) async throws -> EnrollResult
    func projects() async throws -> [Project]
    func catchup(project: String) async throws -> Catchup
    func tasks(project: String) async throws -> [Card]
    func card(id: Int) async throws -> CardDetail
    func events(project: String?, since: Int, limit: Int) async throws -> EventsResponse
    func inbox(session: String, since: Int) async throws -> InboxResponse
    func send(from: String, to: String, text: String, project: String?, re: Int?) async throws -> Int
    func delivered(session: String, upTo: Int) async throws
    func peers() async throws -> PeersResponse
    func holds(status: String?) async throws -> [Hold]
    func decideHold(id: Int, go: Bool) async throws
    func verifyGates(project: String?) async throws -> [VerifyGate]
    func resolveGate(id: Int, project: String, status: GateResolution, note: String, by: String) async throws
    func proposals(status: String?) async throws -> ProposalsResponse
    func decideProposal(id: Int, approve: Bool, note: String) async throws
    func balances(machine: String?) async throws -> BalancesResponse
    func overseerStatus() async throws -> OverseerStatus
    func moveCard(id: Int, to status: String, note: String?, drill: String?, by: String) async throws
    func addNote(id: Int, note: String, by: String) async throws
    func toggleChecklist(id: Int, index: Int, done: Bool) async throws
    func reconcile(op: String) async throws -> OpOutcome
}

public enum GateResolution: String, Sendable, CaseIterable {
    case verified, failed, waived
}

public final class HubAPI: HubServing, @unchecked Sendable {
    public let baseURL: URL
    public let signer: Signer
    private let session: URLSession

    public init(baseURL: URL, signer: Signer, session: URLSession = .shared) {
        self.baseURL = baseURL; self.signer = signer; self.session = session
    }

    // MARK: Reads

    public func health() async throws -> HealthInfo {
        let (data, response) = try await perform(method: "GET", path: "/health", query: [], body: nil, op: nil)
        // Calibrate from the server's clock so a drifting phone does not get 401 "stale".
        if let http = response as? HTTPURLResponse, let date = http.value(forHTTPHeaderField: "Date").flatMap(Self.parseHTTPDate) {
            signer.calibrate(serverDate: date)
        }
        return try decode(HealthInfo.self, data)
    }

    public func projects() async throws -> [Project] { try await get(ProjectsResponse.self, "/projects").projects }
    public func catchup(project: String) async throws -> Catchup { try await get(Catchup.self, "/catchup", ["project": project]) }
    public func tasks(project: String) async throws -> [Card] {
        try await get(TasksResponse.self, "/tasks", ["project": project, "fields": "slim"]).tasks
    }
    public func card(id: Int) async throws -> CardDetail { try await get(CardDetail.self, "/card", ["id": String(id)]) }

    public func events(project: String?, since: Int, limit: Int = 300) async throws -> EventsResponse {
        var q: [String: String] = ["since": String(since), "limit": String(limit)]
        if let project, !project.isEmpty { q["project"] = project }
        return try await get(EventsResponse.self, "/events", q)
    }

    /// `peek=1`: look without claiming delivery. Call `delivered` once the user has seen it.
    public func inbox(session: String, since: Int) async throws -> InboxResponse {
        try await get(InboxResponse.self, "/inbox", ["session": session, "since": String(since), "peek": "1"])
    }

    public func peers() async throws -> PeersResponse { try await get(PeersResponse.self, "/peers") }

    public func holds(status: String? = nil) async throws -> [Hold] {
        var q: [String: String] = [:]
        if let status { q["status"] = status }
        return try await get(HoldsResponse.self, "/holds", q).holds
    }

    public func verifyGates(project: String? = nil) async throws -> [VerifyGate] {
        var q: [String: String] = [:]
        if let project { q["project"] = project }
        return try await get(GatesResponse.self, "/verify-gates", q).gates
    }

    public func proposals(status: String? = "pending") async throws -> ProposalsResponse {
        var q: [String: String] = [:]
        if let status { q["status"] = status }
        return try await get(ProposalsResponse.self, "/proposals", q)
    }

    public func balances(machine: String? = nil) async throws -> BalancesResponse {
        var q: [String: String] = [:]
        if let machine { q["machine"] = machine }
        return try await get(BalancesResponse.self, "/balances", q)
    }

    public func overseerStatus() async throws -> OverseerStatus { try await get(OverseerStatus.self, "/overseer/status") }

    public func reconcile(op: String) async throws -> OpOutcome { try await get(OpOutcome.self, "/_op", ["id": op]) }

    // MARK: Writes (every POST carries `_op`)

    public func enroll(token: String, name: String) async throws -> EnrollResult {
        let data = try await post("/enroll", ["token": .string(token), "name": .string(name), "kind": .string("human")])
        return try decode(EnrollResult.self, data)
    }

    @discardableResult
    public func send(from: String, to: String, text: String, project: String? = nil, re: Int? = nil) async throws -> Int {
        var f: [String: JSONValue] = ["from": .string(from), "to": .string(to), "text": .string(text)]
        if let project, !project.isEmpty { f["project"] = .string(project) }
        if let re, re > 0 { f["re"] = .number(Double(re)) }
        let data = try await post("/send", f)
        return (try? JSONDecoder().decode(JSONValue.self, from: data))?["id"]?.intValue ?? 0
    }

    public func delivered(session: String, upTo: Int) async throws {
        _ = try await post("/delivered", ["session": .string(session), "upTo": .number(Double(upTo))])
    }

    public func decideHold(id: Int, go: Bool) async throws {
        _ = try await post("/hold/decide", ["id": .number(Double(id)), "status": .string(go ? "go" : "nogo")])
    }

    public func resolveGate(id: Int, project: String, status: GateResolution, note: String, by: String) async throws {
        _ = try await post("/verify-gate", [
            "resolve": .bool(true), "id": .number(Double(id)), "project": .string(project),
            "status": .string(status.rawValue), "note": .string(note), "by": .string(by),
        ])
    }

    public func decideProposal(id: Int, approve: Bool, note: String) async throws {
        _ = try await post("/proposal/decide", [
            "id": .number(Double(id)), "status": .string(approve ? "approved" : "denied"), "note": .string(note),
        ])
    }

    public func moveCard(id: Int, to status: String, note: String? = nil, drill: String? = nil, by: String) async throws {
        var f: [String: JSONValue] = ["id": .number(Double(id)), "status": .string(status), "by": .string(by)]
        if let note, !note.isEmpty { f["note"] = .string(note) }
        if let drill, !drill.isEmpty { f["drill"] = .string(drill) }
        _ = try await post("/task/update", f)
    }

    public func addNote(id: Int, note: String, by: String) async throws {
        _ = try await post("/task/update", ["id": .number(Double(id)), "note": .string(note), "by": .string(by)])
    }

    public func toggleChecklist(id: Int, index: Int, done: Bool) async throws {
        _ = try await post("/task/checklist-toggle", [
            "id": .number(Double(id)), "index": .number(Double(index)), "done": .bool(done),
        ])
    }

    /// APNs registration. The hub route is card #12114 and may not exist yet, so callers guard it
    /// (see PushRegistrar); a 404 surfaces as `.notFound`.
    public func registerDevice(apnsToken: String, environment: String, name: String) async throws {
        _ = try await post("/device/register", [
            "apnsToken": .string(apnsToken), "env": .string(environment),
            "bundleId": .string("ai.trantor.companion"), "name": .string(name),
        ])
    }

    // MARK: Transport

    private func get<T: Decodable>(_ type: T.Type, _ path: String, _ query: [String: String] = [:]) async throws -> T {
        let items = query.sorted { $0.key < $1.key }.map { ($0.key, $0.value) }
        let (data, _) = try await perform(method: "GET", path: path, query: items, body: nil, op: nil)
        return try decode(type, data)
    }

    /// POST JSON with a fresh `_op`. A dropped connection surfaces as `.offline(op:)` / `.timeout(op:)`;
    /// the caller can then `reconcile(op:)` and, if the hub never saw it, retry the same `_op`.
    @discardableResult
    func post(_ path: String, _ fields: [String: JSONValue], op: String = UUID().uuidString) async throws -> Data {
        var f = fields
        f["_op"] = .string(op)
        let enc = JSONEncoder()
        enc.outputFormatting = [.sortedKeys, .withoutEscapingSlashes]
        let body = try enc.encode(JSONValue.object(f))
        return try await perform(method: "POST", path: path, query: [], body: body, op: op).0
    }

    /// Path + query exactly as it goes on the wire; this string is what gets signed.
    static func wirePath(_ path: String, _ query: [(String, String)]) -> String {
        guard !query.isEmpty else { return path }
        let allowed = CharacterSet(charactersIn: "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-._~")
        func enc(_ s: String) -> String { s.addingPercentEncoding(withAllowedCharacters: allowed) ?? s }
        return path + "?" + query.map { "\(enc($0.0))=\(enc($0.1))" }.joined(separator: "&")
    }

    func makeRequest(method: String, path: String, query: [(String, String)], body: Data?) throws -> URLRequest {
        let wire = Self.wirePath(path, query)
        guard let url = URL(string: baseURL.absoluteString.trimmingSuffix("/") + wire) else { throw HubError.invalidURL }
        var req = URLRequest(url: url)
        req.httpMethod = method
        req.timeoutInterval = 20
        if let body {
            req.httpBody = body
            req.setValue("application/json", forHTTPHeaderField: "content-type")
        }
        let signed = try signer.sign(method: method, path: wire, body: body)
        for (k, v) in signed.dictionary { req.setValue(v, forHTTPHeaderField: k) }
        return req
    }

    private func perform(method: String, path: String, query: [(String, String)], body: Data?, op: String?) async throws -> (Data, URLResponse) {
        let req = try makeRequest(method: method, path: path, query: query, body: body)
        let data: Data, response: URLResponse
        do {
            (data, response) = try await session.data(for: req)
        } catch let e as URLError {
            switch e.code {
            case .timedOut: throw HubError.timeout(op: op)
            case .cancelled: throw CancellationError()
            default: throw HubError.offline(op: op)
            }
        }
        guard let http = response as? HTTPURLResponse else { throw HubError.offline(op: op) }
        let message = Self.errorMessage(data)
        switch http.statusCode {
        case 200..<300: return (data, response)
        case 400: throw HubError.badRequest(message)
        case 401: throw HubError.unauthorized(message)
        case 403: throw HubError.forbidden(message)
        case 404: throw HubError.notFound(message)
        case 409: throw HubError.conflict(message)
        default: throw HubError.server(code: http.statusCode, message: message)
        }
    }

    private func decode<T: Decodable>(_ type: T.Type, _ data: Data) throws -> T {
        do { return try JSONDecoder().decode(type, from: data) }
        catch { throw HubError.decoding(String(describing: error)) }
    }

    static func errorMessage(_ data: Data) -> String {
        (try? JSONDecoder().decode(JSONValue.self, from: data))?["error"]?.stringValue ?? ""
    }

    static func parseHTTPDate(_ s: String) -> Date? {
        let f = DateFormatter()
        f.locale = Locale(identifier: "en_US_POSIX")
        f.timeZone = TimeZone(secondsFromGMT: 0)
        f.dateFormat = "EEE, dd MMM yyyy HH:mm:ss zzz"
        return f.date(from: s)
    }
}

private extension String {
    func trimmingSuffix(_ s: String) -> String { hasSuffix(s) ? String(dropLast(s.count)) : self }
}
