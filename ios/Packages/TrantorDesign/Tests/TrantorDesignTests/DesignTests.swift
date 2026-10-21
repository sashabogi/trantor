import SwiftUI
import UIKit
import XCTest
@testable import TrantorDesign

final class DesignTests: XCTestCase {
    func testBundledFontsRegister() {
        Fonts.register()
        for name in ["Geist-Regular", "Geist-SemiBold", "JetBrainsMono-Regular", "JetBrainsMono-Medium"] {
            XCTAssertNotNil(UIFont(name: name, size: 12), "\(name) did not register")
        }
    }

    func testHueIsStablePerName() {
        XCTAssertEqual(Palette.hue(for: "codex:trantor"), Palette.hue(for: "codex:trantor"))
    }

    func testTokensMatchIbkrStage() {
        // ibkr tokens.css: --ibkr-accent #3ef0c2, --ibkr-stage #0b1020
        let accent = UIColor(Palette.accent).cgColor.components ?? []
        XCTAssertEqual(accent[0], 0x3E / 255, accuracy: 0.002)
        XCTAssertEqual(accent[1], 0xF0 / 255, accuracy: 0.002)
        XCTAssertEqual(accent[2], 0xC2 / 255, accuracy: 0.002)
        let stage = UIColor(Palette.stage).cgColor.components ?? []
        XCTAssertEqual(stage[2], 0x20 / 255, accuracy: 0.002)
    }
}
