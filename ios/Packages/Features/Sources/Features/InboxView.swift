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
                if inbox.freshness.isStale { FreshnessBanner(freshness: inbox.freshness) }
                if inbox.threads.isEmpty { EmptyState(title: "No messages", systemImage: "tray").card() }
                ForEach(inbox.threads) { thread in
                    let unread = thread.messages.contains { $0.to == inbox.identity && $0.id > inbox.readUpTo }
                    NavigationLink(value: thread.counterpart) {
                        HStack(alignment: .top, spacing: Space.md) {
                            NameMark(thread.counterpart, size: 34)
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
                                    Chip(project, color: Palette.hue(for: project))
                                }
                            }
                            Image(systemName: "chevron.right").font(.tCaption).foregroundStyle(Palette.textDim)
                        }.card()
                    }.buttonStyle(.plain).accessibilityValue(unread ? "Unread" : "Read")
                }
            }
            .padding(.horizontal, Space.lg).padding(.bottom, Space.xl)
        }
        .stage()
        .navigationTitle("Inbox")
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
                            Text(message.text).font(.tBody).foregroundStyle(Palette.text).textSelection(.enabled)
                        }
                        .card(highlighted: mine)
                        .background(mine ? Palette.accentSoft : .clear, in: RoundedRectangle(cornerRadius: Radius.lg))
                        if !mine { Spacer(minLength: Space.xl) }
                    }
                }
            }
            .padding(Space.lg)
        }
        .safeAreaInset(edge: .bottom) {
            VStack(alignment: .leading, spacing: Space.sm) {
                if let error = inbox.sendError { Text(error).font(.tCaption).foregroundStyle(Palette.down) }
                HStack(alignment: .bottom, spacing: Space.sm) {
                    WellField("Reply", text: $text, axis: .vertical)
                    Button("Send", systemImage: "arrow.up") {
                        let body = text
                        guard let thread else { return }
                        Task { await inbox.reply(to: thread, text: body); text = "" }
                    }
                    .buttonStyle(.primary)
                    .disabled(text.trimmingCharacters(in: .whitespaces).isEmpty)
                }
            }
            .padding(Space.lg)
            .background(Palette.ground.opacity(0.95))
            .overlay(alignment: .top) { Hairline() }
        }
        .stage()
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
                    Panel("To") {
                        WellField("Seat name", text: $seat, mono: true)
                            .textInputAutocapitalization(.never).autocorrectionDisabled()
                        if !model.fleet.online.isEmpty {
                            Menu {
                                ForEach(model.fleet.online) { peer in
                                    Button(peer.session) { seat = peer.session }
                                }
                            } label: {
                                Label("Choose an online seat", systemImage: "person.2")
                            }.buttonStyle(.ghost)
                        }
                        if !seat.isEmpty { SeatLine(seat: seat, verb: "") }
                    }
                    Panel("Message") { WellField("Message", text: $text, axis: .vertical) }
                    if let error = model.inbox.sendError { Text(error).font(.tCallout).foregroundStyle(Palette.down).card() }
                    Button("Send message", systemImage: "arrow.up") {
                        Task { await model.inbox.send(to: seat, text: text); if model.inbox.sendError == nil { dismiss() } }
                    }
                    .buttonStyle(.primary)
                    .disabled(seat.isEmpty || text.trimmingCharacters(in: .whitespaces).isEmpty)
                }
                .padding(Space.lg)
            }
            .stage()
            .navigationTitle("New message")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar { ToolbarItem(placement: .cancellationAction) { Button("Cancel") { dismiss() } } }
        }
    }
}

#Preview("Inbox") {
    NavigationStack { InboxView() }.environment(DemoData.model()).trantorTheme()
}
