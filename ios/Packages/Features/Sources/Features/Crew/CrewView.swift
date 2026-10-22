import SwiftUI
import TrantorCore
import TrantorDesign
import TrantorStore

struct CrewView: View {
    let store: CrewStore
    @State private var picker: CrewPicker?
    @State private var stopCrew = false
    @Environment(\.scenePhase) private var scenePhase

    var body: some View {
        ScrollView {
            LazyVStack(alignment: .leading, spacing: Space.md) {
                ViewThatFits(in: .horizontal) {
                    HStack { controls }
                    VStack(alignment: .leading, spacing: Space.sm) { controls }
                }
                .disabled(store.busy || store.disabledReason != nil)
                if let reason = store.disabledReason { Text(reason).font(.tCallout).foregroundStyle(Palette.textDim).card() }
                if store.freshness.isStale { FreshnessBanner(freshness: store.freshness) }
                if store.fleet.freshness.isStale { FreshnessBanner(freshness: store.fleet.freshness) }
                if let error = store.error { Label(error, systemImage: "exclamationmark.triangle").foregroundStyle(Palette.down).card() }
                if store.sending {
                    HStack { ProgressView(); Text("Confirming command…").font(.tCallout) }.card()
                }
                ForEach(store.commands) { CrewCommandBanner(command: $0) }
                HStack { Eyebrow("Seats"); CountBadge(store.seats.count, hot: false) }
                if store.seats.isEmpty {
                    StageEmpty("No crew seats", systemImage: "person.3", message: "Add seats to work on this project.").card()
                }
                ForEach(store.seats) { peer in seatRow(peer) }
            }
            .padding(.horizontal, Space.lg).padding(.vertical, Space.md)
        }
        .stage()
        .task { await store.refresh(); await store.refreshCommands() }
        .onChange(of: scenePhase) { _, phase in
            if phase == .active { Task { await store.refresh(); await store.refreshCommands() } }
        }
        .refreshable { await store.refresh(); await store.refreshCommands() }
        .sheet(item: $picker) { selection in
            CrewRosterSheet(store: store, replacing: selection.from)
        }
        .alert("Stop the crew?", isPresented: $stopCrew) {
            Button("Stop the crew", role: .destructive) { Task { await store.command(.down) } }
            Button("Cancel", role: .cancel) {}
        } message: { Text("Stop every crew seat in \(store.project).") }
    }

    @ViewBuilder private var controls: some View {
        Button { picker = CrewPicker() } label: { Label("Add seats", systemImage: "plus") }
            .buttonStyle(.primary).accessibilityIdentifier("crew.add")
        Button("Stop the crew", role: .destructive) { stopCrew = true }
            .buttonStyle(.ghost).foregroundStyle(Palette.down).accessibilityIdentifier("crew.stopAll")
    }

    private func seatRow(_ peer: Peer) -> some View {
        let state = CrewStore.state(for: peer)
        return VStack(alignment: .leading, spacing: Space.md) {
            HStack(alignment: .top, spacing: Space.md) {
                NameMark(peer.session, size: 34)
                VStack(alignment: .leading, spacing: Space.sm) {
                    Text(CrewStore.spec(for: peer)).font(.tHeadline).foregroundStyle(Palette.text)
                    if !peer.model.isEmpty || !peer.llm.isEmpty { Chip(peer.model.isEmpty ? peer.llm : peer.model) }
                }
                Spacer()
                VStack(alignment: .trailing, spacing: Space.sm) {
                    HStack(spacing: Space.sm) {
                        StatusDot(live: peer.online && state != "stale" && state != "down")
                        Text(state).font(.tDataSmall).foregroundStyle(state == "working" ? Palette.up : Palette.textDim)
                    }
                    TimeAgo(millis: peer.lastSeen)
                }
            }
            HStack {
                Button("Swap") { picker = CrewPicker(from: CrewStore.spec(for: peer)) }.buttonStyle(.ghost).accessibilityIdentifier("crew.swap.\(CrewStore.spec(for: peer))")
                Button("Stop", role: .destructive) { Task { await store.command(.down, seats: [CrewStore.spec(for: peer)]) } }
                    .buttonStyle(.ghost).foregroundStyle(Palette.down).accessibilityIdentifier("crew.stop.\(CrewStore.spec(for: peer))")
            }.disabled(store.busy || store.disabledReason != nil)
        }.card()
    }
}

private struct CrewPicker: Identifiable {
    var from: String?
    var id: String { from ?? "add" }
}

private struct CrewCommandBanner: View {
    let command: CrewCommandStatus
    @State private var expanded = false
    private var color: Color {
        switch command.status {
        case "done": Palette.up
        case "failed", "expired": Palette.down
        default: Palette.blue
        }
    }
    var body: some View {
        VStack(alignment: .leading, spacing: Space.sm) {
            HStack {
                if !command.isFinal { ProgressView() }
                Chip(command.label, color: color)
                Spacer()
                Mono("#\(command.id)", color: Palette.textDim)
            }
            if !command.error.isEmpty { Text(command.error).font(.tCallout).foregroundStyle(Palette.down) }
            if command.status == "expired", command.error.isEmpty {
                Text("No Mac picked up this command. Open Trantor on your Mac.").font(.tCallout).foregroundStyle(Palette.textDim)
            }
            if !command.output.isEmpty {
                DisclosureGroup("CLI output", isExpanded: $expanded) {
                    WellField("Output", text: .constant(command.output), mono: true, axis: .vertical)
                        .allowsHitTesting(false)
                        .accessibilityLabel("CLI output: \(command.output)")
                }.font(.tCallout).tint(Palette.accent)
            }
        }.card()
    }
}

private struct CrewRosterSheet: View {
    let store: CrewStore
    let replacing: String?
    @State private var selected: Set<String> = []
    @State private var confirmCost = false
    @Environment(\.dismiss) private var dismiss

    var body: some View {
        NavigationStack {
            ScrollView {
                LazyVStack(alignment: .leading, spacing: Space.md) {
                    if let replacing { Text("Replace \(replacing) with a seat from this Mac.").font(.tCallout).foregroundStyle(Palette.textDim) }
                    if store.freshness.isStale { FreshnessBanner(freshness: store.freshness) }
                    if let error = store.error { Text(error).font(.tCallout).foregroundStyle(Palette.down).card() }
                    if store.roster.isEmpty {
                        StageEmpty("No roster available", systemImage: "person.3", message: "Open Trantor on your Mac to publish its available seats.").card()
                    }
                    ForEach(store.roster) { seat in
                        Button { toggle(seat.agent) } label: { rosterRow(seat) }
                            .buttonStyle(.plain).accessibilityIdentifier("crew.roster.\(seat.agent)")
                            .disabled(!seat.available || seat.agent == replacing || store.busy ||
                                      (replacing == nil && selected.count >= 6 && !selected.contains(seat.agent)))
                            .accessibilityAddTraits(selected.contains(seat.agent) ? .isSelected : [])
                    }
                }.padding(Space.lg)
            }
            .stage()
            .navigationTitle(replacing == nil ? "Add seats" : "Swap seat")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar { ToolbarItem(placement: .cancellationAction) { Button("Cancel") { dismiss() } } }
            .safeAreaInset(edge: .bottom) {
                Button(replacing == nil ? "Add selected seats" : "Swap seat") {
                    if store.needsCostConfirmation(seats: Array(selected)) { confirmCost = true }
                    else { submit(costConfirmed: false) }
                }
                .buttonStyle(.primary).accessibilityIdentifier("crew.submit")
                .disabled(selected.isEmpty || store.busy || store.disabledReason != nil)
                .padding(Space.lg)
                .frame(maxWidth: .infinity)
                .background(Palette.stage)
            }
            .task { await store.refresh() }
            .refreshable { await store.refresh() }
            .alert("This seat costs money per token", isPresented: $confirmCost) {
                Button("Confirm cost and continue") { submit(costConfirmed: true) }
                Button("Cancel", role: .cancel) {}
            } message: { Text("\(selected.sorted().joined(separator: ", ")) includes a metered seat. Usage is billed to its API plan.") }
        }
        .presentationDetents([.large])
    }

    private func rosterRow(_ seat: RosterSeat) -> some View {
        HStack(spacing: Space.md) {
            Image(systemName: selected.contains(seat.agent) ? "checkmark.circle.fill" : "circle").foregroundStyle(Palette.accent)
            NameMark(seat.agent, size: 30)
            VStack(alignment: .leading, spacing: Space.sm) {
                Text(seat.label.isEmpty ? seat.agent : seat.label).font(.tHeadline).foregroundStyle(Palette.text)
                if !seat.plan.isEmpty { Text(seat.plan).font(.tCallout).foregroundStyle(Palette.textDim) }
                if !seat.available {
                    Text(seat.reason.isEmpty ? "Unavailable on this Mac" : seat.reason).font(.tCaption).foregroundStyle(Palette.amber)
                }
            }
            Spacer()
            if seat.metered { Chip("$", color: Palette.amber).accessibilityLabel("Metered, costs money per token") }
        }.card().opacity(seat.available ? 1 : 0.6)
    }

    private func toggle(_ agent: String) {
        if selected.contains(agent) { selected.remove(agent) }
        else if replacing != nil { selected = [agent] }
        else if selected.count < 6 { selected.insert(agent) }
    }

    private func submit(costConfirmed: Bool) {
        Task {
            let sent: Bool
            if let replacing {
                sent = await store.command(.swap, from: replacing, to: selected.first, costConfirmed: costConfirmed)
            } else {
                sent = await store.command(.up, seats: selected.sorted(), costConfirmed: costConfirmed)
            }
            if sent { dismiss() }
        }
    }
}
