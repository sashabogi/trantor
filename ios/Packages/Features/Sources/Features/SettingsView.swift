import HubClient
import SwiftUI
import TrantorDesign
import TrantorStore

public struct SettingsView: View {
    @Environment(AppModel.self) private var model
    @State private var confirmUnpair = false
    @State private var publicHub: URL?
    @State private var switchingHub = false
    @State private var hubSwitchFailed = false
    @State private var editingHub = false
    @State private var hubDraft = ""
    @State private var removing = false
    @Environment(\.dismiss) private var dismiss

    public init() {}

    public var body: some View {
        @Bindable var settings = model.settings
        ScrollView {
            LazyVStack(alignment: .leading, spacing: Space.md) {
                Panel("Hub") {
                    VStack(alignment: .leading, spacing: Space.sm) {
                        Eyebrow("Address")
                        Text(settings.hubURL?.absoluteString ?? "Not paired").font(.tData).foregroundStyle(Palette.text2)
                            .textSelection(.enabled).well()
                        if editingHub {
                            WellField("https://your-hub.ts.net", text: $hubDraft, mono: true)
                                .textInputAutocapitalization(.never).autocorrectionDisabled().keyboardType(.URL)
                                .accessibilityIdentifier("settings.hubField")
                            HStack(spacing: Space.sm) {
                                Button(switchingHub ? "Checking…" : "Connect") {
                                    if let url = SettingsStore.normalizeHub(hubDraft) { Task { await usePublicHub(url) } }
                                    else { hubSwitchFailed = true }
                                }
                                .buttonStyle(.primary).disabled(switchingHub || hubDraft.trimmingCharacters(in: .whitespaces).isEmpty)
                                Button("Cancel") { editingHub = false; hubSwitchFailed = false }.buttonStyle(.ghost)
                            }
                        } else if settings.isPaired {
                            Button("Change address", systemImage: "pencil") {
                                hubDraft = settings.knownPublicHub?.absoluteString ?? ""
                                editingHub = true
                            }
                            .buttonStyle(.action(.quiet, compact: true))
                            .accessibilityIdentifier("settings.changeHub")
                        }
                        if hubSwitchFailed {
                            Text("That address did not answer. Check it, or your connection, and try again.")
                                .font(.tCaption).foregroundStyle(Palette.amber)
                        }
                    }
                    if let publicHub {
                        Hairline()
                        VStack(alignment: .leading, spacing: Space.sm) {
                            Text("This hub also answers on the public internet — no Tailscale needed:")
                                .font(.tCallout).foregroundStyle(Palette.text2)
                            Text(publicHub.absoluteString).font(.tData).foregroundStyle(Palette.text2)
                                .textSelection(.enabled)
                            Button(switchingHub ? "Checking the public address…" : "Use the public address",
                                   systemImage: "network") { Task { await usePublicHub(publicHub) } }
                                .buttonStyle(.ghost).disabled(switchingHub)
                                .accessibilityIdentifier("settings.usePublicHub")
                        }
                    }
                    Hairline()
                    Eyebrow("This device")
                    SeatLine(seat: settings.identityName.isEmpty ? "Unpaired device" : settings.identityName, verb: "")
                    if let key = settings.publicKeyHex {
                        Detail(label: "Key", text: String(key.prefix(16)) + "…", mono: true)
                    }
                    ForEach(settings.scopes, id: \.self) { scope in
                        HStack {
                            if !scope.project.isEmpty { NameMark(scope.project, size: 22) }
                            Text(scope.project.isEmpty ? "All projects" : scope.project).font(.tData)
                            Spacer()
                            Chip(scope.role, color: Palette.blue)
                        }
                    }
                }
                Panel("Notifications") {
                    Toggle("Holds", isOn: $settings.notifyHolds)
                    Hairline()
                    Toggle("Proposals and verify gates", isOn: $settings.notifyProposals)
                    Hairline()
                    Toggle("Messages to me", isOn: $settings.notifyMessages)
                    Text("These switches are saved. Use project mutes below to control push notifications.")
                        .font(.tCaption).foregroundStyle(Palette.textDim)
                }
                Panel("Mute projects") {
                    if model.projects.projects.isEmpty {
                        Text("Your projects will appear here after pairing.").font(.tCallout).foregroundStyle(Palette.textDim)
                    }
                    ForEach(model.projects.projects) { project in
                        Toggle(isOn: Binding(
                            get: { settings.mutedProjects.contains(project.project) },
                            set: { _ in settings.toggleMute(project.project) })) {
                                HStack(spacing: Space.sm) {
                                    NameMark(project.project, size: 26)
                                    Text(project.project).font(.tData)
                                }
                            }
                    }
                }
                Panel("Device access") {
                    Toggle("Confirm decisions with Face ID or passcode", isOn: $settings.requireBiometrics)
                    Hairline()
                    Button(removing ? "Removing…" : "Pair again or remove this device", role: .destructive) { confirmUnpair = true }
                        .buttonStyle(.danger).disabled(removing)
                        .accessibilityIdentifier("settings.unpair")
                    Text("This deletes the key from this device. The hub keeps the identity until an owner revokes it.")
                        .font(.tCaption).foregroundStyle(Palette.textDim)
                }
            }
            .padding(.horizontal, Space.lg).padding(.bottom, Space.xl)
        }
        .stage()
        .navigationTitle("Settings")
        .task {
            // the remembered public address works even when the paired (tailnet) hub can't answer
            if let current = settings.hubURL, HubNetwork.needsTailscale(current), let known = settings.knownPublicHub {
                publicHub = known
            } else {
                publicHub = await model.publicHubURL()
            }
        }
        // an alert, not a confirmation dialog: the dialog did not reliably present inside this sheet
        .alert("Forget this hub?", isPresented: $confirmUnpair) {
            Button("Forget and delete key", role: .destructive) {
                removing = true
                Task {
                    await model.unpair()
                    removing = false
                    dismiss()
                }
            }
            Button("Cancel", role: .cancel) {}
        } message: {
            Text("This deletes the signing key from this phone. You can pair again right after.")
        }
    }

    /// Probe the public address first; the pairing only moves when it answers (same key, no re-pair).
    private func usePublicHub(_ url: URL) async {
        switchingHub = true; hubSwitchFailed = false
        defer { switchingHub = false }
        let moved = await model.switchHub(to: url) { try await HubReachability.check($0.absoluteString) }
        if moved {
            if url.scheme == "https" { model.settings.knownPublicHub = url }
            publicHub = nil; editingHub = false
            await model.refreshAll()
        } else { hubSwitchFailed = true }
    }
}

#Preview("Settings") {
    NavigationStack { SettingsView() }.environment(DemoData.model()).trantorTheme()
}
