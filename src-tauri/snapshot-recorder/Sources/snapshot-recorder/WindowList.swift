import CoreGraphics
import Foundation
import ScreenCaptureKit

struct ListedWindow: Encodable {
    let id: CGWindowID
    let pid: pid_t
    let appName: String
    let title: String
    let area: UInt64
    /// 前后顺序（0 = 最前面）。选择器按它排，最近用过的窗口在上面。
    let order: Int
    /// 最小化到程序坞的窗口（经辅助功能确认）。截取时会临时还原。
    var minimized: Bool = false
}

// 台前调度会把正常窗口的 frame 缩到侧栏大小，甚至标记为不在屏幕上。
// 普通层窗口不能用 isOnScreen 或 80px 下限识别；非普通层仍排除小型状态项，
// 保留原先可以截取的大浮动面板/置顶窗口。
func listedWindowArea(title: String?, layer: Int, size: CGSize) -> UInt64? {
    guard let title, !title.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty,
          size.width.isFinite, size.height.isFinite,
          size.width > 0, size.height > 0 else { return nil }
    // 普通层之外只留浮动/面板这几层（kCGFloatingWindowLevel…kCGModalPanelWindowLevel）的大窗口；
    // 程序坞、菜单栏图标、输入法候选、桌面/壁纸、系统浮层都在别的层。
    guard layer == 0 || ((1...8).contains(layer) && size.width >= 80 && size.height >= 80) else { return nil }
    // 1×1、几十像素的隐形辅助窗口不是内容窗口；台前调度侧栏缩略图也有约 100px，不会被误伤。
    guard size.width >= 40 && size.height >= 40 else { return nil }
    let area = size.width * size.height
    guard area.isFinite, area < CGFloat(UInt64.max) else { return nil }
    return max(UInt64(area), 1)
}

/// 只有系统界面、没有用户内容窗口的进程：台前调度、程序坞、控制中心、输入法、通知中心等。
let systemSurfaceBundleIDs: Set<String> = [
    "com.apple.WindowManager", "com.apple.dock", "com.apple.controlcenter", "com.apple.systemuiserver",
    "com.apple.notificationcenterui", "com.apple.Spotlight", "com.apple.TextInputSwitcher",
    "com.apple.TextInputMenuAgent", "com.apple.TextInputUI.xpc.CursorUIViewService", "com.apple.OSDUIHelper",
    "com.apple.loginwindow", "com.apple.screencaptureui", "com.apple.WindowServer",
]

/// 选择器里只列用户真正在用的窗口：系统界面进程不要；
/// isActive 为 false 的是藏起来的辅助窗口（关到托盘的 QQ 主窗、权限引导窗、离屏缓存窗口），也不要。
/// 台前调度侧栏里的窗口 isActive 为 true，照样列出来、照样能无感截取。
func isUserFacingWindow(bundleID: String?, appName: String, isActive: Bool) -> Bool {
    guard isActive, !appName.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty else { return false }
    if let bundleID, systemSurfaceBundleIDs.contains(bundleID) { return false }
    return true
}

/// CGWindowList 按从前到后的顺序返回窗口；拿不到时退回原来的顺序。
func windowStackOrder() -> [CGWindowID: Int] {
    guard let list = CGWindowListCopyWindowInfo([.optionAll], kCGNullWindowID) as? [[String: Any]] else { return [:] }
    var order: [CGWindowID: Int] = [:]
    for (index, info) in list.enumerated() {
        if let number = info[kCGWindowNumber as String] as? Int, order[CGWindowID(number)] == nil {
            order[CGWindowID(number)] = index
        }
    }
    return order
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
    let stack = windowStackOrder()
    // 最小化的窗口 isActive 为 false，和藏起来的辅助窗口分不开；按进程问一次辅助功能，
    // 只有 AX 确认是最小化的那个才列出来。每个进程只问一次，已配对的不再重复使用。
    var minimizedByProcess: [pid_t: [AXWindowSnapshot]] = [:]
    let windows = content.windows.enumerated().compactMap { index, window -> ListedWindow? in
        guard window.windowID > 0, let application = window.owningApplication,
              application.processID > 0,
              let area = listedWindowArea(title: window.title, layer: window.windowLayer, size: window.frame.size) else { return nil }
        var minimized = false
        if !isUserFacingWindow(bundleID: application.bundleIdentifier, appName: application.applicationName, isActive: window.isActive) {
            guard window.windowLayer == 0, !window.isOnScreen,
                  isUserFacingWindow(bundleID: application.bundleIdentifier, appName: application.applicationName, isActive: true) else { return nil }
            let pid = application.processID
            if minimizedByProcess[pid] == nil { minimizedByProcess[pid] = minimizedAXWindows(pid: pid).map(\.snapshot) }
            guard let match = matchMinimizedWindow(title: window.title ?? "", frame: window.frame, among: minimizedByProcess[pid] ?? []) else { return nil }
            minimizedByProcess[pid]?.remove(at: match)
            minimized = true
        }
        return ListedWindow(
            id: window.windowID, pid: application.processID,
            appName: application.applicationName, title: window.title ?? "", area: area,
            // 最小化的排在所有可见窗口后面
            order: (stack[window.windowID] ?? stack.count + index) + (minimized ? 1_000_000 : 0),
            minimized: minimized
        )
    }
    FileHandle.standardOutput.write(try JSONEncoder().encode(windows))
}
