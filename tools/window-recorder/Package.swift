// swift-tools-version: 5.9
import PackageDescription

let package = Package(
    name: "WindowRecorder",
    platforms: [.macOS(.v13)],
    targets: [
        .executableTarget(
            name: "WindowRecorder",
            path: "Sources/WindowRecorder",
            exclude: ["Info.plist"],
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
// Note: The binary is codesigned with --identifier com.gentyr.window-recorder
// by sync.js step 7b after building. This gives macOS TCC a stable identifier
// to persist Screen Recording grants across rebuilds.
