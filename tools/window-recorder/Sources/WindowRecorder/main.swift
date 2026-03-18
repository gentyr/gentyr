import Foundation
import ScreenCaptureKit
import AVFoundation
import CoreMedia
import CoreGraphics

// MARK: - CLI Argument Parsing

func parseArgs() -> (output: String, app: String, title: String?, fps: Int) {
    let args = CommandLine.arguments
    var output: String?
    var app = "Chrome for Testing"
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

func appendDiag(_ line: String) {
    let diagPath = config.output + ".diag"
    // Use String read+append+write instead of FileHandle (which silently returns nil in some contexts)
    if var existing = try? String(contentsOfFile: diagPath, encoding: .utf8) {
        existing += line
        try? existing.write(toFile: diagPath, atomically: false, encoding: .utf8)
    }
}

func findWindow(appName: String, titleSubstring: String?) async -> SCWindow? {
    let deadline = Date().addingTimeInterval(120)
    let targetBundleID = "com.google.chrome.for.testing"
    var pollCount = 0
    var existingWindowIDs: Set<UInt32>? = nil

    while Date() < deadline {
        do {
            let content = try await SCShareableContent.current
            pollCount += 1

            // On first poll, snapshot ALL window IDs (not just Chrome)
            if existingWindowIDs == nil {
                existingWindowIDs = Set(content.windows.map { $0.windowID })
                let chromeCount = content.windows.filter {
                    $0.owningApplication?.applicationName.localizedCaseInsensitiveContains(appName) == true
                }.count
                appendDiag("Snapshot: \(existingWindowIDs!.count) total windows (\(chromeCount) matching '\(appName)')\n")
            }

            // Detect genuinely NEW windows (any app) that appeared after snapshot
            let allCurrentIDs = Set(content.windows.map { $0.windowID })
            let newIDs = allCurrentIDs.subtracting(existingWindowIDs!)

            // Log new windows with bundleIdentifier to identify Playwright's browser
            if !newIDs.isEmpty {
                let newWindows = content.windows.filter { newIDs.contains($0.windowID) }
                let descriptions = newWindows.compactMap { w -> String? in
                    let name = w.owningApplication?.applicationName ?? "(nil)"
                    let bundleID = w.owningApplication?.bundleIdentifier ?? "(nil)"
                    return "\(name) [bundle:\(bundleID)] (\(Int(w.frame.width))x\(Int(w.frame.height))) [ID:\(w.windowID)]"
                }
                appendDiag("NEW windows at poll \(pollCount): \(descriptions.joined(separator: ", "))\n")
            }

            // Log all windows on first few polls for full diagnostics
            if pollCount <= 3 {
                let appNames = content.windows.compactMap { w -> String? in
                    guard let name = w.owningApplication?.applicationName else { return nil }
                    let bundleID = w.owningApplication?.bundleIdentifier ?? "?"
                    return "\(name) [bundle:\(bundleID)] (\(Int(w.frame.width))x\(Int(w.frame.height))) [ID:\(w.windowID)]"
                }
                appendDiag("poll \(pollCount): \(appNames.joined(separator: ", "))\n")
            }

            // Find the largest NEW matching window (skip pre-existing ones)
            // Prefer windows with the exact Chrome for Testing bundle ID
            var bestWindow: SCWindow? = nil
            var bestArea: CGFloat = 0
            var bestHasBundleMatch = false
            for window in content.windows {
                guard let ownerName = window.owningApplication?.applicationName else { continue }
                guard ownerName.localizedCaseInsensitiveContains(appName) else { continue }
                guard window.frame.width >= 100 && window.frame.height >= 100 else { continue }
                if existingWindowIDs?.contains(window.windowID) == true { continue }
                if let sub = titleSubstring {
                    guard let t = window.title, t.localizedCaseInsensitiveContains(sub) else { continue }
                }
                let hasBundleMatch = window.owningApplication?.bundleIdentifier == targetBundleID
                let area = window.frame.width * window.frame.height
                // Bundle-matched windows always win over non-bundle-matched
                if hasBundleMatch && !bestHasBundleMatch {
                    bestArea = area
                    bestWindow = window
                    bestHasBundleMatch = true
                } else if hasBundleMatch == bestHasBundleMatch && area > bestArea {
                    bestArea = area
                    bestWindow = window
                    bestHasBundleMatch = hasBundleMatch
                }
            }
            if let w = bestWindow {
                let bundleID = w.owningApplication?.bundleIdentifier ?? "?"
                appendDiag("MATCHED: \(w.owningApplication?.applicationName ?? "?") [bundle:\(bundleID)] - \(w.title ?? "(untitled)") (\(Int(w.frame.width))x\(Int(w.frame.height))) [ID:\(w.windowID)]\n")
                return w
            }

            // Only exclude non-matching-app new windows; keep target-app windows
            // eligible for re-evaluation (they may be too small now but resize later)
            if !newIDs.isEmpty {
                let nonTargetNewIDs = newIDs.filter { id in
                    guard let window = content.windows.first(where: { $0.windowID == id }) else { return true }
                    guard let ownerName = window.owningApplication?.applicationName else { return true }
                    return !ownerName.localizedCaseInsensitiveContains(appName)
                }
                if !nonTargetNewIDs.isEmpty {
                    existingWindowIDs = existingWindowIDs!.union(Set(nonTargetNewIDs))
                }
            }
        } catch {
            FileHandle.standardError.write(Data("Window discovery error: \(error.localizedDescription)\n".utf8))
        }
        try? await Task.sleep(nanoseconds: 100_000_000) // 100ms — fast discovery phase
    }
    appendDiag("FAILED: No NEW window matching app=\(appName) found after \(pollCount) polls\n")
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

// Write diagnostic file so the caller can tell if the binary even started
let diagPath = config.output + ".diag"
try? "started at \(Date()), app=\(config.app), pid=\(ProcessInfo.processInfo.processIdentifier)\n".write(toFile: diagPath, atomically: true, encoding: .utf8)
appendDiag("appendDiag OK, output=\(config.output)\n")

// Shared state for signal handling — must outlive the Task closure
let semaphore = DispatchSemaphore(value: 0)
var exitCode: Int32 = 0
var activeStream: SCStream?
var activeDelegate: RecorderDelegate?

// Set up SIGINT handler at module level so it stays alive
let signalQueue = DispatchQueue(label: "signal")
let sigintSource = DispatchSource.makeSignalSource(signal: SIGINT, queue: signalQueue)
signal(SIGINT, SIG_IGN)
sigintSource.setEventHandler {
    FileHandle.standardError.write(Data("\nStopping recording...\n".utf8))
    Task {
        if let stream = activeStream { try? await stream.stopCapture() }
        activeDelegate?.finalizeRecording()
        let fileSize = (try? FileManager.default.attributesOfItem(atPath: config.output)[.size] as? Int) ?? 0
        FileHandle.standardError.write(Data("Saved: \(config.output) (\(fileSize / 1024)KB)\n".utf8))
        semaphore.signal()
    }
}
sigintSource.resume()

Task {
    // Find the target window
    guard let window = await findWindow(appName: config.app, titleSubstring: config.title) else {
        FileHandle.standardError.write(Data("Error: No window found matching app=\"\(config.app)\"\(config.title.map { " title=\"\($0)\"" } ?? "") after 120s\n".utf8))
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
    activeDelegate = delegate

    // Create and start the stream (with timeout — startCapture hangs if permission is missing)
    do {
        let stream = SCStream(filter: filter, configuration: streamConfig, delegate: nil)
        try stream.addStreamOutput(delegate, type: .screen, sampleHandlerQueue: DispatchQueue(label: "recorder"))

        try await withThrowingTaskGroup(of: Void.self) { group in
            group.addTask { try await stream.startCapture() }
            group.addTask {
                try await Task.sleep(nanoseconds: 10_000_000_000)
                throw NSError(domain: "WindowRecorder", code: 1, userInfo: [
                    NSLocalizedDescriptionKey: "startCapture timed out — Screen Recording permission likely not granted"
                ])
            }
            try await group.next()
            group.cancelAll()
        }

        activeStream = stream
    } catch {
        FileHandle.standardError.write(Data("Error: Failed to start capture — \(error.localizedDescription)\n".utf8))
        FileHandle.standardError.write(Data("Grant Screen Recording permission in System Settings > Privacy & Security > Screen Recording\n".utf8))
        exitCode = 1
        semaphore.signal()
        return
    }

    FileHandle.standardError.write(Data("Recording started. Send SIGINT (Ctrl+C) to stop.\n".utf8))
}

semaphore.wait()
exit(exitCode)
