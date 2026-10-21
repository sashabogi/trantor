import SwiftUI
import TrantorCore
import TrantorStore

/// iPad: sidebar and detail. iPhone: tabs with Decisions first. Unpaired: pairing.
public struct RootView: View {
    @Environment(AppModel.self) private var model
    @Environment(\.horizontalSizeClass) private var sizeClass
    @Environment(\.scenePhase) private var scenePhase

    public init() {}

    public var body: some View {
        Group {
            if !model.settings.isPaired || model.showPairingSummary {
                NavigationStack { PairingView() }
            } else if sizeClass == .regular {
                SplitRoot()
            } else {
                TabRoot()
            }
        }
        .onChange(of: model.pendingLink) { _, link in
            if link != nil && model.settings.isPaired { model.showPairingSummary = true }
        }
        .task(id: model.settings.isPaired) {
            guard model.settings.isPaired else { return }
            if !model.isConnected { model.connect() }
            await model.refreshAll()
            model.startFeed()
        }
        .onChange(of: scenePhase) { _, phase in
            guard model.settings.isPaired else { return }
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
        @Bindable var model = model
        TabView(selection: $model.selection) {
            ForEach(AppSection.allCases) { section in
                NavigationStack { SectionView(section: section) }
                    .tabItem { Label(section.title, systemImage: section.systemImage) }
                    .badge(section == .decisions ? model.decisions.pendingCount : 0)
                    .tag(section)
            }
        }
    }
}

struct SplitRoot: View {
    @Environment(AppModel.self) private var model

    var body: some View {
        @Bindable var model = model
        NavigationSplitView {
            List(AppSection.allCases, selection: Binding<AppSection?>(
                get: { model.selection }, set: { if let s = $0 { model.selection = s } })) { section in
                Label(section.title, systemImage: section.systemImage)
                    .badge(section == .decisions ? model.decisions.pendingCount : 0)
                    .tag(section)
            }
            .navigationTitle("Trantor")
        } detail: {
            NavigationStack { SectionView(section: model.selection) }
                .id(model.selection)
        }
    }
}

struct SectionView: View {
    let section: AppSection
    var body: some View {
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
}

// MARK: - Shared pieces

/// "Showing data from 3 minutes ago" when the hub has not confirmed what is on screen.
struct FreshnessBanner: View {
    let freshness: Freshness

    var body: some View {
        if let since = freshness.staleSince {
            HStack(spacing: 6) {
                Image(systemName: "wifi.slash")
                Text("Last confirmed")
                Text(since, style: .relative)
                Text("ago")
                Spacer()
            }
            .font(.footnote)
            .foregroundStyle(.secondary)
            .accessibilityElement(children: .combine)
        }
    }
}

struct EmptyState: View {
    let title: String
    let systemImage: String
    var message: String = ""

    var body: some View {
        ContentUnavailableView(title, systemImage: systemImage, description: message.isEmpty ? nil : Text(message))
    }
}

func date(fromMillis ms: Double) -> Date { Date(timeIntervalSince1970: ms / 1000) }

struct TimeAgo: View {
    let millis: Double
    var body: some View {
        if millis > 0 { Text(date(fromMillis: millis), style: .relative) } else { Text("") }
    }
}
