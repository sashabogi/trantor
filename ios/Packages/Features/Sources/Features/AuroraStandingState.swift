import SwiftUI
import TrantorCore
import TrantorDesign
import TrantorStore

/// Standing facts from the current snapshots; feed events never change the wash.
struct AuroraStandingState: Equatable {
    let waiting: Int
    let working: Int
    let idle: Int
    let failed: Int

    init(peers: [Peer], waiting: Int) {
        self.waiting = waiting
        failed = peers.filter(Self.hasFailed).count
        working = peers.filter { !Self.hasFailed($0) && $0.online && $0.status.hasPrefix("working") }.count
        idle = peers.filter { !Self.hasFailed($0) && $0.online && !$0.status.hasPrefix("working") }.count
    }

    var wash: AuroraState { AuroraState(hasWaiting: waiting > 0, hasFailed: failed > 0) }
    var headline: String {
        var counts: [String] = []
        if failed > 0 { counts.append("\(failed) failed") }
        if waiting > 0 { counts.append("\(waiting) waiting on you") }
        counts.append("\(working) working")
        counts.append("\(idle) idle")
        return counts.joined(separator: " · ")
    }

    static func hasFailed(_ peer: Peer) -> Bool {
        ["down", "errored", "failed"].contains(peer.health) ||
        ["down", "errored", "failed"].contains { peer.status.hasPrefix($0) }
    }

    static func caption(_ peer: Peer) -> String {
        let state = hasFailed(peer) ? "Failed" : peer.online ? "Online" : "Offline"
        return [state, peer.status, peer.model.isEmpty ? peer.llm : peer.model]
            .filter { !$0.isEmpty }.joined(separator: " · ")
    }
}

extension AppModel {
    func standingState(project: String? = nil, questions: Int = 0) -> AuroraStandingState {
        let peers = fleet.peers.filter { project == nil || $0.project == project }
        let pending = decisions.items.filter { project == nil || $0.project == project }.count
        return AuroraStandingState(peers: peers, waiting: pending + questions)
    }
}

/// Reused by the phone screens, with one wash behind the whole scrolling surface.
private struct AuroraScreen: ViewModifier {
    let state: AuroraState
    func body(content: Content) -> some View {
        content
            .frame(maxWidth: .infinity, maxHeight: .infinity)
            .background { AuroraBackground(state: state) }
            .foregroundStyle(Palette.text)
            .toolbarBackground(.hidden, for: .navigationBar)
    }
}

extension View {
    func auroraScreen(_ state: AuroraState) -> some View { modifier(AuroraScreen(state: state)) }
}
