import Foundation
import HubClient
import Observation
import TrantorCore

@MainActor @Observable
public final class CrewStore {
    public let project: String
    public let fleet: FleetStore
    public private(set) var host = ""
    public private(set) var roster: [RosterSeat] = []
    public private(set) var commands: [CrewCommandStatus] = []
    public private(set) var sending = false
    public private(set) var freshness = Freshness()
    public var error: String?
    public var api: HubServing?
    @ObservationIgnored public var mayControl: () -> Bool = { false }
    @ObservationIgnored public var requiresAuthentication: () -> Bool = { true }
    private let authenticator: any Authenticator
    private var generation = 0
    private var checking = false
    @ObservationIgnored private var polling: Task<Void, Never>?

    public init(project: String, fleet: FleetStore, api: HubServing? = nil,
                authenticator: any Authenticator = DeviceAuthenticator()) {
        self.project = project; self.fleet = fleet; self.api = api; self.authenticator = authenticator
    }

    public var seats: [Peer] {
        fleet.peers.filter { $0.project == project && $0.kind == "agent" && Self.validSpec(Self.spec(for: $0)) }
    }
    public var busy: Bool { sending || commands.contains { !$0.isFinal } }
    public var disabledReason: String? {
        guard api != nil else { return "Pair with your hub to control the crew." }
        guard mayControl() else { return "Crew controls need approver or owner access to this project." }
        guard !host.isEmpty else { return "No Mac is hosting this project's orchestrator" }
        return nil
    }

    public static func allowsControl(scopes: [Scope], project: String) -> Bool {
        scopes.contains { ($0.project == "*" || $0.project == project) && ["approver", "owner"].contains($0.role) }
    }

    public static func spec(for peer: Peer) -> String { String(peer.session.split(separator: ":").first ?? "") }

    public static func validSpec(_ spec: String) -> Bool {
        guard let range = spec.range(of: "^[a-z][a-z0-9-]{0,30}(:[A-Za-z0-9._/-]{1,80})?$", options: .regularExpression),
              range == spec.startIndex..<spec.endIndex else { return false }
        return spec.split(separator: ":").first != "claude"
    }

    public static func state(for peer: Peer) -> String {
        if peer.status.hasPrefix("down") || ["down", "errored"].contains(peer.health) { return "down" }
        if peer.status == "stale" || peer.health == "stale" { return "stale" }
        if !peer.online { return "stale" }
        return peer.status == "working" ? "working" : "idle"
    }

    public func refresh() async {
        guard let api else { return }
        let current = generation
        do {
            async let incomingRoster = api.crewRoster()
            async let incomingChat = api.chat(project: project, after: -1)
            let (incoming, snapshot) = try await (incomingRoster, incomingChat)
            guard current == generation else { return }
            host = snapshot.host
            roster = (incoming.first { $0.machine == host }?.seats ?? []).filter { Self.validSpec($0.agent) }
                .map { seat in
                    var seat = seat
                    if seat.spec.isEmpty || !Self.validSpec(seat.spec) {
                        seat.available = false
                        seat.reason = "Can't launch this seat from the phone"
                    }
                    return seat
                }
                .reduce(into: [String: RosterSeat]()) { $0[$1.agent] = $1 }.values.sorted { $0.agent < $1.agent }
            freshness.fresh()
        } catch { if current == generation { freshness.failed(DecisionsStore.describe(error)) } }
        if current == generation { await fleet.refresh() }
    }

    public func needsCostConfirmation(seats: [String]) -> Bool {
        seats.contains { spec in roster.first { $0.launchSpec == spec }?.metered ?? true }
    }

    private func validate(action: CrewAction, seats: [String], from: String?, to: String?, costConfirmed: Bool) -> String? {
        guard seats.count <= 6, Set(seats).count == seats.count, seats.allSatisfy(Self.validSpec) else {
            return "Choose up to six valid seats."
        }
        let targets: [String]
        switch action {
        case .up:
            guard !seats.isEmpty, from == nil, to == nil else { return "Choose at least one seat to add." }
            targets = seats
        case .down:
            guard from == nil, to == nil else { return "Choose the seats to stop." }
            targets = []
        case .swap:
            guard seats.isEmpty, let from, let to, Self.validSpec(from), Self.validSpec(to), from != to else {
                return "Choose a different valid replacement seat."
            }
            targets = [to]
        }
        for spec in targets {
            guard let seat = roster.first(where: { $0.launchSpec == spec }) else { return "Refresh the roster before choosing a seat." }
            guard seat.available else { return seat.reason.isEmpty ? "\(seat.agent) is unavailable on the Mac." : seat.reason }
        }
        if needsCostConfirmation(seats: targets), !costConfirmed { return "This seat costs money per token" }
        return nil
    }

    @discardableResult
    public func command(_ action: CrewAction, seats: [String] = [], from: String? = nil, to: String? = nil,
                        costConfirmed: Bool = false) async -> Bool {
        guard !busy else { return false }
        error = disabledReason ?? validate(action: action, seats: seats, from: from, to: to, costConfirmed: costConfirmed)
        guard error == nil, let api else { return false }
        sending = true
        let current = generation
        defer { sending = false }
        let authenticated = requiresAuthentication() ? await authenticator.authenticate() : true
        guard current == generation else { return false }
        guard authenticated, !Task.isCancelled else { error = "Not confirmed"; return false }
        error = disabledReason ?? validate(action: action, seats: seats, from: from, to: to, costConfirmed: costConfirmed)
        guard error == nil else { return false }
        do {
            let receipt = try await api.crewCommand(project: project, action: action, seats: seats, from: from, to: to)
            guard current == generation else { return false }
            try accept(receipt)
            if receipt.isFinal { await fleet.refresh() } else { startPolling() }
            return true
        } catch let failure as HubError where failure.isConnectivity {
            let op: String?
            switch failure { case .offline(let id), .timeout(let id): op = id; default: op = nil }
            let result = if let op { try? await api.reconcile(op: op) } else { nil as OpOutcome? }
            guard current == generation else { return false }
            if let result, result.isCommitted,
               let data = try? JSONEncoder().encode(result.body),
               let receipt = try? JSONDecoder().decode(CrewCommandStatus.self, from: data),
               (try? accept(receipt)) != nil {
                if receipt.isFinal { await fleet.refresh() } else { startPolling() }
                return true
            }
            error = result?.isRejected == true ? result?.body["error"]?.stringValue :
                "Delivery is unconfirmed. Check the crew on your Mac before trying again."
        } catch { if current == generation { self.error = DecisionsStore.describe(error) } }
        return false
    }

    private func accept(_ receipt: CrewCommandStatus) throws {
        guard !receipt.id.isEmpty, ["queued", "claimed", "done", "failed", "expired"].contains(receipt.status) else {
            throw HubError.decoding("Missing or unknown crew command receipt")
        }
        commands.insert(receipt, at: 0)
        commands = Array(commands.prefix(20))
    }

    private func startPolling() {
        guard polling == nil else { return }
        polling = Task { [weak self] in
            while !Task.isCancelled {
                do { try await Task.sleep(for: .seconds(2)) } catch { break }
                guard let self else { break }
                await self.refreshCommands()
                if !self.commands.contains(where: { !$0.isFinal }) { break }
            }
            self?.polling = nil
        }
    }

    public func refreshCommands() async {
        guard let api, !checking else { return }
        checking = true
        defer { checking = false }
        let current = generation
        for command in commands where !command.isFinal {
            do {
                var receipt = try await api.crewCommandStatus(id: command.id)
                guard current == generation, !Task.isCancelled else { return }
                guard receipt.id == command.id else { throw HubError.decoding("Crew command receipt did not match") }
                if !["queued", "claimed", "done", "failed", "expired"].contains(receipt.status) {
                    receipt = CrewCommandStatus(id: command.id, status: "failed", error: "The hub returned an unknown crew command status.")
                }
                if let index = commands.firstIndex(where: { $0.id == receipt.id }) { commands[index] = receipt }
                error = nil
                if receipt.isFinal { await fleet.refresh() }
            } catch HubError.notFound {
                guard current == generation else { return }
                if let index = commands.firstIndex(where: { $0.id == command.id }) {
                    commands[index] = CrewCommandStatus(id: command.id, status: "failed", error: "This command receipt is no longer available. Check the crew on your Mac.")
                }
                await fleet.refresh()
            } catch { if current == generation { self.error = DecisionsStore.describe(error) } }
        }
    }

    public func disconnect() {
        generation += 1
        polling?.cancel(); polling = nil
        api = nil; host = ""; roster = []; commands = []; error = nil
    }
}
