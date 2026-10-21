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
                DecisionsHeader(count: store.items.count, kinds: kindCounts(store.items))
                if store.freshness.isStale { FreshnessBanner(freshness: store.freshness) }
                if store.items.isEmpty && !store.isLoading {
                    EmptyState(title: "Nothing waiting", systemImage: "checkmark.seal",
                               message: "Holds, proposals, verify gates and questions from seats show up here.")
                        .card()
                }
                ForEach(store.items) { item in
                    DecisionCard(item: item, state: store.actions[item.id])
                        .transition(.asymmetric(insertion: .opacity.combined(with: .move(edge: .top)), removal: .opacity))
                }
            }
            .padding(.horizontal, Space.lg)
            .padding(.bottom, Space.xl)
            .animation(Motion.ease, value: store.items.map(\.id))
        }
        .navigationTitle("Decisions")
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

    private func kindCounts(_ items: [DecisionItem]) -> [(String, Int)] {
        var holds = 0, gates = 0, props = 0, asks = 0
        for i in items {
            switch i.kind { case .hold: holds += 1; case .gate: gates += 1; case .proposal: props += 1; case .ask: asks += 1 }
        }
        return [("Holds", holds), ("Gates", gates), ("Proposals", props), ("Questions", asks)]
    }
}

/// The hero: how many things wait on you, and the split by kind.
struct DecisionsHeader: View {
    let count: Int
    let kinds: [(String, Int)]

    var body: some View {
        VStack(alignment: .leading, spacing: Space.md) {
            HStack(alignment: .firstTextBaseline, spacing: Space.sm) {
                Text("\(count)")
                    .font(.tNumberHero).monospacedDigit()
                    .foregroundStyle(count > 0 ? Palette.accent : Palette.text)
                    .shadow(color: count > 0 ? Palette.accent.opacity(0.5) : .clear, radius: 14)
                    .contentTransition(.numericText())
                Text("waiting on you").font(.tCallout).foregroundStyle(Palette.text2)
                Spacer()
                ConnectionPill()
            }
            HStack(spacing: 0) {
                ForEach(Array(kinds.enumerated()), id: \.offset) { i, k in
                    VStack(alignment: .leading, spacing: 3) {
                        Eyebrow(k.0)
                        Text("\(k.1)").font(.mono(15, .medium)).monospacedDigit()
                            .foregroundStyle(k.1 > 0 ? Palette.text : Palette.textFaint)
                    }
                    .frame(maxWidth: .infinity, alignment: .leading)
                    if i < kinds.count - 1 { Rectangle().fill(Palette.hairline).frame(width: 1, height: 28).padding(.trailing, Space.md) }
                }
            }
        }
        .card(highlighted: count > 0)
        .padding(.top, Space.xs)
        .accessibilityElement(children: .combine)
    }
}

struct DecisionCard: View {
    @Environment(AppModel.self) private var model
    let item: DecisionItem
    let state: DecisionActionState?
    @State private var note = ""

    private var pending: Bool { state == .pending }

    var body: some View {
        VStack(alignment: .leading, spacing: Space.md) {
            header
            content
            if let state { stateLine(state) }
        }
        .card()
        .overlay(alignment: .leading) {
            RoundedRectangle(cornerRadius: 2).fill(kindColor).frame(width: 3).padding(.vertical, 14)
                .shadow(color: kindColor.opacity(0.6), radius: 6)
        }
        .accessibilityElement(children: .contain)
    }

    private var header: some View {
        HStack(spacing: Space.sm) {
            Image(systemName: kindIcon).font(.system(size: 12, weight: .semibold)).foregroundStyle(kindColor)
            Eyebrow(kindTitle, color: kindColor)
            Spacer()
            if !item.project.isEmpty { Chip(item.project, color: Palette.hue(for: item.project)) }
            TimeAgo(millis: item.ts)
        }
    }

    @ViewBuilder private var content: some View {
        let store = model.decisions
        switch item.kind {
        case .hold(let h):
            SeatLine(seat: h.session.isEmpty ? "A seat" : h.session, verb: "wants to edit")
            Text(h.file).font(.mono(14, .medium)).foregroundStyle(Palette.text)
                .frame(maxWidth: .infinity, alignment: .leading).well()
            if !h.other.isEmpty {
                HStack(spacing: 6) {
                    Image(systemName: "exclamationmark.triangle.fill").font(.system(size: 11)).foregroundStyle(Palette.amber)
                    Text("\(h.other) is also working on it").font(.tCallout).foregroundStyle(Palette.text2)
                }
            }
            HStack(spacing: Space.sm) {
                Button { Task { await store.decideHold(h, go: true) } } label: { Label("Go", systemImage: "checkmark") }
                    .buttonStyle(.primary)
                Button { Task { await store.decideHold(h, go: false) } } label: { Label("No-go", systemImage: "xmark") }
                    .buttonStyle(.ghost)
                Spacer()
            }.disabled(pending)

        case .gate(let g):
            Text(g.claim).font(.tHeadline).foregroundStyle(Palette.text)
            if !g.by.isEmpty { SeatLine(seat: g.by, verb: "claims it") }
            if !g.why.isEmpty { Detail(label: "Why", text: g.why) }
            if !g.howToVerify.isEmpty { Detail(label: "How", text: g.howToVerify, mono: true) }
            WellField("Note (optional)", text: $note, axis: .vertical)
            HStack(spacing: Space.sm) {
                Button("Verified") { Task { await store.resolveGate(g, as: .verified, note: note) } }.buttonStyle(.primary)
                Button("Failed") { Task { await store.resolveGate(g, as: .failed, note: note) } }.buttonStyle(.danger)
                Button("Waive") { Task { await store.resolveGate(g, as: .waived, note: note) } }.buttonStyle(.ghost)
                Spacer()
            }.disabled(pending)

        case .proposal(let p):
            SeatLine(seat: p.session, verb: "asks for")
            Text(p.scope).font(.tHeadline).foregroundStyle(Palette.text)
            if !p.condition.isEmpty { Detail(label: "When", text: p.condition) }
            if !p.exclusions.isEmpty { Detail(label: "Not covered", text: p.exclusions) }
            WellField("Note (optional)", text: $note, axis: .vertical)
            HStack(spacing: Space.sm) {
                Button("Approve") { Task { await store.decideProposal(p, approve: true, note: note) } }.buttonStyle(.primary)
                Button("Deny") { Task { await store.decideProposal(p, approve: false, note: note) } }.buttonStyle(.ghost)
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
                .buttonStyle(.primary)
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
    private var kindColor: Color {
        switch item.kind {
        case .hold: return Palette.amber; case .gate: return Palette.accent
        case .proposal: return Palette.purple; case .ask: return Palette.blue
        }
    }
}

/// "kimi-8 · wants to edit": the seat's mark, name and what it wants.
struct SeatLine: View {
    let seat: String
    let verb: String
    var body: some View {
        HStack(spacing: Space.sm) {
            NameMark(seat, size: 22)
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
