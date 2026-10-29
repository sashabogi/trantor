import SwiftUI
import TrantorCore
import TrantorDesign
import TrantorStore

struct ChatQuestionCard: View {
    @Environment(\.duoComposing) private var duoComposing
    let block: ChatBlock
    let store: ChatStore
    @State private var picks: Set<Int> = []
    @State private var writingOther = false
    @State private var other = ""
    @FocusState private var composing: Bool

    private var delivery: AnswerDelivery? {
        if let answer = block.answer { return .answered(answer) }
        return store.answers[block.toolID]
    }
    private var disabled: Bool { store.disabledReason != nil || delivery?.preventsSending == true }
    private var answered: Bool { if case .answered = delivery { return true }; return false }

    var body: some View {
        VStack(alignment: .leading, spacing: Space.md) {
            if block.ask.isEmpty { Text(block.text).font(.tCallout) }
            ForEach(Array(block.ask.enumerated()), id: \.offset) { _, question in
                if !question.header.isEmpty { Eyebrow(question.header) }
                Text(question.question).font(.tCallout)
                if block.ask.count == 1 && !block.toolID.isEmpty {
                    choices(question)
                } else {
                    ForEach(Array(question.options.enumerated()), id: \.offset) { _, option in
                        Text(option.label).font(.tCaption).foregroundStyle(Palette.text2)
                    }
                }
            }
            if block.ask.count != 1 || block.toolID.isEmpty {
                Label("Answer it on the Mac", systemImage: "desktopcomputer").font(.tCaption).foregroundStyle(Palette.amber)
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
        .onChange(of: composing) { _, focused in duoComposing?.wrappedValue = focused }
        .onDisappear { if composing { duoComposing?.wrappedValue = false } }
    }

    private func choices(_ question: ChatQuestion) -> some View {
        VStack(alignment: .leading, spacing: Space.sm) {
            ForEach(Array(question.options.enumerated()), id: \.offset) { index, option in
                Button {
                    if question.multiSelect {
                        if picks.contains(index) { picks.remove(index) } else { picks.insert(index) }
                    } else { submit([index]) }
                } label: {
                    HStack(alignment: .top, spacing: Space.sm) {
                        Image(systemName: question.multiSelect ? (picks.contains(index) ? "checkmark.square.fill" : "square") : "circle")
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
                .accessibilityIdentifier("chat.ask.option.\(block.toolID).\(index)")
                .accessibilityValue(question.multiSelect ? (picks.contains(index) ? "Selected" : "Not selected") : "")
                .disabled(disabled)
            }
            if !answered {
                Button("Something else…") { writingOther.toggle() }
                    .buttonStyle(AuroraButtonStyle())
                    .disabled(disabled)
                    .accessibilityIdentifier("chat.ask.other.\(block.toolID)")
                if writingOther {
                    WellField("Your answer", text: $other, axis: .vertical).lineLimit(2...5)
                        .focused($composing)
                        .disabled(disabled)
                        .accessibilityIdentifier("chat.ask.field.\(block.toolID)")
                    if other.utf16.count > 2000 {
                        Text("Keep your answer under 2,000 characters.").font(.tCaption).foregroundStyle(Palette.amber)
                    }
                }
                if question.multiSelect || writingOther {
                    Button(writingOther ? "Send" : "Submit") {
                        submit(question.multiSelect ? picks.sorted() : [], other: writingOther ? other : nil)
                    }
                    .buttonStyle(AuroraButtonStyle(.primary))
                    .disabled(disabled || (writingOther && (other.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty || other.utf16.count > 2000)) || (!writingOther && picks.isEmpty))
                    .accessibilityIdentifier("chat.ask.submit.\(block.toolID)")
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

    private func submit(_ picks: [Int], other: String? = nil) {
        Task { await store.answer(toolId: block.toolID, picks: picks, other: other) }
    }
}
