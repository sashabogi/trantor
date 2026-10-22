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

    /// The Connect page's failure line. Tailscale only helps for a tailnet (http 100.x) hub; for an
    /// https hub the problem is the ordinary internet connection.
    static func connectFailureCopy(forHub hub: String) -> String {
        HubNetwork.needsTailscale(hub)
            ? "Can't reach your hub. Turn on Tailscale, then Retry"
            : "Can't reach your hub. Check your internet connection, then Retry"
    }
}
