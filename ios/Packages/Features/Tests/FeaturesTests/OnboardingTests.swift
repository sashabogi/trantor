import XCTest
import HubClient
@testable import Features

final class OnboardingTests: XCTestCase {
    private let invite = "trantor://enroll?hub=http%3A%2F%2F100.64.0.1%3A4477&token=one-time"

    func testFivePagesRequireReachableHubBeforeNameAndPairBeforeDone() {
        var flow = OnboardingFlow()
        XCTAssertEqual(flow.step, .welcome)
        flow.begin()
        XCTAssertEqual(flow.step, .scan)
        flow.continueToName()
        flow.paired()
        XCTAssertEqual(flow.step, .scan)
        XCTAssertTrue(flow.accept(invite))
        XCTAssertEqual(flow.step, .connect)
        flow.connectionResult(false)
        flow.continueToName()
        XCTAssertEqual(flow.step, .connect)
        flow.connectionResult(true)
        flow.continueToName()
        XCTAssertEqual(flow.step, .name)
        flow.paired()
        XCTAssertEqual(flow.step, .done)
        flow.back()
        XCTAssertEqual(flow.step, .done)
    }

    func testRescanClearsPriorHubReachabilityAndInvalidCodeDoesNotAdvance() {
        var flow = OnboardingFlow()
        flow.begin()
        XCTAssertFalse(flow.accept("https://example.com"))
        XCTAssertEqual(flow.step, .scan)
        XCTAssertTrue(flow.accept(invite))
        flow.connectionResult(true)
        flow.back()
        XCTAssertFalse(flow.connected)
        flow.connectionResult(true)
        XCTAssertFalse(flow.connected)
        XCTAssertTrue(flow.accept(invite.replacingOccurrences(of: "100.64.0.1", with: "100.64.0.2")))
        flow.continueToName()
        XCTAssertEqual(flow.step, .connect)
    }

    func testBackFromNameReturnsToConnectionAndDeepLinkSkipsCamera() {
        var flow = OnboardingFlow()
        flow.accept(InviteCode.parse(invite)!)
        XCTAssertEqual(flow.step, .connect)
        flow.connectionResult(true)
        flow.continueToName()
        flow.back()
        XCTAssertEqual(flow.step, .connect)
        flow.back()
        flow.back()
        XCTAssertEqual(flow.step, .welcome)
    }

    func testScannerAndClipboardDecodePercentEscapesAndTrimWhitespace() {
        let link = InviteCode.parse(" \ntrantor://enroll?hub=https%3A%2F%2Fhub.example%3A443&token=a%2Bb%26c\n")
        XCTAssertEqual(link?.hub, "https://hub.example:443")
        XCTAssertEqual(link?.token, "a+b&c")
    }

    func testScannerRejectsUnrelatedEmptyAmbiguousAndUnsafeInvites() {
        for raw in ["garbage", "https://example.com", "trantor://decisions?hub=http://hub&token=t",
                    "trantor://enroll?hub=http://hub", "trantor://enroll?hub=http://hub&token=%20",
                    "trantor://enroll?hub=file:///tmp/key&token=t", "trantor://enroll?hub=https://user:pass@hub&token=t",
                    "trantor://enroll?hub=http://hub&token=a&token=b", "trantor://enroll?hub=http://hub&hub=http://other&token=t"] {
            XCTAssertNil(InviteCode.parse(raw), raw)
        }
    }

    func testZoomUsesFocusDistanceAndStaysWithinSupportedRange() {
        XCTAssertEqual(ScannerOptics.zoom(minimumFocusDistance: -1, fieldOfView: 60, reticleFraction: 0.7, minimumZoom: 1, maximumZoom: 4), 1)
        XCTAssertEqual(ScannerOptics.zoom(minimumFocusDistance: 200, fieldOfView: 60, reticleFraction: 0.7, minimumZoom: 1, maximumZoom: 4), 4)
        XCTAssertEqual(ScannerOptics.zoom(minimumFocusDistance: 60, fieldOfView: 60, reticleFraction: 0.5, minimumZoom: 1, maximumZoom: 4), 1.732, accuracy: 0.001)
    }

    func testTimeoutGivesTailscaleHint() {
        XCTAssertEqual(HubError.timeout(op: nil).userMessage, "The hub did not answer. Is Tailscale on?")
    }

    func testReachabilityUsesFourSecondsAndRequiresHealthyResponse() async throws {
        let config = URLSessionConfiguration.ephemeral
        config.protocolClasses = [OnboardingURLProtocol.self]
        let session = URLSession(configuration: config)
        defer { session.invalidateAndCancel() }
        try await HubReachability.check("https://healthy.example", session: session)
        for host in ["unhealthy", "forbidden", "malformed", "timeout"] {
            do {
                try await HubReachability.check("https://\(host).example", session: session)
                XCTFail("\(host) must not advance to Name")
            } catch { }
        }
    }
}

private final class OnboardingURLProtocol: URLProtocol {
    override class func canInit(with request: URLRequest) -> Bool { true }
    override class func canonicalRequest(for request: URLRequest) -> URLRequest { request }
    override func startLoading() {
        XCTAssertEqual(request.url?.path, "/health")
        XCTAssertEqual(request.timeoutInterval, 4)
        XCTAssertEqual(request.cachePolicy, .reloadIgnoringLocalCacheData)
        XCTAssertNil(request.url?.query)
        let host = request.url?.host ?? ""
        if host == "timeout.example" {
            client?.urlProtocol(self, didFailWithError: URLError(.timedOut))
            return
        }
        let status = host == "forbidden.example" ? 403 : 200
        let body = host == "malformed.example" ? "not json" : host == "unhealthy.example" ? "{\"ok\":false}" : "{\"ok\":true}"
        let response = HTTPURLResponse(url: request.url!, statusCode: status, httpVersion: "HTTP/1.1", headerFields: nil)!
        client?.urlProtocol(self, didReceive: response, cacheStoragePolicy: .notAllowed)
        client?.urlProtocol(self, didLoad: Data(body.utf8))
        client?.urlProtocolDidFinishLoading(self)
    }
    override func stopLoading() {}
}
