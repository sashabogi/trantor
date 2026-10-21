import Foundation
import TrantorCore

/// Incremental parser for `text/event-stream`. Feed it one line at a time, including blank lines
/// (`URLSession.AsyncBytes.lines` drops blank lines, so the stream reads raw bytes instead).
public struct SSEParser: Sendable {
    public struct Frame: Equatable, Sendable {
        public var event: String
        public var data: String
    }
    private var event = ""
    private var dataLines: [String] = []

    public init() {}

    public mutating func feed(line: String) -> Frame? {
        if line.isEmpty {
            defer { event = ""; dataLines = [] }
            guard !dataLines.isEmpty else { return nil }
            return Frame(event: event.isEmpty ? "message" : event, data: dataLines.joined(separator: "\n"))
        }
        if line.hasPrefix(":") { return nil }                       // comment / keepalive
        let name: Substring, value: Substring
        if let i = line.firstIndex(of: ":") {
            name = line[..<i]
            var v = line[line.index(after: i)...]
            if v.first == " " { v = v.dropFirst() }
            value = v
        } else { name = line[...]; value = "" }
        switch name {
        case "event": event = String(value)
        case "data": dataLines.append(String(value))
        default: break
        }
        return nil
    }
}

public enum StreamUpdate: Sendable {
    case connected
    case event(HubEvent)
    case disconnected(retryIn: TimeInterval)
}

/// Live feed over `/stream?session=<name>&events=1`, signed once at connect. After every
/// (re)connect it first catches up with `/events?since=` so a dropped connection loses nothing.
public final class EventStream: @unchecked Sendable {
    private let baseURL: URL
    private let signer: Signer
    private let session: URLSession
    private let api: HubServing
    private let sessionName: String
    private let project: String?

    public init(baseURL: URL, signer: Signer, api: HubServing, sessionName: String, project: String? = nil, session: URLSession = .shared) {
        self.baseURL = baseURL; self.signer = signer; self.api = api
        self.sessionName = sessionName; self.project = project; self.session = session
    }

    public static func backoff(attempt: Int) -> TimeInterval { min(30, pow(2, Double(min(attempt, 5)))) }

    /// Ends when the consuming task is cancelled.
    public func updates(since: Int) -> AsyncStream<StreamUpdate> {
        AsyncStream { continuation in
            let task = Task {
                var last = since
                var attempt = 0
                while !Task.isCancelled {
                    do {
                        // Catch up first, then listen: anything between the two is deduplicated by id.
                        let missed = try await api.events(project: project, since: last, limit: 300)
                        for ev in missed.events where ev.id > last { last = ev.id; continuation.yield(.event(ev)) }
                        try await listen(&last, attempt: &attempt, continuation: continuation)
                    } catch is CancellationError {
                        break
                    } catch {
                        // fall through to backoff
                    }
                    if Task.isCancelled { break }
                    let wait = Self.backoff(attempt: attempt)
                    attempt += 1
                    continuation.yield(.disconnected(retryIn: wait))
                    try? await Task.sleep(nanoseconds: UInt64(wait * 1_000_000_000))
                }
                continuation.finish()
            }
            continuation.onTermination = { _ in task.cancel() }
        }
    }

    private func listen(_ last: inout Int, attempt: inout Int, continuation: AsyncStream<StreamUpdate>.Continuation) async throws {
        let wire = HubAPI.wirePath("/stream", [("events", "1"), ("session", sessionName)])
        guard let url = URL(string: baseURL.absoluteString.trimmingSuffix("/") + wire) else { throw HubError.invalidURL }
        var req = URLRequest(url: url)
        req.timeoutInterval = 75            // the hub sends a keepalive every 20 s
        req.setValue("text/event-stream", forHTTPHeaderField: "accept")
        for (k, v) in try signer.sign(method: "GET", path: wire, body: nil).dictionary { req.setValue(v, forHTTPHeaderField: k) }

        let (bytes, response) = try await session.bytes(for: req)
        guard let http = response as? HTTPURLResponse, http.statusCode == 200 else {
            throw HubError.server(code: (response as? HTTPURLResponse)?.statusCode ?? 0, message: "stream refused")
        }
        attempt = 0
        continuation.yield(.connected)

        var parser = SSEParser()
        var buffer = Data()
        for try await byte in bytes {
            if byte != 0x0A { buffer.append(byte); continue }
            var line = String(decoding: buffer, as: UTF8.self)
            buffer.removeAll(keepingCapacity: true)
            if line.hasSuffix("\r") { line.removeLast() }
            guard let frame = parser.feed(line: line), frame.event == "ev",
                  let ev = try? JSONDecoder().decode(HubEvent.self, from: Data(frame.data.utf8)) else { continue }
            if ev.id > last { last = ev.id; continuation.yield(.event(ev)) }
        }
        throw HubError.offline(op: nil)     // the server closed the stream: reconnect
    }
}

private extension String {
    func trimmingSuffix(_ s: String) -> String { hasSuffix(s) ? String(dropLast(s.count)) : self }
}
