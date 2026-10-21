import SwiftUI
import TrantorDesign
import TrantorStore
import UIKit

public struct PairingView: View {
    @Environment(AppModel.self) private var model
    @State private var hub = ""
    @State private var token = ""
    @State private var deviceName = SettingsStore.defaultDeviceName(UIDevice.current.model)

    public init() {}

    public var body: some View {
        let settings = model.settings
        ScrollView {
            LazyVStack(alignment: .leading, spacing: Space.md) {
                VStack(alignment: .leading, spacing: Space.md) {
                    BrandMark()
                    Text("Your fleet, within reach.").font(.tTitle)
                    Text("Pair this device with your Trantor hub. On the Mac, create an invite; it gives a hub address and a one-time token. Opening a trantor://enroll link fills both in.")
                        .font(.tCallout).foregroundStyle(Palette.text2)
                }.card(highlighted: true)
                Panel("Hub") {
                    Eyebrow("Address")
                    WellField("Hub address", text: $hub, mono: true)
                        .textInputAutocapitalization(.never).autocorrectionDisabled()
                        .keyboardType(.URL).textContentType(.URL)
                    Eyebrow("Invite token")
                    WellField("Invite token", text: $token, mono: true)
                        .textInputAutocapitalization(.never).autocorrectionDisabled()
                    Button("Paste from clipboard", systemImage: "doc.on.clipboard") { pasteInvite() }
                        .buttonStyle(.ghost)
                }
                Panel("This device") {
                    WellField("Device name", text: $deviceName, mono: true)
                        .textInputAutocapitalization(.never).autocorrectionDisabled()
                    Text("This is the name seats see when you message them. A new signing key is created and kept in this device's Keychain.")
                        .font(.tCaption).foregroundStyle(Palette.textDim)
                }
                Button {
                    model.showPairingSummary = true
                    Task { await settings.pair(hub: hub, token: token, deviceName: deviceName) }
                } label: {
                    HStack(spacing: Space.sm) {
                        Text("Pair")
                        if case .working = settings.pairing { ProgressView().tint(Palette.onAccent) }
                        else { Image(systemName: "arrow.right") }
                    }
                }
                .buttonStyle(.primary)
                .disabled(isWorking || hub.isEmpty || token.isEmpty)
                status(settings.pairing)
            }
            .padding(.horizontal, Space.lg).padding(.bottom, Space.xl)
        }
        .stage()
        .navigationTitle("Pair with Trantor")
        .toolbar {
            if settings.isPaired, !isPairedNow {
                ToolbarItem(placement: .cancellationAction) { Button("Cancel") { model.showPairingSummary = false } }
            }
        }
        .onChange(of: settings.pairing) { _, state in
            if case .paired = state {
                model.connect()
                Task { await model.refreshAll(); model.startFeed() }
            } else if case .failed = state, !settings.isPaired {
                model.showPairingSummary = false
            }
        }
        .onAppear { applyPending() }
        .onChange(of: model.pendingLink) { _, _ in applyPending() }
    }

    private var isPairedNow: Bool { if case .paired = model.settings.pairing { return true } else { return false } }
    private var isWorking: Bool { if case .working = model.settings.pairing { return true } else { return false } }

    @ViewBuilder private func status(_ state: PairingState) -> some View {
        switch state {
        case .idle: EmptyView()
        case .working(let step):
            HStack(spacing: Space.sm) {
                ProgressView().tint(Palette.accent)
                Text(step).font(.tCallout).foregroundStyle(Palette.text2)
            }.card()
        case .failed(let message):
            Label(message, systemImage: "exclamationmark.triangle").font(.tCallout).foregroundStyle(Palette.down).card()
        case .paired(let health, let scopes):
            Panel("Paired", accessory: { Chip(health.ok ? "reachable" : "not healthy", color: health.ok ? Palette.up : Palette.amber) }) {
                Detail(label: "Auth", text: health.authMode.isEmpty ? "unknown" : health.authMode, mono: true)
                HStack { Eyebrow("Seats online"); Spacer(); Mono(String(health.peers)) }
                ForEach(scopes, id: \.self) { scope in
                    HStack {
                        Text(scope.project.isEmpty ? "All projects" : scope.project).font(.tData)
                        Spacer()
                        Chip(scope.role, color: Palette.blue)
                    }
                }
                Button("Continue", systemImage: "arrow.right") { model.showPairingSummary = false }.buttonStyle(.primary)
            }
        }
    }

    private func pasteInvite() {
        guard let text = UIPasteboard.general.string?.trimmingCharacters(in: .whitespacesAndNewlines) else { return }
        if let url = URL(string: text), let link = PairingLink.parse(url) { hub = link.hub; token = link.token }
        else { token = text }
    }

    private func applyPending() {
        guard let link = model.pendingLink else { return }
        hub = link.hub; token = link.token
        model.pendingLink = nil
    }
}

#Preview("Pairing") {
    NavigationStack { PairingView() }.environment(DemoData.model()).trantorTheme()
}
