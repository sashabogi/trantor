// swift-tools-version: 5.10
import PackageDescription

let package = Package(
    name: "TrantorDesign",
    platforms: [.iOS(.v17)],
    products: [.library(name: "TrantorDesign", targets: ["TrantorDesign"])],
    targets: [
        .target(name: "TrantorDesign", resources: [.copy("Fonts")],
                swiftSettings: [.enableExperimentalFeature("StrictConcurrency")]),
        .testTarget(name: "TrantorDesignTests", dependencies: ["TrantorDesign"]),
    ]
)
