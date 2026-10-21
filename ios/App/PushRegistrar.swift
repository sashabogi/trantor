import Foundation
import HubClient
import TrantorStore
import UIKit
import UserNotifications

@MainActor
enum PushRegistrar {
    private static var registration: Task<Void, Never>?
    private static let tokenKey = "apnsTokenHex"

    static var storedToken: String? { UserDefaults.standard.string(forKey: tokenKey) }

    static func requestAuthorizationAndRegister() async {
        let center = UNUserNotificationCenter.current()
        let granted = (try? await center.requestAuthorization(options: [.alert, .sound, .badge])) ?? false
        if granted { UIApplication.shared.registerForRemoteNotifications() }
    }

    static func didRegister(deviceToken: Data) {
        UserDefaults.standard.set(deviceToken.map { String(format: "%02x", $0) }.joined(), forKey: tokenKey)
    }

    static func didFail(_ error: Error) {
        // Expected in the simulator and before the App ID has the push capability. Not fatal.
        NSLog("Trantor: remote notification registration failed: \(error.localizedDescription)")
    }

    static func registerWithHubIfPossible(model: AppModel) async {
        guard !model.isUnpairing, let token = storedToken,
              let bundleId = Bundle.main.bundleIdentifier,
              let api = model.settings.makeClient() as? HubAPI else { return }
        #if DEBUG
        let environment = "sandbox"
        #else
        let environment = "production"
        #endif
        let previous = registration
        let name = model.settings.identityName
        let mutedProjects = model.settings.mutedProjects
        let task = Task {
            await previous?.value
            do {
                try await api.registerDevice(apnsToken: token, environment: environment, bundleId: bundleId,
                                             name: name, mutedProjects: mutedProjects)
            } catch {
                NSLog("Trantor: device registration failed: \(error)")
            }
        }
        registration = task
        await task.value
    }

    static func unregisterFromHub(model: AppModel) async throws {
        await registration?.value
        guard let token = storedToken, let api = model.settings.makeClient() as? HubAPI else { return }
        try await api.unregisterDevice(apnsToken: token)
    }
}
