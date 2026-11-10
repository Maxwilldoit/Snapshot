// 单帧截图复用录制 sidecar，但不还原窗口、不激活应用，也不请求辅助功能权限。
import AppKit
import CoreMedia
import CoreVideo
import ImageIO
import ScreenCaptureKit
import UniformTypeIdentifiers

struct ScreenshotArguments {
    let windowID: CGWindowID
    let includeCursor: Bool

    static func parse(_ values: [String]) throws -> ScreenshotArguments {
        var windowID: CGWindowID?
        var includeCursor = false
        var index = 1
        while index < values.count {
            switch values[index] {
            case "--screenshot": break
            case "--window-id":
                index += 1
                guard index < values.count, let value = UInt32(values[index]), value > 0 else {
                    throw RecorderError(message: "--window-id 缺少有效的窗口编号")
                }
                windowID = value
            case "--include-cursor": includeCursor = true
            default: throw RecorderError(message: "未知参数：\(values[index])")
            }
            index += 1
        }
        guard let windowID else { throw RecorderError(message: "缺少 --window-id") }
        return ScreenshotArguments(windowID: windowID, includeCursor: includeCursor)
    }
}

struct WindowPixelSize: Equatable {
    let width: Int
    let height: Int

    init(contentRect: CGRect, contentScale: CGFloat, scaleFactor: CGFloat) throws {
        // contentRect 是输出帧中的逻辑点；除以内容缩放，再乘 Retina 比例，
        // 才是完整窗口的原生像素尺寸。SCWindow.frame 可能只是台前调度的侧栏矩形。
        let width = (contentRect.size.width / contentScale * scaleFactor).rounded()
        let height = (contentRect.size.height / contentScale * scaleFactor).rounded()
        guard contentScale.isFinite, contentScale > 0,
              scaleFactor.isFinite, scaleFactor > 0,
              width.isFinite, height.isFinite,
              width >= 1, height >= 1,
              width <= 16_384, height <= 16_384, width * height <= 100_000_000 else {
            throw RecorderError(message: "目标窗口的截图尺寸无效或过大")
        }
        self.width = Int(width)
        self.height = Int(height)
    }
}

private let unavailableWindowFrame = "目标窗口暂无可用画面，若已最小化请先还原后重试"

@MainActor
private final class WindowSizeProbe: NSObject, SCStreamOutput, SCStreamDelegate {
    private var result: Result<WindowPixelSize, Error>?
    private var continuation: CheckedContinuation<WindowPixelSize, Error>?

    private func finish(_ value: Result<WindowPixelSize, Error>) {
        guard result == nil else { return }
        result = value
        continuation?.resume(with: value)
        continuation = nil
    }

    nonisolated func stream(
        _ stream: SCStream, didOutputSampleBuffer buffer: CMSampleBuffer,
        of outputType: SCStreamOutputType
    ) {
        guard outputType == .screen, buffer.isValid,
              let attachments = CMSampleBufferGetSampleAttachmentsArray(buffer, createIfNecessary: false)
                as? [[SCStreamFrameInfo: Any]], let info = attachments.first,
              let status = info[.status] as? Int else { return }
        if status == SCFrameStatus.suspended.rawValue || status == SCFrameStatus.blank.rawValue {
            Task { @MainActor in self.finish(.failure(RecorderError(message: unavailableWindowFrame))) }
            return
        }
        guard status == SCFrameStatus.complete.rawValue,
              let rawRect = info[.contentRect] as? [String: Any],
              let rect = CGRect(dictionaryRepresentation: rawRect as CFDictionary),
              let contentScale = info[.contentScale] as? CGFloat,
              let scaleFactor = info[.scaleFactor] as? CGFloat else { return }
        let size = Result { try WindowPixelSize(contentRect: rect, contentScale: contentScale, scaleFactor: scaleFactor) }
        Task { @MainActor in self.finish(size) }
    }

    nonisolated func stream(_ stream: SCStream, didStopWithError error: Error) {
        let message = "无感窗口采集失败：\(error.localizedDescription)"
        Task { @MainActor in self.finish(.failure(RecorderError(message: message))) }
    }

    func measure(filter: SCContentFilter) async throws -> WindowPixelSize {
        let configuration = screenshotConfiguration(width: 512, height: 512, includeCursor: false)
        let stream = SCStream(filter: filter, configuration: configuration, delegate: self)
        try stream.addStreamOutput(self, type: .screen, sampleHandlerQueue: .main)
        let timeout = Task { @MainActor in
            do { try await Task.sleep(nanoseconds: 3_000_000_000) } catch { return }
            finish(.failure(RecorderError(message: unavailableWindowFrame)))
        }
        defer { timeout.cancel() }
        do {
            try await stream.startCapture()
            let size = try await withCheckedThrowingContinuation { continuation in
                if let result { continuation.resume(with: result) }
                else { self.continuation = continuation }
            }
            try? await stream.stopCapture()
            return size
        } catch {
            try? await stream.stopCapture()
            throw error
        }
    }
}

func screenshotConfiguration(width: Int, height: Int, includeCursor: Bool) -> SCStreamConfiguration {
    let configuration = SCStreamConfiguration()
    configuration.width = width
    configuration.height = height
    configuration.pixelFormat = kCVPixelFormatType_32BGRA
    configuration.captureResolution = .best
    configuration.scalesToFit = false
    configuration.ignoreShadowsSingleWindow = true
    configuration.ignoreGlobalClipSingleWindow = true
    configuration.showsCursor = includeCursor
    configuration.capturesAudio = false
    configuration.queueDepth = 3
    return configuration
}

@MainActor
func runScreenshot(arguments: ScreenshotArguments) async throws {
    let content = try await shareableWindowContent()
    guard let window = content.windows.first(where: { $0.windowID == arguments.windowID }) else {
        throw RecorderError(message: "目标窗口已经关闭")
    }
    let filter = SCContentFilter(desktopIndependentWindow: window)
    let size = try await WindowSizeProbe().measure(filter: filter)
    let configuration = screenshotConfiguration(width: size.width, height: size.height, includeCursor: arguments.includeCursor)
    let image = try await SCScreenshotManager.captureImage(contentFilter: filter, configuration: configuration)
    let data = NSMutableData()
    guard let destination = CGImageDestinationCreateWithData(data, UTType.png.identifier as CFString, 1, nil) else {
        throw RecorderError(message: "无感窗口采集失败：无法创建 PNG 编码器")
    }
    CGImageDestinationAddImage(destination, image, nil)
    guard CGImageDestinationFinalize(destination) else {
        throw RecorderError(message: "无感窗口采集失败：无法编码 PNG")
    }
    // 一行 JSON 元数据 + 原始 PNG。图像只经管道传回宿主，不留临时截图。
    let header = try JSONSerialization.data(withJSONObject: [
        "appName": window.owningApplication?.applicationName ?? "应用",
        "width": image.width, "height": image.height,
    ], options: [.sortedKeys])
    FileHandle.standardOutput.write(header)
    FileHandle.standardOutput.write(Data([10]))
    FileHandle.standardOutput.write(data as Data)
}
