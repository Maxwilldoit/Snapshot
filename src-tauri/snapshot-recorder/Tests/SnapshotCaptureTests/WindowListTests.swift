import XCTest
import ScreenCaptureKit
@testable import snapshot_recorder

final class WindowListTests: XCTestCase {
    func testStageManagerContentWindowsAreNotRejectedForThumbnailDimensions() {
        // 本机后台 VS Code 7046 的 frame 为 203×115，isOnScreen 为 false。
        // 同一个窗口在列表和无感截图中必须沿用真实 CGWindowID，且不要求激活。
        XCTAssertEqual(listedWindowArea(title: "test2.cpp — experiment5", layer: 0, size: CGSize(width: 203, height: 115)), 23_345)
        // 多窗口/侧栏缩放还可能令一边小于原先的 80px 下限。
        XCTAssertEqual(listedWindowArea(title: "窗口", layer: 0, size: CGSize(width: 120, height: 65)), 7_800)
    }

    func testStatusItemsAreExcludedButUntitledContentWindowsRemainCapturable() {
        // Shadowrocket 的 Item-0 是 layer 25；不要再把菜单栏图标当成主窗口。
        XCTAssertNil(listedWindowArea(title: "Item-0", layer: 25, size: CGSize(width: 34, height: 24)))
        XCTAssertNil(listedWindowArea(title: "系统浮层", layer: 1000, size: CGSize(width: 685, height: 30)))
        for title in [nil, "", " \n\t"] as [String?] {
            XCTAssertEqual(listedWindowArea(title: title, layer: 0, size: CGSize(width: 500, height: 500)), 250_000)
        }
        XCTAssertEqual(listedWindowArea(title: "Shadowrocket", layer: 0, size: CGSize(width: 168, height: 107)), 17_976)
    }

    func testLargeFloatingOrPinnedWindowsRemainCapturable() {
        XCTAssertEqual(listedWindowArea(title: "置顶窗口", layer: 3, size: CGSize(width: 1024, height: 655)), 670_720)
        // Shadowrocket / Tailscale 这类菜单栏应用的面板与二级菜单，不限于 0…8 层，也不一定有标题。
        XCTAssertEqual(listedWindowArea(title: nil, layer: 25, size: CGSize(width: 320, height: 400)), 128_000)
        XCTAssertEqual(listedWindowArea(title: "", layer: 101, size: CGSize(width: 280, height: 380)), 106_400)
    }

    func testInvalidSizesDoNotTrapOrBecomeContentWindows() {
        for size in [CGSize.zero, CGSize(width: -1, height: 100), CGSize(width: 100, height: -1), CGSize(width: CGFloat.infinity, height: 100), CGSize(width: CGFloat.nan, height: 100), CGSize(width: 1e20, height: 1e20)] {
            XCTAssertNil(listedWindowArea(title: "Code", layer: 0, size: size))
        }
    }

    func testWindowListProtocolPreservesNativeIdentifiersAndTitles() throws {
        let window = ListedWindow(id: 7046, pid: 59230, appName: "Code", title: "测试\n— experiment5", area: 23_345, order: 3)
        let data = try JSONEncoder().encode([window])
        let entries = try XCTUnwrap(JSONSerialization.jsonObject(with: data) as? [[String: Any]])
        let entry = try XCTUnwrap(entries.first)
        XCTAssertEqual(entry["id"] as? Int, 7046)
        XCTAssertEqual(entry["pid"] as? Int, 59230)
        XCTAssertEqual(entry["appName"] as? String, "Code")
        XCTAssertEqual(entry["title"] as? String, "测试\n— experiment5")
        XCTAssertEqual(entry["area"] as? Int, 23_345)
        XCTAssertEqual(entry["order"] as? Int, 3)
    }

    func testDesktopWallpaperDockAndOverlayLayersAreExcluded() {
        // 访达的桌面层、程序坞壁纸都是全屏大窗口，但层级是负的极值。
        XCTAssertNil(listedWindowArea(title: "Desktop", layer: -2147483603, size: CGSize(width: 1280, height: 800)))
        XCTAssertNil(listedWindowArea(title: "Wallpaper-06ACE38B", layer: -2147483624, size: CGSize(width: 1280, height: 800)))
        // 输入法切换浮层（TextInputSwitcher「键盘输入」）在很高的层。
        XCTAssertNil(listedWindowArea(title: "键盘输入", layer: 2147483628, size: CGSize(width: 247, height: 160)))
        XCTAssertNil(listedWindowArea(title: "Notification Center", layer: 2005, size: CGSize(width: 400, height: 800)))
    }

    func testInvisibleHelperWindowsAreExcluded() {
        // QQ 1×1 的辅助窗口
        XCTAssertNil(listedWindowArea(title: "QQ", layer: 0, size: CGSize(width: 1, height: 1)))
        XCTAssertNil(listedWindowArea(title: "QQ", layer: 0, size: CGSize(width: 30, height: 600)))
    }

    func testActiveOrOnScreenWindowsOfUserAppsAreListed() {
        // 台前调度侧栏里的窗口 isActive 为 true
        XCTAssertTrue(isUserFacingWindow(bundleID: "com.microsoft.VSCode", appName: "Code", isActive: true))
        // 已在屏幕上的二级窗口即使不是 active，也不能从选择器里消失。
        XCTAssertTrue(isUserFacingWindow(bundleID: "com.tencent.xinWeChat", appName: "微信", isActive: false, isOnScreen: true))
        XCTAssertTrue(isUserFacingWindow(bundleID: "io.tailscale.ipn.macsys", appName: "Tailscale", isActive: false, isOnScreen: true))
        // 关到托盘的 QQ 主窗口、ChatGPT Computer Use 的权限引导窗：存在但 isActive 为 false
        XCTAssertFalse(isUserFacingWindow(bundleID: "com.tencent.qq", appName: "QQ", isActive: false))
        XCTAssertFalse(isUserFacingWindow(bundleID: "com.openai.sky.CUAService", appName: "ChatGPT Computer Use", isActive: false))
        // 系统界面进程，就算 isActive 也不列
        for bundleID in ["com.apple.WindowManager", "com.apple.dock", "com.apple.TextInputSwitcher", "com.apple.controlcenter"] {
            XCTAssertFalse(isUserFacingWindow(bundleID: bundleID, appName: "System", isActive: true))
        }
        XCTAssertFalse(isUserFacingWindow(bundleID: "com.openai.sky.CUAService", appName: "ChatGPT Computer Use", isActive: true, isOnScreen: true))
        // 没有应用名的（WindowServer 的 Desktop）不列
        XCTAssertFalse(isUserFacingWindow(bundleID: nil, appName: " ", isActive: true))
    }

    func testMinimizedWindowsAreMatchedByTitleAndFrameNotGuessed() {
        let frame = CGRect(x: 300, y: 152, width: 480, height: 348)
        let candidates = [
            AXWindowSnapshot(title: "文稿 1", frame: CGRect(x: 10, y: 10, width: 400, height: 300)),
            AXWindowSnapshot(title: "文稿 2", frame: frame),
            AXWindowSnapshot(title: "文稿 2", frame: CGRect(x: 600, y: 100, width: 480, height: 348)),
        ]
        // 同标题两个：按位置大小认
        XCTAssertEqual(matchMinimizedWindow(title: "文稿 2", frame: frame, among: candidates), 1)
        // 同标题只有一个：位置变了也认
        XCTAssertEqual(matchMinimizedWindow(title: "文稿 1", frame: frame.offsetBy(dx: 50, dy: 0), among: candidates), 0)
        // 标题不同、同标题有多个但位置都对不上：不猜
        XCTAssertNil(matchMinimizedWindow(title: "文稿 2", frame: CGRect(x: 0, y: 0, width: 10, height: 10), among: candidates))
        // QQ 关到托盘的隐藏窗口不是最小化：AX 里没有对应的最小化窗口
        XCTAssertNil(matchMinimizedWindow(title: "QQ", frame: frame, among: []))
    }

    func testMinimizedFlagIsEncoded() throws {
        var window = ListedWindow(id: 1, pid: 2, appName: "文本编辑", title: "未命名", area: 10, order: 5)
        window.minimized = true
        let entry = try XCTUnwrap((JSONSerialization.jsonObject(with: JSONEncoder().encode([window])) as? [[String: Any]])?.first)
        XCTAssertEqual(entry["minimized"] as? Bool, true)
    }

    func testOffscreenContentNeedsMatchingGeometryAndKeepsItsRealMinimizedState() {
        let frame = CGRect(x: 300, y: 150, width: 800, height: 600)
        let normal = AXWindowSnapshot(title: "微信", frame: frame)
        XCTAssertEqual(matchOffscreenWindow(title: "微信", frame: frame, among: [normal]), 0)
        // 相同标题、位置却对不上的是缓存面，不能只因同名就列出。
        XCTAssertNil(matchOffscreenWindow(title: "微信", frame: frame.offsetBy(dx: 100, dy: 0), among: [normal]))
        var minimized = normal
        minimized.minimized = true
        XCTAssertEqual(matchOffscreenWindow(title: "微信", frame: frame.offsetBy(dx: 100, dy: 0), among: [minimized]), 0)
        XCTAssertFalse(normal.minimized)
        XCTAssertTrue(minimized.minimized)
        XCTAssertNil(matchOffscreenWindow(title: "缓存窗口", frame: frame, among: []))
    }

    func testMinimizedLookupWithNoCandidatesDoesNotTouchAccessibility() {
        // 没有可能是最小化的窗口时一次辅助功能调用都不发（也不要求权限）
        XCTAssertTrue(minimizedAXSnapshots(pids: []).isEmpty)
    }

    func testMinimizedLookupAnswersEveryProcessEvenIfItHasNoWindows() {
        // 不存在的进程问不到东西：并发查询要按原顺序给每个进程一份（可能为空）的结果，不能错位或丢失
        let pids: [pid_t] = [999_991, 999_992, 999_993]
        let result = minimizedAXSnapshots(pids: pids)
        if result.isEmpty { return } // 测试进程没有辅助功能权限
        XCTAssertEqual(Set(result.keys), Set(pids))
        XCTAssertTrue(result.values.allSatisfy(\.isEmpty))
    }
}

