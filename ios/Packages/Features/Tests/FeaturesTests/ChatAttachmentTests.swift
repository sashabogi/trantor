import XCTest
import HubClient
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
    }

    func testPrepareRefusesNilAndGarbageData() {
        XCTAssertNil(ChatAttachment.prepare(nil))
        XCTAssertNil(ChatAttachment.prepare(Data("not an image".utf8)))
    }
}
