import CoreGraphics
import Foundation
import ScreenCaptureKit

struct ListedWindow: Encodable {
    let id: CGWindowID
    let pid: pid_t
    let appName: String
    let title: String
    let area: UInt64
}

// 台前调度会把正常窗口的 frame 缩到侧栏大小，甚至标记为不在屏幕上。
// 普通层窗口不能用 isOnScreen 或 80px 下限识别；非普通层仍排除小型状态项，
// 保留原先可以截取的大浮动面板/置顶窗口。
func listedWindowArea(title: String?, layer: Int, size: CGSize) -> UInt64? {
    guard let title, !title.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty,
          size.width.isFinite, size.height.isFinite,
          size.width > 0, size.height > 0 else { return nil }
    guard layer == 0 || (size.width >= 80 && size.height >= 80) else { return nil }
    let area = size.width * size.height
    guard area.isFinite, area < CGFloat(UInt64.max) else { return nil }
    return max(UInt64(area), 1)
}

@MainActor
func shareableWindowContent() async throws -> SCShareableContent {
    // 列表和截图只检查已有授权，不因后台枚举自动弹出权限请求。
    guard CGPreflightScreenCaptureAccess() else {
        throw RecorderError(message: "需要「屏幕录制」权限才能读取和截取窗口")
    }
    return try await SCShareableContent.excludingDesktopWindows(false, onScreenWindowsOnly: false)
}

@MainActor
func runWindowList() async throws {
    let content = try await shareableWindowContent()
    let windows = content.windows.compactMap { window -> ListedWindow? in
        guard window.windowID > 0, let application = window.owningApplication,
              application.processID > 0,
              let area = listedWindowArea(title: window.title, layer: window.windowLayer, size: window.frame.size) else { return nil }
        return ListedWindow(
            id: window.windowID, pid: application.processID,
            appName: application.applicationName, title: window.title ?? "", area: area
        )
    }
    FileHandle.standardOutput.write(try JSONEncoder().encode(windows))
}
