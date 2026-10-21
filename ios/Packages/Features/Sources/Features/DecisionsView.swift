import HubClient
import SwiftUI
import TrantorCore
import TrantorStore

public struct DecisionsView: View {
    @Environment(AppModel.self) private var model

    public init() {}

    public var body: some View {
        let store = model.decisions
        List {
            if store.freshness.isStale { FreshnessBanner(freshness: store.freshness).listRowSeparator(.hidden) }
            if store.items.isEmpty {
                EmptyState(title: "Nothing waiting", systemImage: "checkmark.seal",
                           message: "Holds, proposals, verify gates and questions from seats show up here.")
                    .listRowSeparator(.hidden)
            }
            ForEach(store.items) { item in
                DecisionRow(item: item, state: store.actions[item.id])
            }
        }
        .listStyle(.insetGrouped)
        .navigationTitle("Decisions")
        .refreshable { await store.refresh() }
        .overlay { if store.isLoading && store.items.isEmpty { ProgressView() } }
    }
}

struct DecisionRow: View {
    @Environment(AppModel.self) private var model
    let item: DecisionItem
    let state: DecisionActionState?
    @State private var note = ""

    private var pending: Bool { state == .pending }

    var body: some View {
        VStack(alignment: .leading, spacing: 10) {
            header
            content
            if let state { stateLine(state) }
        }
        .padding(.vertical, 4)
        .accessibilityElement(children: .contain)
    }

    private var header: some View {
        HStack {
            Label(kindTitle, systemImage: kindIcon).font(.subheadline.weight(.semibold))
            Spacer()
            if !item.project.isEmpty { Text(item.project).font(.caption).foregroundStyle(.secondary) }
            TimeAgo(millis: item.ts).font(.caption).foregroundStyle(.secondary)
        }
    }

    @ViewBuilder private var content: some View {
        let store = model.decisions
        switch item.kind {
        case .hold(let h):
            Text("\(h.session.isEmpty ? "A seat" : h.session) wants to edit \(h.file)").font(.body)
            if !h.other.isEmpty { Text("\(h.other) is also working on it.").font(.callout).foregroundStyle(.secondary) }
            HStack {
                Button("Go") { Task { await store.decideHold(h, go: true) } }.buttonStyle(.borderedProminent)
                Button("No-go", role: .destructive) { Task { await store.decideHold(h, go: false) } }.buttonStyle(.bordered)
            }.disabled(pending)

        case .gate(let g):
            Text(g.claim).font(.body)
            if !g.why.isEmpty { Text(g.why).font(.callout).foregroundStyle(.secondary) }
            if !g.howToVerify.isEmpty { Text("How: \(g.howToVerify)").font(.callout).foregroundStyle(.secondary) }
            TextField("Note (optional)", text: $note, axis: .vertical).textFieldStyle(.roundedBorder)
            HStack {
                Button("Verified") { Task { await store.resolveGate(g, as: .verified, note: note) } }.buttonStyle(.borderedProminent)
                Button("Failed", role: .destructive) { Task { await store.resolveGate(g, as: .failed, note: note) } }.buttonStyle(.bordered)
                Button("Waived") { Task { await store.resolveGate(g, as: .waived, note: note) } }.buttonStyle(.bordered)
            }.disabled(pending)

        case .proposal(let p):
            Text("\(p.session) asks for: \(p.scope)").font(.body)
            if !p.condition.isEmpty { Text("When: \(p.condition)").font(.callout).foregroundStyle(.secondary) }
            if !p.exclusions.isEmpty { Text("Not covered: \(p.exclusions)").font(.callout).foregroundStyle(.secondary) }
            TextField("Note (optional)", text: $note, axis: .vertical).textFieldStyle(.roundedBorder)
            HStack {
                Button("Approve") { Task { await store.decideProposal(p, approve: true, note: note) } }.buttonStyle(.borderedProminent)
                Button("Deny", role: .destructive) { Task { await store.decideProposal(p, approve: false, note: note) } }.buttonStyle(.bordered)
            }.disabled(pending)

        case .ask(let m):
            Text("\(m.from) asks").font(.callout).foregroundStyle(.secondary)
            Text(m.text).font(.body)
            TextField("Reply", text: $note, axis: .vertical).textFieldStyle(.roundedBorder)
            Button("Send reply") { Task { await store.reply(to: m, text: note) } }
                .buttonStyle(.borderedProminent)
                .disabled(pending || note.trimmingCharacters(in: .whitespaces).isEmpty)
        }
    }

    @ViewBuilder private func stateLine(_ state: DecisionActionState) -> some View {
        switch state {
        case .pending: HStack { ProgressView(); Text("Waiting for the hub").font(.footnote).foregroundStyle(.secondary) }
        case .failed(let m): Label(m, systemImage: "exclamationmark.triangle").font(.footnote).foregroundStyle(.red)
        case .alreadyDecided(let m): Label(m, systemImage: "person.2").font(.footnote).foregroundStyle(.orange)
        }
    }

    private var kindTitle: String {
        switch item.kind { case .hold: return "File hold"; case .gate: return "Verify gate"; case .proposal: return "Proposal"; case .ask: return "Question" }
    }
    private var kindIcon: String {
        switch item.kind {
        case .hold: return "hand.raised"; case .gate: return "checkmark.shield"
        case .proposal: return "doc.badge.plus"; case .ask: return "questionmark.bubble"
        }
    }
}

#Preview("Decisions") {
    NavigationStack { DecisionsView() }.environment(PreviewData.model())
}
