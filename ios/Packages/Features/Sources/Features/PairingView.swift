import SwiftUI
import TrantorDesign
import TrantorStore
import HubClient
import UIKit

public struct PairingView: View {
    @Environment(AppModel.self) private var model
    @Environment(\.scenePhase) private var scenePhase
    @State private var flow = OnboardingFlow()
    @State private var deviceName = SettingsStore.defaultDeviceName(UIDevice.current.model)
    @State private var pastedLink = ""
    @State private var showPaste = false
    @State private var scanMessage: String?
    @State private var brightHint = false
    @State private var torch = false
    @State private var hasTorch = false
    @State private var checking = false
    @State private var connectionFailed = false
    @State private var checkRevision = UUID()
    @State private var canOpenTailscale = false
    private let tailscaleURL = URL(string: "tailscale://")!

    public init() {}

    public var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: Space.lg) {
                BrandMark()
                Text(flow.step.title).font(.tTitle)
                page
            }
            .frame(maxWidth: 560, alignment: .leading)
            .frame(maxWidth: .infinity)
            .padding(Space.lg)
        }
        .scrollDismissesKeyboard(.interactively)
        .safeAreaInset(edge: .bottom, spacing: 0) { footer }
        .stage()
        .navigationTitle("Pair with Trantor")
        .navigationBarTitleDisplayMode(.inline)
        .toolbar {
            ToolbarItem(placement: .cancellationAction) {
                if flow.step != .welcome && flow.step != .done {
                    Button("Back") {
                        flow.back(); scanMessage = nil; checkRevision = UUID()
                    }.disabled(isWorking)
                } else if model.settings.isPaired && flow.step != .done {
                    Button("Cancel") { model.showPairingSummary = false }
                }
            }
        }
        .onAppear { applyPending(); refreshTailscaleAvailability() }
        .onChange(of: model.pendingLink) { _, _ in applyPending() }
        .onChange(of: scenePhase) { _, phase in
            if phase == .active { refreshTailscaleAvailability() }
        }
        .onChange(of: model.settings.pairing) { _, state in
            guard case .paired = state else { return }
            flow.paired()
            model.connect()
        }
        .task(id: checkKey) { await checkConnection() }
    }

    @ViewBuilder private var page: some View {
        switch flow.step {
        case .welcome:
            VStack(alignment: .leading, spacing: Space.md) {
                Text("Your fleet, within reach.").font(.tHeadline)
                // A known https invite reaches the hub over the internet; only tailnet hubs need this.
                if welcomeShowsTailscaleLine {
                    Text("Turn on Tailscale on this phone first.").font(.tCallout)
                }
                Text("On your Mac, open Pair Phone in Trantor to show an invite. We'll scan it, check the connection, and name this device.")
                    .font(.tCallout).foregroundStyle(Palette.text2)
            }.card(highlighted: true)
        case .scan:
            scanPage
        case .connect:
            Panel("Your hub") {
                Text(flow.invite?.hub ?? "").font(.tData).textSelection(.enabled)
                if checking {
                    HStack { ProgressView(); Text("Checking the connection…").font(.tCallout) }
                } else if flow.connected {
                    Label("Connected", systemImage: "checkmark.circle.fill").foregroundStyle(Palette.up)
                } else if connectionFailed {
                    Text(HubReachability.connectFailureCopy(forHub: flow.invite?.hub ?? ""))
                        .font(.tCallout).foregroundStyle(Palette.amber)
                }
                if canOpenTailscale, HubNetwork.needsTailscale(flow.invite?.hub ?? "") {
                    Button("Open Tailscale", systemImage: "arrow.up.forward.app") {
                        UIApplication.shared.open(tailscaleURL)
                    }.buttonStyle(.ghost)
                }
            }
        case .name:
            Panel("This device") {
                WellField("Device name", text: $deviceName, mono: true)
                    .textInputAutocapitalization(.never).autocorrectionDisabled()
                Text("This is the name seats see when you message them. Your signing key stays on this device.")
                    .font(.tCallout).foregroundStyle(Palette.text2)
                if case .working(let step) = model.settings.pairing {
                    HStack { ProgressView(); Text(step).font(.tCallout) }
                }
                if case .failed(let message) = model.settings.pairing {
                    Text(message).font(.tCallout).foregroundStyle(Palette.down)
                }
            }
        case .done:
            Panel("Paired", accessory: { Chip("Connected", color: Palette.up) }) {
                Detail(label: "Hub", text: model.settings.hubURL?.absoluteString ?? "", mono: true)
                Detail(label: "Device", text: model.settings.identityName, mono: true)
                ForEach(model.settings.scopes, id: \.self) { scope in
                    HStack {
                        Text(scope.project == "*" || scope.project.isEmpty ? "All projects" : scope.project).font(.tData)
                        Spacer()
                        Chip(scope.role, color: Palette.blue)
                    }
                }
            }
        }
    }

    private var scanPage: some View {
        VStack(alignment: .leading, spacing: Space.md) {
            if !showPaste && scenePhase == .active {
                InviteScanner(torch: torch, onScan: accept, onFailure: { scanMessage = $0 }, onTorchAvailable: { hasTorch = $0 })
                    .frame(height: 280).clipShape(RoundedRectangle(cornerRadius: Radius.md))
                    .task {
                        brightHint = false
                        do { try await Task.sleep(for: .seconds(3)) } catch { return }
                        brightHint = true
                    }
                Text(brightHint ? "Too bright: tilt the phone slightly" : "Hold steady about a hand's width away")
                    .font(.tCallout).foregroundStyle(Palette.text2)
                if hasTorch {
                    Button(torch ? "Turn torch off" : "Turn torch on", systemImage: torch ? "flashlight.on.fill" : "flashlight.off.fill") {
                        torch.toggle()
                    }.buttonStyle(.ghost)
                }
            }
            if showPaste {
                Text("Copy the invite on your Mac, then paste it here. Universal Clipboard works too.")
                    .font(.tCallout).foregroundStyle(Palette.text2)
                WellField("Invite link", text: $pastedLink, mono: true)
                    .textInputAutocapitalization(.never).autocorrectionDisabled().keyboardType(.URL)
                    .accessibilityIdentifier("onboarding.invite")
                PasteButton(payloadType: String.self) { strings in
                    guard let text = strings.first else { return }
                    pastedLink = text
                    accept(text)
                }.tint(Palette.accent)
                Button("Use camera", systemImage: "camera") { showPaste = false; scanMessage = nil }
                    .buttonStyle(.ghost)
            }
            if let scanMessage { Text(scanMessage).font(.tCallout).foregroundStyle(Palette.amber) }
        }
    }

    private var footer: some View {
        VStack(spacing: Space.md) {
            HStack(spacing: Space.sm) {
                ForEach(OnboardingStep.allCases, id: \.rawValue) { step in
                    Circle().fill(step == flow.step ? Palette.accent : Palette.textDim.opacity(0.4)).frame(width: 7, height: 7)
                }
            }
            .accessibilityElement(children: .ignore)
            .accessibilityLabel("Step \(flow.step.rawValue + 1) of 5: \(flow.step.title)")
            Button(action: primaryAction) {
                HStack { Text(primaryTitle); Spacer(); Image(systemName: "arrow.right") }
            }
            .buttonStyle(.primary)
            .disabled(primaryDisabled)
            .accessibilityIdentifier("onboarding.primary")
            .accessibilityLabel(primaryTitle)
        }
        .frame(maxWidth: 560)
        .frame(maxWidth: .infinity)
        .padding(Space.lg)
        .background(Palette.ground)
    }

    private var primaryTitle: String {
        switch flow.step {
        case .welcome: "Get started"
        case .scan: showPaste ? "Use invite link" : "Paste link instead"
        case .connect: checking ? "Checking…" : flow.connected ? "Continue" : "Retry"
        case .name: isWorking ? "Pairing…" : "Pair this device"
        case .done: "Open Decisions"
        }
    }

    private var primaryDisabled: Bool {
        isWorking || (flow.step == .connect && checking)
            || (flow.step == .name && deviceName.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
            || (flow.step == .scan && showPaste && pastedLink.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
    }

    private var isWorking: Bool { if case .working = model.settings.pairing { true } else { false } }
    private var checkKey: String { "\(flow.step.rawValue)-\(checkRevision)" }

    /// The Welcome page only tells people to turn on Tailscale when the invite (if one already
    /// arrived by deep link) is a tailnet hub — or when nothing is known yet.
    private var welcomeShowsTailscaleLine: Bool {
        guard let hub = flow.invite?.hub ?? model.pendingLink?.hub else { return true }
        return HubNetwork.needsTailscale(hub)
    }

    private func primaryAction() {
        switch flow.step {
        case .welcome: flow.begin()
        case .scan:
            if showPaste { accept(pastedLink) }
            else { showPaste = true; torch = false }
        case .connect:
            if flow.connected { flow.continueToName() }
            else { checkRevision = UUID() }
        case .name:
            guard let invite = flow.invite else { return }
            model.showPairingSummary = true
            Task { await model.settings.pair(hub: invite.hub, token: invite.token, deviceName: deviceName) }
        case .done:
            model.selection = .decisions
            model.showPairingSummary = false
        }
    }

    private func accept(_ text: String) {
        guard flow.accept(text) else {
            scanMessage = "That isn't a valid Trantor invite. Copy the full pairing link from your Mac."
            return
        }
        scanMessage = nil; torch = false; connectionFailed = false; checkRevision = UUID()
    }

    private func applyPending() {
        guard let link = model.pendingLink else { return }
        flow.accept(link)
        model.pendingLink = nil
        connectionFailed = false; checkRevision = UUID()
    }

    private func refreshTailscaleAvailability() { canOpenTailscale = UIApplication.shared.canOpenURL(tailscaleURL) }

    private func checkConnection() async {
        guard flow.step == .connect, let invite = flow.invite else { return }
        let revision = checkRevision
        checking = true; connectionFailed = false
        do {
            try await HubReachability.check(invite.hub)
            guard !Task.isCancelled, revision == checkRevision, flow.step == .connect else { return }
            flow.connectionResult(true)
        } catch {
            guard !Task.isCancelled, revision == checkRevision, flow.step == .connect else { return }
            flow.connectionResult(false); connectionFailed = true
        }
        checking = false
    }
}

#Preview("Pairing") {
    NavigationStack { PairingView() }.environment(DemoData.model()).trantorTheme()
}
