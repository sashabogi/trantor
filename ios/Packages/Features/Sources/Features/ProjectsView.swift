import SwiftUI
import TrantorCore
import TrantorStore

public struct ProjectsView: View {
    @Environment(AppModel.self) private var model

    public init() {}

    public var body: some View {
        let store = model.projects
        List {
            if store.freshness.isStale { FreshnessBanner(freshness: store.freshness) }
            if store.projects.isEmpty { EmptyState(title: "No projects", systemImage: "square.stack.3d.up") }
            ForEach(store.projects) { project in
                NavigationLink(value: project.project) { ProjectRow(project: project) }
            }
        }
        .navigationTitle("Projects")
        .navigationDestination(for: String.self) { BoardView(project: $0) }
        .refreshable { await store.refresh() }
    }
}

struct ProjectRow: View {
    let project: Project
    private let order = ["todo", "doing", "testing", "failed", "blocked", "done"]

    var body: some View {
        VStack(alignment: .leading, spacing: 4) {
            HStack {
                Text(project.project).font(.headline)
                Spacer()
                Circle().fill(project.idle ? Color.secondary : Color.green).frame(width: 8, height: 8)
                    .accessibilityLabel(project.idle ? "Idle" : "Active")
            }
            if !project.phase.isEmpty { Text(project.phase).font(.subheadline).foregroundStyle(.secondary) }
            HStack(spacing: 10) {
                ForEach(order.filter { (project.counts[$0] ?? 0) > 0 }, id: \.self) { s in
                    Text("\(project.counts[s] ?? 0) \(s)").font(.caption)
                        .foregroundStyle(s == "failed" || s == "blocked" ? .red : .secondary)
                }
            }
        }
        .padding(.vertical, 2)
    }
}

// MARK: - Board

public struct BoardView: View {
    @Environment(AppModel.self) private var model
    let project: String

    public init(project: String) { self.project = project }

    public var body: some View {
        let board = model.board
        List {
            if board.freshness.isStale { FreshnessBanner(freshness: board.freshness) }
            if let e = board.writeError { Label(e, systemImage: "exclamationmark.triangle").foregroundStyle(.red) }
            if board.lanes.isEmpty { EmptyState(title: "No cards", systemImage: "rectangle.stack") }
            ForEach(board.lanes) { lane in
                Section("\(lane.status.capitalized) (\(lane.cards.count))") {
                    ForEach(lane.cards) { card in
                        NavigationLink(value: card) { CardRow(card: card) }
                    }
                }
            }
        }
        .navigationTitle(project)
        .navigationDestination(for: Card.self) { CardDetailView(card: $0) }
        .refreshable { await board.load(project: project) }
        .task(id: project) { await board.load(project: project) }
    }
}

struct CardRow: View {
    let card: Card
    var body: some View {
        VStack(alignment: .leading, spacing: 2) {
            Text("#\(card.id)  \(card.title)").lineLimit(2)
            HStack {
                if !card.assignee.isEmpty { Text(card.assignee) }
                if !card.difficulty.isEmpty { Text(card.difficulty) }
                Spacer()
                TimeAgo(millis: card.updated)
            }
            .font(.caption).foregroundStyle(.secondary)
        }
    }
}

struct CardDetailView: View {
    @Environment(AppModel.self) private var model
    let card: Card
    @State private var note = ""
    @State private var drill = ""
    @State private var askDone = false

    private var current: Card { model.board.detail?.task?.id == card.id ? (model.board.detail?.task ?? card) : card }

    var body: some View {
        let board = model.board
        let c = current
        List {
            Section {
                Text(c.title).font(.headline)
                LabeledContent("Status", value: c.status)
                if !c.assignee.isEmpty { LabeledContent("Assignee", value: c.assignee) }
                if !c.difficulty.isEmpty { LabeledContent("Difficulty", value: c.difficulty) }
                if !c.drill.isEmpty { LabeledContent("Drill", value: c.drill) }
            }
            if let e = board.writeError { Section { Label(e, systemImage: "exclamationmark.triangle").foregroundStyle(.red) } }

            Section("Move to") {
                ForEach(["todo", "doing", "testing", "blocked", "done"].filter { $0 != c.status }, id: \.self) { s in
                    Button(s.capitalized) {
                        if s == "done" { askDone = true } else { Task { await board.move(c, to: s) } }
                    }.disabled(board.busy)
                }
            }

            if !c.checklist.isEmpty {
                Section("Checklist") {
                    ForEach(Array(c.checklist.enumerated()), id: \.offset) { i, item in
                        Button {
                            Task { await board.toggle(c, index: i, done: !item.done) }
                        } label: {
                            Label(item.text, systemImage: item.done ? "checkmark.square.fill" : "square")
                                .foregroundStyle(.primary)
                        }.disabled(board.busy)
                    }
                }
            }

            Section("Add a note") {
                TextField("Note", text: $note, axis: .vertical)
                Button("Post note") {
                    let text = note
                    Task { await board.addNote(c, text); note = "" }
                }.disabled(note.trimmingCharacters(in: .whitespaces).isEmpty || board.busy)
            }

            if !c.log.isEmpty {
                Section("Log") {
                    ForEach(Array(c.log.reversed().enumerated()), id: \.offset) { _, entry in
                        VStack(alignment: .leading, spacing: 2) {
                            Text(entry.text)
                            HStack { Text(entry.by); Spacer(); TimeAgo(millis: entry.ts) }
                                .font(.caption).foregroundStyle(.secondary)
                        }
                    }
                }
            }

            if let messages = board.detail?.messages, !messages.isEmpty {
                Section("Messages") {
                    ForEach(messages) { m in
                        VStack(alignment: .leading, spacing: 2) {
                            Text(m.text).lineLimit(6)
                            Text("\(m.from) to \(m.to)").font(.caption).foregroundStyle(.secondary)
                        }
                    }
                }
            }
        }
        .navigationTitle("Card #\(c.id)")
        .navigationBarTitleDisplayMode(.inline)
        .task(id: card.id) { await board.open(card: card.id) }
        .refreshable { await board.open(card: card.id) }
        .alert("Close this card", isPresented: $askDone) {
            TextField("Drill: what you did and saw", text: $drill)
            Button("Mark done") { Task { await board.move(c, to: "done", drill: drill) } }
            Button("Cancel", role: .cancel) {}
        } message: {
            Text("The hub needs a drill line to close a card.")
        }
    }
}
