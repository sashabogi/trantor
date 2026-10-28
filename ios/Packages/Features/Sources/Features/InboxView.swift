import SwiftUI
import TrantorCore
import TrantorDesign
import TrantorStore

public struct InboxView: View {
    @Environment(AppModel.self) private var model
    @State private var composing = false

    public init() {}

    public var body: some View {
        let inbox = model.inbox
        ScrollView {
            LazyVStack(alignment: .leading, spacing: Space.md) {
                StatusHeadline("\(inbox.unreadCount) unread · " + model.standingState().headline, eyebrow: "Inbox")
                    .padding(.top, Space.md)
                if inbox.freshness.isStale { FreshnessBanner(freshness: inbox.freshness) }
                if inbox.threads.isEmpty { EmptyState(title: "No messages", systemImage: "tray").padding(Space.md).auroraPanel() }
                ForEach(inbox.threads) { thread in
                    let unread = thread.messages.contains { $0.to == inbox.identity && $0.id > inbox.readUpTo }
                    NavigationLink(value: thread.counterpart) {
                        HStack(alignment: .top, spacing: Space.md) {
                            SeatOrb(thread.counterpart)
                            VStack(alignment: .leading, spacing: Space.sm) {
                                HStack {
                                    Text(thread.counterpart).font(.mono(14, .medium)).foregroundStyle(Palette.text)
                                    Spacer()
                                    if unread {
                                        Circle().fill(Palette.accent).frame(width: 6, height: 6).accessibilityHidden(true)
                                    }
                                    TimeAgo(millis: thread.last?.ts ?? 0)
                                }
                                Text(thread.last?.text ?? "").lineLimit(2).font(.tCallout).foregroundStyle(Palette.text2)
                                if let project = thread.last?.project, !project.isEmpty {
                                    Chip(project)
                                }
                            }
                            Image(systemName: "chevron.right").font(.tCaption).foregroundStyle(Palette.textDim)
                        }.padding(Space.md).auroraPanel()
                    }.buttonStyle(.plain).accessibilityValue(unread ? "Unread" : "Read")
                }
            }
            .padding(.horizontal, Space.lg).padding(.bottom, Space.xl)
        }
        .auroraScreen(model.standingState().wash)
        .navigationTitle("Inbox")
        .navigationBarTitleDisplayMode(.inline)
        .navigationDestination(for: String.self) { ThreadView(counterpart: $0) }
        .toolbar { ToolbarItem(placement: .topBarTrailing) { Button("New", systemImage: "square.and.pencil") { composing = true } } }
        .sheet(isPresented: $composing) { ComposeView().trantorTheme() }
        .refreshable { await inbox.refresh() }
    }
}

struct ThreadView: View {
    @Environment(AppModel.self) private var model
    let counterpart: String
    @State private var text = ""
    @FocusState private var composing: Bool

    var body: some View {
        let inbox = model.inbox
        let thread = inbox.threads.first { $0.counterpart == counterpart }
        ScrollView {
            LazyVStack(alignment: .leading, spacing: Space.md) {
                ForEach(thread?.messages ?? []) { message in
                    let mine = message.from == inbox.identity
                    HStack {
                        if mine { Spacer(minLength: Space.xl) }
                        VStack(alignment: .leading, spacing: Space.sm) {
                            HStack {
                                SeatLine(seat: message.from, verb: "")
                                Spacer()
                                TimeAgo(millis: message.ts)
                            }
                            ChatBubble(message.text, speaker: mine ? .operator : .orchestrator).textSelection(.enabled)
                        }
                        if !mine { Spacer(minLength: Space.xl) }
                    }
                }
            }
            .padding(Space.lg)
        }
        .scrollDismissesKeyboard(.interactively)
        .onTapGesture { composing = false }
        .safeAreaInset(edge: .bottom) {
            VStack(alignment: .leading, spacing: Space.sm) {
                if let error = inbox.sendError { Text(error).font(.tCaption).foregroundStyle(Palette.down) }
                Composer(focused: composing) {
                    TextField("Reply", text: $text, axis: .vertical)
                        .font(.ui(16)).lineLimit(1...5).focused($composing)
                        .padding(.horizontal, Space.sm)
                    Button("Send", systemImage: "arrow.up") {
                        let body = text
                        guard let thread else { return }
                        Task { await inbox.reply(to: thread, text: body); text = "" }
                    }
                    .buttonStyle(AuroraButtonStyle(.primary))
                    .disabled(text.trimmingCharacters(in: .whitespaces).isEmpty)
                }
            }
            .padding(Space.lg)

        }
        .auroraScreen(model.standingState().wash)
        .navigationTitle(counterpart)
        .navigationBarTitleDisplayMode(.inline)
        .task { await inbox.markRead() }
    }
}

struct ComposeView: View {
    @Environment(AppModel.self) private var model
    @Environment(\.dismiss) private var dismiss
    @State private var seat = ""
    @State private var text = ""

    var body: some View {
        NavigationStack {
            ScrollView {
                LazyVStack(alignment: .leading, spacing: Space.md) {
                    AuroraSection("To") {
                        WellField("Seat name", text: $seat, mono: true)
                            .textInputAutocapitalization(.never).autocorrectionDisabled()
                        if !model.fleet.online.isEmpty {
                            Menu {
                                ForEach(model.fleet.online) { peer in
                                    Button(peer.session) { seat = peer.session }
                                }
                            } label: {
                                Label("Choose an online seat", systemImage: "person.2")
                            }.buttonStyle(AuroraButtonStyle())
                        }
                        if !seat.isEmpty { SeatLine(seat: seat, verb: "") }
                    }
                    AuroraSection("Message") { WellField("Message", text: $text, axis: .vertical) }
                    if let error = model.inbox.sendError { Text(error).font(.tCallout).foregroundStyle(Palette.down).padding(Space.md).auroraPanel() }
                    Button("Send message", systemImage: "arrow.up") {
                        Task { await model.inbox.send(to: seat, text: text); if model.inbox.sendError == nil { dismiss() } }
                    }
                    .buttonStyle(AuroraButtonStyle(.primary))
                    .disabled(seat.isEmpty || text.trimmingCharacters(in: .whitespaces).isEmpty)
                }
                .padding(Space.lg)
            }
            .auroraScreen(model.standingState().wash)
            .navigationTitle("New message")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar { ToolbarItem(placement: .cancellationAction) { Button("Cancel") { dismiss() } } }
        }
    }
}

#Preview("Inbox") {
    NavigationStack { InboxView() }.environment(DemoData.model()).trantorTheme()
}
