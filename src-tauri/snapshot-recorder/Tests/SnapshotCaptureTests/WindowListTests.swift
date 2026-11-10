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

    func testStatusItemsAndUnnamedHelperSurfacesAreExcluded() {
        // Shadowrocket 的 Item-0 是 layer 25；不要再把菜单栏图标当成主窗口。
        XCTAssertNil(listedWindowArea(title: "Item-0", layer: 25, size: CGSize(width: 34, height: 24)))
        XCTAssertNil(listedWindowArea(title: "系统浮层", layer: 1000, size: CGSize(width: 685, height: 30)))
        for title in [nil, "", " \n\t"] as [String?] {
            XCTAssertNil(listedWindowArea(title: title, layer: 0, size: CGSize(width: 500, height: 500)))
        }
        XCTAssertEqual(listedWindowArea(title: "Shadowrocket", layer: 0, size: CGSize(width: 168, height: 107)), 17_976)
    }

    func testLargeFloatingOrPinnedWindowsRemainCapturable() {
        XCTAssertEqual(listedWindowArea(title: "置顶窗口", layer: 3, size: CGSize(width: 1024, height: 655)), 670_720)
    }

    func testInvalidSizesDoNotTrapOrBecomeContentWindows() {
        for size in [CGSize.zero, CGSize(width: -1, height: 100), CGSize(width: 100, height: -1), CGSize(width: CGFloat.infinity, height: 100), CGSize(width: CGFloat.nan, height: 100), CGSize(width: 1e20, height: 1e20)] {
            XCTAssertNil(listedWindowArea(title: "Code", layer: 0, size: size))
        }
    }

    func testWindowListProtocolPreservesNativeIdentifiersAndTitles() throws {
        let window = ListedWindow(id: 7046, pid: 59230, appName: "Code", title: "测试\n— experiment5", area: 23_345)
        let data = try JSONEncoder().encode([window])
        let entries = try XCTUnwrap(JSONSerialization.jsonObject(with: data) as? [[String: Any]])
        let entry = try XCTUnwrap(entries.first)
        XCTAssertEqual(entry["id"] as? Int, 7046)
        XCTAssertEqual(entry["pid"] as? Int, 59230)
        XCTAssertEqual(entry["appName"] as? String, "Code")
        XCTAssertEqual(entry["title"] as? String, "测试\n— experiment5")
        XCTAssertEqual(entry["area"] as? Int, 23_345)
    }
}
