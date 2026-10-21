import CryptoKit
import Foundation

/// The four headers the hub reads (lib/identity.mjs HDR).
public struct SignedHeaders: Equatable, Sendable {
    public var pubkey: String
    public var sig: String
    public var ts: String
    public var nonce: String

    public var dictionary: [String: String] {
        ["x-trantor-pubkey": pubkey, "x-trantor-sig": sig, "x-trantor-ts": ts, "x-trantor-nonce": nonce]
    }
}

/// Signs requests exactly like `signRequest` in lib/identity.mjs:
///
///     message = "trantor-v1\nMETHOD\npath\nbodyHashHex\nts\nnonce"
///
/// `path` is the URL pathname plus query string as sent. `bodyHashHex` is the lowercase hex
/// SHA-256 of the exact body bytes, or "" for no body. The signature is Ed25519 over the message
/// bytes with no prehash.
public final class Signer: @unchecked Sendable {
    public static let scheme = "trantor-v1"

    private let key: Curve25519.Signing.PrivateKey
    private let lock = NSLock()
    private var offsetMs: Int64 = 0

    public init(privateKey: Curve25519.Signing.PrivateKey) { self.key = privateKey }

    public convenience init(rawPrivateKey: Data) throws {
        try self.init(privateKey: Curve25519.Signing.PrivateKey(rawRepresentation: rawPrivateKey))
    }

    /// 64 lowercase hex chars: the raw public key, as `x-trantor-pubkey`.
    public var publicKeyHex: String { Self.hex(key.publicKey.rawRepresentation) }

    /// Server time minus local time, in ms. The hub rejects skew over 120 s.
    public var clockOffsetMs: Int64 {
        get { lock.lock(); defer { lock.unlock() }; return offsetMs }
        set { lock.lock(); offsetMs = newValue; lock.unlock() }
    }

    /// Learn the offset from an HTTP `Date` header (second resolution is plenty).
    public func calibrate(serverDate: Date, localNow: Date = Date()) {
        clockOffsetMs = Int64((serverDate.timeIntervalSince(localNow) * 1000).rounded())
    }

    public func nowMs() -> Int64 { Int64((Date().timeIntervalSince1970 * 1000).rounded()) + clockOffsetMs }

    public static func bodyHash(_ body: Data?) -> String {
        guard let body, !body.isEmpty else { return "" }
        return hex(Data(SHA256.hash(data: body)))
    }

    public static func canonicalString(method: String, path: String, hash: String, ts: Int64, nonce: String) -> String {
        [scheme, method.uppercased(), path, hash, String(ts), nonce].joined(separator: "\n")
    }

    public static func randomNonce() -> String {
        var bytes = [UInt8](repeating: 0, count: 16)
        for i in bytes.indices { bytes[i] = UInt8.random(in: .min ... .max) }
        return hex(Data(bytes))
    }

    /// Sign with explicit ts and nonce (used by tests and the cross-check).
    public func sign(method: String, path: String, body: Data?, ts: Int64, nonce: String) throws -> SignedHeaders {
        let message = Self.canonicalString(method: method, path: path, hash: Self.bodyHash(body), ts: ts, nonce: nonce)
        let sig = try key.signature(for: Data(message.utf8))
        return SignedHeaders(pubkey: publicKeyHex, sig: sig.base64EncodedString(), ts: String(ts), nonce: nonce)
    }

    public func sign(method: String, path: String, body: Data?) throws -> SignedHeaders {
        try sign(method: method, path: path, body: body, ts: nowMs(), nonce: Self.randomNonce())
    }

    static func hex(_ data: Data) -> String {
        data.map { String(format: "%02x", $0) }.joined()
    }
}
