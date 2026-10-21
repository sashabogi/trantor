import SwiftUI
import TrantorCore
import TrantorDesign
import TrantorStore

struct ProjectView: View {
    @Environment(AppModel.self) private var model
    let project: String
    @State private var section = "chat"

    var body: some View {
        VStack(spacing: 0) {
            PillPicker([("chat", "Chat"), ("board", "Board")], selection: $section)
                .padding(.horizontal, Space.lg).padding(.vertical, Space.sm)
            if section == "chat" { ProjectChatView(store: model.chat(project: project)) }
            else { BoardView(project: project) }
        }
        .stage()
        .navigationTitle(project)
        .navigationBarTitleDisplayMode(.inline)
    }
}

struct ProjectChatView: View {
    let store: ChatStore
    @Environment(\.scenePhase) private var scenePhase
    @State private var draft = ""
    @State private var followingBottom = true
    @FocusState private var composing: Bool

    var body: some View {
        VStack(spacing: 0) {
            header
            if store.freshness.isStale { FreshnessBanner(freshness: store.freshness).padding(.horizontal, Space.lg) }
            ScrollViewReader { proxy in
                ScrollView {
                    LazyVStack(alignment: .leading, spacing: Space.md) {
                        if store.turns.isEmpty && store.outgoing.isEmpty {
                            StageEmpty("Your project conversation", systemImage: "bubble.left.and.bubble.right",
                                       message: store.snapshot.host.isEmpty ? "Open this project in Trantor on your Mac to see the session here." : "Send a message to your orchestrator.")
                        }
                        ForEach(store.turns) { turn in
                            ChatTurnRow(turn: turn, delivery: store.delivery(for: turn))
                        }
                        ForEach(store.unmirroredOutgoing) { prompt in
                            HStack {
                                Spacer(minLength: 44)
                                VStack(alignment: .trailing, spacing: Space.sm) {
                                    Text(prompt.text).font(.tBody).textSelection(.enabled)
                                    Text(prompt.delivery.label).font(.tCaption).foregroundStyle(deliveryColor(prompt.delivery))
                                }
                                .padding(Space.md)
                                .background(Palette.accentSoft, in: RoundedRectangle(cornerRadius: Radius.md))
                            }
                        }
                        if store.snapshot.meta.working {
                            HStack(spacing: Space.sm) { StatusDot(); Text("Working…").font(.tCallout).foregroundStyle(Palette.text2) }
                                .accessibilityElement(children: .combine)
                        }
                        Color.clear.frame(height: 1).id("chat-bottom")
                            .onAppear { followingBottom = true }
                            .onDisappear { followingBottom = false }
                    }
                    .padding(Space.lg)
                }
                .defaultScrollAnchor(.bottom)
                .scrollDismissesKeyboard(.interactively)
                .onChange(of: store.turns) { _, _ in
                    if followingBottom { proxy.scrollTo("chat-bottom", anchor: .bottom) }
                }
                .onChange(of: store.outgoing) { _, _ in
                    if followingBottom || store.sending { proxy.scrollTo("chat-bottom", anchor: .bottom) }
                }
                .refreshable { await store.refresh() }
            }
        }
        .safeAreaInset(edge: .bottom, spacing: 0) { composer }
        // A destination can appear before the scene becomes active; load its first snapshot on appearance.
        .task { await store.refresh() }
        .task(id: scenePhase) {
            guard scenePhase == .active else { return }
            await store.follow()
        }
        .toolbar {
            ToolbarItemGroup(placement: .keyboard) {
                Spacer()
                Button("Hide keyboard") { composing = false }.accessibilityIdentifier("chat.hide-keyboard")
            }
        }
    }

    private var header: some View {
        HStack(spacing: Space.md) {
            VStack(alignment: .leading, spacing: Space.xs) {
                Eyebrow("Session")
                Text(store.snapshot.meta.model.isEmpty ? "Orchestrator" : store.snapshot.meta.model)
                    .font(.tDataSmall).foregroundStyle(Palette.text2).lineLimit(1)
            }
            Spacer()
            VStack(alignment: .trailing, spacing: Space.xs) {
                if let fraction = store.snapshot.meta.context.fraction {
                    Text("Context \(Int(min(fraction, 1) * 100))%")
                        .font(.tDataSmall).foregroundStyle(Palette.text2)
                    ProgressView(value: min(1, fraction)).tint(fraction >= 0.8 ? Palette.amber : Palette.accent).frame(width: 112)
                        .accessibilityLabel("Context use").accessibilityValue("\(Int(min(fraction, 1) * 100)) percent")
                } else {
                    Text("Context —").font(.tDataSmall).foregroundStyle(Palette.textDim)
                }
            }
        }.padding(.horizontal, Space.lg).padding(.vertical, Space.sm)
    }

    private var composer: some View {
        VStack(alignment: .leading, spacing: Space.sm) {
            if let reason = store.disabledReason {
                Text(reason).font(.tCaption).foregroundStyle(Palette.textDim)
            } else if let error = store.sendError {
                Text(error).font(.tCaption).foregroundStyle(Palette.down)
            }
            if draft.utf16.count > 8000 {
                Text("Keep your message under 8,000 characters.").font(.tCaption).foregroundStyle(Palette.amber)
            }
            HStack(alignment: .bottom, spacing: Space.sm) {
                WellField("Message your orchestrator", text: $draft, axis: .vertical)
                    .lineLimit(1...5).focused($composing)
                    .accessibilityIdentifier("chat.composer")
                Button {
                    let text = draft
                    Task { if await store.send(text), draft == text { draft = "" } }
                } label: {
                    if store.sending { ProgressView().tint(Palette.onAccent) }
                    else { Image(systemName: "arrow.up") }
                }
                .buttonStyle(.primary)
                .accessibilityLabel("Send message")
                .accessibilityIdentifier("chat.send")
                .disabled(store.disabledReason != nil || store.sending || draft.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty || draft.utf16.count > 8000)
            }
        }
        .padding(Space.lg)
        .background(Palette.ground)
        .overlay(alignment: .top) { Hairline() }
    }

    private func deliveryColor(_ delivery: PromptDelivery) -> Color {
        if case .failed = delivery { return Palette.down }
        return Palette.textDim
    }
}

private struct ChatTurnRow: View {
    let turn: ChatTurn
    let delivery: PromptDelivery?
    private var mine: Bool { turn.role == "user" }

    var body: some View {
        HStack(alignment: .top) {
            if mine { Spacer(minLength: 44) }
            VStack(alignment: .leading, spacing: Space.sm) {
                ForEach(Array(turn.blocks.enumerated()), id: \.offset) { _, block in
                    if block.isQuestion {
                        VStack(alignment: .leading, spacing: Space.sm) {
                            if block.ask.isEmpty { Text(block.text).font(.tCallout) }
                            ForEach(Array(block.ask.enumerated()), id: \.offset) { _, question in
                                Text(question.question).font(.tCallout)
                                ForEach(Array(question.options.enumerated()), id: \.offset) { _, option in
                                    Text("• \(option.label)\(option.description.isEmpty ? "" : ": \(option.description)")")
                                        .font(.tCaption).foregroundStyle(Palette.text2)
                                }
                            }
                            Label("Answer it on the Mac", systemImage: "desktopcomputer").font(.tCaption).foregroundStyle(Palette.amber)
                        }.card()
                    } else if block.kind == "tool" {
                        Text([block.tool, block.text].filter { !$0.isEmpty }.joined(separator: " "))
                            .font(.tDataSmall).lineLimit(1).truncationMode(.middle)
                            .padding(.horizontal, Space.sm).padding(.vertical, Space.xs)
                            .background(Palette.raise, in: RoundedRectangle(cornerRadius: Radius.xs))
                            .accessibilityLabel([block.tool, block.text].joined(separator: " "))
                    } else if block.kind == "text" || block.kind == "thinking" {
                        Text(mine ? AttributedString(block.text) : (try? AttributedString(markdown: block.text, options: .init(interpretedSyntax: .inlineOnlyPreservingWhitespace))) ?? AttributedString(block.text))
                            .font(.tBody).foregroundStyle(block.kind == "thinking" ? Palette.textDim : Palette.text)
                            .textSelection(.enabled)
                    } else if !block.text.isEmpty {
                        Text(block.text).font(.tCallout).foregroundStyle(Palette.textDim)
                    }
                }
                if mine && (delivery != nil || turn.queued) {
                    Text(delivery?.label ?? "Queued").font(.tCaption).foregroundStyle(Palette.textDim)
                }
            }
            .padding(mine ? Space.md : 0)
            .background(mine ? Palette.accentSoft : .clear, in: RoundedRectangle(cornerRadius: Radius.md))
            if !mine { Spacer(minLength: 24) }
        }
    }
}
