// swift-tools-version: 6.2
import PackageDescription

// The macOS application. TermKit is the client of the core's terminal
// protocol and the models behind the window, without any UI; App draws them
// with AppKit and Ghostty's renderer (scripts/fetch-ghostty.sh puts the
// pinned package into .deps/). SwiftPM builds and tests it for development;
// the application that ships is built by Xcode from xcode/project.yml.
let package = Package(
    name: "MacApp",
    defaultLocalization: "en",
    platforms: [.macOS(.v13)],
    products: [
        .library(name: "TermKit", targets: ["TermKit"]),
    ],
    dependencies: [
        .package(path: ".deps/libghostty-spm"),
    ],
    targets: [
        .target(name: "TermKit", swiftSettings: [.swiftLanguageMode(.v5)]),
        .executableTarget(
            name: "App",
            dependencies: ["TermKit", .product(name: "GhosttyTerminal", package: "libghostty-spm")],
            resources: [.process("Resources")],
            swiftSettings: [.swiftLanguageMode(.v5)]
        ),
        .testTarget(name: "TermKitTests", dependencies: ["TermKit"], swiftSettings: [.swiftLanguageMode(.v5)]),
    ]
)
