// swift-tools-version: 5.10
import PackageDescription

let package = Package(
    name: "TrantorStore",
    platforms: [.iOS(.v17), .macOS(.v14)],
    products: [.library(name: "TrantorStore", targets: ["TrantorStore"])],
    dependencies: [.package(path: "../TrantorCore"), .package(path: "../HubClient")],
    targets: [
        .target(name: "TrantorStore", dependencies: ["TrantorCore", "HubClient"],
                swiftSettings: [.enableExperimentalFeature("StrictConcurrency")]),
        .testTarget(name: "TrantorStoreTests", dependencies: ["TrantorStore"]),
    ]
)
