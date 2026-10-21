import SwiftUI
import TrantorCore
import TrantorStore

public struct FleetView: View {
    @Environment(AppModel.self) private var model

    public init() {}

    public var body: some View {
        let fleet = model.fleet
        List {
            if fleet.freshness.isStale { FreshnessBanner(freshness: fleet.freshness) }
            if !fleet.collisions.isEmpty {
                Section("File collisions") {
                    ForEach(Array(fleet.collisions.enumerated()), id: \.offset) { _, c in
                        Label(collisionText(c), systemImage: "exclamationmark.triangle.fill").foregroundStyle(.orange)
                    }
                }
            }
            Section("Seats (\(fleet.online.count) online)") {
                if fleet.peers.isEmpty { EmptyState(title: "No seats", systemImage: "person.3") }
                ForEach(fleet.peers) { PeerRow(peer: $0) }
            }
        }
        .navigationTitle("Fleet")
        .refreshable { await fleet.refresh() }
    }

    private func collisionText(_ c: JSONValue) -> String {
        let file = c["file"]?.stringValue ?? "a file"
        let who = (c["sessions"]).flatMap { v -> String? in
            if case .array(let a) = v { return a.compactMap(\.stringValue).joined(separator: ", ") } else { return nil }
        } ?? ""
        return who.isEmpty ? file : "\(file): \(who)"
    }
}

struct PeerRow: View {
    let peer: Peer
    var body: some View {
        VStack(alignment: .leading, spacing: 2) {
            HStack {
                Circle().fill(peer.online ? Color.green : Color.secondary).frame(width: 8, height: 8)
                Text(peer.session).font(.headline)
                Spacer()
                if !peer.status.isEmpty { Text(peer.status).font(.caption).foregroundStyle(.secondary) }
            }
            HStack(spacing: 8) {
                if !peer.project.isEmpty { Text(peer.project) }
                if !peer.model.isEmpty { Text(peer.model) } else if !peer.llm.isEmpty { Text(peer.llm) }
                if !peer.kind.isEmpty { Text(peer.kind) }
            }
            .font(.caption).foregroundStyle(.secondary)
        }
        .accessibilityElement(children: .combine)
    }
}

public struct CostView: View {
    @Environment(AppModel.self) private var model

    public init() {}

    public var body: some View {
        let cost = model.cost
        List {
            if cost.freshness.isStale { FreshnessBanner(freshness: cost.freshness) }
            if cost.lowCount > 0 {
                Label("\(cost.lowCount) provider\(cost.lowCount == 1 ? "" : "s") running low", systemImage: "exclamationmark.triangle.fill")
                    .foregroundStyle(.orange)
            }
            if cost.entries.isEmpty { EmptyState(title: "No balances", systemImage: "dollarsign.circle", message: "A Mac pushes provider balances to the hub.") }
            ForEach(cost.entries) { e in
                HStack {
                    VStack(alignment: .leading) {
                        Text(e.label.isEmpty ? e.provider : e.label).font(.headline)
                        if !e.plan.isEmpty || !e.kind.isEmpty { Text(e.plan.isEmpty ? e.kind : e.plan).font(.caption).foregroundStyle(.secondary) }
                    }
                    Spacer()
                    Text(amount(e)).foregroundStyle(e.low ? .orange : (e.ok ? .primary : .red))
                }
            }
        }
        .navigationTitle("Cost")
        .refreshable { await cost.refresh() }
    }

    private func amount(_ e: BalanceEntry) -> String {
        if !e.ok { return "error" }
        if let r = e.remaining { return r.formatted(.currency(code: e.currency.isEmpty ? "USD" : e.currency)) }
        if let p = e.remainingPct { return "\(Int(p))% left" }
        return "subscription"
    }
}
