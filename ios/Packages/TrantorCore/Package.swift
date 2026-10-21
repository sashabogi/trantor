// swift-tools-version: 5.10
import PackageDescription

let package = Package(
    name: "TrantorCore",
    platforms: [.iOS(.v17), .macOS(.v14)],
    products: [.library(name: "TrantorCore", targets: ["TrantorCore"])],
    targets: [
        .target(name: "TrantorCore", swiftSettings: [.enableExperimentalFeature("StrictConcurrency")]),
        .testTarget(name: "TrantorCoreTests", dependencies: ["TrantorCore"]),
    ]
)
