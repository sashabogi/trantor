import SwiftUI

/// Scrolling screens span the fold; this keeps a fixed control right of an active vertical one (#12347).
struct DuoFoldClear: ViewModifier {
    @State private var inset: CGFloat = 0

    func body(content: Content) -> some View {
        if #available(iOS 27.1, *) {
            content
                .padding(.leading, inset)
                .onGeometryChange(for: CGFloat.self) { proxy in
                    let divisions = proxy.reservedRegions(kind: .division, layoutDirectionBehavior: .fixed).map { region in
                        CGRect(x: region.frame.minX - region.margins.leading,
                               y: region.frame.minY - region.margins.top,
                               width: region.frame.width + region.margins.leading + region.margins.trailing,
                               height: region.frame.height + region.margins.top + region.margins.bottom)
                    }
                    return duoFoldClearInset(width: proxy.size.width, divisions: divisions)
                } action: { inset = $0 }
        } else {
            content
        }
    }
}

func duoFoldClearInset(width: CGFloat, divisions: [CGRect]) -> CGFloat {
    divisions.filter { $0.height > $0.width && $0.minX < width && $0.maxX > 0 }.map(\.maxX).max() ?? 0
}
