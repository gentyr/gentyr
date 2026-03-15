// swift-tools-version: 5.9
import PackageDescription

let package = Package(
    name: "WindowRecorder",
    platforms: [.macOS(.v13)],
    targets: [
        .executableTarget(
            name: "WindowRecorder",
            path: "Sources/WindowRecorder",
            linkerSettings: [
                .linkedFramework("ScreenCaptureKit"),
                .linkedFramework("AVFoundation"),
                .linkedFramework("CoreMedia"),
                .linkedFramework("CoreVideo"),
                .linkedFramework("CoreGraphics"),
            ]
        ),
    ]
)
