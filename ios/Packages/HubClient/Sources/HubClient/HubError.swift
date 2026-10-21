import Foundation

public enum HubError: Error, Equatable, Sendable {
    /// 401: the signature or key was not accepted (or the clock is off).
    case unauthorized(String)
    /// 403: signed fine, but this identity may not do that.
    case forbidden(String)
    /// 409: someone else got there first ("already decided").
    case conflict(String)
    case notFound(String)
    case badRequest(String)
    /// No answer. For a POST, `op` is the id to hand to `reconcile(op:)`.
    case offline(op: String?)
    case timeout(op: String?)
    case server(code: Int, message: String)
    case decoding(String)
    case invalidURL

    public var isAlreadyDecided: Bool { if case .conflict = self { return true } else { return false } }
    public var isConnectivity: Bool {
        switch self { case .offline, .timeout: return true; default: return false }
    }

    public var userMessage: String {
        switch self {
        case .unauthorized(let m): return m.isEmpty ? "The hub did not accept this device. Pair again." : "The hub did not accept this device: \(m)"
        case .forbidden(let m): return m.isEmpty ? "This device is not allowed to do that." : m
        case .conflict(let m): return m.isEmpty ? "Already decided." : m
        case .notFound(let m): return m.isEmpty ? "Not found." : m
        case .badRequest(let m): return m.isEmpty ? "The hub refused the request." : m
        case .offline: return "Can't reach the hub. Check that Tailscale is connected."
        case .timeout: return "The hub did not answer in time."
        case .server(_, let m): return m.isEmpty ? "The hub had an error." : m
        case .decoding(let m): return "Unexpected answer from the hub: \(m)"
        case .invalidURL: return "That hub address is not valid."
        }
    }
}
