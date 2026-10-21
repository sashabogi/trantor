// swift-tools-version: 5.10
import PackageDescription

let package = Package(
    name: "Features",
    platforms: [.iOS(.v17)],
    products: [.library(name: "Features", targets: ["Features"])],
    dependencies: [
        .package(path: "../TrantorCore"), .package(path: "../HubClient"), .package(path: "../TrantorStore"),
    ],
    targets: [
        .target(name: "Features", dependencies: ["TrantorCore", "HubClient", "TrantorStore"],
                swiftSettings: [.enableExperimentalFeature("StrictConcurrency")]),
    ]
)
