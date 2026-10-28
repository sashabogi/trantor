import SwiftUI
import TrantorCore
import TrantorDesign
import TrantorStore

public struct FeedView: View {
    @Environment(AppModel.self) private var model

    public init() {}

    public var body: some View {
        let feed = model.feed
        ScrollView {
            LazyVStack(alignment: .leading, spacing: Space.md) {
                StatusHeadline("\(feed.filtered.count) events")
                    .padding(.top, Space.md)
                ScrollView(.horizontal, showsIndicators: false) {
                    HStack(spacing: Space.sm) {
                        Button("All") { feed.activeChips.removeAll() }
                            .buttonStyle(AuroraButtonStyle(feed.activeChips.isEmpty ? .primary : .standard))
                            .accessibilityAddTraits(feed.activeChips.isEmpty ? .isSelected : [])
                        ForEach(FeedStore.chips, id: \.label) { chip in
                            // Separate pills retain the tape's existing multi-select filtering.
                            AuroraPicker([(true, chip.label)], selection: Binding(
                                get: { feed.activeChips.contains(chip.label) },
                                set: { _ in
                                    if feed.activeChips.contains(chip.label) { feed.activeChips.remove(chip.label) }
                                    else { feed.activeChips.insert(chip.label) }
                                }))
                        }
                    }
                }.padding(.vertical, Space.xs)
                if feed.freshness.isStale { FreshnessBanner(freshness: feed.freshness) }
                if feed.filtered.isEmpty { EmptyState(title: "No events", systemImage: "list.bullet.rectangle").padding(Space.md).auroraPanel() }
                ForEach(feed.filtered) { event in EventRow(event: event).padding(Space.md).auroraPanel() }
            }
            .padding(.horizontal, Space.lg).padding(.bottom, Space.xl)
        }
        .auroraScreen(model.standingState().wash)
        .navigationTitle("Feed")
        .navigationBarTitleDisplayMode(.inline)
        .toolbar { ToolbarItem(placement: .topBarTrailing) { ConnectionDot(connection: feed.connection) } }
        .refreshable { await feed.refresh() }
    }
}

struct ConnectionDot: View {
    let connection: FeedConnection
    private var label: String {
        switch connection { case .live: return "Live"; case .reconnecting: return "Reconnecting"; case .idle: return "Paused" }
    }
    private var color: Color {
        switch connection { case .live: return Palette.live; case .reconnecting: return Palette.amber; case .idle: return Palette.textDim }
    }
    var body: some View {
        HStack(spacing: Space.sm) {
            StatusDot(color, live: connection == .live)
            Text(label).font(.tCaption).foregroundStyle(color)
        }.accessibilityElement(children: .combine)
    }
}

struct EventRow: View {
    let event: HubEvent
    private var color: Color { Palette.text2 }
    private var glyph: String {
        switch event.type {
        case let type where type.hasPrefix("hold"): return "hand.raised"
        case let type where type.hasPrefix("verify"): return "checkmark.shield"
        case let type where type.hasPrefix("proposal"): return "doc.badge.plus"
        case let type where type.hasPrefix("presence"): return "person.crop.circle"
        case let type where type.hasPrefix("message"): return "bubble.left"
        default: return "rectangle.stack"
        }
    }
    var body: some View {
        HStack(alignment: .top, spacing: Space.md) {
            Image(systemName: glyph).font(.ui(14)).foregroundStyle(color).frame(width: 20).padding(.top, 2)
            VStack(alignment: .leading, spacing: Space.sm) {
                HStack {
                    Text(event.type).font(.tDataSmall).foregroundStyle(color)
                    Spacer()
                    TimeAgo(millis: event.ts)
                }
                Text(event.summary).font(.tCallout).foregroundStyle(Palette.text).lineLimit(3)
                ViewThatFits(in: .horizontal) {
                    metadata
                    VStack(alignment: .leading, spacing: Space.sm) {
                        if !event.by.isEmpty { SeatLine(seat: event.by, verb: "") }
                        tags
                    }
                }
            }
        }
    }
    private var metadata: some View {
        HStack(spacing: Space.sm) {
            if !event.by.isEmpty { SeatLine(seat: event.by, verb: "") }
            Spacer(minLength: Space.sm)
            tags
        }
    }
    private var tags: some View {
        HStack(spacing: Space.sm) {
            if !event.project.isEmpty { Chip(event.project) }
            if let id = event.taskId { Mono("#\(id)", font: .tDataSmall) }
        }
    }
}

#Preview("Feed") {
    NavigationStack { FeedView() }.environment(DemoData.model()).trantorTheme()
}
