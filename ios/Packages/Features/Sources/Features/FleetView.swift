import SwiftUI
import TrantorCore
import TrantorDesign
import TrantorStore

public struct FleetView: View {
    @Environment(AppModel.self) private var model
    @State private var showCost = false

    public init() {}

    public var body: some View {
        let fleet = model.fleet
        ScrollView {
            LazyVStack(alignment: .leading, spacing: Space.md) {
                PillPicker([(false, "Seats"), (true, "Cost")], selection: $showCost).padding(.vertical, Space.xs)
                if showCost {
                    CostContent()
                } else {
                    if fleet.freshness.isStale { FreshnessBanner(freshness: fleet.freshness) }
                    HStack(spacing: Space.md) {
                        StatTile("Online", value: "\(fleet.online.count)")
                        StatTile("Seats", value: "\(fleet.peers.count)")
                    }
                    if !fleet.collisions.isEmpty {
                        Panel("File collisions", accessory: { CountBadge(fleet.collisions.count) }) {
                            ForEach(Array(fleet.collisions.enumerated()), id: \.offset) { _, collision in
                                Label(collisionText(collision), systemImage: "exclamationmark.triangle.fill")
                                    .font(.tData).foregroundStyle(Palette.amber)
                            }
                        }
                    }
                    Eyebrow("Seats").padding(.top, Space.sm)
                    if fleet.peers.isEmpty { EmptyState(title: "No seats", systemImage: "person.3").card() }
                    ForEach(fleet.peers) { PeerRow(peer: $0).card() }
                }
            }
            .padding(.horizontal, Space.lg).padding(.bottom, Space.xl)
        }
        .stage()
        .navigationTitle("Fleet")
        .refreshable {
            if showCost { await model.cost.refresh() } else { await fleet.refresh() }
        }
    }

    private func collisionText(_ collision: JSONValue) -> String {
        let file = collision["file"]?.stringValue ?? "a file"
        let who = (collision["sessions"]).flatMap { value -> String? in
            if case .array(let names) = value { return names.compactMap(\.stringValue).joined(separator: ", ") } else { return nil }
        } ?? ""
        return who.isEmpty ? file : "\(file): \(who)"
    }
}

struct PeerRow: View {
    let peer: Peer
    var body: some View {
        HStack(alignment: .top, spacing: Space.md) {
            NameMark(peer.session, size: 34)
            VStack(alignment: .leading, spacing: Space.sm) {
                HStack(spacing: Space.sm) {
                    Text(peer.session).font(.mono(14, .medium)).foregroundStyle(Palette.text)
                    Spacer()
                    StatusDot(live: peer.online)
                    Text(peer.online ? "online" : "offline").font(.tDataSmall).foregroundStyle(peer.online ? Palette.up : Palette.textDim)
                }
                ViewThatFits(in: .horizontal) {
                    tags
                    ScrollView(.horizontal, showsIndicators: false) { tags }
                }
                if !peer.status.isEmpty {
                    HStack {
                        Text(peer.status).font(.tCallout).foregroundStyle(Palette.text2)
                        Spacer()
                        TimeAgo(millis: peer.lastSeen)
                    }
                }
            }
        }
        .accessibilityElement(children: .combine)
    }
    private var tags: some View {
        HStack(spacing: Space.sm) {
            if !peer.project.isEmpty { Chip(peer.project, color: Palette.hue(for: peer.project)) }
            if !peer.model.isEmpty { Chip(peer.model) } else if !peer.llm.isEmpty { Chip(peer.llm) }
            if !peer.kind.isEmpty { Chip(peer.kind, color: Palette.textDim) }
        }
    }
}

public struct CostView: View {
    @Environment(AppModel.self) private var model

    public init() {}

    public var body: some View {
        ScrollView {
            LazyVStack(alignment: .leading, spacing: Space.md) { CostContent() }
                .padding(.horizontal, Space.lg).padding(.bottom, Space.xl)
        }
        .stage()
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
            }.foregroundStyle(Palette.amber).card()
        }
        if cost.entries.isEmpty {
            EmptyState(title: "No balances", systemImage: "dollarsign.circle", message: "A Mac pushes provider balances to the hub.").card()
        }
        LazyVGrid(columns: [GridItem(.adaptive(minimum: 220), spacing: Space.md)], spacing: Space.md) {
            ForEach(cost.entries) { entry in
                VStack(alignment: .leading, spacing: Space.sm) {
                    StatTile(entry.label.isEmpty ? entry.provider : entry.label, value: amount(entry))
                        .overlay(alignment: .leading) {
                            if entry.low || !entry.ok {
                                Capsule().fill(entry.ok ? Palette.amber : Palette.down).frame(width: 3).padding(.vertical, Space.md)
                            }
                        }
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
