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
                    #if DEBUG
                    await debugEnroll()
                    #endif
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

#if DEBUG
extension TrantorApp {
    /// Drills on the simulator: `-enroll <trantor://enroll link> [-name <device>]` pairs without the
    /// system "Open in Trantor?" prompt, which nothing can tap from the command line.
    @MainActor func debugEnroll() async {
        let args = ProcessInfo.processInfo.arguments
        // -tab <section>: open on a screen (decisions, projects, feed, inbox, fleet, cost, settings)
        if let t = args.firstIndex(of: "-tab"), t + 1 < args.count, let section = AppSection(rawValue: args[t + 1]) {
            model.selection = section
        }
        guard let i = args.firstIndex(of: "-enroll"), i + 1 < args.count,
              let url = URL(string: args[i + 1]), let link = PairingLink.parse(url) else { return }
        let name = args.firstIndex(of: "-name").flatMap { $0 + 1 < args.count ? args[$0 + 1] : nil } ?? "ios-sim"
        if model.settings.isPaired { model.unpair() }
        await model.settings.pair(hub: link.hub, token: link.token, deviceName: name)
        if model.settings.isPaired { model.connect() }
    }
}
#endif
