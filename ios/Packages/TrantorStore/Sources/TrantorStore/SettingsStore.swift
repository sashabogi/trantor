import CryptoKit
import Foundation
import HubClient
import Observation
import TrantorCore

/// `trantor://enroll?hub=http://100.79.242.104:4477&token=...`
public struct PairingLink: Equatable, Sendable {
    public var hub: String
    public var token: String

    public static func parse(_ url: URL) -> PairingLink? {
        guard url.scheme == "trantor", url.host == "enroll",
              let items = URLComponents(url: url, resolvingAgainstBaseURL: false)?.queryItems else { return nil }
        let hub = items.first { $0.name == "hub" }?.value ?? ""
        let token = items.first { $0.name == "token" }?.value ?? ""
        return hub.isEmpty || token.isEmpty ? nil : PairingLink(hub: hub, token: token)
    }
}

public enum PairingState: Equatable, Sendable {
    case idle
    case working(String)
    case paired(health: HealthInfo, scopes: [Scope])
    case failed(String)
}


@MainActor @Observable
public final class SettingsStore {
    public private(set) var hubURL: URL?
    public private(set) var identityName: String
    public private(set) var scopes: [Scope] = []
    public private(set) var pairing: PairingState = .idle

    public static var defaultRequireBiometrics: Bool {
        #if targetEnvironment(simulator)
        false
        #else
        true
        #endif
    }

    public var requireBiometrics: Bool { didSet { defaults.set(requireBiometrics, forKey: Keys.biometrics) } }
    public var notifyHolds: Bool { didSet { defaults.set(notifyHolds, forKey: Keys.notifyHolds) } }
    public var notifyProposals: Bool { didSet { defaults.set(notifyProposals, forKey: Keys.notifyProposals) } }
    public var notifyMessages: Bool { didSet { defaults.set(notifyMessages, forKey: Keys.notifyMessages) } }
    public var mutedProjects: Set<String> { didSet { defaults.set(Array(mutedProjects).sorted(), forKey: Keys.muted) } }

    public var isPaired: Bool { hubURL != nil && !identityName.isEmpty }

    private enum Keys {
        static let hub = "hubURL", name = "identityName", scopes = "scopes"
        static let notifyHolds = "notifyHolds", notifyProposals = "notifyProposals", notifyMessages = "notifyMessages"
        static let biometrics = "requireBiometrics"
        static let muted = "mutedProjects"
        static let publicHub = "publicHubURL"
    }

    private let defaults: UserDefaults
    private let keyStore: KeyStore
    private let makeAPI: @Sendable (URL, Signer) -> HubServing

    public init(defaults: UserDefaults = .standard,
                keyStore: KeyStore = KeychainKeyStore(),
                makeAPI: @escaping @Sendable (URL, Signer) -> HubServing = { HubAPI(baseURL: $0, signer: $1) }) {
        self.defaults = defaults; self.keyStore = keyStore; self.makeAPI = makeAPI
        hubURL = defaults.string(forKey: Keys.hub).flatMap(URL.init(string:))
        identityName = defaults.string(forKey: Keys.name) ?? ""
        if let data = defaults.data(forKey: Keys.scopes), let s = try? JSONDecoder().decode([Scope].self, from: data) { scopes = s }
        requireBiometrics = defaults.object(forKey: Keys.biometrics) as? Bool ?? Self.defaultRequireBiometrics
        notifyHolds = defaults.object(forKey: Keys.notifyHolds) as? Bool ?? true
        notifyProposals = defaults.object(forKey: Keys.notifyProposals) as? Bool ?? true
        notifyMessages = defaults.object(forKey: Keys.notifyMessages) as? Bool ?? true
        mutedProjects = Set(defaults.stringArray(forKey: Keys.muted) ?? [])
    }

    public static func normalizeHub(_ raw: String) -> URL? {
        var s = raw.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !s.isEmpty else { return nil }
        if !s.contains("://") { s = "http://" + s }
        while s.hasSuffix("/") { s.removeLast() }
        guard let u = URL(string: s), u.host != nil else { return nil }
        return u
    }

    public static func defaultDeviceName(_ model: String) -> String {
        let slug = model.lowercased().filter { $0.isLetter || $0.isNumber }
        return "ios-" + (slug.isEmpty ? "device" : slug)
    }

    /// The signer for the stored key, or nil before pairing.
    public func signer() -> Signer? {
        guard let key = try? keyStore.loadKey() else { return nil }
        return Signer(privateKey: key)
    }

    /// A client for the paired hub (calibrates the clock first via `health`).
    public func makeClient() -> HubServing? {
        guard let hubURL, let signer = signer() else { return nil }
        return makeAPI(hubURL, signer)
    }

    public var publicKeyHex: String? { signer()?.publicKeyHex }

    /// Generate a key, check the hub, enroll with the invite token. Remote trust-on-first-use is
    /// refused by the hub, so the invite is the only way in.
    public func pair(hub: String, token: String, deviceName: String) async {
        guard let url = Self.normalizeHub(hub) else { pairing = .failed("That hub address is not valid."); return }
        let name = deviceName.trimmingCharacters(in: .whitespaces)
        guard !name.isEmpty, !token.trimmingCharacters(in: .whitespaces).isEmpty else {
            pairing = .failed("A device name and an invite token are both needed."); return
        }
        pairing = .working("Creating a key on this device")
        do {
            // The new key only replaces the old one once the hub has accepted it, so a failed
            // re-pair leaves a working pairing alone.
            let key = Curve25519.Signing.PrivateKey()
            let api = makeAPI(url, Signer(privateKey: key))
            pairing = .working("Checking the hub")
            let health = try await api.health()
            pairing = .working("Enrolling")
            let result = try await api.enroll(token: token.trimmingCharacters(in: .whitespacesAndNewlines), name: name)
            guard result.ok else { pairing = .failed("The hub did not accept the invite."); return }
            try keyStore.saveKey(key)
            hubURL = url; identityName = result.name.isEmpty ? name : result.name; scopes = result.scopes
            defaults.set(url.absoluteString, forKey: Keys.hub)
            defaults.set(identityName, forKey: Keys.name)
            if let data = try? JSONEncoder().encode(scopes) { defaults.set(data, forKey: Keys.scopes) }
            pairing = .paired(health: health, scopes: scopes)
        } catch let e as HubError {
            pairing = .failed(e.userMessage(forHub: url))
        } catch {
            pairing = .failed(error.localizedDescription)
        }
    }

    /// Re-point at another address for the same hub (its public URL). The key, identity and scopes
    /// stay: signatures do not depend on the host, so there is nothing to re-pair. Clients built by
    /// `makeClient()` after this point at the new address.
    /// The hub's public https address, remembered whenever /health advertised one, so the phone can
    /// move to it later even when the address it is paired on (the tailnet one) no longer answers.
    public var knownPublicHub: URL? {
        get { defaults.string(forKey: Keys.publicHub).flatMap(URL.init(string:)) }
        set { defaults.set(newValue?.absoluteString, forKey: Keys.publicHub) }
    }

    public func setHub(_ url: URL) {
        hubURL = url
        defaults.set(url.absoluteString, forKey: Keys.hub)
    }

    /// Forget this device's pairing and delete its key. The hub keeps the identity until an owner revokes it.
    public func unpair() {
        try? keyStore.deleteKey()
        hubURL = nil; identityName = ""; scopes = []; pairing = .idle
        for k in [Keys.hub, Keys.name, Keys.scopes] { defaults.removeObject(forKey: k) }
    }

    public func toggleMute(_ project: String) {
        if mutedProjects.contains(project) { mutedProjects.remove(project) } else { mutedProjects.insert(project) }
    }
}
