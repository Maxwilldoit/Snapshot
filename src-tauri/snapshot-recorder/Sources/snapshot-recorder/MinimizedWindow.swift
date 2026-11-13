// 最小化窗口：ScreenCaptureKit 拿不到画面（截图请求会一直不返回），旧的 CGWindowListCreateImage 也返回空。
// 只能经辅助功能（AX）临时还原：先把窗口挪到屏幕角落外，再取消最小化、截图、重新最小化、放回原位，
// 全程不激活目标应用。台前调度开着时「最小化」的窗口其实在侧栏里，照常无感截取，不走这里。
import AppKit
import ApplicationServices
import ScreenCaptureKit

let minimizedNeedsAccessibility = "截取最小化的窗口需要「辅助功能」权限：在系统设置 › 隐私与安全性 › 辅助功能里允许 Snapshot 后重试"
let minimizedRestoreFailed = "目标窗口仍处于最小化，未能还原"

/// 一个 AX 窗口的标题和位置（屏幕左上角为原点，与 SCWindow.frame 同一坐标系）。
struct AXWindowSnapshot: Equatable {
    let title: String
    let frame: CGRect
    var minimized: Bool = false
}

private func windowFramesMatch(_ a: CGRect, _ b: CGRect) -> Bool {
    abs(a.minX - b.minX) <= 2 && abs(a.minY - b.minY) <= 2 && abs(a.width - b.width) <= 2 && abs(a.height - b.height) <= 2
}

/// 在同一进程的最小化 AX 窗口里找出对应 SCWindow 的那个：标题相同且位置大小一致的优先；
/// 只有一个同标题的最小化窗口时也算。找不到返回 nil（宁可不认，也不还原错窗口）。
func matchMinimizedWindow(title: String, frame: CGRect, among candidates: [AXWindowSnapshot]) -> Int? {
    let sameTitle = candidates.indices.filter { candidates[$0].title == title }
    if let exact = sameTitle.first(where: { windowFramesMatch(candidates[$0].frame, frame) }) { return exact }
    if sameTitle.count == 1 { return sameTitle[0] }
    let sameFrame = candidates.indices.filter { windowFramesMatch(candidates[$0].frame, frame) }
    return sameFrame.count == 1 ? sameFrame[0] : nil
}

/// 未最小化的离屏窗口必须对上几何位置，不能只凭同名认出缓存窗口。
func matchOffscreenWindow(title: String, frame: CGRect, among candidates: [AXWindowSnapshot]) -> Int? {
    guard let match = matchMinimizedWindow(title: title, frame: frame, among: candidates) else { return nil }
    let candidate = candidates[match]
    return candidate.minimized || windowFramesMatch(candidate.frame, frame) ? match : nil
}

private func axRawValue(_ element: AXUIElement, _ attribute: String) -> AXValue? {
    var raw: CFTypeRef?
    guard AXUIElementCopyAttributeValue(element, attribute as CFString, &raw) == .success, let raw,
          CFGetTypeID(raw) == AXValueGetTypeID() else { return nil }
    return (raw as! AXValue)
}

private func axSize(_ element: AXUIElement) -> CGSize? {
    guard let value = axRawValue(element, kAXSizeAttribute) else { return nil }
    var size = CGSize.zero
    return AXValueGetValue(value, .cgSize, &size) ? size : nil
}

private func axBool(_ element: AXUIElement, _ attribute: String) -> Bool {
    var raw: CFTypeRef?
    guard AXUIElementCopyAttributeValue(element, attribute as CFString, &raw) == .success else { return false }
    return (raw as? Bool) ?? false
}

private func axPosition(_ element: AXUIElement) -> CGPoint? {
    guard let value = axRawValue(element, kAXPositionAttribute) else { return nil }
    var point = CGPoint.zero
    return AXValueGetValue(value, .cgPoint, &point) ? point : nil
}

@discardableResult
private func setAXPosition(_ element: AXUIElement, _ point: CGPoint) -> Bool {
    var point = point
    guard let value = AXValueCreate(.cgPoint, &point) else { return false }
    return AXUIElementSetAttributeValue(element, kAXPositionAttribute as CFString, value) == .success
}

@discardableResult
private func setAXMinimized(_ element: AXUIElement, _ minimized: Bool) -> Bool {
    AXUIElementSetAttributeValue(element, kAXMinimizedAttribute as CFString, (minimized ? kCFBooleanTrue : kCFBooleanFalse) as CFTypeRef) == .success
}

/// 应用当前仍存在的 AX 窗口，不主动申请辅助功能权限。
private func axWindows(pid: pid_t, timeout: Float? = nil) -> [(element: AXUIElement, snapshot: AXWindowSnapshot)] {
    guard AXIsProcessTrusted() else { return [] }
    let application = AXUIElementCreateApplication(pid)
    if let timeout { AXUIElementSetMessagingTimeout(application, timeout) }
    var raw: CFTypeRef?
    guard AXUIElementCopyAttributeValue(application, kAXWindowsAttribute as CFString, &raw) == .success,
          let windows = raw as? [AXUIElement] else { return [] }
    return windows.compactMap { element in
        var title: CFTypeRef?
        AXUIElementCopyAttributeValue(element, kAXTitleAttribute as CFString, &title)
        let origin = axPosition(element) ?? .zero
        let size = axSize(element) ?? .zero
        return (element, AXWindowSnapshot(title: (title as? String) ?? "", frame: CGRect(origin: origin, size: size), minimized: axBool(element, kAXMinimizedAttribute)))
    }
}

/// 截取时只还原明确最小化的窗口。
func minimizedAXWindows(pid: pid_t, timeout: Float? = nil) -> [(element: AXUIElement, snapshot: AXWindowSnapshot)] {
    axWindows(pid: pid, timeout: timeout).filter { $0.snapshot.minimized }
}

/// 并发地问多个进程各自有哪些最小化窗口。每个进程单独设了消息超时，
/// 一个卡住的应用不会拖住整份列表（最多等它 0.3 秒，问不到就当它没有最小化窗口）。
func axWindowSnapshots(pids: [pid_t]) -> [pid_t: [AXWindowSnapshot]] {
    guard !pids.isEmpty, AXIsProcessTrusted() else { return [:] }
    var results = [[AXWindowSnapshot]](repeating: [], count: pids.count)
    results.withUnsafeMutableBufferPointer { buffer in
        let slots = buffer
        DispatchQueue.concurrentPerform(iterations: pids.count) { index in
            slots[index] = axWindows(pid: pids[index], timeout: 0.3).map(\.snapshot)
        }
    }
    return Dictionary(uniqueKeysWithValues: zip(pids, results))
}

func minimizedAXSnapshots(pids: [pid_t]) -> [pid_t: [AXWindowSnapshot]] {
    axWindowSnapshots(pids: pids).mapValues { $0.filter(\.minimized) }
}

/// 这个 SCWindow 是不是一个（Dock 里的）最小化窗口；是的话返回它的 AX 元素。
func minimizedAXElement(for window: SCWindow) -> AXUIElement? {
    guard !window.isOnScreen, let pid = window.owningApplication?.processID else { return nil }
    let candidates = minimizedAXWindows(pid: pid)
    guard let index = matchMinimizedWindow(title: window.title ?? "", frame: window.frame, among: candidates.map(\.snapshot)) else { return nil }
    return candidates[index].element
}

@MainActor
func refreshedWindow(_ id: CGWindowID) async -> SCWindow? {
    let content = try? await SCShareableContent.excludingDesktopWindows(false, onScreenWindowsOnly: false)
    return content?.windows.first { $0.windowID == id }
}

/// 同一时刻只让一个组件进程去还原最小化窗口：两个并发的截图会互相把对方挪走的位置当成「原位」，
/// 窗口最后就留在了屏幕角落。锁随进程退出由内核释放，等不到就放弃。
func withMinimizedRestoreLock<T>(_ body: () async throws -> T) async throws -> T {
    let fd = open(NSTemporaryDirectory() + "snapshot-recorder-minimized.lock", O_CREAT | O_RDWR, 0o600)
    guard fd >= 0 else { return try await body() }
    defer { close(fd) }
    let deadline = Date().addingTimeInterval(8)
    while flock(fd, LOCK_EX | LOCK_NB) != 0 {
        guard Date() < deadline else { throw RecorderError(message: minimizedRestoreFailed) }
        try? await Task.sleep(nanoseconds: 50_000_000)
    }
    defer { flock(fd, LOCK_UN) }
    return try await body()
}

/// 录制和 Windows 版一样：最小化的窗口先还原（留在屏幕上），录完不再最小化回去。
/// 不是最小化窗口或没有辅助功能权限时原样返回。
@MainActor
func restoredForRecording(_ window: SCWindow) async throws -> SCWindow {
    guard !window.isOnScreen, let element = minimizedAXElement(for: window) else { return window }
    guard setAXMinimized(element, false) else { throw RecorderError(message: minimizedRestoreFailed) }
    let deadline = Date().addingTimeInterval(2)
    while Date() < deadline {
        if let current = await refreshedWindow(window.windowID), current.isOnScreen, !axBool(element, kAXMinimizedAttribute) {
            try? await Task.sleep(nanoseconds: 120_000_000)
            return current
        }
        try? await Task.sleep(nanoseconds: 40_000_000)
    }
    throw RecorderError(message: minimizedRestoreFailed)
}

/// 临时还原一个最小化窗口来截图，截完一定重新最小化并放回原位。
@MainActor
func withTemporarilyRestored<T>(
    _ window: SCWindow, element: AXUIElement, body: (SCWindow) async throws -> T
) async throws -> T {
    let frontmost = NSWorkspace.shared.frontmostApplication
    let original = axPosition(element)
    // 挪到屏幕外：系统会把它夹到最后一块屏幕的右下角，只露出几十像素，还原动画也落在那里。
    setAXPosition(element, CGPoint(x: 100_000, y: 100_000))
    func cleanUp() async {
        // 不管截没截成，都重新最小化
        setAXMinimized(element, true)
        if let original {
            // 等它真的回到程序坞再放回原位，免得在屏幕上跳一下。
            let deadline = Date().addingTimeInterval(1.5)
            while !axBool(element, kAXMinimizedAttribute), Date() < deadline {
                try? await Task.sleep(nanoseconds: 30_000_000)
            }
            setAXPosition(element, original)
        }
        if let frontmost, NSWorkspace.shared.frontmostApplication != frontmost, !frontmost.isTerminated {
            frontmost.activate()
        }
    }
    do {
        guard setAXMinimized(element, false) else { throw RecorderError(message: minimizedRestoreFailed) }
        let deadline = Date().addingTimeInterval(2)
        var restored: SCWindow?
        while Date() < deadline {
            if let current = await refreshedWindow(window.windowID), current.isOnScreen, !axBool(element, kAXMinimizedAttribute) {
                restored = current
                break
            }
            try? await Task.sleep(nanoseconds: 40_000_000)
        }
        guard let restored else { throw RecorderError(message: minimizedRestoreFailed) }
        // 还原后第一帧要等合成器画出来
        try? await Task.sleep(nanoseconds: 120_000_000)
        let result = try await body(restored)
        await cleanUp()
        return result
    } catch {
        await cleanUp()
        throw error
    }
}
