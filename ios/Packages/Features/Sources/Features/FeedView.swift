import SwiftUI
import TrantorCore
import TrantorStore

public struct FeedView: View {
    @Environment(AppModel.self) private var model

    public init() {}

    public var body: some View {
        let feed = model.feed
        List {
            Section {
                ScrollView(.horizontal, showsIndicators: false) {
                    HStack {
                        ForEach(FeedStore.chips, id: \.label) { chip in
                            let on = feed.activeChips.contains(chip.label)
                            Button(chip.label) {
                                if on { feed.activeChips.remove(chip.label) } else { feed.activeChips.insert(chip.label) }
                            }
                            .buttonStyle(.bordered)
                            .tint(on ? .accentColor : .secondary)
                            .accessibilityAddTraits(on ? .isSelected : [])
                        }
                    }
                }
                .listRowInsets(EdgeInsets(top: 4, leading: 12, bottom: 4, trailing: 12))
            }
            if feed.freshness.isStale { FreshnessBanner(freshness: feed.freshness) }
            if feed.filtered.isEmpty { EmptyState(title: "No events", systemImage: "list.bullet.rectangle") }
            ForEach(feed.filtered) { event in
                EventRow(event: event)
            }
        }
        .listStyle(.plain)
        .navigationTitle("Feed")
        .toolbar { ToolbarItem(placement: .topBarTrailing) { ConnectionDot(connection: feed.connection) } }
        .refreshable { await feed.refresh() }
    }
}

struct ConnectionDot: View {
    let connection: FeedConnection
    var body: some View {
        switch connection {
        case .live: Label("Live", systemImage: "circle.fill").foregroundStyle(.green).labelStyle(.titleAndIcon).font(.caption)
        case .reconnecting: Label("Reconnecting", systemImage: "arrow.triangle.2.circlepath").foregroundStyle(.orange).font(.caption)
        case .idle: Label("Paused", systemImage: "pause.circle").foregroundStyle(.secondary).font(.caption)
        }
    }
}

struct EventRow: View {
    let event: HubEvent
    var body: some View {
        VStack(alignment: .leading, spacing: 2) {
            HStack {
                Text(event.type).font(.caption.monospaced()).foregroundStyle(.secondary)
                Spacer()
                TimeAgo(millis: event.ts).font(.caption).foregroundStyle(.secondary)
            }
            Text(event.summary).lineLimit(3)
            HStack(spacing: 8) {
                if !event.by.isEmpty { Text(event.by) }
                if !event.project.isEmpty { Text(event.project) }
                if let t = event.taskId { Text("#\(t)") }
            }
            .font(.caption).foregroundStyle(.secondary)
        }
        .padding(.vertical, 2)
    }
}
