import SwiftUI
import TrantorStore

public struct SettingsView: View {
    @Environment(AppModel.self) private var model
    @State private var confirmUnpair = false

    public init() {}

    public var body: some View {
        @Bindable var settings = model.settings
        Form {
            Section("Hub") {
                LabeledContent("Address", value: settings.hubURL?.absoluteString ?? "Not paired")
                LabeledContent("This device", value: settings.identityName.isEmpty ? "-" : settings.identityName)
                if let key = settings.publicKeyHex { LabeledContent("Public key", value: String(key.prefix(16)) + "...") }
                ForEach(settings.scopes, id: \.self) { s in
                    LabeledContent(s.project.isEmpty ? "Scope" : s.project, value: s.role)
                }
            }
            Section {
                Toggle("Holds", isOn: $settings.notifyHolds)
                Toggle("Proposals and verify gates", isOn: $settings.notifyProposals)
                Toggle("Messages to me", isOn: $settings.notifyMessages)
            } header: {
                Text("Notifications")
            } footer: {
                Text("Push needs hub support that is not live yet. These switches are saved for when it is.")
            }
            Section("Mute projects") {
                ForEach(model.projects.projects) { p in
                    Toggle(p.project, isOn: Binding(
                        get: { settings.mutedProjects.contains(p.project) },
                        set: { _ in settings.toggleMute(p.project) }))
                }
            }
            Section {
                Button("Pair again or remove this device", role: .destructive) { confirmUnpair = true }
            } footer: {
                Text("This deletes the key from this phone. The hub keeps the identity until an owner revokes it.")
            }
        }
        .navigationTitle("Settings")
        .confirmationDialog("Forget this hub?", isPresented: $confirmUnpair, titleVisibility: .visible) {
            Button("Forget and delete key", role: .destructive) { model.unpair() }
            Button("Cancel", role: .cancel) {}
        }
    }
}
