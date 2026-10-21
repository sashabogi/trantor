import CryptoKit
import XCTest
@testable import HubClient
import TrantorCore

final class StubURLProtocol: URLProtocol {
    struct Reply { var status: Int; var body: String; var headers: [String: String] = [:] }
    nonisolated(unsafe) static var handler: (@Sendable (URLRequest, Data?) throws -> Reply)?
    nonisolated(unsafe) static var seen: [(URLRequest, Data?)] = []
    private static let lock = NSLock()

    static func reset(_ h: @escaping @Sendable (URLRequest, Data?) throws -> Reply) {
        lock.lock(); handler = h; seen = []; lock.unlock()
    }

    override class func canInit(with request: URLRequest) -> Bool { true }
    override class func canonicalRequest(for request: URLRequest) -> URLRequest { request }

    override func startLoading() {
        var body: Data?
        if let s = request.httpBodyStream {
            s.open(); defer { s.close() }
            var d = Data(); var buf = [UInt8](repeating: 0, count: 4096)
            while s.hasBytesAvailable { let n = s.read(&buf, maxLength: buf.count); if n <= 0 { break }; d.append(buf, count: n) }
            body = d
        } else { body = request.httpBody }
        Self.lock.lock(); Self.seen.append((request, body)); let h = Self.handler; Self.lock.unlock()
        do {
            guard let h else { throw URLError(.cannotConnectToHost) }
            let r = try h(request, body)
            let resp = HTTPURLResponse(url: request.url!, statusCode: r.status, httpVersion: "HTTP/1.1", headerFields: r.headers)!
            client?.urlProtocol(self, didReceive: resp, cacheStoragePolicy: .notAllowed)
            client?.urlProtocol(self, didLoad: Data(r.body.utf8))
            client?.urlProtocolDidFinishLoading(self)
        } catch {
            client?.urlProtocol(self, didFailWithError: error)
        }
    }
    override func stopLoading() {}
}

final class HubAPITests: XCTestCase {
    private var api: HubAPI!
    private var signer: Signer!

    override func setUpWithError() throws {
        let cfg = URLSessionConfiguration.ephemeral
        cfg.protocolClasses = [StubURLProtocol.self]
        signer = try Signer(rawPrivateKey: Data((0..<32).map { UInt8($0) }))
        api = HubAPI(baseURL: URL(string: "http://100.79.242.104:4477")!, signer: signer, session: URLSession(configuration: cfg))
    }

    func testGetUsesPathQueryAndSignedHeaders() async throws {
        StubURLProtocol.reset { _, _ in .init(status: 200, body: #"{"tasks":[{"id":1,"title":"a"}],"fields":"slim"}"#) }
        let cards = try await api.tasks(project: "my proj")
        XCTAssertEqual(cards.first?.title, "a")

        let (req, body) = try XCTUnwrap(StubURLProtocol.seen.first)
        XCTAssertEqual(req.httpMethod, "GET")
        XCTAssertNil(body)
        XCTAssertEqual(req.url?.path, "/tasks")
        XCTAssertEqual(req.url?.query, "fields=slim&project=my%20proj")
        for h in ["x-trantor-pubkey", "x-trantor-sig", "x-trantor-ts", "x-trantor-nonce"] {
            XCTAssertNotNil(req.value(forHTTPHeaderField: h), h)
        }
        XCTAssertEqual(req.value(forHTTPHeaderField: "x-trantor-pubkey"), signer.publicKeyHex)
        try assertSignatureValid(req, body)
    }

    func testPostCarriesOpAndSignsTheExactBodyBytes() async throws {
        StubURLProtocol.reset { _, _ in .init(status: 200, body: #"{"ok":true,"hold":{"id":7}}"#) }
        try await api.decideHold(id: 7, go: true)

        let (req, bodyData) = try XCTUnwrap(StubURLProtocol.seen.first)
        let body = try XCTUnwrap(bodyData)
        XCTAssertEqual(req.httpMethod, "POST")
        XCTAssertEqual(req.url?.path, "/hold/decide")
        let json = try XCTUnwrap(JSONSerialization.jsonObject(with: body) as? [String: Any])
        XCTAssertEqual(json["id"] as? Int, 7)
        XCTAssertEqual(json["status"] as? String, "go")
        let op = try XCTUnwrap(json["_op"] as? String)
        XCTAssertNotNil(UUID(uuidString: op))
        try assertSignatureValid(req, body)
    }

    func testEveryPostGetsADistinctOp() async throws {
        StubURLProtocol.reset { _, _ in .init(status: 200, body: "{}") }
        try await api.toggleChecklist(id: 1, index: 0, done: true)
        try await api.addNote(id: 1, note: "hi", by: "ios")
        let ops = try StubURLProtocol.seen.map { try XCTUnwrap(JSONSerialization.jsonObject(with: try XCTUnwrap($0.1)) as? [String: Any])["_op"] as? String }
        XCTAssertEqual(Set(ops.compactMap { $0 }).count, 2)
        XCTAssertEqual(StubURLProtocol.seen.map { $0.0.url?.path }, ["/task/checklist-toggle", "/task/update"])
    }

    func testConflictMapsToAlreadyDecided() async throws {
        StubURLProtocol.reset { _, _ in .init(status: 409, body: #"{"error":"hold already decided"}"#) }
        do {
            try await api.decideHold(id: 1, go: false)
            XCTFail("should throw")
        } catch let e as HubError {
            XCTAssertEqual(e, .conflict("hold already decided"))
            XCTAssertTrue(e.isAlreadyDecided)
        }
    }

    func testStatusCodesMap() async throws {
        let cases: [(Int, HubError)] = [
            (401, .unauthorized("stale")), (403, .forbidden("stale")), (404, .notFound("stale")),
            (400, .badRequest("stale")), (500, .server(code: 500, message: "stale")),
        ]
        for (code, expected) in cases {
            StubURLProtocol.reset { _, _ in .init(status: code, body: #"{"error":"stale"}"#) }
            do { _ = try await api.peers(); XCTFail("should throw for \(code)") }
            catch let e as HubError { XCTAssertEqual(e, expected) }
        }
    }

    func testOfflineAndTimeoutCarryTheOpForReconcile() async throws {
        StubURLProtocol.reset { _, _ in throw URLError(.notConnectedToInternet) }
        do { try await api.decideProposal(id: 3, approve: true, note: "ok"); XCTFail() }
        catch let HubError.offline(op) { XCTAssertNotNil(op) }

        StubURLProtocol.reset { _, _ in throw URLError(.timedOut) }
        do { try await api.decideProposal(id: 3, approve: false, note: ""); XCTFail() }
        catch let HubError.timeout(op) { XCTAssertNotNil(op) }
    }

    func testReconcileReadsOpOutcome() async throws {
        StubURLProtocol.reset { _, _ in .init(status: 200, body: #"{"status":"rejected","code":409,"body":{"error":"already approved"}}"#) }
        let o = try await api.reconcile(op: "abc-123")
        XCTAssertTrue(o.isRejected)
        XCTAssertEqual(o.code, 409)
        XCTAssertEqual(o.body["error"]?.stringValue, "already approved")
        let (req, _) = try XCTUnwrap(StubURLProtocol.seen.first)
        XCTAssertEqual(req.url?.path, "/_op")
        XCTAssertEqual(req.url?.query, "id=abc-123")
    }

    func testHealthCalibratesClockFromDateHeader() async throws {
        let future = Date().addingTimeInterval(3600)
        let f = DateFormatter(); f.locale = Locale(identifier: "en_US_POSIX"); f.timeZone = TimeZone(secondsFromGMT: 0)
        f.dateFormat = "EEE, dd MMM yyyy HH:mm:ss 'GMT'"
        StubURLProtocol.reset { _, _ in .init(status: 200, body: #"{"ok":true,"authMode":"enforce","peers":2}"#, headers: ["Date": f.string(from: future)]) }
        let h = try await api.health()
        XCTAssertTrue(h.ok)
        XCTAssertEqual(h.authMode, "enforce")
        XCTAssertLessThan(abs(signer.clockOffsetMs - 3_600_000), 3_000)
    }

    func testSendPutsReplyThreadInBody() async throws {
        StubURLProtocol.reset { _, _ in .init(status: 200, body: #"{"ok":true,"id":42}"#) }
        let id = try await api.send(from: "ios-phone", to: "codex", text: "go ahead", project: "trantor", re: 10)
        XCTAssertEqual(id, 42)
        let json = try XCTUnwrap(JSONSerialization.jsonObject(with: try XCTUnwrap(StubURLProtocol.seen.first?.1)) as? [String: Any])
        XCTAssertEqual(json["re"] as? Int, 10)
        XCTAssertEqual(json["from"] as? String, "ios-phone")
    }

    func testInboxPeeksWithoutClaimingDelivery() async throws {
        StubURLProtocol.reset { _, _ in .init(status: 200, body: #"{"messages":[],"cursor":0}"#) }
        _ = try await api.inbox(session: "ios-phone", since: 5)
        XCTAssertEqual(StubURLProtocol.seen.first?.0.url?.query, "peek=1&session=ios-phone&since=5")
    }

    func testSSEParserFramesNamedEvents() {
        var p = SSEParser()
        var frames: [SSEParser.Frame] = []
        for line in [": connected as x", "", "event: ev", #"data: {"id":1}"#, "", "data: plain", ""] {
            if let f = p.feed(line: line) { frames.append(f) }
        }
        XCTAssertEqual(frames, [.init(event: "ev", data: #"{"id":1}"#), .init(event: "message", data: "plain")])
    }

    func testBackoffGrowsAndCaps() {
        XCTAssertEqual(EventStream.backoff(attempt: 0), 1)
        XCTAssertEqual(EventStream.backoff(attempt: 3), 8)
        XCTAssertEqual(EventStream.backoff(attempt: 20), 30)
    }

    private func assertSignatureValid(_ req: URLRequest, _ body: Data?, file: StaticString = #filePath, line: UInt = #line) throws {
        let url = try XCTUnwrap(req.url)
        let path = url.path + (url.query.map { "?" + $0 } ?? "")
        let ts = try XCTUnwrap(Int64(try XCTUnwrap(req.value(forHTTPHeaderField: "x-trantor-ts"))))
        let nonce = try XCTUnwrap(req.value(forHTTPHeaderField: "x-trantor-nonce"))
        let message = Signer.canonicalString(method: req.httpMethod ?? "GET", path: path, hash: Signer.bodyHash(body), ts: ts, nonce: nonce)
        let pub = try Curve25519.Signing.PublicKey(rawRepresentation: Data(hex: try XCTUnwrap(req.value(forHTTPHeaderField: "x-trantor-pubkey"))))
        let sig = try XCTUnwrap(Data(base64Encoded: try XCTUnwrap(req.value(forHTTPHeaderField: "x-trantor-sig"))))
        XCTAssertTrue(pub.isValidSignature(sig, for: Data(message.utf8)), file: file, line: line)
    }
}
