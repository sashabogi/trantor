import SwiftUI

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
    @Environment(\.toolbarVerticalEdge) private var toolbarEdge
    @ViewBuilder var leading: () -> Leading
    @ViewBuilder var detail: () -> Detail

    var body: some View {
        GeometryReader { geometry in
            let division = geometry.reservedRegions(kind: .division, layoutDirectionBehavior: .fixed).first
            let horizontal = division.map { $0.frame.height > $0.frame.width } ?? (toolbarEdge != nil)
            ArrangementView {
                leading().frame(maxWidth: .infinity, maxHeight: .infinity)
            } secondary: {
                detail().frame(maxWidth: .infinity, maxHeight: .infinity)
            }
            .arrangementViewStyle(.split.axes(horizontal ? .horizontal : .vertical))
        }
    }
}
