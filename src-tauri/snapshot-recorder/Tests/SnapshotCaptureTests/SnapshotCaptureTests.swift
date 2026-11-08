import XCTest
import ScreenCaptureKit
@testable import snapshot_recorder

final class SnapshotCaptureTests: XCTestCase {
    func testStageManagerFrameMetadataRecoversNativeSizeWithoutAccessibility() throws {
        // 本机的 CG / SCWindow.frame 分别只有 203×115 和 127×110，
        // 输出帧的 contentRect / contentScale 才能还原真正的窗口尺寸。
        for (rect, scale, expectedWidth, expectedHeight) in [
            (CGRect(x: 0, y: 0, width: 256.0000063180923, height: 144.9563848376274), CGFloat(0.2067851424217224), 2476, 1402),
            (CGRect(x: 0, y: 0, width: 256.0000002384186, height: 161.2307693809271), CGFloat(0.2461538463830948), 2080, 1310),
        ] {
            let size = try WindowPixelSize(contentRect: rect, contentScale: scale, scaleFactor: 2)
            XCTAssertEqual(size.width, expectedWidth)
            XCTAssertEqual(size.height, expectedHeight)
        }
    }

    func testNonRetinaAndFractionalDimensions() throws {
        let size = try WindowPixelSize(contentRect: CGRect(x: 0, y: 0, width: 250, height: 125.25), contentScale: 0.25, scaleFactor: 1)
        XCTAssertEqual(size.width, 1000)
        XCTAssertEqual(size.height, 501)
    }

    func testInvalidMetadataDoesNotCreateEmptyOrUnboundedImages() {
        let rect = CGRect(x: 0, y: 0, width: 256, height: 128)
        for scale in [CGFloat.zero, -1, .infinity, .nan] {
            XCTAssertThrowsError(try WindowPixelSize(contentRect: rect, contentScale: scale, scaleFactor: 2))
            XCTAssertThrowsError(try WindowPixelSize(contentRect: rect, contentScale: 1, scaleFactor: scale))
        }
        for size in [CGSize.zero, CGSize(width: -1, height: 128), CGSize(width: 20_000, height: 128), CGSize(width: 16_384, height: 16_384)] {
            XCTAssertThrowsError(try WindowPixelSize(contentRect: CGRect(origin: .zero, size: size), contentScale: 1, scaleFactor: 1))
        }
    }

    func testScreenshotArgumentsAreSeparateFromRecordingArguments() throws {
        let args = try ScreenshotArguments.parse(["snapshot-recorder", "--screenshot", "--window-id", "7046", "--include-cursor"])
        XCTAssertEqual(args.windowID, 7046)
        XCTAssertTrue(args.includeCursor)
        XCTAssertFalse(try ScreenshotArguments.parse(["helper", "--screenshot", "--window-id", "5563"]).includeCursor)
        for args in [
            ["helper", "--screenshot"], ["helper", "--screenshot", "--window-id"],
            ["helper", "--screenshot", "--window-id", "0"],
            ["helper", "--screenshot", "--window-id", "bad"],
            ["helper", "--screenshot", "--system-audio"],
        ] { XCTAssertThrowsError(try ScreenshotArguments.parse(args)) }
    }

    func testCaptureUsesIndependentUnclippedNativePixelsAndNativeCursor() {
        for includeCursor in [false, true] {
            let config = screenshotConfiguration(width: 2476, height: 1402, includeCursor: includeCursor)
            XCTAssertEqual(config.width, 2476)
            XCTAssertEqual(config.height, 1402)
            XCTAssertEqual(config.captureResolution, .best)
            XCTAssertFalse(config.scalesToFit)
            XCTAssertTrue(config.ignoreGlobalClipSingleWindow)
            XCTAssertTrue(config.ignoreShadowsSingleWindow)
            XCTAssertEqual(config.showsCursor, includeCursor)
            XCTAssertFalse(config.capturesAudio)
        }
    }
}
