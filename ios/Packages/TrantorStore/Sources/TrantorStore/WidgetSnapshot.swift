import Foundation
#if canImport(WidgetKit)
import WidgetKit
#endif

/// What the home-screen widget shows, written by the app whenever the decisions queue changes.
/// The widget reads this file from the App Group container with no network.
public struct WidgetSnapshot: Codable, Equatable, Sendable {
    public struct Top: Codable, Equatable, Sendable {
        /// "hold" | "gate" | "proposal" | "ask"
        public var kind: String
        public var title: String
        public var project: String
        public var ts: Double
        public init(kind: String, title: String, project: String, ts: Double) {
            self.kind = kind; self.title = title; self.project = project; self.ts = ts
        }
    }

    public var count: Int
    public var holds: Int
    public var gates: Int
    public var proposals: Int
    public var asks: Int
    public var top: Top?
    public var savedAt: Date

    public init(count: Int, holds: Int, gates: Int, proposals: Int, asks: Int, top: Top?, savedAt: Date) {
        self.count = count; self.holds = holds; self.gates = gates
        self.proposals = proposals; self.asks = asks; self.top = top; self.savedAt = savedAt
    }

    /// Derive the snapshot from the merged decisions queue (already sorted: holds, gates,
    /// proposals, asks; oldest first within a kind — so `items.first` is the top item).
    public static func derive(from items: [DecisionItem], at date: Date = Date()) -> WidgetSnapshot {
        var holds = 0, gates = 0, proposals = 0, asks = 0
        for item in items {
            switch item.kind {
            case .hold: holds += 1
            case .gate: gates += 1
            case .proposal: proposals += 1
            case .ask: asks += 1
            }
        }
        return WidgetSnapshot(count: items.count, holds: holds, gates: gates,
                              proposals: proposals, asks: asks, top: items.first.map(Self.top), savedAt: date)
    }

    private static func top(_ item: DecisionItem) -> Top {
        switch item.kind {
        case .hold(let h): return Top(kind: "hold", title: h.file, project: item.project, ts: item.ts)
        case .gate(let g): return Top(kind: "gate", title: g.claim, project: item.project, ts: item.ts)
        case .proposal(let p): return Top(kind: "proposal", title: p.scope, project: item.project, ts: item.ts)
        case .ask(let m): return Top(kind: "ask", title: m.text, project: item.project, ts: item.ts)
        }
    }
}

/// One JSON file in the shared App Group container. The app writes, the widget reads.
public struct WidgetSnapshotStore: Sendable {
    public static let appGroupID = "group.ai.trantor.companion"
    public static let fileName = "widget-snapshot.json"

    private let directory: URL?

    /// `nil` directory (no App Group, e.g. previews) disables the snapshot entirely.
    public init(directory: URL? = FileManager.default.containerURL(forSecurityApplicationGroupIdentifier: "group.ai.trantor.companion")) {
        self.directory = directory
    }

    public func load() -> WidgetSnapshot? {
        guard let url = fileURL(), let data = try? Data(contentsOf: url) else { return nil }
        let dec = JSONDecoder(); dec.dateDecodingStrategy = .secondsSince1970
        return try? dec.decode(WidgetSnapshot.self, from: data)
    }

    public func save(_ snapshot: WidgetSnapshot) {
        guard let directory, let url = fileURL() else { return }
        try? FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
        let enc = JSONEncoder(); enc.dateEncodingStrategy = .secondsSince1970
        if let data = try? enc.encode(snapshot) { try? data.write(to: url, options: .atomic) }
    }

    public func clear() {
        guard let url = fileURL() else { return }
        try? FileManager.default.removeItem(at: url)
    }

    /// App side: persist the snapshot and ask WidgetKit to reload the widget's timeline.
    public func publish(_ snapshot: WidgetSnapshot) {
        save(snapshot)
        reloadTimelines()
    }

    /// App side: unpaired — drop the snapshot so the widget falls back to "Not paired".
    public func clearAndReload() {
        clear()
        reloadTimelines()
    }

    private func reloadTimelines() {
        #if canImport(WidgetKit)
        WidgetCenter.shared.reloadAllTimelines()
        #endif
    }

    private func fileURL() -> URL? {
        directory?.appendingPathComponent(Self.fileName)
    }
}
