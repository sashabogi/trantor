import Foundation
import HubClient
import TrantorStore
import UIKit
import UserNotifications

/// Gets the APNs token and, once the hub can take it, tells the hub.
/// The hub route (`POST /device/register`) is card #12114 and does not exist yet, so the upload is
/// switched off. Nothing here can crash the app: every failure is swallowed and logged.
enum PushRegistrar {
    /// Flip when #12114 ships `POST /device/register`.
    static let hubSupportsDeviceRegistration = false

    private static let tokenKey = "apnsTokenHex"

    static var storedToken: String? { UserDefaults.standard.string(forKey: tokenKey) }

    @MainActor static func requestAuthorizationAndRegister() async {
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

    @MainActor static func registerWithHubIfPossible(model: AppModel) async {
        guard hubSupportsDeviceRegistration, let token = storedToken,
              let api = model.settings.makeClient() as? HubAPI else { return }
        #if DEBUG
        let environment = "development"
        #else
        let environment = "production"
        #endif
        do {
            try await api.registerDevice(apnsToken: token, environment: environment, name: model.settings.identityName)
        } catch {
            NSLog("Trantor: device registration failed: \(error)")
        }
    }
}
