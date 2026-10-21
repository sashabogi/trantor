// swift-tools-version: 5.10
import PackageDescription

let package = Package(
    name: "HubClient",
    platforms: [.iOS(.v17), .macOS(.v14)],
    products: [.library(name: "HubClient", targets: ["HubClient"])],
    dependencies: [.package(path: "../TrantorCore")],
    targets: [
        .target(name: "HubClient", dependencies: ["TrantorCore"],
                swiftSettings: [.enableExperimentalFeature("StrictConcurrency")]),
        .testTarget(name: "HubClientTests", dependencies: ["HubClient"]),
    ]
)
