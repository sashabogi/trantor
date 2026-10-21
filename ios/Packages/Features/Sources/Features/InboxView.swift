import SwiftUI
import TrantorCore
import TrantorStore

public struct InboxView: View {
    @Environment(AppModel.self) private var model
    @State private var composing = false

    public init() {}

    public var body: some View {
        let inbox = model.inbox
        List {
            if inbox.freshness.isStale { FreshnessBanner(freshness: inbox.freshness) }
            if inbox.threads.isEmpty { EmptyState(title: "No messages", systemImage: "tray") }
            ForEach(inbox.threads) { thread in
                NavigationLink(value: thread.counterpart) {
                    VStack(alignment: .leading, spacing: 2) {
                        HStack {
                            Text(thread.counterpart).font(.headline)
                            Spacer()
                            TimeAgo(millis: thread.last?.ts ?? 0).font(.caption).foregroundStyle(.secondary)
                        }
                        Text(thread.last?.text ?? "").lineLimit(2).font(.subheadline).foregroundStyle(.secondary)
                    }
                }
            }
        }
        .navigationTitle("Inbox")
        .navigationDestination(for: String.self) { ThreadView(counterpart: $0) }
        .toolbar { ToolbarItem(placement: .topBarTrailing) { Button("New", systemImage: "square.and.pencil") { composing = true } } }
        .sheet(isPresented: $composing) { ComposeView() }
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
        VStack(spacing: 0) {
            List {
                ForEach(thread?.messages ?? []) { m in
                    let mine = m.from == model.settings.identityName
                    VStack(alignment: mine ? .trailing : .leading, spacing: 2) {
                        Text(m.text).padding(10)
                            .background(mine ? Color.accentColor.opacity(0.18) : Color.secondary.opacity(0.15), in: RoundedRectangle(cornerRadius: 12))
                        TimeAgo(millis: m.ts).font(.caption2).foregroundStyle(.secondary)
                    }
                    .frame(maxWidth: .infinity, alignment: mine ? .trailing : .leading)
                    .listRowSeparator(.hidden)
                }
            }
            .listStyle(.plain)
            if let e = inbox.sendError { Text(e).font(.footnote).foregroundStyle(.red).padding(.horizontal) }
            HStack {
                TextField("Reply", text: $text, axis: .vertical).textFieldStyle(.roundedBorder)
                Button("Send") {
                    let body = text
                    guard let thread else { return }
                    Task { await inbox.reply(to: thread, text: body); text = "" }
                }
                .buttonStyle(.borderedProminent)
                .disabled(text.trimmingCharacters(in: .whitespaces).isEmpty)
            }
            .padding()
        }
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
            Form {
                Section("To") {
                    TextField("Seat name", text: $seat).textInputAutocapitalization(.never).autocorrectionDisabled()
                    if !model.fleet.online.isEmpty {
                        Picker("Online seats", selection: $seat) {
                            Text("Choose").tag("")
                            ForEach(model.fleet.online) { Text($0.session).tag($0.session) }
                        }
                    }
                }
                Section("Message") { TextField("Message", text: $text, axis: .vertical) }
                if let e = model.inbox.sendError { Section { Text(e).foregroundStyle(.red) } }
            }
            .navigationTitle("New message")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) { Button("Cancel") { dismiss() } }
                ToolbarItem(placement: .confirmationAction) {
                    Button("Send") {
                        Task { await model.inbox.send(to: seat, text: text); if model.inbox.sendError == nil { dismiss() } }
                    }.disabled(seat.isEmpty || text.trimmingCharacters(in: .whitespaces).isEmpty)
                }
            }
        }
    }
}
