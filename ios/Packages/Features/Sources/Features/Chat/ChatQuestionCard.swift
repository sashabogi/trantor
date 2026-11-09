import SwiftUI
import HubClient
import TrantorCore
import TrantorDesign
import TrantorStore

/// One ask, any number of questions (CONTRACT-ask.md #12912): every question gets its own
/// picks/Other state; one Submit sends an `answers` entry per question once all are answered.
struct ChatQuestionCard: View {
    @Environment(\.duoComposing) private var duoComposing
    let block: ChatBlock
    let store: ChatStore
    @State private var picks: [Set<Int>]
    @State private var writingOther: [Bool]
    @State private var other: [String]
    @FocusState private var composing: Bool

    init(block: ChatBlock, store: ChatStore) {
        self.block = block
        self.store = store
        let count = max(block.ask.count, 1)
        _picks = State(initialValue: Array(repeating: [], count: count))
        _writingOther = State(initialValue: Array(repeating: false, count: count))
        _other = State(initialValue: Array(repeating: "", count: count))
    }

    private var delivery: AnswerDelivery? {
        if let answer = block.answer { return .answered(answer) }
        return store.answers[block.toolID]
    }
    private var disabled: Bool { store.disabledReason != nil || delivery?.preventsSending == true }
    private var answered: Bool { if case .answered = delivery { return true }; return false }
    /// Question-scoped identifiers only when the ask has several questions; a lone question
    /// keeps the long-standing single-question ids.
    private var perQuestion: Bool { block.ask.count > 1 }

    var body: some View {
        VStack(alignment: .leading, spacing: Space.md) {
            if block.ask.isEmpty { Text(block.text).font(.tCallout) }
            ForEach(block.ask.indices, id: \.self) { index in
                choices(block.ask[index], index)
            }
            if block.toolID.isEmpty {
                Label("Answer it on the Mac", systemImage: "desktopcomputer").font(.tCaption).foregroundStyle(Palette.amber)
            } else if !answered {
                Button("Submit") { submit() }
                    .buttonStyle(AuroraButtonStyle(.primary))
                    .disabled(disabled || !allAnswered || block.ask.indices.contains { overlong($0) })
                    .accessibilityIdentifier("chat.ask.submit.\(block.toolID)")
            }
            if let delivery {
                Text(delivery.label).font(.tCaption).foregroundStyle(statusColor)
                    .accessibilityIdentifier("chat.ask.status.\(block.toolID)")
            } else if let reason = store.disabledReason {
                Text(reason).font(.tCaption).foregroundStyle(Palette.textDim)
            }
        }
        .padding(Space.md)
        .auroraPanel(stroke: answered ? nil : Glass.waitingStroke, shadow: answered ? nil : Glass.waitingShadow)
        .opacity(answered ? 0.6 : 1)
        .onChange(of: block.ask) { _, ask in reseed(ask.count) }
        .onChange(of: composing) { _, focused in duoComposing?.wrappedValue = focused }
        .onDisappear { if composing { duoComposing?.wrappedValue = false } }
    }

    private func choices(_ question: ChatQuestion, _ qi: Int) -> some View {
        VStack(alignment: .leading, spacing: Space.sm) {
            if !question.header.isEmpty { Eyebrow(question.header) }
            Text(question.question).font(.tCallout)
            if block.toolID.isEmpty {
                ForEach(Array(question.options.enumerated()), id: \.offset) { _, option in
                    Text(option.label).font(.tCaption).foregroundStyle(Palette.text2)
                }
            } else {
                ForEach(Array(question.options.enumerated()), id: \.offset) { index, option in
                    Button {
                        if question.multiSelect {
                            if picks[qi].contains(index) { picks[qi].remove(index) } else { picks[qi].insert(index) }
                        } else {
                            picks[qi] = [index]
                        }
                    } label: {
                        HStack(alignment: .top, spacing: Space.sm) {
                            Image(systemName: question.multiSelect
                                  ? (picks[qi].contains(index) ? "checkmark.square.fill" : "square")
                                  : (picks[qi].contains(index) ? "circle.inset.filled" : "circle"))
                                .foregroundStyle(Palette.accent)
                            VStack(alignment: .leading, spacing: Space.xs) {
                                Text(option.label).font(.tCallout)
                                if !option.description.isEmpty { Text(option.description).font(.tCaption).foregroundStyle(Palette.text2) }
                            }
                            Spacer(minLength: 0)
                        }
                        .padding(Space.sm).frame(maxWidth: .infinity, alignment: .leading)

                        .contentShape(Rectangle())
                    }
                    .buttonStyle(AuroraButtonStyle())
                    .accessibilityIdentifier(perQuestion ? "chat.ask.option.\(block.toolID).\(qi).\(index)" : "chat.ask.option.\(block.toolID).\(index)")
                    .accessibilityValue(picks[qi].contains(index) ? "Selected" : "Not selected")
                    .disabled(disabled)
                }
                if !answered {
                    Button("Something else…") { writingOther[qi].toggle() }
                        .buttonStyle(AuroraButtonStyle())
                        .disabled(disabled)
                        .accessibilityIdentifier(perQuestion ? "chat.ask.other.\(block.toolID).\(qi)" : "chat.ask.other.\(block.toolID)")
                    if writingOther[qi] {
                        WellField("Your answer", text: $other[qi], axis: .vertical).lineLimit(2...5)
                            .focused($composing)
                            .disabled(disabled)
                            .accessibilityIdentifier(perQuestion ? "chat.ask.field.\(block.toolID).\(qi)" : "chat.ask.field.\(block.toolID)")
                        if overlong(qi) {
                            Text("Keep your answer under 2,000 characters.").font(.tCaption).foregroundStyle(Palette.amber)
                        }
                    }
                }
            }
        }
    }

    private var statusColor: Color {
        switch delivery {
        case .failed, .stale: Palette.amber
        default: Palette.textDim
        }
    }

    private func trimmed(_ qi: Int) -> String { other[qi].trimmingCharacters(in: .whitespacesAndNewlines) }
    private func hasOther(_ qi: Int) -> Bool { !trimmed(qi).isEmpty }
    private func overlong(_ qi: Int) -> Bool { other[qi].utf16.count > 2000 }

    /// Mirrors ChatStore's validation: a multi-select question needs a pick or Other text; a
    /// single-select question exactly one of the two.
    private func questionAnswered(_ qi: Int) -> Bool {
        guard block.ask.indices.contains(qi) else { return false }
        let count = picks[qi].count
        return block.ask[qi].multiSelect ? (count > 0 || hasOther(qi)) : (count + (hasOther(qi) ? 1 : 0) == 1)
    }
    private var allAnswered: Bool { !block.ask.isEmpty && block.ask.indices.allSatisfy { questionAnswered($0) } }

    private func submit() {
        let entries = block.ask.indices.map { qi in
            QuestionAnswer(picks: picks[qi].sorted(), other: hasOther(qi) ? trimmed(qi) : nil)
        }
        Task { await store.answer(toolId: block.toolID, answers: entries) }
    }

    /// A replaced ask under the same tool id must not leave stale per-question state behind.
    private func reseed(_ count: Int) {
        let sized = max(count, 1)
        if picks.count != sized { picks = Array(repeating: [], count: sized) }
        if writingOther.count != sized { writingOther = Array(repeating: false, count: sized) }
        if other.count != sized { other = Array(repeating: "", count: sized) }
    }
}
