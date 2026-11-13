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
// 普通层窗口不能用 isOnScreen 或 80px 下限识别；二级窗口可能没有标题，
// 菜单栏应用的面板也可能在 status / pop-up 层。用尺寸、系统进程与可见性排除辅助面。
func listedWindowArea(title _: String?, layer: Int, size: CGSize) -> UInt64? {
    guard size.width.isFinite, size.height.isFinite,
          size.width > 0, size.height > 0 else { return nil }
    // 桌面/壁纸为负层；屏保、安全及系统提示层不作为应用内容。高于普通层的大面板仍可截取。
    guard layer >= 0, layer < Int(CGWindowLevelForKey(.screenSaverWindow)) else { return nil }
    guard layer == 0 || (size.width >= 80 && size.height >= 80) else { return nil }
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
    "com.openai.sky.CUAService",
]

/// 选择器里只列用户真正在用的窗口：系统界面进程不要；
/// 已显示的二级窗口不能只按 isActive 排除。不可见且 inactive 的窗口还需 AX 确认，
/// 避免把关到托盘后的缓存窗口误列进来；台前调度窗口的 active 状态仍可直接使用。
func isUserFacingWindow(bundleID: String?, appName: String, isActive: Bool, isOnScreen: Bool = false) -> Bool {
    guard isActive || isOnScreen, !appName.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty else { return false }
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

/// 不在屏幕上且 inactive 的普通应用窗口：用 AX 区分其它空间、最小化与隐藏缓存面。
private func needsAXWindowConfirmation(_ window: SCWindow, application: SCRunningApplication) -> Bool {
    !isUserFacingWindow(bundleID: application.bundleIdentifier, appName: application.applicationName, isActive: window.isActive, isOnScreen: window.isOnScreen)
        && window.windowLayer == 0 && !window.isOnScreen
        && isUserFacingWindow(bundleID: application.bundleIdentifier, appName: application.applicationName, isActive: true)
}

@MainActor
func runWindowList() async throws {
    let content = try await shareableWindowContent()
    // 其它空间、最小化与离屏缓存窗口都可能 inactive；按进程问一次 AX，
    // 确认仍在应用的窗口列表中再列出。每个进程只问一次，已配对的不再重复使用。
    // 逐个进程问辅助功能是这条命令里最慢的一步（每个进程 10–40ms），所以并发去问，
    // 同时在另一条线程上读前后顺序。
    let candidates = Set(content.windows.compactMap { window -> pid_t? in
        guard let application = window.owningApplication, application.processID > 0,
              listedWindowArea(title: window.title, layer: window.windowLayer, size: window.frame.size) != nil,
              needsAXWindowConfirmation(window, application: application) else { return nil }
        return application.processID
    })
    async let stackTask = Task.detached { windowStackOrder() }.value
    var offscreenByProcess = await Task.detached { axWindowSnapshots(pids: Array(candidates)) }.value
    let stack = await stackTask
    let windows = content.windows.enumerated().compactMap { index, window -> ListedWindow? in
        guard window.windowID > 0, let application = window.owningApplication,
              application.processID > 0,
              let area = listedWindowArea(title: window.title, layer: window.windowLayer, size: window.frame.size) else { return nil }
        var minimized = false
        if !isUserFacingWindow(bundleID: application.bundleIdentifier, appName: application.applicationName, isActive: window.isActive, isOnScreen: window.isOnScreen) {
            guard needsAXWindowConfirmation(window, application: application) else { return nil }
            let pid = application.processID
            guard let match = matchOffscreenWindow(title: window.title ?? "", frame: window.frame, among: offscreenByProcess[pid] ?? []) else { return nil }
            minimized = offscreenByProcess[pid]?[match].minimized ?? false
            offscreenByProcess[pid]?.remove(at: match)
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
