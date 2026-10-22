import CryptoKit
import XCTest
import TrantorCore
@testable import HubClient

final class CrewTransportTests: XCTestCase {
    func testRosterCommandAndStatusUseSignedRoutesAndOperationID() async throws {
        let config = URLSessionConfiguration.ephemeral
        config.protocolClasses = [CrewURLProtocol.self]
        let key = Curve25519.Signing.PrivateKey()
        let session = URLSession(configuration: config)
        defer { session.invalidateAndCancel() }
        let api = HubAPI(baseURL: URL(string: "https://hub.example")!, signer: Signer(privateKey: key), session: session)
        CrewURLProtocol.reset()
        let roster = try await api.crewRoster()
        XCTAssertEqual(roster.first?.machine, "sasha@mac")
        XCTAssertEqual(roster.first?.seats.first?.agent, "glm")
        let receipt = try await api.crewCommand(project: "a & b", action: .up, seats: ["glm"])
        XCTAssertEqual(receipt.status, "queued")
        let final = try await api.crewCommandStatus(id: receipt.id)
        XCTAssertEqual(final.status, "done")
        XCTAssertEqual(final.output, "glm started")
        _ = try await api.crewCommand(project: "a & b", action: .swap, seats: [], from: "glm", to: "kimi")
        let requests = CrewURLProtocol.requests
        XCTAssertEqual(requests.count, 4)
        XCTAssertEqual(requests[0].0.url?.path, "/crew/roster")
        XCTAssertEqual(requests[1].0.url?.path, "/crew/command")
        XCTAssertEqual(requests[1].0.httpMethod, "POST")
        let up = try XCTUnwrap(JSONSerialization.jsonObject(with: XCTUnwrap(requests[1].1)) as? [String: Any])
        XCTAssertEqual(up["project"] as? String, "a & b")
        XCTAssertEqual(up["action"] as? String, "up")
        XCTAssertEqual(up["seats"] as? [String], ["glm"])
        XCTAssertNil(up["from"])
        XCTAssertNil(up["to"])
        XCTAssertNotNil(UUID(uuidString: try XCTUnwrap(up["_op"] as? String)))
        XCTAssertEqual(requests[2].0.url?.path, "/session/prompt")
        XCTAssertEqual(requests[2].0.url?.query, "id=77")
        let swap = try XCTUnwrap(JSONSerialization.jsonObject(with: XCTUnwrap(requests[3].1)) as? [String: Any])
        XCTAssertEqual(swap["action"] as? String, "swap")
        XCTAssertEqual(swap["from"] as? String, "glm")
        XCTAssertEqual(swap["to"] as? String, "kimi")
        XCTAssertEqual(swap["seats"] as? [String], [])
        XCTAssertNotEqual(up["_op"] as? String, swap["_op"] as? String)
        for (request, body) in requests {
            let url = try XCTUnwrap(request.url)
            let path = url.path + (url.query.map { "?" + $0 } ?? "")
            let timestamp = try XCTUnwrap(Int64(try XCTUnwrap(request.value(forHTTPHeaderField: "x-trantor-ts"))))
            let nonce = try XCTUnwrap(request.value(forHTTPHeaderField: "x-trantor-nonce"))
            let canonical = Signer.canonicalString(method: request.httpMethod ?? "GET", path: path, hash: Signer.bodyHash(body), ts: timestamp, nonce: nonce)
            let signature = try XCTUnwrap(Data(base64Encoded: try XCTUnwrap(request.value(forHTTPHeaderField: "x-trantor-sig"))))
            XCTAssertTrue(key.publicKey.isValidSignature(signature, for: Data(canonical.utf8)))
        }
    }
}

private final class CrewURLProtocol: URLProtocol {
    private static let lock = NSLock()
    nonisolated(unsafe) private static var captured: [(URLRequest, Data?)] = []
    static var requests: [(URLRequest, Data?)] { lock.lock(); defer { lock.unlock() }; return captured }
    static func reset() { lock.lock(); captured = []; lock.unlock() }
    override class func canInit(with request: URLRequest) -> Bool { true }
    override class func canonicalRequest(for request: URLRequest) -> URLRequest { request }
    override func startLoading() {
        var body = request.httpBody
        if let stream = request.httpBodyStream {
            stream.open(); defer { stream.close() }
            var data = Data(), bytes = [UInt8](repeating: 0, count: 4096)
            while stream.hasBytesAvailable {
                let count = stream.read(&bytes, maxLength: bytes.count)
                if count <= 0 { break }
                data.append(bytes, count: count)
            }
            body = data
        }
        Self.lock.lock(); Self.captured.append((request, body)); Self.lock.unlock()
        let payload: String
        if request.url?.path == "/crew/roster" {
            payload = #"{"machines":[{"machine":"sasha@mac","updatedAt":1000,"seats":[{"agent":"glm","metered":false,"available":true,"reason":""}]}]}"#
        } else if request.httpMethod == "POST" { payload = #"{"id":77,"status":"queued"}"# }
        else { payload = #"{"id":77,"status":"done","outcome":"done","output":"glm started"}"# }
        let response = HTTPURLResponse(url: request.url!, statusCode: 200, httpVersion: "HTTP/1.1", headerFields: nil)!
        client?.urlProtocol(self, didReceive: response, cacheStoragePolicy: .notAllowed)
        client?.urlProtocol(self, didLoad: Data(payload.utf8))
        client?.urlProtocolDidFinishLoading(self)
    }
    override func stopLoading() {}
}
