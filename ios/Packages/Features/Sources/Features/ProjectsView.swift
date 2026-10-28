import SwiftUI
import TrantorCore
import TrantorDesign
import TrantorStore

public struct ProjectsView: View {
    @Environment(AppModel.self) private var model

    public init() {}

    public var body: some View {
        let store = model.projects
        ScrollView {
            LazyVStack(alignment: .leading, spacing: Space.md) {
                StatusHeadline("\(store.projects.count) projects · \(model.decisions.items.count) waiting")
                    .padding(.top, Space.md)
                if store.freshness.isStale { FreshnessBanner(freshness: store.freshness) }
                if store.projects.isEmpty { EmptyState(title: "No projects", systemImage: "square.stack.3d.up").padding(Space.md).auroraPanel() }
                ForEach(store.projects) { project in
                    NavigationLink(value: project.project) { ProjectRow(project: project) }
                        .buttonStyle(.plain)
                }
            }
            .padding(.horizontal, Space.lg).padding(.bottom, Space.xl)
        }
        .auroraScreen(model.standingState().wash)
        .navigationTitle("Projects")
        .navigationBarTitleDisplayMode(.inline)
        .navigationDestination(for: String.self) { ProjectView(project: $0) }
        .navigationDestination(item: Binding(get: { model.openProject }, set: { model.openProject = $0 })) { ProjectView(project: $0) }
        .refreshable { await store.refresh() }
    }
}

func laneColor(_ status: String) -> Color {
    switch status {
    case "doing": return Palette.accent
    case "testing": return Palette.accent
    case "done": return Palette.up
    case "blocked": return Palette.text2
    case "failed": return Palette.down
    case "todo": return Palette.textFaint
    default: return Palette.textDim
    }
}

struct ProjectRow: View {
    let project: Project
    private let order = ["todo", "doing", "testing", "done", "blocked", "failed"]
    private var lanes: [String] { order.filter { (project.counts[$0] ?? 0) > 0 } }
    private var total: Int { lanes.reduce(0) { $0 + (project.counts[$1] ?? 0) } }

    var body: some View {
        VStack(alignment: .leading, spacing: Space.md) {
            HStack(spacing: Space.sm) {
                NameMark(project.project, size: 34)
                VStack(alignment: .leading, spacing: Space.xs) {
                    Text(project.project).font(.tHeadline).foregroundStyle(Palette.text)
                    if !project.phase.isEmpty { Text(project.phase).font(.tCallout).foregroundStyle(Palette.text2) }
                }
                Spacer()
                StatusDot(live: !project.idle)
                Chip(project.idle ? "idle" : "active", color: project.idle ? Palette.textDim : Palette.up)
                Image(systemName: "chevron.right").font(.tCaption).foregroundStyle(Palette.textDim)
            }
            if !project.brief.isEmpty { Text(project.brief).font(.tCallout).foregroundStyle(Palette.textDim).lineLimit(2) }
            if total > 0 {
                GeometryReader { geo in
                    HStack(spacing: 0) {
                        ForEach(lanes, id: \.self) { lane in
                            Rectangle().fill(laneColor(lane))
                                .frame(width: geo.size.width * CGFloat(project.counts[lane] ?? 0) / CGFloat(total))
                        }
                    }
                    .clipShape(Capsule())
                }
                .frame(height: 4).accessibilityHidden(true)
                ViewThatFits(in: .horizontal) {
                    laneCounts
                    ScrollView(.horizontal, showsIndicators: false) { laneCounts }
                }
            }
            if !project.doingTitles.isEmpty {
                Hairline()
                Eyebrow("In progress")
                ForEach(Array(project.doingTitles.enumerated()), id: \.offset) { _, title in
                    HStack(alignment: .firstTextBaseline, spacing: Space.sm) {
                        Image(systemName: "arrow.up.right").font(.tCaption).foregroundStyle(Palette.accent)
                        Text(title).font(.tCallout).foregroundStyle(Palette.text2)
                    }
                }
            }
            if !project.agents.isEmpty {
                ScrollView(.horizontal, showsIndicators: false) {
                    HStack(spacing: Space.md) {
                        ForEach(Array(project.agents.enumerated()), id: \.offset) { _, agent in
                            HStack(spacing: Space.sm) {
                                SeatOrb(agent.session, size: 28)
                                StatusDot(live: agent.online)
                                Text(agent.session).font(.tDataSmall).foregroundStyle(Palette.text2)
                            }
                            .accessibilityElement(children: .combine)
                            .accessibilityLabel("\(agent.session), \(agent.online ? "online" : "offline")")
                        }
                    }
                }
            }
        }
        .padding(Space.md).auroraPanel()
    }

    private var laneCounts: some View {
        HStack(spacing: Space.md) {
            ForEach(lanes, id: \.self) { lane in
                HStack(spacing: Space.xs) {
                    Text("\(project.counts[lane] ?? 0)").font(.tDataSmall).monospacedDigit().foregroundStyle(laneColor(lane))
                    Text(lane).font(.tCaption).foregroundStyle(Palette.textDim)
                }
            }
        }
    }
}

public struct BoardView: View {
    @Environment(AppModel.self) private var model
    let project: String
    @State private var selectedLane = ""

    public init(project: String) { self.project = project }

    public var body: some View {
        let board = model.board
        ScrollView {
            LazyVStack(alignment: .leading, spacing: Space.md) {
                StatusHeadline(board.lanes.isEmpty ? "No cards" : board.lanes.filter { selectedLane.isEmpty || $0.status == selectedLane }.map { "\($0.cards.count) \($0.status)" }.joined(separator: " · "))
                    .padding(.top, Space.md)
                ScrollView(.horizontal, showsIndicators: false) {
                    AuroraPicker([("", "All")] + board.lanes.map { ($0.status, $0.status.capitalized) }, selection: $selectedLane)
                }.padding(.vertical, Space.xs)
                if board.freshness.isStale { FreshnessBanner(freshness: board.freshness) }
                if let error = board.writeError { Label(error, systemImage: "exclamationmark.triangle").foregroundStyle(Palette.down).padding(Space.md).auroraPanel() }
                if board.lanes.isEmpty { EmptyState(title: "No cards", systemImage: "rectangle.stack").padding(Space.md).auroraPanel() }
                ForEach(board.lanes.filter { selectedLane.isEmpty || $0.status == selectedLane }) { lane in
                    HStack(spacing: Space.sm) {
                        Eyebrow(lane.status, color: laneColor(lane.status))
                        CountBadge(lane.cards.count, hot: false)
                        Spacer()
                    }.padding(.top, Space.sm)
                    ForEach(lane.cards) { card in
                        NavigationLink(value: card) { CardRow(card: card).padding(Space.md).auroraPanel() }.buttonStyle(.plain)
                    }
                }
            }
            .padding(.horizontal, Space.lg).padding(.bottom, Space.xl)
        }
        .auroraScreen(model.standingState(project: project).wash)
        .navigationTitle(project)
        .navigationDestination(for: Card.self) { CardDetailView(card: $0) }
        .refreshable { await board.load(project: project) }
        .task(id: project) { await board.load(project: project) }
        .onChange(of: board.lanes.map(\.status)) { _, statuses in
            if !statuses.contains(selectedLane) { selectedLane = "" }
        }
    }
}

struct CardRow: View {
    let card: Card
    var body: some View {
        VStack(alignment: .leading, spacing: Space.sm) {
            HStack {
                Mono("#\(card.id)", color: Palette.textDim)
                Spacer()
                if !card.difficulty.isEmpty { Chip(card.difficulty) }
                TimeAgo(millis: card.updated)
            }
            Text(card.title).font(.tHeadline).foregroundStyle(Palette.text).lineLimit(3)
            if !card.assignee.isEmpty { SeatLine(seat: card.assignee, verb: "") }
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
        ScrollView {
            LazyVStack(alignment: .leading, spacing: Space.md) {
                VStack(alignment: .leading, spacing: Space.md) {
                    HStack {
                        Mono("#\(c.id)", color: Palette.textDim)
                        Spacer()
                        Chip(c.status, color: laneColor(c.status))
                        if !c.difficulty.isEmpty { Chip(c.difficulty) }
                    }
                    Text(c.title).font(.tTitle)
                    if !c.assignee.isEmpty { SeatLine(seat: c.assignee, verb: "") }
                    if !c.drill.isEmpty { Detail(label: "Drill", text: c.drill) }
                }.padding(Space.md).auroraPanel()
                if let error = board.writeError { Label(error, systemImage: "exclamationmark.triangle").foregroundStyle(Palette.down).padding(Space.md).auroraPanel() }
                AuroraSection("Move to") {
                    LazyVGrid(columns: [GridItem(.adaptive(minimum: 100))], alignment: .leading, spacing: Space.sm) {
                        ForEach(["todo", "doing", "testing", "blocked", "done"].filter { $0 != c.status }, id: \.self) { status in
                            Button(status.capitalized) {
                                if status == "done" { askDone = true } else { Task { await board.move(c, to: status) } }
                            }
                            .buttonStyle(AuroraButtonStyle()).disabled(board.busy)
                        }
                    }
                }
                if !c.checklist.isEmpty {
                    AuroraSection("Checklist") {
                        ForEach(Array(c.checklist.enumerated()), id: \.offset) { i, item in
                            Button { Task { await board.toggle(c, index: i, done: !item.done) } } label: {
                                HStack(alignment: .firstTextBaseline, spacing: Space.sm) {
                                    Image(systemName: item.done ? "checkmark.square.fill" : "square")
                                        .foregroundStyle(item.done ? Palette.accent : Palette.textDim)
                                    Text(item.text).font(.tBody).foregroundStyle(item.done ? Palette.text2 : Palette.text)
                                        .frame(maxWidth: .infinity, alignment: .leading)
                                }.padding(.vertical, Space.sm)
                            }.buttonStyle(.plain).disabled(board.busy)
                                .accessibilityLabel("\(item.text), \(item.done ? "complete" : "incomplete")")
                        }
                    }
                }
                AuroraSection("Add a note") {
                    WellField("Note", text: $note, axis: .vertical)
                    Button("Post note") {
                        let text = note
                        Task { await board.addNote(c, text); note = "" }
                    }.buttonStyle(AuroraButtonStyle(.primary)).disabled(note.trimmingCharacters(in: .whitespaces).isEmpty || board.busy)
                }
                if !c.log.isEmpty {
                    AuroraSection("Log") {
                        ForEach(Array(c.log.reversed().enumerated()), id: \.offset) { i, entry in
                            if i > 0 { Hairline() }
                            VStack(alignment: .leading, spacing: Space.sm) {
                                HStack { SeatLine(seat: entry.by, verb: ""); Spacer(); TimeAgo(millis: entry.ts) }
                                Text(entry.text).font(.tBody).foregroundStyle(Palette.text2)
                            }
                        }
                    }
                }
                if let messages = board.detail?.messages, !messages.isEmpty {
                    AuroraSection("Messages") {
                        ForEach(messages) { message in
                            VStack(alignment: .leading, spacing: Space.sm) {
                                SeatLine(seat: message.from, verb: "to \(message.to)")
                                Text(message.text).font(.tBody).foregroundStyle(Palette.text2).lineLimit(6)
                            }.well()
                        }
                    }
                }
            }
            .padding(.horizontal, Space.lg).padding(.bottom, Space.xl)
        }
        .auroraScreen(model.standingState(project: card.project).wash)
        .navigationTitle("Card")
        .navigationBarTitleDisplayMode(.inline)
        .task(id: card.id) { await board.open(card: card.id) }
        .refreshable { await board.open(card: card.id) }
        .alert("Close this card", isPresented: $askDone) {
            TextField("Drill: what you did and saw", text: $drill)
            Button("Mark done") { Task { await board.move(c, to: "done", drill: drill) } }
            Button("Cancel", role: .cancel) {}
        } message: { Text("The hub needs a drill line to close a card.") }
    }
}

#Preview("Projects") {
    NavigationStack { ProjectsView() }.environment(DemoData.model()).trantorTheme()
}
