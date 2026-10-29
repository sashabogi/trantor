import SwiftUI

/// Keep the single-column controls on one side of an active fold. The system owns bar insets.
struct DuoContentBounds: ViewModifier {
    func body(content: Content) -> some View {
        if #available(iOS 27.1, *) {
            DuoContentRegion { content }
        } else {
            content
        }
    }
}

@available(iOS 27.1, *)
private struct DuoContentRegion<Content: View>: View {
    @Environment(\.toolbarVerticalEdge) private var toolbarEdge
    @ViewBuilder var content: () -> Content

    var body: some View {
        GeometryReader { geometry in
            let divisions = geometry.reservedRegions(kind: .division, layoutDirectionBehavior: .fixed).map { region in
                CGRect(x: region.frame.minX - region.margins.leading,
                       y: region.frame.minY - region.margins.top,
                       width: region.frame.width + region.margins.leading + region.margins.trailing,
                       height: region.frame.height + region.margins.top + region.margins.bottom)
            }
            let bounds = duoSingleColumnBounds(in: CGRect(origin: .zero, size: geometry.size),
                                               divisions: divisions, toolbarEdge: toolbarEdge)
            content()
                .frame(width: bounds.width, height: bounds.height)
                .position(x: bounds.midX, y: bounds.midY)
        }
    }
}

func duoSingleColumnBounds(in available: CGRect, divisions: [CGRect], toolbarEdge: HorizontalEdge?) -> CGRect {
    var result = available
    for division in divisions {
        // A flat display may report a zero-width fold; it still separates the two regions.
        guard division.maxX >= result.minX, division.minX <= result.maxX,
              division.maxY >= result.minY, division.minY <= result.maxY else { continue }
        if division.height > division.width {
            if toolbarEdge == .leading {
                result.size.width = max(0, min(result.maxX, division.minX) - result.minX)
            } else {
                let right = result.maxX
                result.origin.x = max(result.minX, division.maxX)
                result.size.width = max(0, right - result.minX)
            }
        } else {
            let bottom = result.maxY
            result.origin.y = max(result.minY, division.maxY)
            result.size.height = max(0, bottom - result.minY)
        }
    }
    return result
}
