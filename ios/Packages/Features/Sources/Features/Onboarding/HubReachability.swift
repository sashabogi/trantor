import Foundation
import HubClient
import TrantorCore

struct HubReachability {
    static func check(_ hub: String, session suppliedSession: URLSession? = nil) async throws {
        guard let base = URL(string: hub) else { throw HubError.invalidURL }
        let config = URLSessionConfiguration.ephemeral
        config.timeoutIntervalForRequest = 4
        config.timeoutIntervalForResource = 4
        config.waitsForConnectivity = false
        let session = suppliedSession ?? URLSession(configuration: config)
        defer { if suppliedSession == nil { session.invalidateAndCancel() } }
        var request = URLRequest(url: base.appendingPathComponent("health"))
        request.timeoutInterval = 4
        request.cachePolicy = .reloadIgnoringLocalCacheData
        let (data, response) = try await session.data(for: request)
        guard let response = response as? HTTPURLResponse, (200..<300).contains(response.statusCode),
              let health = try? JSONDecoder().decode(HealthInfo.self, from: data), health.ok else {
            throw HubError.offline(op: nil)
        }
    }
}
