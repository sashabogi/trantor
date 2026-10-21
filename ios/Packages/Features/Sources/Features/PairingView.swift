import SwiftUI
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
        Form {
            Section {
                Text("Pair this device with your Trantor hub. On the Mac, create an invite; it gives a hub address and a one-time token. Opening a trantor://enroll link fills both in.")
                    .font(.callout)
                    .foregroundStyle(.secondary)
            }
            Section("Hub") {
                TextField("100.79.242.104:4477", text: $hub)
                    .textInputAutocapitalization(.never)
                    .autocorrectionDisabled()
                    .keyboardType(.URL)
                    .textContentType(.URL)
                TextField("Invite token", text: $token)
                    .textInputAutocapitalization(.never)
                    .autocorrectionDisabled()
                Button("Paste from clipboard") { pasteInvite() }
            }
            Section {
                TextField("Device name", text: $deviceName)
                    .textInputAutocapitalization(.never)
                    .autocorrectionDisabled()
            } header: {
                Text("This device")
            } footer: {
                Text("This is the name seats see when you message them. A new signing key is created and kept in this device's Keychain.")
            }
            Section {
                Button {
                    model.showPairingSummary = true
                    Task { await settings.pair(hub: hub, token: token, deviceName: deviceName) }
                } label: {
                    HStack {
                        Text("Pair")
                        if case .working = settings.pairing { Spacer(); ProgressView() }
                    }
                }
                .disabled(isWorking || hub.isEmpty || token.isEmpty)
            }
            status(settings.pairing)
        }
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
        case .working(let step): Section { Label(step, systemImage: "hourglass") }
        case .failed(let message): Section { Label(message, systemImage: "exclamationmark.triangle").foregroundStyle(.red) }
        case .paired(let health, let scopes):
            Section {
                Button("Continue") { model.showPairingSummary = false }.buttonStyle(.borderedProminent)
            }
            Section("Paired") {
                LabeledContent("Hub", value: health.ok ? "Reachable" : "Not healthy")
                LabeledContent("Auth mode", value: health.authMode.isEmpty ? "unknown" : health.authMode)
                LabeledContent("Seats online", value: String(health.peers))
                ForEach(scopes, id: \.self) { s in LabeledContent(s.project.isEmpty ? "All projects" : s.project, value: s.role) }
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
