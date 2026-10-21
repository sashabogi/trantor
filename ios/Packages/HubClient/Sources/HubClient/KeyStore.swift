import CryptoKit
import Foundation
import Security

/// Where the 32-byte Ed25519 private key lives. The Secure Enclave only does P-256, so the raw
/// bytes go in the Keychain.
public protocol KeyStore: Sendable {
    func loadKey() throws -> Curve25519.Signing.PrivateKey?
    func saveKey(_ key: Curve25519.Signing.PrivateKey) throws
    func deleteKey() throws
}

public extension KeyStore {
    /// Load the stored key or mint and store a new one.
    func loadOrCreate() throws -> Curve25519.Signing.PrivateKey {
        if let k = try loadKey() { return k }
        let k = Curve25519.Signing.PrivateKey()
        try saveKey(k)
        return k
    }
}

public final class InMemoryKeyStore: KeyStore, @unchecked Sendable {
    private let lock = NSLock()
    private var raw: Data?
    public init(raw: Data? = nil) { self.raw = raw }
    public func loadKey() throws -> Curve25519.Signing.PrivateKey? {
        lock.lock(); defer { lock.unlock() }
        return try raw.map { try Curve25519.Signing.PrivateKey(rawRepresentation: $0) }
    }
    public func saveKey(_ key: Curve25519.Signing.PrivateKey) throws {
        lock.lock(); raw = key.rawRepresentation; lock.unlock()
    }
    public func deleteKey() throws { lock.lock(); raw = nil; lock.unlock() }
}

public struct KeychainError: Error, Equatable, LocalizedError {
    public let status: OSStatus
    public init(status: OSStatus) { self.status = status }
    public var errorDescription: String? {
        if status == errSecMissingEntitlement {
            return "This build can't use the Keychain (\(status)): it isn't code signed."
        }
        let why = SecCopyErrorMessageString(status, nil) as String? ?? "unknown"
        return "The Keychain refused the signing key (\(status): \(why))."
    }
}

/// Generic-password item, readable only while unlocked and never synced or migrated off this device.
public struct KeychainKeyStore: KeyStore {
    public let service: String
    public let account: String

    public init(service: String = "ai.trantor.companion", account: String = "identity-ed25519") {
        self.service = service; self.account = account
    }

    private var query: [String: Any] {
        [kSecClass as String: kSecClassGenericPassword,
         kSecAttrService as String: service,
         kSecAttrAccount as String: account]
    }

    public func loadKey() throws -> Curve25519.Signing.PrivateKey? {
        var q = query
        q[kSecReturnData as String] = true
        q[kSecMatchLimit as String] = kSecMatchLimitOne
        var out: CFTypeRef?
        let status = SecItemCopyMatching(q as CFDictionary, &out)
        if status == errSecItemNotFound { return nil }
        guard status == errSecSuccess, let data = out as? Data else { throw KeychainError(status: status) }
        return try Curve25519.Signing.PrivateKey(rawRepresentation: data)
    }

    public func saveKey(_ key: Curve25519.Signing.PrivateKey) throws {
        try deleteKey()
        var q = query
        q[kSecValueData as String] = key.rawRepresentation
        q[kSecAttrAccessible as String] = kSecAttrAccessibleWhenUnlockedThisDeviceOnly
        q[kSecAttrSynchronizable as String] = false
        let status = SecItemAdd(q as CFDictionary, nil)
        guard status == errSecSuccess else { throw KeychainError(status: status) }
    }

    public func deleteKey() throws {
        let status = SecItemDelete(query as CFDictionary)
        guard status == errSecSuccess || status == errSecItemNotFound else { throw KeychainError(status: status) }
    }
}
