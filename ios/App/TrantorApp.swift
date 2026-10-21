import Features
import SwiftUI
import TrantorDesign
import TrantorStore
import UIKit
import UserNotifications

final class AppDelegate: NSObject, UIApplicationDelegate {
    func application(_ application: UIApplication, didRegisterForRemoteNotificationsWithDeviceToken deviceToken: Data) {
        PushRegistrar.didRegister(deviceToken: deviceToken)
    }

    func application(_ application: UIApplication, didFailToRegisterForRemoteNotificationsWithError error: Error) {
        PushRegistrar.didFail(error)
    }
}

@main
struct TrantorApp: App {
    @UIApplicationDelegateAdaptor(AppDelegate.self) private var appDelegate
    @State private var model: AppModel
    private let notifications = NotificationCoordinator()

    init() {
        Appearance.install()
        // -demo: canned fleet, no hub (screenshots, first look before pairing)
        _model = State(initialValue: ProcessInfo.processInfo.arguments.contains("-demo") ? DemoData.model() : AppModel())
    }

    var body: some Scene {
        WindowGroup {
            RootView()
                .environment(model)
                .trantorTheme()
                .onOpenURL { url in
                    // trantor://enroll?hub=...&token=...
                    if let link = PairingLink.parse(url) { model.pendingLink = link }
                }
                .task {
                    notifications.model = model
                    notifications.install()
                }
                .task(id: model.settings.isPaired) {
                    guard model.settings.isPaired else { return }
                    await PushRegistrar.requestAuthorizationAndRegister()
                    await PushRegistrar.registerWithHubIfPossible(model: model)
                }
                .onChange(of: model.decisions.pendingCount) { _, count in
                    UNUserNotificationCenter.current().setBadgeCount(count)
                }
        }
    }
}
