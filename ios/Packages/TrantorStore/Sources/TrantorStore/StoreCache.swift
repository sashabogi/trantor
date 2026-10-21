import Foundation

/// Last known state of a store, kept as one JSON file per store so the app opens with something
/// to show while the hub answers (or when the phone is off the tailnet).
public struct StoreCache: Sendable {
    private struct Envelope<T: Codable>: Codable {
        var savedAt: Date
        var value: T
    }

    public let directory: URL?

    /// `nil` disables caching (tests and previews).
    public init(directory: URL?) { self.directory = directory }

    public static var `default`: StoreCache {
        let base = FileManager.default.urls(for: .cachesDirectory, in: .userDomainMask).first
        return StoreCache(directory: base?.appendingPathComponent("TrantorStores", isDirectory: true))
    }

    private func url(_ name: String) -> URL? {
        let safe = name.map { $0.isLetter || $0.isNumber || $0 == "-" || $0 == "_" ? $0 : "_" }
        return directory?.appendingPathComponent(String(safe) + ".json")
    }

    public func load<T: Codable>(_ type: T.Type, name: String) -> (value: T, savedAt: Date)? {
        guard let url = url(name), let data = try? Data(contentsOf: url) else { return nil }
        let dec = JSONDecoder(); dec.dateDecodingStrategy = .secondsSince1970
        guard let env = try? dec.decode(Envelope<T>.self, from: data) else { return nil }
        return (env.value, env.savedAt)
    }

    public func save<T: Codable>(_ value: T, name: String, at date: Date = Date()) {
        guard let dir = directory, let url = url(name) else { return }
        try? FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
        let enc = JSONEncoder(); enc.dateEncodingStrategy = .secondsSince1970
        if let data = try? enc.encode(Envelope(savedAt: date, value: value)) { try? data.write(to: url, options: .atomic) }
    }

    public func clear() {
        guard let directory else { return }
        try? FileManager.default.removeItem(at: directory)
    }
}

/// How fresh a store's data is. `staleSince` is when the data stopped being confirmed by the hub.
public struct Freshness: Equatable, Sendable {
    public var lastUpdated: Date?
    public var staleSince: Date?
    public var lastError: String?

    public init(lastUpdated: Date? = nil, staleSince: Date? = nil, lastError: String? = nil) {
        self.lastUpdated = lastUpdated; self.staleSince = staleSince; self.lastError = lastError
    }

    public var isStale: Bool { staleSince != nil }

    public mutating func fresh(at date: Date = Date()) { lastUpdated = date; staleSince = nil; lastError = nil }
    public mutating func failed(_ message: String, at date: Date = Date()) {
        staleSince = staleSince ?? lastUpdated ?? date
        lastError = message
    }
    /// Data loaded from disk is by definition not yet confirmed.
    public mutating func fromCache(savedAt: Date) { lastUpdated = savedAt; staleSince = savedAt }
}
