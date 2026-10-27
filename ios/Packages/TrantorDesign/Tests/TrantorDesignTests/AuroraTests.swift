import SwiftUI
import UIKit
import XCTest
@testable import TrantorDesign

final class AuroraTests: XCTestCase {
    func testStandingStatePrecedence() {
        XCTAssertEqual(AuroraState(hasWaiting: false, hasFailed: false), .clear)
        XCTAssertEqual(AuroraState(hasWaiting: true, hasFailed: false), .waiting)
        XCTAssertEqual(AuroraState(hasWaiting: false, hasFailed: true), .failed)
        XCTAssertEqual(AuroraState(hasWaiting: true, hasFailed: true), .failed)
    }

    /// Render real panels and text, plus solid foreground swatches to avoid measuring glyph antialiasing.
    @MainActor func testContrastSnapshots() throws {
        let lights: [(String, Color, Double)] = AuroraState.allCases.map {
            ($0.rawValue, Glow.primary($0), Glow.primaryStrength)
        } + [("secondary", Glow.secondary, Glow.secondaryStrength), ("tertiary", Glow.tertiary, Glow.tertiaryStrength)]
        for reduced in [false, true] {
            for (name, light, strength) in lights {
                for (role, foreground) in [("text", Palette.text), ("text2", Palette.text2)] {
                    let view = ZStack {
                        ZStack {
                            Palette.auroraGround
                            light.opacity(strength * (reduced ? 0.4 : 1))
                        }.drawingGroup(colorMode: .linear)
                        AuroraSurface(shape: Rectangle())
                        Text("Aurora \(role)").font(.ui(16)).foregroundStyle(foreground)
                        HStack { Spacer(); Rectangle().fill(foreground).frame(width: 24) }
                    }
                    .ignoresSafeArea()
                    .environment(\.auroraReduceTransparency, reduced)
                    .environment(\.colorScheme, .dark)
                    let renderer = ImageRenderer(content: view.frame(width: 240, height: 100))
                    renderer.scale = 1
                    let snapshot = try XCTUnwrap(renderer.uiImage)
                    let attachment = XCTAttachment(image: snapshot)
                    attachment.name = "\(name)-\(role)-\(reduced ? "solid" : "glass")"
                    attachment.lifetime = .keepAlways
                    add(attachment)
                    let background = try pixel(snapshot, x: 8, y: 8)
                    XCTAssertGreaterThan(background.reduce(0, +), 0.02, "Snapshot must contain the rendered surface")
                    let textColor = UIColor(foreground)
                    var red: CGFloat = 0, green: CGFloat = 0, blue: CGFloat = 0, alpha: CGFloat = 0
                    XCTAssertTrue(textColor.getRed(&red, green: &green, blue: &blue, alpha: &alpha))
                    let renderedText = try pixel(snapshot, x: 228, y: 50)
                    for (actual, expected) in zip(renderedText, [Double(red), Double(green), Double(blue)]) {
                        XCTAssertEqual(actual, expected, accuracy: 0.01, "Foreground swatch must render")
                    }
                    let ratio = (luminance(renderedText) + 0.05) / (luminance(background) + 0.05)
                    XCTAssertGreaterThanOrEqual(ratio, 4.5, "\(attachment.name): \(ratio):1")
                    if reduced {
                        let solid = UIColor(Palette.panel2)
                        solid.getRed(&red, green: &green, blue: &blue, alpha: &alpha)
                        for (actual, expected) in zip(background, [Double(red), Double(green), Double(blue)]) {
                            XCTAssertEqual(actual, expected, accuracy: 0.01)
                        }
                    }
                }
            }
        }
    }

    @MainActor func testPanelStaysDarkWithoutGlowInEitherHostScheme() throws {
        var samples: [[Double]] = []
        for scheme in [ColorScheme.light, .dark] {
            let view = ZStack {
                Palette.auroraGround
                AuroraSurface(shape: Rectangle(), stroke: Glass.waitingStroke, shadow: Glass.waitingShadow)
            }
            .frame(width: 100, height: 100)
            .environment(\.colorScheme, scheme)
            let renderer = ImageRenderer(content: view)
            renderer.scale = 1
            let snapshot = try XCTUnwrap(renderer.uiImage)
            let sample = try pixel(snapshot, x: 50, y: 50)
            XCTAssertGreaterThan(luminance(sample), 0.005, "Panel fill must remain visible")
            XCTAssertLessThan(luminance(sample), 0.03, "Unlit glass must stay near the navy ground")
            samples.append(sample)
        }
        for (light, dark) in zip(samples[0], samples[1]) {
            XCTAssertEqual(light, dark, accuracy: 0.01, "Host appearance must not lighten Aurora glass")
        }
    }

    private func pixel(_ image: UIImage, x: Int, y: Int) throws -> [Double] {
        let cg = try XCTUnwrap(image.cgImage)
        var bytes = [UInt8](repeating: 0, count: cg.width * cg.height * 4)
        let space = try XCTUnwrap(CGColorSpace(name: CGColorSpace.sRGB))
        let context = try XCTUnwrap(CGContext(data: &bytes, width: cg.width, height: cg.height,
                                            bitsPerComponent: 8, bytesPerRow: cg.width * 4, space: space,
                                            bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue))
        context.draw(cg, in: CGRect(x: 0, y: 0, width: cg.width, height: cg.height))
        let offset = (y * cg.width + x) * 4
        return (0..<3).map { Double(bytes[offset + $0]) / 255 }
    }

    private func luminance(_ rgb: [Double]) -> Double {
        let linear = rgb.map { $0 <= 0.04045 ? $0 / 12.92 : pow(($0 + 0.055) / 1.055, 2.4) }
        return linear[0] * 0.2126 + linear[1] * 0.7152 + linear[2] * 0.0722
    }
}
