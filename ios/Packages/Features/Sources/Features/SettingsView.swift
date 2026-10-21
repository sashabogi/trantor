import SwiftUI
import TrantorDesign
import TrantorStore

public struct SettingsView: View {
    @Environment(AppModel.self) private var model
    @State private var confirmUnpair = false

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
                    Button("Pair again or remove this device", role: .destructive) { confirmUnpair = true }
                        .buttonStyle(.danger)
                    Text("This deletes the key from this device. The hub keeps the identity until an owner revokes it.")
                        .font(.tCaption).foregroundStyle(Palette.textDim)
                }
            }
            .padding(.horizontal, Space.lg).padding(.bottom, Space.xl)
        }
        .stage()
        .navigationTitle("Settings")
        .confirmationDialog("Forget this hub?", isPresented: $confirmUnpair, titleVisibility: .visible) {
            Button("Forget and delete key", role: .destructive) {
                Task { await model.unpair() }
            }
            Button("Cancel", role: .cancel) {}
        }
    }
}

#Preview("Settings") {
    NavigationStack { SettingsView() }.environment(DemoData.model()).trantorTheme()
}
