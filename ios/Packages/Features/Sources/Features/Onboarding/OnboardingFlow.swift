import Foundation
import TrantorStore

enum OnboardingStep: Int, CaseIterable {
    case welcome, scan, connect, name, done

    var title: String {
        switch self {
        case .welcome: "Welcome"
        case .scan: "Scan your invite"
        case .connect: "Connect to your hub"
        case .name: "Name this device"
        case .done: "You're connected"
        }
    }
}

struct OnboardingFlow {
    private(set) var step: OnboardingStep = .welcome
    private(set) var invite: PairingLink?
    private(set) var connected = false

    mutating func begin() { step = .scan }

    @discardableResult
    mutating func accept(_ text: String) -> Bool {
        guard let link = InviteCode.parse(text) else { return false }
        accept(link)
        return true
    }

    mutating func accept(_ link: PairingLink) {
        invite = link
        connected = false
        step = .connect
    }

    mutating func connectionResult(_ reachable: Bool) {
        guard step == .connect else { return }
        connected = reachable
    }

    mutating func continueToName() {
        guard step == .connect, connected, invite != nil else { return }
        step = .name
    }

    mutating func paired() {
        guard step == .name else { return }
        step = .done
    }

    mutating func back() {
        switch step {
        case .welcome, .done: break
        case .scan: step = .welcome
        case .connect: step = .scan; connected = false
        case .name: step = .connect
        }
    }
}

enum InviteCode {
    static func parse(_ text: String) -> PairingLink? {
        let raw = text.trimmingCharacters(in: .whitespacesAndNewlines)
        guard let url = URL(string: raw),
              let parts = URLComponents(url: url, resolvingAgainstBaseURL: false),
              parts.queryItems?.filter({ $0.name == "hub" }).count == 1,
              parts.queryItems?.filter({ $0.name == "token" }).count == 1,
              let link = PairingLink.parse(url),
              !link.token.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty,
              let hub = URLComponents(string: link.hub),
              ["http", "https"].contains(hub.scheme?.lowercased() ?? ""),
              let host = hub.host, !host.isEmpty,
              hub.user == nil, hub.password == nil, hub.fragment == nil else { return nil }
        return link
    }
}

// AVCamBarcode's focus-distance calculation, with a 20 mm minimum code and the visible reticle width.
enum ScannerOptics {
    static func zoom(minimumFocusDistance: Double, fieldOfView: Double, reticleFraction: Double,
                     minimumZoom: Double, maximumZoom: Double) -> Double {
        guard minimumFocusDistance > 0, fieldOfView > 0, fieldOfView < 180, reticleFraction > 0 else { return minimumZoom }
        let subjectDistance = 20 / reticleFraction / (2 * tan(fieldOfView * .pi / 360))
        return min(maximumZoom, max(minimumZoom, minimumFocusDistance / subjectDistance))
    }
}
