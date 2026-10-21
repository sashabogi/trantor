import CryptoKit
import XCTest
@testable import HubClient

final class SignerTests: XCTestCase {
    // The vector from card #12079. Node's verifyRequest must accept exactly this (see verify-vector.mjs).
    static let privateKeyBytes = Data((0..<32).map { UInt8($0) })
    static let method = "POST"
    static let path = "/task/update?x=1"
    static let body = Data(#"{"id":1}"#.utf8)
    static let ts: Int64 = 1_700_000_000_000
    static let nonce = "00112233445566778899aabbccddeeff"

    func testBodyHashIsLowercaseHexOfExactBytesOrEmpty() {
        XCTAssertEqual(Signer.bodyHash(nil), "")
        XCTAssertEqual(Signer.bodyHash(Data()), "")
        XCTAssertEqual(Signer.bodyHash(Data("abc".utf8)),
                       "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad")
    }

    func testFixedVectorMessageAndSignature() throws {
        let signer = try Signer(rawPrivateKey: Self.privateKeyBytes)
        let headers = try signer.sign(method: Self.method, path: Self.path, body: Self.body, ts: Self.ts, nonce: Self.nonce)

        let hash = Signer.bodyHash(Self.body)
        XCTAssertEqual(hash, "037c9214eef74cc3887f3a4f085b4e17d76280dafd273b0ee160c09c4ba1cfd4")   // shasum -a 256
        let message = Signer.canonicalString(method: Self.method, path: Self.path, hash: hash, ts: Self.ts, nonce: Self.nonce)
        XCTAssertEqual(message, "trantor-v1\nPOST\n/task/update?x=1\n\(hash)\n1700000000000\n00112233445566778899aabbccddeeff")
        XCTAssertEqual(message.split(separator: "\n", omittingEmptySubsequences: false).count, 6)
        XCTAssertFalse(message.hasSuffix("\n"))

        // Header shapes the hub checks.
        XCTAssertEqual(headers.pubkey.count, 64)
        XCTAssertEqual(headers.pubkey, headers.pubkey.lowercased())
        XCTAssertEqual(headers.nonce, Self.nonce)
        XCTAssertEqual(headers.ts, "1700000000000")
        let sigBytes = try XCTUnwrap(Data(base64Encoded: headers.sig))
        XCTAssertEqual(sigBytes.count, 64)
        XCTAssertTrue(headers.sig.hasSuffix("="), "64 bytes encode to 88 chars with padding")

        // The signature verifies with CryptoKit's public key over exactly that message.
        let pub = try Curve25519.Signing.PublicKey(rawRepresentation: Data(hex: headers.pubkey))
        XCTAssertTrue(pub.isValidSignature(sigBytes, for: Data(message.utf8)))
        // And fails if any signed field changes.
        let other = Signer.canonicalString(method: "GET", path: Self.path, hash: hash, ts: Self.ts, nonce: Self.nonce)
        XCTAssertFalse(pub.isValidSignature(sigBytes, for: Data(other.utf8)))
    }

    func testEmptyBodyUsesEmptyHashLine() throws {
        let m = Signer.canonicalString(method: "get", path: "/peers", hash: Signer.bodyHash(nil), ts: 5, nonce: "n")
        XCTAssertEqual(m, "trantor-v1\nGET\n/peers\n\n5\nn")
    }

    func testNonceIs32LowercaseHex() {
        let n = Signer.randomNonce()
        XCTAssertEqual(n.count, 32)
        XCTAssertNotNil(n.range(of: "^[0-9a-f]{32}$", options: .regularExpression))
        XCTAssertNotEqual(n, Signer.randomNonce())
    }

    func testClockOffsetShiftsTimestamp() throws {
        let signer = try Signer(rawPrivateKey: Self.privateKeyBytes)
        let local = Date()
        signer.calibrate(serverDate: local.addingTimeInterval(90), localNow: local)
        XCTAssertEqual(signer.clockOffsetMs, 90_000)
        let ts = try XCTUnwrap(Int64(signer.sign(method: "GET", path: "/x", body: nil).ts))
        let expected = Int64(Date().timeIntervalSince1970 * 1000) + 90_000
        XCTAssertLessThan(abs(ts - expected), 2_000)
    }

    /// Writes the Swift-produced vector to Tests/HubClientTests/Fixtures/signing-vector.json so Node can
    /// verify it. Always checks the committed fixture still matches what Swift produces now.
    func testCrossCheckFixtureMatchesSwiftOutput() throws {
        let signer = try Signer(rawPrivateKey: Self.privateKeyBytes)
        let h = try signer.sign(method: Self.method, path: Self.path, body: Self.body, ts: Self.ts, nonce: Self.nonce)
        let hash = Signer.bodyHash(Self.body)
        let vector: [String: Any] = [
            "method": Self.method, "path": Self.path, "body": String(decoding: Self.body, as: UTF8.self),
            "bodyHash": hash,
            "message": Signer.canonicalString(method: Self.method, path: Self.path, hash: hash, ts: Self.ts, nonce: Self.nonce),
            "ts": Self.ts,
            "headers": ["x-trantor-pubkey": h.pubkey, "x-trantor-sig": h.sig, "x-trantor-ts": h.ts, "x-trantor-nonce": h.nonce],
        ]
        let data = try JSONSerialization.data(withJSONObject: vector, options: [.prettyPrinted, .sortedKeys, .withoutEscapingSlashes])
        let url = URL(fileURLWithPath: #filePath).deletingLastPathComponent().appendingPathComponent("Fixtures/signing-vector.json")
        if ProcessInfo.processInfo.environment["TRANTOR_WRITE_VECTOR"] != nil {
            try FileManager.default.createDirectory(at: url.deletingLastPathComponent(), withIntermediateDirectories: true)
            try data.write(to: url)
        }
        // CryptoKit's Ed25519 signatures are randomized, so the committed signature will not equal a new
        // one byte for byte. Everything else must match, and the committed signature must still verify.
        var fresh = try XCTUnwrap(JSONSerialization.jsonObject(with: data) as? [String: Any])
        var old = try XCTUnwrap(JSONSerialization.jsonObject(with: try Data(contentsOf: url)) as? [String: Any])
        var freshHeaders = try XCTUnwrap(fresh["headers"] as? [String: String])
        var oldHeaders = try XCTUnwrap(old["headers"] as? [String: String])
        let oldSig = try XCTUnwrap(Data(base64Encoded: try XCTUnwrap(oldHeaders["x-trantor-sig"])))
        freshHeaders["x-trantor-sig"] = nil; oldHeaders["x-trantor-sig"] = nil
        fresh["headers"] = freshHeaders; old["headers"] = oldHeaders
        XCTAssertEqual(old as NSDictionary, fresh as NSDictionary, "signing inputs drifted: regenerate with TRANTOR_WRITE_VECTOR=1")
        let pub = try Curve25519.Signing.PublicKey(rawRepresentation: Data(hex: h.pubkey))
        XCTAssertTrue(pub.isValidSignature(oldSig, for: Data(Signer.canonicalString(
            method: Self.method, path: Self.path, hash: hash, ts: Self.ts, nonce: Self.nonce).utf8)))
    }
}

extension Data {
    init(hex: String) {
        var out = Data()
        var i = hex.startIndex
        while i < hex.endIndex {
            let j = hex.index(i, offsetBy: 2)
            out.append(UInt8(hex[i..<j], radix: 16) ?? 0)
            i = j
        }
        self = out
    }
}
