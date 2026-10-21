import SwiftUI
import TrantorDesign
import TrantorStore
import WidgetKit

/// The widget's deep link: tapping anywhere opens the app on Decisions.
private let decisionsURL = URL(string: "trantor://decisions")

struct TrantorWidgetEntry: TimelineEntry {
    let date: Date
    /// nil means no snapshot was ever written: the app is not paired (or never ran).
    let snapshot: WidgetSnapshot?
}

struct TrantorWidgetProvider: TimelineProvider {
    init() { Fonts.register() }

    func placeholder(in context: Context) -> TrantorWidgetEntry {
        TrantorWidgetEntry(date: Date(), snapshot: Self.preview)
    }

    func getSnapshot(in context: Context, completion: @escaping (TrantorWidgetEntry) -> Void) {
        completion(load())
    }

    func getTimeline(in context: Context, completion: @escaping (Timeline<TrantorWidgetEntry>) -> Void) {
        let entry = load()
        // The app reloads timelines on every change; this is only the fallback.
        completion(Timeline(entries: [entry], policy: .after(entry.date.addingTimeInterval(30 * 60))))
    }

    private func load() -> TrantorWidgetEntry {
        TrantorWidgetEntry(date: Date(), snapshot: WidgetSnapshotStore().load())
    }

    static let preview = WidgetSnapshot(
        count: 3, holds: 1, gates: 1, proposals: 0, asks: 1,
        top: .init(kind: "hold", title: "hub/routes/holds.mjs", project: "trantor", ts: Date().timeIntervalSince1970),
        savedAt: Date())
}

struct TrantorWidgetEntryView: View {
    @Environment(\.widgetFamily) private var family
    let entry: TrantorWidgetEntry

    var body: some View {
        switch family {
        case .accessoryCircular:
            accessoryCircular
        case .accessoryRectangular:
            accessoryRectangular
        case .systemMedium:
            homeScreen(compact: false)
        default:
            homeScreen(compact: true)
        }
    }

    // MARK: Home screen (small / medium)

    @ViewBuilder
    private func homeScreen(compact: Bool) -> some View {
        if let snapshot = entry.snapshot {
            VStack(alignment: .leading, spacing: Space.sm) {
                HStack(alignment: .firstTextBaseline, spacing: Space.sm) {
                    Text("\(snapshot.count)")
                        .font(.mono(compact ? 30 : 34, .medium)).monospacedDigit()
                        .foregroundStyle(snapshot.count > 0 ? Palette.accent : Palette.text)
                        .shadow(color: snapshot.count > 0 ? Palette.accent.opacity(0.5) : .clear, radius: 12)
                        .contentTransition(.numericText())
                    Text("waiting on you").font(.tCaption).foregroundStyle(Palette.text2)
                    Spacer()
                }
                kindRow(snapshot)
                Spacer(minLength: 0)
                if let top = snapshot.top {
                    topLine(top, compact: compact)
                } else {
                    Text("Nothing waiting").font(.tCallout).foregroundStyle(Palette.textDim)
                }
                staleLine(snapshot.savedAt)
            }
            .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .topLeading)
        } else {
            VStack(alignment: .leading, spacing: Space.sm) {
                Eyebrow("Trantor")
                Spacer(minLength: 0)
                Text("Not paired").font(.tHeadline).foregroundStyle(Palette.text)
                Text("Open Trantor to pair with your hub.").font(.tCaption).foregroundStyle(Palette.textDim)
            }
            .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .topLeading)
        }
    }

    private func kindRow(_ snapshot: WidgetSnapshot) -> some View {
        HStack(spacing: Space.sm + 2) {
            kindCount("Holds", snapshot.holds)
            kindCount("Gates", snapshot.gates)
            kindCount("Props", snapshot.proposals)
            kindCount("Asks", snapshot.asks)
        }
    }

    private func kindCount(_ label: String, _ value: Int) -> some View {
        HStack(spacing: 4) {
            Text(label.uppercased()).font(.mono(9, .medium)).tracking(0.8)
                .foregroundStyle(Palette.textDim)
            Text("\(value)").font(.mono(11, .medium)).monospacedDigit()
                .foregroundStyle(value > 0 ? Palette.text : Palette.textFaint)
        }
    }

    private func topLine(_ top: WidgetSnapshot.Top, compact: Bool) -> some View {
        VStack(alignment: .leading, spacing: 3) {
            HStack(spacing: 6) {
                Eyebrow(Self.kindTitle(top.kind), color: Self.kindColor(top.kind))
                if !top.project.isEmpty {
                    Text(top.project).font(.mono(9, .medium)).foregroundStyle(Palette.hue(for: top.project))
                        .lineLimit(1)
                }
            }
            Text(top.title)
                .font(compact ? .tCaption : .tData)
                .foregroundStyle(Palette.text)
                .lineLimit(compact ? 1 : 2)
        }
    }

    /// "as of 3m" — the snapshot's age, so stale data reads as stale.
    private func staleLine(_ savedAt: Date) -> some View {
        let minutes = max(0, Int(entry.date.timeIntervalSince(savedAt) / 60))
        let age = minutes < 1 ? "just now" : minutes < 60 ? "\(minutes)m" : "\(minutes / 60)h"
        return Text("as of \(age)").font(.mono(9, .regular)).foregroundStyle(Palette.textFaint)
    }

    // MARK: Lock screen

    private var accessoryCircular: some View {
        let count = entry.snapshot?.count ?? 0
        return ZStack {
            AccessoryWidgetBackground()
            VStack(spacing: 1) {
                Text("\(count)").font(.mono(20, .semibold)).monospacedDigit()
                Text("waiting").font(.mono(8, .medium))
            }
        }
    }

    private var accessoryRectangular: some View {
        HStack {
            if let snapshot = entry.snapshot {
                VStack(alignment: .leading, spacing: 2) {
                    HStack(alignment: .firstTextBaseline, spacing: 5) {
                        Text("\(snapshot.count)").font(.mono(17, .semibold)).monospacedDigit()
                        Text("WAITING").font(.mono(9, .medium)).tracking(0.8)
                    }
                    if let top = snapshot.top {
                        Text(top.title).font(.mono(11, .regular)).lineLimit(2)
                    }
                }
            } else {
                VStack(alignment: .leading, spacing: 2) {
                    Text("TRANTOR").font(.mono(9, .medium)).tracking(0.8)
                    Text("Not paired").font(.mono(11, .regular))
                }
            }
            Spacer(minLength: 0)
        }
    }

    static func kindTitle(_ kind: String) -> String {
        switch kind {
        case "hold": return "File hold"
        case "gate": return "Verify gate"
        case "proposal": return "Proposal"
        default: return "Question"
        }
    }

    static func kindColor(_ kind: String) -> Color {
        switch kind {
        case "hold": return Palette.amber
        case "gate": return Palette.accent
        case "proposal": return Palette.purple
        default: return Palette.blue
        }
    }
}

struct TrantorWidget: Widget {
    var body: some WidgetConfiguration {
        StaticConfiguration(kind: "ai.trantor.companion.widget", provider: TrantorWidgetProvider()) { entry in
            TrantorWidgetEntryView(entry: entry)
                .widgetURL(decisionsURL)
                .containerBackground(for: .widget) { StageBackground() }
        }
        .configurationDisplayName("Waiting on you")
        .description("Holds, verify gates, proposals and questions waiting on the operator.")
        .supportedFamilies([.systemSmall, .systemMedium, .accessoryCircular, .accessoryRectangular])
    }
}

@main
struct TrantorWidgetBundle: WidgetBundle {
    var body: some Widget {
        TrantorWidget()
    }
}

#Preview("Small", as: .systemSmall) {
    TrantorWidget()
} timeline: {
    TrantorWidgetEntry(date: Date(), snapshot: TrantorWidgetProvider.preview)
    TrantorWidgetEntry(date: Date(), snapshot: nil)
}
