import CryptoKit
import XCTest
import TrantorCore
@testable import HubClient

final class ChatTransportTests: XCTestCase {
    func testChatAndPromptRoutesSignExactWireAndCreateOperationID() async throws {
        let config = URLSessionConfiguration.ephemeral
        config.protocolClasses = [ChatURLProtocol.self]
        let key = Curve25519.Signing.PrivateKey()
        let session = URLSession(configuration: config)
        defer { session.invalidateAndCancel() }
        let api = HubAPI(baseURL: URL(string: "https://hub.example")!, signer: Signer(privateKey: key), session: session)
        ChatURLProtocol.reset()
        let chat = try await api.chat(project: "a & b", after: -1)
        XCTAssertEqual(chat.session, "s1")
        let receipt = try await api.sendPrompt(project: "a & b", text: "Please continue")
        XCTAssertEqual(receipt.status, "queued")
        let status = try await api.promptStatus(id: receipt.id)
        XCTAssertEqual(status.status, "delivered")
        _ = try await api.answer(project: "a & b", session: "session-1", toolId: "tool-7", picks: [0, 2], other: "Another idea")
        _ = try await api.answer(project: "a & b", session: "session-1", toolId: "tool-8", picks: [1])
        let requests = ChatURLProtocol.requests
        XCTAssertEqual(requests.count, 5)
        XCTAssertEqual(requests[0].0.url?.query, "after=-1&project=a%20%26%20b")
        XCTAssertEqual(requests[1].0.httpMethod, "POST")
        let json = try XCTUnwrap(JSONSerialization.jsonObject(with: XCTUnwrap(requests[1].1)) as? [String: Any])
        XCTAssertEqual(json["project"] as? String, "a & b")
        XCTAssertEqual(json["text"] as? String, "Please continue")
        XCTAssertNotNil(UUID(uuidString: try XCTUnwrap(json["_op"] as? String)))
        XCTAssertEqual(requests[2].0.url?.query, "id=77")
        XCTAssertEqual(requests[3].0.url?.path, "/session/answer")
        let answer = try XCTUnwrap(JSONSerialization.jsonObject(with: XCTUnwrap(requests[3].1)) as? [String: Any])
        XCTAssertEqual(answer["project"] as? String, "a & b")
        XCTAssertEqual(answer["session"] as? String, "session-1")
        XCTAssertEqual(answer["toolId"] as? String, "tool-7")
        XCTAssertEqual(answer["picks"] as? [Int], [0, 2])
        XCTAssertEqual(answer["other"] as? String, "Another idea")
        XCTAssertNotNil(UUID(uuidString: try XCTUnwrap(answer["_op"] as? String)))
        let withoutOther = try XCTUnwrap(JSONSerialization.jsonObject(with: XCTUnwrap(requests[4].1)) as? [String: Any])
        XCTAssertNil(withoutOther["other"])
        XCTAssertNotEqual(answer["_op"] as? String, withoutOther["_op"] as? String)
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

    func testPromptAttachmentsRideTheSignedJSONBody() async throws {
        let config = URLSessionConfiguration.ephemeral
        config.protocolClasses = [ChatURLProtocol.self]
        let key = Curve25519.Signing.PrivateKey()
        let session = URLSession(configuration: config)
        defer { session.invalidateAndCancel() }
        let api = HubAPI(baseURL: URL(string: "https://hub.example")!, signer: Signer(privateKey: key), session: session)
        ChatURLProtocol.reset()
        let jpeg = Data([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3, 4])
        _ = try await api.sendPrompt(project: "trantor", text: "What is in this?", attachments: [
            PromptAttachment(name: "shot.jpg", jpegData: jpeg),
        ])
        let requests = ChatURLProtocol.requests
        XCTAssertEqual(requests.count, 1)
        XCTAssertEqual(requests[0].0.url?.path, "/session/prompt")
        let json = try XCTUnwrap(JSONSerialization.jsonObject(with: XCTUnwrap(requests[0].1)) as? [String: Any])
        XCTAssertEqual(json["text"] as? String, "What is in this?")
        let attachments = try XCTUnwrap(json["attachments"] as? [[String: Any]])
        XCTAssertEqual(attachments.count, 1)
        XCTAssertEqual(attachments[0]["name"] as? String, "shot.jpg")
        let data = try XCTUnwrap(attachments[0]["data"] as? String)
        XCTAssertEqual(Data(base64Encoded: data), jpeg)
        // the signature still covers the whole body
        let request = requests[0].0
        let body = try XCTUnwrap(requests[0].1)
        let path = try XCTUnwrap(request.url).path
        let timestamp = try XCTUnwrap(Int64(try XCTUnwrap(request.value(forHTTPHeaderField: "x-trantor-ts"))))
        let nonce = try XCTUnwrap(request.value(forHTTPHeaderField: "x-trantor-nonce"))
        let canonical = Signer.canonicalString(method: "POST", path: path, hash: Signer.bodyHash(body), ts: timestamp, nonce: nonce)
        let signature = try XCTUnwrap(Data(base64Encoded: try XCTUnwrap(request.value(forHTTPHeaderField: "x-trantor-sig"))))
        XCTAssertTrue(key.publicKey.isValidSignature(signature, for: Data(canonical.utf8)))
    }

    func testLiveChatFramesAreSeparateFromFeedEventCursor() {        var parser = SSEParser()
        _ = parser.feed(line: "event: ev")
        _ = parser.feed(line: #"data: {"type":"chat.updated","project":"trantor","total":2,"working":true}"#)
        let frame = parser.feed(line: "")!
        XCTAssertEqual(EventStream.chatSignal(frame), ChatSignal(project: "trantor"))
        _ = parser.feed(line: "event: ev")
        _ = parser.feed(line: #"data: {"type":"chat.prompt","project":"trantor","id":42}"#)
        XCTAssertEqual(EventStream.chatSignal(parser.feed(line: "")!), ChatSignal(project: "trantor", promptID: "42"))
        _ = parser.feed(line: "event: chat.updated")
        _ = parser.feed(line: "data: {}")
        XCTAssertNil(EventStream.chatSignal(parser.feed(line: "")!))
    }
}

private final class ChatURLProtocol: URLProtocol {
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
        if request.url?.path == "/session/chat" { payload = #"{"session":"s1","total":0,"turns":[],"host":"mac"}"# }
        else if request.httpMethod == "POST" { payload = #"{"id":77,"status":"queued"}"# }
        else { payload = #"{"id":77,"status":"delivered"}"# }
        let response = HTTPURLResponse(url: request.url!, statusCode: 200, httpVersion: "HTTP/1.1", headerFields: nil)!
        client?.urlProtocol(self, didReceive: response, cacheStoragePolicy: .notAllowed)
        client?.urlProtocol(self, didLoad: Data(payload.utf8))
        client?.urlProtocolDidFinishLoading(self)
    }
    override func stopLoading() {}
}
