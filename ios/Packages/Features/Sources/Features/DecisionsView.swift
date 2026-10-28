import HubClient
import SwiftUI
import TrantorCore
import TrantorDesign
import TrantorStore

/// Home: everything the fleet is blocked on, newest first. Holds, verify gates, proposals and
/// questions, each with its decision buttons.
public struct DecisionsView: View {
    @Environment(AppModel.self) private var model
    @State private var showSettings = false

    public init() {}

    public var body: some View {
        let store = model.decisions
        ScrollView {
            LazyVStack(alignment: .leading, spacing: Space.md) {
                StatusHeadline(model.standingState().headline, eyebrow: "Decisions")
                    .padding(.top, Space.md)
                ConnectionPill()
                if store.freshness.isStale { FreshnessBanner(freshness: store.freshness) }
                if store.items.isEmpty && !store.isLoading {
                    EmptyState(title: "Nothing waiting", systemImage: "checkmark.seal",
                               message: "Holds, proposals, verify gates and questions from seats show up here.")
                        .padding(Space.md).auroraPanel()
                }
                ForEach(store.items) { item in
                    DecisionItemCard(item: item, state: store.actions[item.id])
                        .transition(.asymmetric(insertion: .opacity.combined(with: .move(edge: .top)), removal: .opacity))
                }
            }
            .padding(.horizontal, Space.lg)
            .padding(.bottom, Space.xl)
            .animation(Motion.ease, value: store.items.map(\.id))
        }
        .auroraScreen(model.standingState().wash)
        .navigationTitle("Decisions")
        .navigationBarTitleDisplayMode(.inline)
        .toolbar {
            ToolbarItem(placement: .topBarTrailing) {
                Button { showSettings = true } label: { Image(systemName: "gearshape") }
                    .accessibilityLabel("Settings")
            }
        }
        .sheet(isPresented: $showSettings) {
            NavigationStack { SettingsView().stage() }.trantorTheme()
        }
        .refreshable { await store.refresh() }
        .overlay { if store.isLoading && store.items.isEmpty { ProgressView().tint(Palette.accent) } }
    }

}

struct DecisionItemCard: View {
    @Environment(AppModel.self) private var model
    let item: DecisionItem
    let state: DecisionActionState?
    @State private var note = ""

    private var pending: Bool { state == .pending }

    var body: some View {
        VStack(alignment: .leading, spacing: Space.md) {
            if case .hold(let hold) = item.kind {
                TimelineView(.periodic(from: .now, by: 30)) { context in
                    TrantorDesign.DecisionCard(
                        "\(hold.session.isEmpty ? "A seat" : hold.session) wants to edit \(hold.file)" +
                        (hold.other.isEmpty ? "" : ". \(hold.other) is also working on it."),
                        age: compactAge(item.ts, now: context.date),
                        go: { Task { await model.decisions.decideHold(hold, go: true) } },
                        noGo: { Task { await model.decisions.decideHold(hold, go: false) } })
                        .disabled(pending)
                }
            } else {
                VStack(alignment: .leading, spacing: Space.md) {
                    Text("Waiting for you").font(.ui(13, relativeTo: .caption))
                    header
                    content
                }
                .padding(Space.md)
                .auroraPanel(stroke: Glass.waitingStroke, shadow: Glass.waitingShadow)
            }
            if let state { stateLine(state) }
        }
        .accessibilityElement(children: .contain)
    }

    private var header: some View {
        HStack(spacing: Space.sm) {
            Image(systemName: kindIcon).font(.system(size: 12, weight: .semibold)).foregroundStyle(kindColor)
            Eyebrow(kindTitle, color: kindColor)
            Spacer()
            if !item.project.isEmpty { Chip(item.project) }
            TimeAgo(millis: item.ts)
        }
    }

    @ViewBuilder private var content: some View {
        let store = model.decisions
        switch item.kind {
        case .hold:
            EmptyView()

        case .gate(let g):
            Text(g.claim).font(.tHeadline).foregroundStyle(Palette.text)
            if !g.by.isEmpty { SeatLine(seat: g.by, verb: "claims it") }
            if !g.why.isEmpty { Detail(label: "Why", text: g.why) }
            if !g.howToVerify.isEmpty { Detail(label: "How", text: g.howToVerify, mono: true) }
            WellField("Note (optional)", text: $note, axis: .vertical)
            HStack(spacing: Space.sm) {
                Button("Verified") { Task { await store.resolveGate(g, as: .verified, note: note) } }.buttonStyle(AuroraButtonStyle(.primary))
                Button("Failed") { Task { await store.resolveGate(g, as: .failed, note: note) } }.buttonStyle(AuroraButtonStyle(.destructive))
                Button("Waive") { Task { await store.resolveGate(g, as: .waived, note: note) } }.buttonStyle(AuroraButtonStyle())
                Spacer()
            }.disabled(pending)

        case .proposal(let p):
            SeatLine(seat: p.session, verb: "asks for")
            Text(p.scope).font(.tHeadline).foregroundStyle(Palette.text)
            if !p.condition.isEmpty { Detail(label: "When", text: p.condition) }
            if !p.exclusions.isEmpty { Detail(label: "Not covered", text: p.exclusions) }
            WellField("Note (optional)", text: $note, axis: .vertical)
            HStack(spacing: Space.sm) {
                Button("Approve") { Task { await store.decideProposal(p, approve: true, note: note) } }.buttonStyle(AuroraButtonStyle(.primary))
                Button("Deny") { Task { await store.decideProposal(p, approve: false, note: note) } }.buttonStyle(AuroraButtonStyle())
                Spacer()
            }.disabled(pending)

        case .ask(let m):
            SeatLine(seat: m.from, verb: "asks")
            Text(m.text).font(.tBody).foregroundStyle(Palette.text).fixedSize(horizontal: false, vertical: true)
            WellField("Reply", text: $note, axis: .vertical)
            HStack {
                Button { Task { await store.reply(to: m, text: note); note = "" } } label: {
                    Label("Send reply", systemImage: "arrow.up")
                }
                .buttonStyle(AuroraButtonStyle(.primary))
                .disabled(pending || note.trimmingCharacters(in: .whitespaces).isEmpty)
                Spacer()
            }
        }
    }

    @ViewBuilder private func stateLine(_ state: DecisionActionState) -> some View {
        HStack(spacing: Space.sm) {
            switch state {
            case .pending:
                ProgressView().controlSize(.small).tint(Palette.accent)
                Text("Waiting for the hub").font(.tCaption).foregroundStyle(Palette.text2)
            case .failed(let m):
                Image(systemName: "exclamationmark.triangle.fill").foregroundStyle(Palette.down)
                Text(m).font(.tCaption).foregroundStyle(Palette.down)
            case .alreadyDecided(let m):
                Image(systemName: "person.2.fill").foregroundStyle(Palette.amber)
                Text(m).font(.tCaption).foregroundStyle(Palette.amber)
            }
        }
        .font(.system(size: 11))
    }

    private var kindTitle: String {
        switch item.kind { case .hold: return "File hold"; case .gate: return "Verify gate"; case .proposal: return "Proposal"; case .ask: return "Question" }
    }
    private var kindIcon: String {
        switch item.kind {
        case .hold: return "hand.raised.fill"; case .gate: return "checkmark.shield.fill"
        case .proposal: return "doc.badge.plus"; case .ask: return "questionmark.bubble.fill"
        }
    }
    private var kindColor: Color { Palette.text2 }
}

/// "kimi-8 · wants to edit": the seat's mark, name and what it wants.
struct SeatLine: View {
    let seat: String
    let verb: String
    var body: some View {
        HStack(spacing: Space.sm) {
            SeatOrb(seat, size: 28)
            Text(seat).font(.mono(13, .medium)).foregroundStyle(Palette.text).lineLimit(1)
            Text(verb).font(.tCallout).foregroundStyle(Palette.textDim)
        }
        .accessibilityElement(children: .combine)
    }
}

/// A labelled detail line: dim mono label, text beside it.
struct Detail: View {
    let label: String
    let text: String
    var mono = false
    var body: some View {
        HStack(alignment: .firstTextBaseline, spacing: Space.sm) {
            Text(label.uppercased()).font(.tEyebrow).tracking(1.4).foregroundStyle(Palette.textDim)
                .frame(width: 58, alignment: .leading)
            Text(text).font(mono ? .tData : .tCallout).foregroundStyle(Palette.text2)
                .fixedSize(horizontal: false, vertical: true)
        }
        .accessibilityElement(children: .combine)
    }
}

#Preview("Decisions") {
    NavigationStack { DecisionsView().stage() }.environment(DemoData.model()).trantorTheme()
}
