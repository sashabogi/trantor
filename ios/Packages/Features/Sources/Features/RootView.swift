import SwiftUI
import TrantorCore
import TrantorDesign
import TrantorStore

/// One navigation tree adapts between the sidebar and tabs without losing the current screen.
public struct RootView: View {
    @Environment(AppModel.self) private var model
    @Environment(\.scenePhase) private var scenePhase

    public init() {}

    public var body: some View {
        #if DEBUG
        if ProcessInfo.processInfo.arguments.contains("-gallery") {
            AuroraGallery()
        } else {
            applicationRoot
        }
        #else
        applicationRoot
        #endif
    }

    private var applicationRoot: some View {
        Group {
            if !model.isReady || model.showPairingSummary {
                NavigationStack { PairingView() }
            } else {
                TabRoot()
            }
        }
        .onChange(of: model.pendingLink) { _, link in
            if link != nil && model.settings.isPaired { model.showPairingSummary = true }
        }
        .task(id: model.isReady) {
            guard model.isReady else { return }
            if !model.isConnected { model.connect() }
            await model.refreshAll()
            model.startFeed()
        }
        .onChange(of: scenePhase) { _, phase in
            guard model.isReady else { return }
            if phase == .active {
                Task { await model.refreshAll(); model.startFeed() }
            } else if phase == .background {
                model.stopFeed()
            }
        }
        .alert("Already decided", isPresented: Binding(
            get: { model.decisions.notice != nil },
            set: { if !$0 { model.decisions.notice = nil } })) {
            Button("OK", role: .cancel) {}
        } message: {
            Text(model.decisions.notice ?? "")
        }
    }
}

struct TabRoot: View {
    @Environment(AppModel.self) private var model

    var body: some View {
        if #available(iOS 18.0, *) {
            tabs.tabViewStyle(.sidebarAdaptable)
        } else {
            tabs
        }
    }

    private var tabs: some View {
        @Bindable var model = model
        return TabView(selection: $model.selection) {
            ForEach(AppSection.tabs) { section in
                NavigationStack { SectionView(section: section) }
                    .tabItem { Label(section.title, systemImage: section.systemImage) }
                    .badge(badge(for: section))
                    .tag(section)
            }
        }
    }

    private func badge(for section: AppSection) -> Int {
        switch section {
        case .decisions: return model.decisions.pendingCount
        case .inbox: return model.inbox.unreadCount
        default: return 0
        }
    }
}

/// The wordmark: mint diamond and the name in mono caps.
struct BrandMark: View {
    var body: some View {
        HStack(spacing: Space.sm) {
            Image(systemName: "diamond.fill")
                .font(.system(size: 13, weight: .bold))
                .foregroundStyle(Palette.accent)
                .shadow(color: Palette.accent.opacity(0.6), radius: 8)
            Text("TRANTOR").font(.mono(13, .semibold)).tracking(2.6).foregroundStyle(Palette.text)
        }
        .accessibilityElement(children: .combine)
        .accessibilityLabel("Trantor")
    }
}

struct SidebarRow: View {
    let section: AppSection
    let selected: Bool
    let count: Int

    var body: some View {
        HStack(spacing: Space.md) {
            Image(systemName: section.systemImage)
                .font(.system(size: 15, weight: .regular))
                .frame(width: 22)
                .foregroundStyle(selected ? Palette.accent : Palette.textDim)
            Text(section.title).font(.ui(15, selected ? .semibold : .medium))
                .foregroundStyle(selected ? Palette.text : Palette.text2)
            Spacer()
            if count > 0 { CountBadge(count, hot: section == .decisions) }
        }
        .padding(.horizontal, Space.md).padding(.vertical, 10)
        .background(
            RoundedRectangle(cornerRadius: Radius.md, style: .continuous)
                .fill(selected ? Palette.raise : .clear)
        )
        .overlay(alignment: .leading) {
            if selected {
                Capsule().fill(Palette.accent).frame(width: 3, height: 18)
                    .shadow(color: Palette.accent.opacity(0.7), radius: 6)
            }
        }
        .contentShape(Rectangle())
        .accessibilityElement(children: .combine)
        .accessibilityAddTraits(selected ? [.isButton, .isSelected] : .isButton)
    }
}

/// "Connected 103 ms" pill from the ibkr top bar: live dot plus the hub's state.
struct ConnectionPill: View {
    @Environment(AppModel.self) private var model

    var body: some View {
        let stale = model.decisions.freshness.isStale
        HStack(spacing: Space.sm) {
            StatusDot(stale ? Palette.amber : Palette.live, live: !stale)
            Text(model.isDemo ? "Demo" : stale ? "Reconnecting" : "Connected").font(.ui(13, .medium))
                .foregroundStyle(Palette.text)
            Text(model.isDemo ? "no hub" : (model.settings.hubURL?.host ?? "")).font(.tDataSmall).foregroundStyle(Palette.textDim)
                .lineLimit(1)
        }
        .padding(.horizontal, 12).padding(.vertical, 7)
        .background(Capsule().fill(Palette.panel.opacity(0.8)))
        .overlay(Capsule().strokeBorder(Palette.line2))
        .accessibilityElement(children: .combine)
    }
}

struct SectionView: View {
    let section: AppSection
    var body: some View {
        Group {
            switch section {
            case .decisions: DecisionsView()
            case .projects: ProjectsView()
            case .feed: FeedView()
            case .inbox: InboxView()
            case .fleet: FleetView()
            case .cost: CostView()
            case .settings: SettingsView()
            }
        }
        .modifier(DuoContentBounds())
        .toolbarBackground(.hidden, for: .navigationBar)
    }
}

// MARK: - Shared pieces

/// "Last confirmed 3 minutes ago" when the hub has not confirmed what is on screen.
struct FreshnessBanner: View {
    let freshness: Freshness

    var body: some View {
        if let since = freshness.staleSince {
            HStack(spacing: Space.sm) {
                StatusDot(Palette.amber, live: false)
                Text("Offline. Last confirmed").font(.tCaption).foregroundStyle(Palette.text2)
                Text(since, style: .relative).font(.tDataSmall).monospacedDigit().foregroundStyle(Palette.amber)
                Text("ago").font(.tCaption).foregroundStyle(Palette.text2)
                Spacer()
            }
            .padding(.horizontal, 12).padding(.vertical, 8)
            .background(RoundedRectangle(cornerRadius: Radius.md, style: .continuous).fill(Palette.amber.opacity(0.08)))
            .overlay(RoundedRectangle(cornerRadius: Radius.md, style: .continuous).strokeBorder(Palette.amber.opacity(0.25)))
            .accessibilityElement(children: .combine)
        }
    }
}

struct EmptyState: View {
    let title: String
    let systemImage: String
    var message: String = ""

    var body: some View {
        StageEmpty(title, systemImage: systemImage, message: message)
    }
}

func date(fromMillis ms: Double) -> Date { Date(timeIntervalSince1970: ms / 1000) }

/// "4m", "2h", "3d": compact age in mono.
struct TimeAgo: View {
    let millis: Double
    var color: Color = Palette.textDim
    var body: some View {
        TimelineView(.periodic(from: .now, by: 30)) { ctx in
            Text(millis > 0 ? compactAge(millis, now: ctx.date) : "")
                .font(.tDataSmall).monospacedDigit().foregroundStyle(color)
        }
    }
}

func compactAge(_ millis: Double, now: Date = .now) -> String {
    let s = max(0, now.timeIntervalSince1970 - millis / 1000)
    if s < 60 { return "now" }
    if s < 3600 { return "\(Int(s / 60))m" }
    if s < 86400 { return "\(Int(s / 3600))h" }
    return "\(Int(s / 86400))d"
}
