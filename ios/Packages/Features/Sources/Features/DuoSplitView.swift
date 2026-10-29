import SwiftUI
import UIKit

private struct DuoTypingKey: EnvironmentKey { static let defaultValue = false }
private struct DuoCompactPortraitKey: EnvironmentKey { static let defaultValue = false }
private struct DuoComposingKey: EnvironmentKey { static let defaultValue: Binding<Bool>? = nil }

extension EnvironmentValues {
    var duoComposing: Binding<Bool>? {
        get { self[DuoComposingKey.self] }
        set { self[DuoComposingKey.self] = newValue }
    }
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
    @State private var keyboardFrame = CGRect.zero
    @ViewBuilder var leading: () -> Leading
    @ViewBuilder var detail: () -> Detail

    var body: some View {
        GeometryReader { geometry in
            let division = geometry.reservedRegions(kind: .division, options: .includeInactive, layoutDirectionBehavior: .fixed).first
            let horizontal = division.map { $0.frame.height > $0.frame.width } ?? (geometry.size.width > geometry.size.height)
            let compactPortrait = typing && !horizontal && division?.isActive != true
            let extent = horizontal ? geometry.size.width : geometry.size.height
            let fold = division.map { horizontal ? $0.frame.midX : $0.frame.midY }
            let ratio = fold.map { min(1, max(0, $0 / max(1, extent))) } ?? 0.5
            let overlap = typing ? geometry.frame(in: .global).intersection(keyboardFrame).height : 0
            let summaryRatio = min(0.5, 76 / max(1, geometry.size.height))
            ArrangementView {
                leading()
                    .environment(\.duoTyping, typing)
                    .environment(\.duoCompactPortrait, compactPortrait)
                    .padding(.bottom, horizontal ? overlap : 0)
                    .frame(maxWidth: .infinity, maxHeight: .infinity)
                    .splitArrangementLayoutRatio(compactPortrait ? summaryRatio : ratio)
            } secondary: {
                detail()
                    .environment(\.duoComposing, $typing)
                    .padding(.bottom, overlap)
                    .frame(maxWidth: .infinity, maxHeight: .infinity)
            }
            .arrangementViewStyle(.split)
        }
        // Keep the split's pose stable while making room for the keyboard inside its panes.
        .ignoresSafeArea(.keyboard, edges: .bottom)
        .onReceive(NotificationCenter.default.publisher(for: UIResponder.keyboardWillChangeFrameNotification)) { notification in
            keyboardFrame = notification.userInfo?[UIResponder.keyboardFrameEndUserInfoKey] as? CGRect ?? .zero
        }
        .onReceive(NotificationCenter.default.publisher(for: UIResponder.keyboardWillHideNotification)) { _ in keyboardFrame = .zero }
    }
}
