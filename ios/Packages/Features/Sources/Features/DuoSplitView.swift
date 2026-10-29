import SwiftUI
import UIKit

private struct DuoTypingKey: EnvironmentKey { static let defaultValue = false }
private struct DuoCompactPortraitKey: EnvironmentKey { static let defaultValue = false }

extension EnvironmentValues {
    var duoTyping: Bool {
        get { self[DuoTypingKey.self] }
        set { self[DuoTypingKey.self] = newValue }
    }
    var duoCompactPortrait: Bool {
        get { self[DuoCompactPortraitKey.self] }
        set { self[DuoCompactPortraitKey.self] = newValue }
    }
}

/// The system split follows the display division and keeps both panes out of the crease.
struct DuoSplitView<Leading: View, Detail: View>: View {
    @ViewBuilder var leading: () -> Leading
    @ViewBuilder var detail: () -> Detail

    var body: some View {
        if #available(iOS 27.1, *) {
            DuoArrangement(leading: leading, detail: detail)
        } else {
            HStack(spacing: 0) {
                leading().frame(maxWidth: .infinity)
                detail().frame(maxWidth: .infinity)
            }
        }
    }
}

@available(iOS 27.1, *)
private struct DuoArrangement<Leading: View, Detail: View>: View {
    @State private var typing = false
    @ViewBuilder var leading: () -> Leading
    @ViewBuilder var detail: () -> Detail

    var body: some View {
        GeometryReader { geometry in
            let division = geometry.reservedRegions(kind: .division, options: .includeInactive, layoutDirectionBehavior: .fixed).first
            let horizontal = division.map { $0.frame.height > $0.frame.width } ?? (geometry.size.width > geometry.size.height)
            let compactPortrait = typing && !horizontal && division?.isActive != true
            ArrangementView {
                leading().frame(maxWidth: .infinity, maxHeight: .infinity)
                    .environment(\.duoTyping, typing)
                    .environment(\.duoCompactPortrait, compactPortrait)
                    .splitArrangementLayoutRatio(compactPortrait ? 0.18 : 0.5)
            } secondary: {
                detail().frame(maxWidth: .infinity, maxHeight: .infinity)
            }
            .arrangementViewStyle(.split)
        }
        .onReceive(NotificationCenter.default.publisher(for: UIResponder.keyboardWillShowNotification)) { _ in typing = true }
        .onReceive(NotificationCenter.default.publisher(for: UIResponder.keyboardWillHideNotification)) { _ in typing = false }
    }
}
