import Foundation
import ScreenCaptureKit
import AVFoundation
import CoreMedia
import CoreGraphics

// MARK: - CLI Argument Parsing

func parseArgs() -> (output: String, app: String, title: String?, fps: Int) {
    let args = CommandLine.arguments
    var output: String?
    var app = "Chrome"
    var title: String?
    var fps = 25

    var i = 1
    while i < args.count {
        switch args[i] {
        case "--output":
            i += 1; if i < args.count { output = args[i] }
        case "--app":
            i += 1; if i < args.count { app = args[i] }
        case "--title":
            i += 1; if i < args.count { title = args[i] }
        case "--fps":
            i += 1; if i < args.count { fps = Int(args[i]) ?? 25 }
        default:
            break
        }
        i += 1
    }

    guard let outputPath = output else {
        FileHandle.standardError.write(Data("Usage: WindowRecorder --output <path> [--app <name>] [--title <substring>] [--fps <N>]\n".utf8))
        exit(1)
    }
    return (outputPath, app, title, fps)
}

// MARK: - Window Discovery

func findWindow(appName: String, titleSubstring: String?) async -> SCWindow? {
    let deadline = Date().addingTimeInterval(30)
    while Date() < deadline {
        do {
            let content = try await SCShareableContent.current
            for window in content.windows {
                guard let ownerName = window.owningApplication?.applicationName else { continue }
                guard ownerName.localizedCaseInsensitiveContains(appName) else { continue }
                guard window.isOnScreen || window.frame.width > 0 else { continue }
                if let sub = titleSubstring {
                    guard let t = window.title, t.localizedCaseInsensitiveContains(sub) else { continue }
                }
                return window
            }
        } catch {
            FileHandle.standardError.write(Data("Window discovery error: \(error.localizedDescription)\n".utf8))
        }
        try? await Task.sleep(nanoseconds: 500_000_000) // 500ms
    }
    return nil
}

// MARK: - Stream Output Delegate

class RecorderDelegate: NSObject, SCStreamOutput {
    let assetWriter: AVAssetWriter
    let videoInput: AVAssetWriterInput
    private var started = false

    init(assetWriter: AVAssetWriter, videoInput: AVAssetWriterInput) {
        self.assetWriter = assetWriter
        self.videoInput = videoInput
    }

    func stream(_ stream: SCStream, didOutputSampleBuffer sampleBuffer: CMSampleBuffer, of type: SCStreamOutputType) {
        guard type == .screen else { return }
        guard sampleBuffer.isValid else { return }

        // Skip frames without image data (idle/blank frames from ScreenCaptureKit)
        guard let attachments = CMSampleBufferGetSampleAttachmentsArray(sampleBuffer, createIfNecessary: false) as? [[SCStreamFrameInfo: Any]],
              let statusValue = attachments.first?[.status] as? Int,
              statusValue == 0  // SCFrameStatus.complete
        else { return }

        if !started {
            assetWriter.startWriting()
            assetWriter.startSession(atSourceTime: sampleBuffer.presentationTimeStamp)
            started = true
        }

        if videoInput.isReadyForMoreMediaData {
            videoInput.append(sampleBuffer)
        }
    }

    func finalizeRecording() {
        guard started else { return }
        videoInput.markAsFinished()
        let semaphore = DispatchSemaphore(value: 0)
        assetWriter.finishWriting {
            semaphore.signal()
        }
        semaphore.wait()
    }
}

// MARK: - Main

// Initialize CoreGraphics session — required for ScreenCaptureKit in CLI tools
// (GUI apps get this from NSApplication; CLI tools must call CGMainDisplayID explicitly)
let _ = CGMainDisplayID()

let config = parseArgs()

// Run async main
let semaphore = DispatchSemaphore(value: 0)
var exitCode: Int32 = 0

Task {
    // Find the target window
    guard let window = await findWindow(appName: config.app, titleSubstring: config.title) else {
        FileHandle.standardError.write(Data("Error: No window found matching app=\"\(config.app)\"\(config.title.map { " title=\"\($0)\"" } ?? "") after 30s\n".utf8))
        exitCode = 1
        semaphore.signal()
        return
    }

    let windowTitle = window.title ?? "(untitled)"
    let windowID = window.windowID
    FileHandle.standardError.write(Data("Recording window: \(windowTitle) (ID: \(windowID), \(Int(window.frame.width))x\(Int(window.frame.height)))\n".utf8))

    // Set up content filter for this specific window (captures even when occluded)
    let filter = SCContentFilter(desktopIndependentWindow: window)

    // Configure stream
    let streamConfig = SCStreamConfiguration()
    streamConfig.width = Int(window.frame.width) * 2  // Retina
    streamConfig.height = Int(window.frame.height) * 2
    streamConfig.minimumFrameInterval = CMTime(value: 1, timescale: CMTimeScale(config.fps))
    streamConfig.showsCursor = true
    streamConfig.pixelFormat = kCVPixelFormatType_32BGRA

    // Set up AVAssetWriter for H.264 MP4 output
    let outputURL = URL(fileURLWithPath: config.output)
    // Remove existing file if present
    try? FileManager.default.removeItem(at: outputURL)

    guard let assetWriter = try? AVAssetWriter(outputURL: outputURL, fileType: .mp4) else {
        FileHandle.standardError.write(Data("Error: Cannot create asset writer for \(config.output)\n".utf8))
        exitCode = 1
        semaphore.signal()
        return
    }

    let videoSettings: [String: Any] = [
        AVVideoCodecKey: AVVideoCodecType.h264,
        AVVideoWidthKey: streamConfig.width,
        AVVideoHeightKey: streamConfig.height,
        AVVideoCompressionPropertiesKey: [
            AVVideoAverageBitRateKey: 4_000_000,
            AVVideoProfileLevelKey: AVVideoProfileLevelH264HighAutoLevel,
        ],
    ]

    let videoInput = AVAssetWriterInput(mediaType: .video, outputSettings: videoSettings)
    videoInput.expectsMediaDataInRealTime = true
    assetWriter.add(videoInput)

    let delegate = RecorderDelegate(assetWriter: assetWriter, videoInput: videoInput)

    // Create and start the stream (with timeout — startCapture hangs if Screen Recording permission is missing)
    let stream: SCStream
    do {
        stream = SCStream(filter: filter, configuration: streamConfig, delegate: nil)
        try stream.addStreamOutput(delegate, type: .screen, sampleHandlerQueue: DispatchQueue(label: "recorder"))

        // Race startCapture against a 10s timeout — permission prompts can hang indefinitely
        try await withThrowingTaskGroup(of: Void.self) { group in
            group.addTask { try await stream.startCapture() }
            group.addTask {
                try await Task.sleep(nanoseconds: 10_000_000_000) // 10s
                throw NSError(domain: "WindowRecorder", code: 1, userInfo: [
                    NSLocalizedDescriptionKey: "startCapture timed out — Screen Recording permission likely not granted"
                ])
            }
            // Wait for whichever finishes first, cancel the other
            try await group.next()
            group.cancelAll()
        }
    } catch {
        FileHandle.standardError.write(Data("Error: Failed to start capture — \(error.localizedDescription)\n".utf8))
        FileHandle.standardError.write(Data("Grant Screen Recording permission in System Settings > Privacy & Security > Screen Recording\n".utf8))
        exitCode = 1
        semaphore.signal()
        return
    }

    FileHandle.standardError.write(Data("Recording started. Send SIGINT (Ctrl+C) to stop.\n".utf8))

    // Handle SIGINT for graceful shutdown
    // Use a dedicated queue — .main is blocked by semaphore.wait() and can't deliver events
    let signalQueue = DispatchQueue(label: "signal")
    let sigintSource = DispatchSource.makeSignalSource(signal: SIGINT, queue: signalQueue)
    signal(SIGINT, SIG_IGN) // Let DispatchSource handle it
    sigintSource.setEventHandler {
        FileHandle.standardError.write(Data("\nStopping recording...\n".utf8))
        Task {
            try? await stream.stopCapture()
            delegate.finalizeRecording()
            let fileSize = (try? FileManager.default.attributesOfItem(atPath: config.output)[.size] as? Int) ?? 0
            FileHandle.standardError.write(Data("Saved: \(config.output) (\(fileSize / 1024)KB)\n".utf8))
            semaphore.signal()
        }
    }
    sigintSource.resume()
}

semaphore.wait()
exit(exitCode)
