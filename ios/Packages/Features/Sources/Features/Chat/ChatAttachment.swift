import Foundation
import HubClient
import UIKit

/// One photo the composer will ride with the prompt (#12161): the JPEG bytes the hub gets,
/// downscaled to its 2 MB cap, plus a thumbnail for the chip row.
struct PreparedAttachment: Identifiable, Equatable {
    let id: UUID
    let attachment: PromptAttachment
    let thumbnail: UIImage?

    var name: String { attachment.name }
}

enum ChatAttachment {
    static let maxCount = 4
    static let maxBytes = 2 * 1024 * 1024

    /// Resize library image data to a JPEG the hub accepts: shrink the longest edge until the
    /// re-encode lands at 2 MB or less. Returns nil when nothing usable came back.
    static func prepare(_ data: Data?, name: String = "photo.jpg") -> PreparedAttachment? {
        guard let data, let source = CGImageSourceCreateWithData(data as CFData, nil) else { return nil }
        var pixelSize: CGFloat = 4096
        var best: Data?
        for _ in 0..<12 {
            let options: [CFString: Any] = [
                kCGImageSourceCreateThumbnailFromImageAlways: true,
                kCGImageSourceCreateThumbnailWithTransform: true,
                kCGImageSourceThumbnailMaxPixelSize: pixelSize,
            ]
            guard let cg = CGImageSourceCreateThumbnailAtIndex(source, 0, options as CFDictionary) else { break }
            let image = UIImage(cgImage: cg)
            let rendered = image.jpegData(compressionQuality: 0.8)
            guard let rendered else { break }
            if rendered.count <= maxBytes {
                let thumbnail = UIImage(data: rendered) ?? image
                return PreparedAttachment(id: UUID(),
                                          attachment: PromptAttachment(name: name, jpegData: rendered),
                                          thumbnail: thumbnail)
            }
            best = rendered
            pixelSize = max(320, pixelSize / 1.6)
        }
        guard let best else { return nil }
        return PreparedAttachment(id: UUID(),
                                  attachment: PromptAttachment(name: name, jpegData: best),
                                  thumbnail: UIImage(data: best))
    }
}
