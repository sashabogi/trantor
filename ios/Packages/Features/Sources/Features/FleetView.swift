import SwiftUI
import TrantorCore
import TrantorDesign
import TrantorStore

public struct FleetView: View {
    @Environment(AppModel.self) private var model
    @Environment(\.horizontalSizeClass) private var sizeClass
    @State private var showCost = false
    @State private var selectedID: String?

    public init() {}

    public var body: some View {
        Group {
            if sizeClass == .regular && !showCost {
                DuoSplitView {
                    sessions
                } detail: {
                    if let peer = model.fleet.peers.first(where: { $0.id == selectedID }) ?? model.fleet.peers.first {
                        FleetSeatDetail(peer: peer).id(peer.id)
                    } else {
                        EmptyState(title: "No seats", systemImage: "person.3")
                    }
                }
            } else {
                sessions.modifier(DuoContentBounds())
            }
        }
        .auroraScreen(model.standingState().wash)
        .navigationTitle("Fleet")
        .navigationBarTitleDisplayMode(.inline)
        .navigationDestination(for: Peer.self) { FleetSeatDetail(peer: $0).modifier(DuoContentBounds()) }
        .refreshable {
            if showCost { await model.cost.refresh() } else { await model.fleet.refresh() }
        }
    }

    private var sessions: some View {
        let fleet = model.fleet
        return ScrollView {
            LazyVStack(alignment: .leading, spacing: Space.md) {
                StatusHeadline("\(fleet.online.count) online · \(fleet.peers.count) seats")
                    .padding(.top, Space.md)
                AuroraPicker([(false, "Seats"), (true, "Cost")], selection: $showCost).padding(.vertical, Space.xs)
                if showCost {
                    CostContent()
                } else {
                    if fleet.freshness.isStale { FreshnessBanner(freshness: fleet.freshness) }
                    HStack(spacing: Space.md) {
                        StatTile("Online", value: "\(fleet.online.count)")
                        StatTile("Seats", value: "\(fleet.peers.count)")
                    }
                    if !fleet.collisions.isEmpty {
                        AuroraSection("File collisions", accessory: { CountBadge(fleet.collisions.count) }) {
                            ForEach(Array(fleet.collisions.enumerated()), id: \.offset) { _, collision in
                                Label(collisionText(collision), systemImage: "exclamationmark.triangle.fill")
                                    .font(.tData).foregroundStyle(Palette.amber)
                            }
                        }
                    }
                    Eyebrow("Seats").padding(.top, Space.sm)
                    if fleet.peers.isEmpty { EmptyState(title: "No seats", systemImage: "person.3").padding(Space.md).auroraPanel() }
                    ForEach(fleet.peers) { peer in
                        if sizeClass == .regular {
                            Button { selectedID = peer.id } label: { PeerRow(peer: peer) }
                                .buttonStyle(.plain)
                                .accessibilityIdentifier("fleet.select.\(peer.id)")
                                .accessibilityAddTraits((selectedID ?? fleet.peers.first?.id) == peer.id ? [.isSelected] : [])
                        } else {
                            NavigationLink(value: peer) { PeerRow(peer: peer) }.buttonStyle(.plain)
                        }
                    }
                }
            }
            .padding(.horizontal, Space.lg).padding(.bottom, Space.xl)
        }
        .accessibilityIdentifier("fleet.sessions")
    }

    private func collisionText(_ collision: JSONValue) -> String {
        let file = collision["file"]?.stringValue ?? "a file"
        let who = (collision["sessions"]).flatMap { value -> String? in
            if case .array(let names) = value { return names.compactMap(\.stringValue).joined(separator: ", ") } else { return nil }
        } ?? ""
        return who.isEmpty ? file : "\(file): \(who)"
    }
}

private struct FleetSeatDetail: View {
    @Environment(AppModel.self) private var model
    let peer: Peer
    @State private var draft = ""
    @State private var sending = false
    @FocusState private var composing: Bool

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: Space.md) {
                PeerRow(peer: peer)
                AuroraSection("Seat") {
                    if !peer.status.isEmpty { Detail(label: "Status", text: peer.status) }
                    if !peer.health.isEmpty { Detail(label: "Health", text: peer.health) }
                    if !peer.project.isEmpty { Detail(label: "Project", text: peer.project) }
                    if !peer.phase.isEmpty { Detail(label: "Phase", text: peer.phase) }
                    if !peer.model.isEmpty { Detail(label: "Model", text: peer.model) }
                    if peer.lastSeen > 0 { HStack { Eyebrow("Last seen"); TimeAgo(millis: peer.lastSeen) } }
                }
            }.padding(Space.lg)
        }
        .scrollDismissesKeyboard(.interactively)
        .safeAreaInset(edge: .bottom, spacing: 0) {
            VStack(alignment: .leading, spacing: Space.sm) {
                if let error = model.inbox.sendError { Text(error).font(.tCaption).foregroundStyle(Palette.down) }
                Composer(focused: composing) {
                    TextField("Message this seat", text: $draft, axis: .vertical)
                        .font(.ui(16)).lineLimit(1...5).focused($composing)
                        .accessibilityIdentifier("fleet.composer")
                    Button("Send", systemImage: "arrow.up") {
                        let message = draft
                        sending = true
                        Task {
                            await model.inbox.send(to: peer.session, text: message, project: peer.project)
                            if model.inbox.sendError == nil && draft == message { draft = "" }
                            sending = false
                        }
                    }
                    .buttonStyle(AuroraButtonStyle(.primary))
                    .disabled(sending || draft.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
                    .accessibilityIdentifier("fleet.send")
                }
            }.padding(Space.lg)
        }
        .accessibilityIdentifier("fleet.detail")
    }
}

struct PeerRow: View {
    let peer: Peer
    var body: some View {
        SeatCard(peer.session,
                 caption: ([peer.project, AuroraStandingState.caption(peer)]).filter { !$0.isEmpty }.joined(separator: " · "),
                 idle: !peer.online || !peer.status.hasPrefix("working"))
            .accessibilityElement(children: .combine)
    }
}

public struct CostView: View {
    @Environment(AppModel.self) private var model

    public init() {}

    public var body: some View {
        ScrollView {
            LazyVStack(alignment: .leading, spacing: Space.md) {
                StatusHeadline("\(model.cost.entries.count) balances").padding(.top, Space.md)
                CostContent()
            }
                .padding(.horizontal, Space.lg).padding(.bottom, Space.xl)
        }
        .auroraScreen(model.standingState().wash)
        .navigationTitle("Cost")
        .refreshable { await model.cost.refresh() }
    }
}

struct CostContent: View {
    @Environment(AppModel.self) private var model

    var body: some View {
        let cost = model.cost
        if cost.freshness.isStale { FreshnessBanner(freshness: cost.freshness) }
        if cost.lowCount > 0 {
            HStack(spacing: Space.sm) {
                Image(systemName: "exclamationmark.triangle.fill")
                Mono("\(cost.lowCount)", color: Palette.amber)
                Text("provider\(cost.lowCount == 1 ? "" : "s") running low").font(.tCallout)
            }.foregroundStyle(Palette.amber).padding(Space.md).auroraPanel()
        }
        if cost.entries.isEmpty {
            EmptyState(title: "No balances", systemImage: "dollarsign.circle", message: "A Mac pushes provider balances to the hub.").padding(Space.md).auroraPanel()
        }
        LazyVStack(alignment: .leading, spacing: Space.md) {
            ForEach(cost.entries) { entry in
                VStack(alignment: .leading, spacing: Space.sm) {
                    StatTile(entry.label.isEmpty ? entry.provider : entry.label, value: amount(entry))
                    HStack {
                        if !entry.plan.isEmpty || !entry.kind.isEmpty {
                            Chip(entry.plan.isEmpty ? entry.kind : entry.plan)
                        }
                        Spacer()
                        if !entry.ok { Chip("error", color: Palette.down) }
                        else if entry.low { Chip("low balance", color: Palette.amber) }
                    }.padding(.horizontal, Space.xs)
                }
            }
        }
    }

    private func amount(_ entry: BalanceEntry) -> String {
        if !entry.ok { return "Unavailable" }
        if let remaining = entry.remaining { return remaining.formatted(.currency(code: entry.currency.isEmpty ? "USD" : entry.currency)) }
        if let percent = entry.remainingPct { return "\(Int(percent))% left" }
        return "subscription"
    }
}

#Preview("Fleet") {
    NavigationStack { FleetView() }.environment(DemoData.model()).trantorTheme()
}

#Preview("Cost") {
    NavigationStack { CostView() }.environment(DemoData.model()).trantorTheme()
}
