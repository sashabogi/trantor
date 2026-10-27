import XCTest
import HubClient
import UIKit
@testable import Features

@MainActor
final class ChatAttachmentTests: XCTestCase {
    func solidJPEG(width: Int, height: Int) -> Data {
        let renderer = UIGraphicsImageRenderer(size: CGSize(width: width, height: height))
        let image = renderer.image { context in
            UIColor.systemTeal.setFill()
            context.fill(CGRect(x: 0, y: 0, width: width, height: height))
        }
        return image.jpegData(compressionQuality: 1.0)!
    }

    func testPrepareDownscalesLibraryDataUnderTheHubCap() throws {
        let prepared = try XCTUnwrap(ChatAttachment.prepare(solidJPEG(width: 1200, height: 900), name: "shot.jpg"))
        XCTAssertEqual(prepared.name, "shot.jpg")
        let jpeg = Data(base64Encoded: prepared.attachment.dataBase64)
        XCTAssertNotNil(jpeg)
        XCTAssertLessThanOrEqual(jpeg!.count, ChatAttachment.maxBytes)
        XCTAssertEqual([UInt8](jpeg!.prefix(3)), [0xff, 0xd8, 0xff], "the hub only accepts JPEG magic")
        XCTAssertNotNil(prepared.thumbnail)
        let thumbnail = try XCTUnwrap(prepared.thumbnail?.cgImage)
        XCTAssertLessThanOrEqual(max(thumbnail.width, thumbnail.height), 200)
        XCTAssertEqual(Double(thumbnail.width) / Double(thumbnail.height), 4.0 / 3.0, accuracy: 0.02)
    }

    func testPrepareRefusesNilAndGarbageData() {
        XCTAssertNil(ChatAttachment.prepare(nil))
        XCTAssertNil(ChatAttachment.prepare(Data("not an image".utf8)))
    }

    func testPreparationRunsOffMainAndBlocksSendUntilEveryPhotoCompletes() async {
        let queue = ChatAttachmentQueue { data in
            XCTAssertFalse(Thread.isMainThread, "image decoding must not run on the UI thread")
            return ChatAttachment.prepare(data)
        }
        let data = solidJPEG(width: 300, height: 200)
        XCTAssertEqual(queue.beginPreparation(count: 2), 2)
        XCTAssertEqual(queue.preparingCount, 2)
        XCTAssertFalse(queue.readyToSend, "reserve before loading photo bytes")
        await queue.finishPreparation(data)
        XCTAssertEqual(queue.pending.count, 1)
        XCTAssertEqual(queue.preparingCount, 1)
        XCTAssertFalse(queue.readyToSend, "the next photo is still loading")
        await queue.finishPreparation(data)
        XCTAssertEqual(queue.pending.count, 2)
        XCTAssertTrue(queue.readyToSend)
    }

    func testFailedPreparationReleasesReservationAndSelectionCannotExceedFour() async {
        let queue = ChatAttachmentQueue()
        XCTAssertEqual(queue.beginPreparation(count: 6), 4)
        XCTAssertEqual(queue.beginPreparation(count: 1), 0)
        for _ in 0..<4 { await queue.finishPreparation(nil) }
        XCTAssertEqual(queue.preparingCount, 0)
        XCTAssertTrue(queue.pending.isEmpty)
        XCTAssertTrue(queue.readyToSend)
        XCTAssertEqual(queue.beginPreparation(count: 1), 1)
        await queue.finishPreparation(Data("bad image".utf8))
        XCTAssertTrue(queue.readyToSend)
    }
}
