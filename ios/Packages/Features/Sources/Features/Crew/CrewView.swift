import SwiftUI
import TrantorCore
import TrantorDesign
import TrantorStore

struct CrewView: View {
    @Environment(AppModel.self) private var model
    let store: CrewStore
    @State private var picker: CrewPicker?
    @State private var stopCrew = false
    @Environment(\.scenePhase) private var scenePhase
    @Environment(\.duoTyping) private var typing
    @Environment(\.duoCompactPortrait) private var compactPortrait

    var body: some View {
        Group {
            if compactPortrait {
                compactSummary
            } else {
                crewList
            }
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .top)
        .auroraScreen(model.standingState(for: store).wash)
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

    private var compactSummary: some View {
        HStack(spacing: Space.sm) {
            Text("\(store.seats.count) seats").font(.tHeadline)
            ForEach(store.seats.prefix(4)) { peer in SeatOrb(CrewStore.spec(for: peer), size: 28) }
            Spacer(minLength: 0)
            let waiting = model.decisions.items.filter { $0.project == store.project }.count
            if waiting > 0 {
                Button("\(waiting) waiting") { model.selection = .decisions }
                    .buttonStyle(AuroraButtonStyle())
            }
        }.padding(Space.md).auroraPanel().padding(.horizontal, Space.lg)
            .accessibilityElement(children: .contain)
            .accessibilityIdentifier("crew.summary")
    }

    private var crewList: some View {
        ScrollView {
            LazyVStack(alignment: .leading, spacing: Space.md) {
                StatusHeadline("\(store.seats.count) seats · \(model.standingState(for: store).working) working")
                if typing {
                    let waiting = model.decisions.items.filter { $0.project == store.project }.count
                    if waiting > 0 {
                        Button("\(waiting) waiting on you", systemImage: "checkmark.seal") { model.selection = .decisions }
                            .buttonStyle(AuroraButtonStyle())
                    }
                }
                if !typing {
                    ViewThatFits(in: .horizontal) {
                        HStack { controls }
                        VStack(alignment: .leading, spacing: Space.sm) { controls }
                    }
                    .disabled(store.busy || store.disabledReason != nil)
                }
                if let reason = store.disabledReason { Text(reason).font(.tCallout).foregroundStyle(Palette.textDim).padding(Space.md).auroraPanel() }
                if store.freshness.isStale { FreshnessBanner(freshness: store.freshness) }
                if store.fleet.freshness.isStale { FreshnessBanner(freshness: store.fleet.freshness) }
                if let error = store.error { Label(error, systemImage: "exclamationmark.triangle").foregroundStyle(Palette.down).padding(Space.md).auroraPanel() }
                if store.sending {
                    HStack { ProgressView(); Text("Confirming command…").font(.tCallout) }.padding(Space.md).auroraPanel()
                }
                ForEach(store.commands) { CrewCommandBanner(command: $0) }
                HStack { Eyebrow("Seats"); CountBadge(store.seats.count, hot: false) }
                if store.seats.isEmpty {
                    StageEmpty("No crew seats", systemImage: "person.3", message: "Add seats to work on this project.").padding(Space.md).auroraPanel()
                }
                ForEach(store.seats) { peer in
                    if typing {
                        SeatLine(seat: CrewStore.spec(for: peer), verb: AuroraStandingState.caption(peer))
                            .padding(Space.sm).auroraPanel()
                    } else { seatRow(peer) }
                }
            }
            .padding(.horizontal, Space.lg).padding(.vertical, Space.md)
        }
    }

    @ViewBuilder private var controls: some View {
        Button { picker = CrewPicker() } label: { Label("Add seats", systemImage: "plus") }
            .buttonStyle(AuroraButtonStyle(.primary)).accessibilityIdentifier("crew.add")
        Button("Stop the crew", role: .destructive) { stopCrew = true }
            .buttonStyle(AuroraButtonStyle(.destructive)).accessibilityIdentifier("crew.stopAll")
    }

    private func seatRow(_ peer: Peer) -> some View {
        return VStack(alignment: .leading, spacing: Space.sm) {
            SeatCard(CrewStore.spec(for: peer), caption: AuroraStandingState.caption(peer),
                     idle: !peer.online || !peer.status.hasPrefix("working"))
            HStack {
                Button("Swap") { picker = CrewPicker(from: CrewStore.spec(for: peer)) }.buttonStyle(AuroraButtonStyle()).accessibilityIdentifier("crew.swap.\(CrewStore.spec(for: peer))")
                Button("Stop", role: .destructive) { Task { await store.command(.down, seats: [CrewStore.spec(for: peer)]) } }
                    .buttonStyle(AuroraButtonStyle(.destructive)).accessibilityIdentifier("crew.stop.\(CrewStore.spec(for: peer))")
            }.disabled(store.busy || store.disabledReason != nil)
        }
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
        default: Palette.text2
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
        }.padding(Space.md).auroraPanel()
    }
}

private struct CrewRosterSheet: View {
    @Environment(AppModel.self) private var model
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
                    if let error = store.error { Text(error).font(.tCallout).foregroundStyle(Palette.down).padding(Space.md).auroraPanel() }
                    if store.roster.isEmpty {
                        StageEmpty("No roster available", systemImage: "person.3", message: "Open Trantor on your Mac to publish its available seats.").padding(Space.md).auroraPanel()
                    }
                    ForEach(store.roster) { seat in
                        Button { toggle(seat.launchSpec) } label: { rosterRow(seat) }
                            .buttonStyle(.plain).accessibilityIdentifier("crew.roster.\(seat.agent)")
                            .disabled(!seat.available || seat.agent == replacing || store.busy ||
                                      (replacing == nil && selected.count >= 6 && !selected.contains(seat.launchSpec)))
                            .accessibilityAddTraits(selected.contains(seat.launchSpec) ? .isSelected : [])
                    }
                }.padding(Space.lg)
            }
            .auroraScreen(model.standingState(for: store).wash)
            .navigationTitle(replacing == nil ? "Add seats" : "Swap seat")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar { ToolbarItem(placement: .cancellationAction) { Button("Cancel") { dismiss() } } }
            .safeAreaInset(edge: .bottom) {
                Button(replacing == nil ? "Add selected seats" : "Swap seat") {
                    if store.needsCostConfirmation(seats: Array(selected)) { confirmCost = true }
                    else { submit(costConfirmed: false) }
                }
                .buttonStyle(AuroraButtonStyle(.primary)).accessibilityIdentifier("crew.submit")
                .disabled(selected.isEmpty || store.busy || store.disabledReason != nil)
                .padding(Space.lg)
                .frame(maxWidth: .infinity)
                .background(AuroraSurface(shape: Rectangle()))
            }
            .task { await store.refresh() }
            .refreshable { await store.refresh() }
            .alert("This seat costs money per token", isPresented: $confirmCost) {
                Button("Confirm cost and continue") { submit(costConfirmed: true) }
                Button("Cancel", role: .cancel) {}
            } message: { Text("\(selectedLabels) includes a metered seat. Usage is billed to its API plan.") }
        }
        .presentationDetents([.large])
    }

    private func rosterRow(_ seat: RosterSeat) -> some View {
        HStack(spacing: Space.md) {
            Image(systemName: selected.contains(seat.launchSpec) ? "checkmark.circle.fill" : "circle").foregroundStyle(Palette.accent)
            SeatOrb(seat.agent, size: 28)
            VStack(alignment: .leading, spacing: Space.sm) {
                Text(seat.label.isEmpty ? seat.agent : seat.label).font(.tHeadline).foregroundStyle(Palette.text)
                if !seat.plan.isEmpty { Text(seat.plan).font(.tCallout).foregroundStyle(Palette.textDim) }
                if !seat.available {
                    Text(seat.reason.isEmpty ? "Unavailable on this Mac" : seat.reason).font(.tCaption).foregroundStyle(Palette.amber)
                }
            }
            Spacer()
            if seat.metered { Chip("$", color: Palette.text2).accessibilityLabel("Metered, costs money per token") }
        }.padding(Space.md).auroraPanel().opacity(seat.available ? 1 : 0.6)
    }

    private var selectedLabels: String {
        store.roster.filter { selected.contains($0.launchSpec) }
            .map { $0.label.isEmpty ? $0.agent : $0.label }.joined(separator: ", ")
    }

    private func toggle(_ spec: String) {
        if selected.contains(spec) { selected.remove(spec) }
        else if replacing != nil { selected = [spec] }
        else if selected.count < 6 { selected.insert(spec) }
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
