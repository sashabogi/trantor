import SwiftUI
import UIKit

/// UIKit chrome (nav bars, tab bar, lists) in the stage palette. Call once at launch, after
/// `Fonts.register()`.
@MainActor
public enum Appearance {
    public static func install() {
        Fonts.register()

        let nav = UINavigationBarAppearance()
        nav.configureWithTransparentBackground()
        nav.backgroundEffect = UIBlurEffect(style: .systemChromeMaterialDark)
        nav.backgroundColor = UIColor(Palette.ground.opacity(0.55))
        nav.shadowColor = UIColor(Palette.hairline)
        nav.titleTextAttributes = [.foregroundColor: UIColor(Palette.text),
                                   .font: UIFont(name: "Geist-SemiBold", size: 16) ?? .systemFont(ofSize: 16, weight: .semibold)]
        nav.largeTitleTextAttributes = [.foregroundColor: UIColor(Palette.text),
                                        .font: UIFont(name: "Geist-SemiBold", size: 30) ?? .systemFont(ofSize: 30, weight: .semibold),
                                        .kern: -0.4]
        let scrolled = UINavigationBarAppearance()
        scrolled.configureWithTransparentBackground()
        scrolled.backgroundColor = .clear
        scrolled.titleTextAttributes = nav.titleTextAttributes
        scrolled.largeTitleTextAttributes = nav.largeTitleTextAttributes
        UINavigationBar.appearance().standardAppearance = nav
        UINavigationBar.appearance().compactAppearance = nav
        UINavigationBar.appearance().scrollEdgeAppearance = scrolled
        UINavigationBar.appearance().tintColor = UIColor(Palette.accent)

        let tab = UITabBarAppearance()
        tab.configureWithTransparentBackground()
        tab.backgroundEffect = UIBlurEffect(style: .systemChromeMaterialDark)
        tab.backgroundColor = UIColor(Palette.ground.opacity(0.7))
        tab.shadowColor = UIColor(Palette.line2)
        let item = UITabBarItemAppearance()
        let label = UIFont(name: "Geist-Medium", size: 10.5) ?? .systemFont(ofSize: 10.5, weight: .medium)
        item.normal.iconColor = UIColor(Palette.textDim)
        item.normal.titleTextAttributes = [.foregroundColor: UIColor(Palette.textDim), .font: label]
        item.selected.iconColor = UIColor(Palette.accent)
        item.selected.titleTextAttributes = [.foregroundColor: UIColor(Palette.accent), .font: label]
        item.normal.badgeBackgroundColor = UIColor(Palette.accent)
        item.normal.badgeTextAttributes = [.foregroundColor: UIColor(Palette.onAccent),
                                           .font: UIFont(name: "JetBrainsMono-SemiBold", size: 10) ?? .systemFont(ofSize: 10)]
        tab.stackedLayoutAppearance = item
        tab.inlineLayoutAppearance = item
        tab.compactInlineLayoutAppearance = item
        UITabBar.appearance().standardAppearance = tab
        UITabBar.appearance().scrollEdgeAppearance = tab

        UITableView.appearance().backgroundColor = .clear
        UICollectionView.appearance().backgroundColor = .clear
        UIRefreshControl.appearance().tintColor = UIColor(Palette.accent)
        UISegmentedControl.appearance().selectedSegmentTintColor = UIColor(Palette.raise)
        UISegmentedControl.appearance().setTitleTextAttributes([.foregroundColor: UIColor(Palette.text)], for: .selected)
        UISegmentedControl.appearance().setTitleTextAttributes([.foregroundColor: UIColor(Palette.textDim)], for: .normal)
        UISwitch.appearance().onTintColor = UIColor(Palette.accent)
    }
}

extension View {
    /// Applies the stage theme to a whole window: dark scheme, mint tint, Geist body text.
    public func trantorTheme() -> some View {
        self.preferredColorScheme(.dark)
            .tint(Palette.accent)
            .font(.tBody)
            .foregroundStyle(Palette.text)
    }
}
