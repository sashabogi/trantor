import Features
import SwiftUI
import TrantorDesign
import TrantorStore
import UIKit
import UserNotifications

@MainActor
final class AppDelegate: NSObject, UIApplicationDelegate {
    let model = ProcessInfo.processInfo.arguments.contains("-demo") ? DemoData.model() : AppModel()
    private let notifications = NotificationCoordinator()

    func application(_ application: UIApplication, didFinishLaunchingWithOptions launchOptions: [UIApplication.LaunchOptionsKey: Any]? = nil) -> Bool {
        notifications.model = model
        notifications.install()
        model.unregisterDevice = { [weak model] in
            guard let model else { return }
            try await PushRegistrar.unregisterFromHub(model: model)
        }
        return true
    }

    func application(_ application: UIApplication, didReceiveRemoteNotification userInfo: [AnyHashable: Any]) async -> UIBackgroundFetchResult {
        guard let clear = NotificationClear(userInfo: userInfo) else { return .noData }
        let center = UNUserNotificationCenter.current()
        let delivered = await center.deliveredNotifications()
        let identifiers = delivered.filter { clear.matches($0.request.content.userInfo) }.map { $0.request.identifier }
        center.removeDeliveredNotifications(withIdentifiers: identifiers)
        await model.decisions.refresh()
        try? await center.setBadgeCount(model.decisions.pendingCount)
        return model.decisions.freshness.isStale ? .failed : .newData
    }

    func application(_ application: UIApplication, didRegisterForRemoteNotificationsWithDeviceToken deviceToken: Data) {
        PushRegistrar.didRegister(deviceToken: deviceToken)
        Task { await PushRegistrar.registerWithHubIfPossible(model: model) }
    }

    func application(_ application: UIApplication, didFailToRegisterForRemoteNotificationsWithError error: Error) {
        PushRegistrar.didFail(error)
    }
}

@main
struct TrantorApp: App {
    @UIApplicationDelegateAdaptor(AppDelegate.self) private var appDelegate
    private var model: AppModel { appDelegate.model }

    init() {
        Appearance.install()
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
                    #if DEBUG
                    await debugEnroll()
                    #endif
                }
                .task(id: model.settings.isPaired) {
                    guard model.settings.isPaired else { return }
                    await PushRegistrar.requestAuthorizationAndRegister()
                    await PushRegistrar.registerWithHubIfPossible(model: model)
                }
                .task(id: model.settings.mutedProjects) {
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
        if model.settings.isPaired { await model.unpair() }
        await model.settings.pair(hub: link.hub, token: link.token, deviceName: name)
        if model.settings.isPaired { model.connect() }
    }
}
#endif
