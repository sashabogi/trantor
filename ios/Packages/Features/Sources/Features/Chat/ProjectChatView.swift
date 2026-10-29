import PhotosUI
import SwiftUI
import TrantorCore
import TrantorDesign
import TrantorStore

struct ProjectView: View {
    @Environment(AppModel.self) private var model
    @Environment(\.horizontalSizeClass) private var sizeClass
    let project: String
    @State private var section = "chat"

    var body: some View {
        Group {
            if sizeClass == .regular {
                DuoSplitView {
                    if section == "board" { BoardView(project: project) }
                    else { CrewView(store: model.crew(project: project)) }
                } detail: {
                    ProjectChatView(store: model.chat(project: project))
                }
            } else {
                VStack(spacing: 0) {
                    if section == "chat" { ProjectChatView(store: model.chat(project: project)) }
                    else if section == "board" { BoardView(project: project) }
                    else { CrewView(store: model.crew(project: project)) }
                }
                .modifier(DuoContentBounds())
            }
        }
        .onAppear {
            if let wanted = model.openProjectSection { section = wanted; model.openProjectSection = nil }
        }
        .onChange(of: model.chat(project: project).focusedToolID, initial: true) { _, target in
            if target != nil { section = "chat" }
        }
        .navigationTitle(project)
        .navigationBarTitleDisplayMode(.inline)
        // The Chat/Board/Crew picker lives in the nav bar so the transcript starts high on screen.
        .toolbar {
            ToolbarItem(placement: .principal) {
                HStack(spacing: Space.md) {
                    Text(project)
                        .font(.ui(14, .semibold, relativeTo: .callout))
                        .foregroundStyle(Palette.text).lineLimit(1)
                    AuroraPicker([("chat", "Chat"), ("board", "Board"), ("crew", "Crew")], selection: $section)
                }
            }
        }
    }
}

struct ProjectChatView: View {
    // Bindable so the composer can hold `$store.draft`: the draft lives on the per-project
    // ChatStore, so it survives switching Chat/Board/Crew and leaving the project.
    @Environment(AppModel.self) private var model
    @Bindable var store: ChatStore
    @Environment(\.scenePhase) private var scenePhase
    @State private var followingBottom = true
    @State private var pickedPhotos: [PhotosPickerItem] = []
    @State private var photos = ChatAttachmentQueue()
    // The keyboard belongs to a deliberate tap on the composer: nothing here ever sets `composing`
    // programmatically (no autofocus on appear); a transcript tap or drag ends it.
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
                            ChatTurnRow(turn: turn, delivery: store.delivery(for: turn), store: store)
                                .id(turn.idx)
                        }
                        ForEach(store.unmirroredOutgoing) { prompt in
                            HStack {
                                Spacer(minLength: 44)
                                VStack(alignment: .trailing, spacing: Space.sm) {
                                    ChatBubble(prompt.text, speaker: .operator).textSelection(.enabled)
                                    Text(prompt.delivery.label).font(.tCaption).foregroundStyle(deliveryColor(prompt.delivery))
                                }

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
                .onTapGesture { composing = false }
                .onChange(of: store.focusedToolID, initial: true) { _, _ in scrollToQuestion(proxy) }
                .onChange(of: store.turns) { _, _ in
                    if store.focusedToolID != nil { scrollToQuestion(proxy) }
                    else if followingBottom { proxy.scrollTo("chat-bottom", anchor: .bottom) }
                }
                .onChange(of: store.outgoing) { _, _ in
                    if followingBottom || store.sending { proxy.scrollTo("chat-bottom", anchor: .bottom) }
                }
                .refreshable { await store.refresh() }
            }
        }
        .safeAreaInset(edge: .bottom, spacing: 0) { composer }
        .auroraScreen(standingState.wash)
        // A destination can appear before the scene becomes active; load its first snapshot on appearance.
        .task { await store.refresh() }
        .task(id: scenePhase) {
            guard scenePhase == .active else { return }
            await store.follow()
        }
        // Leaving the chat (section switch or nav pop) drops the keyboard, so returning can't restore focus.
        .onDisappear { composing = false }
    }

    private func scrollToQuestion(_ proxy: ScrollViewProxy) {
        guard let toolID = store.focusedToolID,
              let turn = store.turns.first(where: { $0.blocks.contains { $0.toolID == toolID } }) else { return }
        followingBottom = false
        proxy.scrollTo(turn.idx, anchor: .top)
        store.focusedToolID = nil
    }

    private var standingState: AuroraStandingState {
        let questions = store.turns.flatMap(\.blocks).filter { block in
            guard block.isQuestion, block.answer == nil else { return false }
            if case .answered = store.answers[block.toolID] { return false }
            return true
        }.count
        return model.standingState(project: store.project, questions: questions)
    }

    private var header: some View {
        VStack(alignment: .leading, spacing: Space.sm) {
            HStack(spacing: Space.sm) {
                Text(store.snapshot.meta.model.isEmpty ? "Orchestrator" : store.snapshot.meta.model)
                    .font(.ui(13, relativeTo: .caption)).foregroundStyle(Palette.text2).lineLimit(1)
                Spacer()
                if let fraction = store.snapshot.meta.context.fraction {
                    Text("Context \(Int(min(fraction, 1) * 100))%")
                        .font(.mono(13, relativeTo: .caption)).foregroundStyle(Palette.text2)
                        .accessibilityLabel("Context use").accessibilityValue("\(Int(min(fraction, 1) * 100)) percent")
                }
            }
        }.padding(.horizontal, Space.lg).padding(.vertical, Space.sm)
    }

    private var composer: some View {
        VStack(alignment: .leading, spacing: Space.sm) {
            if !photos.pending.isEmpty { attachmentChips }
            if !photos.readyToSend {
                ProgressView("Preparing photos…").font(.tCaption)
            }
            if let reason = store.disabledReason {
                Text(reason).font(.tCaption).foregroundStyle(Palette.textDim)
            } else if let error = store.sendError {
                Text(error).font(.tCaption).foregroundStyle(Palette.down)
            }
            if store.draft.utf16.count > 8000 {
                Text("Keep your message under 8,000 characters.").font(.tCaption).foregroundStyle(Palette.amber)
            }
            Composer(focused: composing) {
                PhotosPicker(selection: $pickedPhotos,
                             maxSelectionCount: max(1, ChatAttachment.maxCount - photos.pending.count),
                             matching: .images) {
                    Image(systemName: "photo")
                        .font(.tBody)
                        .foregroundStyle(Palette.text2)
                        .frame(minWidth: 44, minHeight: 44)
                }
                .accessibilityLabel("Attach photo")
                .accessibilityIdentifier("chat.attach")
                .disabled(store.disabledReason != nil || !photos.readyToSend || photos.pending.count >= ChatAttachment.maxCount)
                TextField("Message your orchestrator", text: $store.draft, axis: .vertical)
                    .font(.ui(16)).foregroundStyle(Palette.text).tint(Palette.accent)
                    .padding(.vertical, Space.sm)
                    .lineLimit(1...5).focused($composing)
                    .accessibilityIdentifier("chat.composer")
                Button {
                    guard photos.readyToSend else { return }
                    let text = store.draft
                    let attachments = photos.pending.map(\.attachment)
                    Task {
                        if await store.send(text, attachments: attachments), store.draft == text {
                            store.draft = ""
                            if photos.pending.map(\.attachment) == attachments { photos.pending = [] }
                        }
                    }
                } label: {
                    if store.sending { ProgressView().tint(Palette.onAccent) }
                    else { Image(systemName: "arrow.up") }
                }
                .buttonStyle(AuroraButtonStyle(.primary))
                .accessibilityLabel("Send message")
                .accessibilityIdentifier("chat.send")
                .disabled(store.disabledReason != nil || !photos.readyToSend || store.sending || store.draft.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty || store.draft.utf16.count > 8000)
            }
        }
        .padding(Space.lg)
        .onChange(of: pickedPhotos) { _, items in
            guard !items.isEmpty else { return }
            let count = photos.beginPreparation(count: items.count)
            Task { await attach(Array(items.prefix(count))) }
        }
    }

    /// Downscale the picked library photos in order; the picker selection clears once consumed
    /// so picking the same photo again still fires the change.
    private func attach(_ items: [PhotosPickerItem]) async {
        for item in items {
            let data = try? await item.loadTransferable(type: Data.self)
            await photos.finishPreparation(data)
        }
        pickedPhotos = []
    }

    private var attachmentChips: some View {
        ScrollView(.horizontal, showsIndicators: false) {
            HStack(spacing: Space.sm) {
                ForEach(photos.pending) { prepared in
                    VStack(spacing: Space.xs) {
                        if let thumbnail = prepared.thumbnail {
                            Image(uiImage: thumbnail)
                                .resizable().scaledToFill()
                                .frame(width: 56, height: 56)
                                .clipShape(RoundedRectangle(cornerRadius: Radius.sm))
                        } else {
                            Image(systemName: "photo")
                                .frame(width: 56, height: 56)
                                .background(Palette.raise, in: RoundedRectangle(cornerRadius: Radius.sm))
                        }
                        Text(prepared.name).font(.tCaption).lineLimit(1).frame(maxWidth: 56)
                    }
                    .overlay(alignment: .topTrailing) {
                        Button {
                            photos.pending.removeAll { $0.id == prepared.id }
                        } label: {
                            Image(systemName: "xmark.circle.fill")
                                .font(.tCallout)
                                .foregroundStyle(Palette.text2)
                        }
                        .accessibilityLabel("Remove \(prepared.name)")
                    }
                }
            }
        }
    }

    private func deliveryColor(_ delivery: PromptDelivery) -> Color {
        if case .failed = delivery { return Palette.down }
        return Palette.textDim
    }
}

private struct ChatTurnRow: View {
    let turn: ChatTurn
    let delivery: PromptDelivery?
    let store: ChatStore
    private var mine: Bool { turn.role == "user" }

    var body: some View {
        HStack(alignment: .top) {
            if mine { Spacer(minLength: 44) }
            VStack(alignment: .leading, spacing: Space.sm) {
                ForEach(Array(turn.blocks.enumerated()), id: \.offset) { _, block in
                    if block.isQuestion {
                        ChatQuestionCard(block: block, store: store)
                            .id(block.toolID)
                    } else if block.kind == "tool" {
                        Text([block.tool, block.text].filter { !$0.isEmpty }.joined(separator: " "))
                            .font(.tDataSmall).lineLimit(1).truncationMode(.middle)
                            .padding(.horizontal, Space.sm).padding(.vertical, Space.xs)
                            .background(AuroraSurface(shape: Capsule(), glass: .control))
                            .accessibilityLabel([block.tool, block.text].joined(separator: " "))
                    } else if block.kind == "text" || block.kind == "thinking" {
                        ChatBubble(mine ? AttributedString(block.text) : (try? AttributedString(markdown: block.text, options: .init(interpretedSyntax: .inlineOnlyPreservingWhitespace))) ?? AttributedString(block.text),
                                   speaker: mine ? .operator : .orchestrator)
                            .textSelection(.enabled)
                    } else if !block.text.isEmpty {
                        Text(block.text).font(.tCallout).foregroundStyle(Palette.textDim)
                    }
                }
                if mine && (delivery != nil || turn.queued) {
                    Text(delivery?.label ?? "Queued").font(.tCaption).foregroundStyle(Palette.textDim)
                }
            }

            if !mine { Spacer(minLength: 24) }
        }
    }
}
