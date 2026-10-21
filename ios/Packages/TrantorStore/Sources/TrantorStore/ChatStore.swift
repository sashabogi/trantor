import Foundation
import HubClient
import Observation
import TrantorCore

public enum PromptDelivery: Equatable, Sendable {
    case sending, queued, delivered, seen, failed(String)
    public var label: String {
        switch self {
        case .sending: "Sending…"
        case .queued: "Queued"
        case .delivered: "Delivered"
        case .seen: "Seen"
        case .failed(let reason): reason
        }
    }
}

public struct OutgoingPrompt: Identifiable, Equatable, Sendable {
    public let id: UUID
    public let text: String
    public var promptID: String?
    public var delivery: PromptDelivery
    public var seenIndex: Int?
    var session: String
    var firstEligibleIndex: Int
}

@MainActor @Observable
public final class ChatStore {
    public let project: String
    public private(set) var snapshot = ChatSnapshot()
    public private(set) var outgoing: [OutgoingPrompt] = []
    public private(set) var freshness = Freshness()
    public private(set) var hasLiveSnapshot = false
    public private(set) var refreshing = false
    public private(set) var sending = false
    public var sendError: String?
    public var api: HubServing?
    @ObservationIgnored public var mayWrite: @MainActor () -> Bool = { false }
    private let cache: StoreCache
    private let cacheKey: String
    private var refreshAgain = false
    private var checkingReceipts = false
    private var generation = 0

    public init(project: String, api: HubServing? = nil, cache: StoreCache = StoreCache(directory: nil)) {
        self.project = project; self.api = api; self.cache = cache
        cacheKey = "chat-" + project.utf8.map { String(format: "%02x", $0) }.joined()
        if let cached = cache.load(ChatSnapshot.self, name: cacheKey) {
            snapshot = cached.value
            snapshot.turns = Array(snapshot.turns.suffix(200))
            freshness.fromCache(savedAt: cached.savedAt)
        }
    }

    public var turns: [ChatTurn] { snapshot.turns }
    public var disabledReason: String? {
        guard api != nil else { return "Pair with your hub to send a message." }
        guard mayWrite() else { return "Pair this device with write access to this project to send a message." }
        guard hasLiveSnapshot else { return "Connect to your hub to send a message." }
        guard !snapshot.host.isEmpty else { return "No Mac is relaying this project. Open Trantor on your Mac." }
        return nil
    }

    public static func allowsWriting(scopes: [Scope], project: String) -> Bool {
        scopes.contains { ($0.project == "*" || $0.project == project) && ["write", "approver", "owner"].contains($0.role) }
    }

    public func merge(_ incoming: ChatSnapshot) {
        let changedSession = incoming.session != snapshot.session
        var byIndex = changedSession ? [:] : Dictionary(snapshot.turns.map { ($0.idx, $0) }, uniquingKeysWith: { _, last in last })
        for turn in incoming.turns { byIndex[turn.idx] = turn }
        snapshot = incoming
        snapshot.turns = Array(byIndex.values.filter { $0.idx < incoming.total }.sorted { $0.idx < $1.idx }.suffix(200))
        hasLiveSnapshot = true
        freshness.fresh()
        markSeen()
        cache.save(snapshot, name: cacheKey)
    }

    public func refresh() async {
        guard let api else { return }
        if refreshing { refreshAgain = true; return }
        refreshing = true
        let currentGeneration = generation
        defer { refreshing = false }
        repeat {
            refreshAgain = false
            do {
                // Reread retained turns: chat.updated does not say which earlier queued/tool turn changed.
                var after = (turns.first?.idx ?? 0) - 1
                var previousSession = snapshot.session
                while !Task.isCancelled {
                    let incoming = try await api.chat(project: project, after: after)
                    guard generation == currentGeneration else { return }
                    if incoming.session != previousSession && after >= 0 {
                        previousSession = incoming.session
                        after = -1
                        continue
                    }
                    merge(incoming)
                    guard let last = incoming.turns.map(\.idx).max(), last > after, last < incoming.total - 1 else { break }
                    after = last
                    previousSession = incoming.session
                }
                await refreshReceipts()
            } catch is CancellationError { return }
            catch { freshness.failed(DecisionsStore.describe(error)) }
        } while refreshAgain && !Task.isCancelled && generation == currentGeneration
    }

    public func follow() async {
        while !Task.isCancelled {
            await refresh()
            do { try await Task.sleep(for: .seconds(3)) } catch { return }
        }
    }

    @discardableResult
    public func send(_ raw: String) async -> Bool {
        guard !sending else { return false }
        let text = raw.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !text.isEmpty else { return false }
        guard text.utf16.count <= 8000 else { sendError = "Keep your message under 8,000 characters."; return false }
        if let reason = disabledReason { sendError = reason; return false }
        guard let api else { return false }
        sending = true; sendError = nil
        let currentGeneration = generation
        let localID = UUID()
        outgoing.append(OutgoingPrompt(id: localID, text: text, delivery: .sending, session: snapshot.session, firstEligibleIndex: snapshot.total))
        if outgoing.count > 200 { outgoing.removeFirst(outgoing.count - 200) }
        defer { sending = false }
        do {
            let receipt = try await api.sendPrompt(project: project, text: text)
            guard generation == currentGeneration else { return false }
            try accept(receipt, localID: localID)
            markSeen()
            return true
        } catch let error as HubError where error.isConnectivity {
            let op: String?
            switch error { case .offline(let id), .timeout(let id): op = id; default: op = nil }
            if let op, let result = try? await api.reconcile(op: op), generation == currentGeneration {
                if result.isCommitted,
                   let data = try? JSONEncoder().encode(result.body),
                   let receipt = try? JSONDecoder().decode(PromptStatus.self, from: data),
                   (try? accept(receipt, localID: localID)) != nil {
                    markSeen()
                    return true
                }
                if result.isRejected {
                    fail(localID, reason: result.body["error"]?.stringValue ?? error.userMessage)
                    return false
                }
            }
            fail(localID, reason: "\(error.userMessage) Delivery is unconfirmed; check the conversation before sending again.")
        } catch {
            guard generation == currentGeneration else { return false }
            fail(localID, reason: DecisionsStore.describe(error))
        }
        return false
    }

    private func accept(_ receipt: PromptStatus, localID: UUID) throws {
        guard !receipt.id.isEmpty, !receipt.status.isEmpty else { throw HubError.decoding("Missing prompt receipt") }
        guard let index = outgoing.firstIndex(where: { $0.id == localID }) else { return }
        outgoing[index].promptID = receipt.id
        apply(receipt)
    }

    public func apply(_ receipt: PromptStatus) {
        guard let index = outgoing.firstIndex(where: { $0.promptID == receipt.id }), outgoing[index].delivery != .seen else { return }
        switch receipt.status {
        case "queued", "claimed":
            if outgoing[index].delivery == .sending { outgoing[index].delivery = .queued }
        case "delivered": outgoing[index].delivery = .delivered
        case "failed", "expired": outgoing[index].delivery = .failed(receipt.failureReason)
        default: outgoing[index].delivery = .failed("The hub returned an unknown prompt status: \(receipt.status)")
        }
    }

    public func refreshReceipts() async {
        guard let api, !checkingReceipts else { return }
        checkingReceipts = true
        let currentGeneration = generation
        defer { checkingReceipts = false }
        let ids = outgoing.filter { $0.delivery == .queued || $0.delivery == .delivered }.compactMap(\.promptID)
        for id in ids {
            do {
                let status = try await api.promptStatus(id: id)
                guard generation == currentGeneration, !Task.isCancelled else { return }
                apply(status)
            } catch is CancellationError { return }
            catch HubError.notFound {
                apply(PromptStatus(id: id, status: "failed", error: "This prompt receipt is no longer available. Check the conversation on your Mac."))
            } catch { freshness.failed(DecisionsStore.describe(error)) }
        }
        markSeen()
    }

    private var transcriptMatches: [UUID: Int] {
        var used = Set<Int>()
        var matches: [UUID: Int] = [:]
        for prompt in outgoing where prompt.session == snapshot.session {
            if let seenIndex = prompt.seenIndex {
                used.insert(seenIndex); matches[prompt.id] = seenIndex
                continue
            }
            if let turn = turns.first(where: {
                $0.role == "user" && $0.idx >= prompt.firstEligibleIndex && !used.contains($0.idx) && $0.text.contains(prompt.text)
            }) {
                matches[prompt.id] = turn.idx; used.insert(turn.idx)
            }
        }
        return matches
    }

    public var unmirroredOutgoing: [OutgoingPrompt] {
        let matches = transcriptMatches
        return outgoing.filter { $0.delivery != .seen && matches[$0.id] == nil }
    }

    public func delivery(for turn: ChatTurn) -> PromptDelivery? {
        let matches = transcriptMatches
        return outgoing.first { matches[$0.id] == turn.idx }?.delivery
    }

    private func markSeen() {
        let matches = transcriptMatches
        for index in outgoing.indices where outgoing[index].delivery != .seen {
            guard let matched = matches[outgoing[index].id],
                  let turn = turns.first(where: { $0.idx == matched }), !turn.queued else { continue }
            outgoing[index].delivery = .seen
            outgoing[index].seenIndex = matched
        }
        if outgoing.last?.delivery == .seen { sendError = nil }
    }

    private func fail(_ id: UUID, reason: String) {
        guard let index = outgoing.firstIndex(where: { $0.id == id }) else { return }
        outgoing[index].delivery = .failed(reason)
        sendError = reason
    }

    public func disconnect() {
        generation += 1
        api = nil; hasLiveSnapshot = false
        snapshot = ChatSnapshot(); outgoing = []
    }
}
