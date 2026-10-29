import SwiftUI
import UIKit
import XCTest
import TrantorDesign
import TrantorStore
@testable import Features

@MainActor
final class DuoNavigationTests: XCTestCase {
    @Observable final class Pose {
        var sizeClass: UserInterfaceSizeClass = .compact
    }

    private struct Harness: View {
        let model: AppModel
        let pose: Pose
        var body: some View {
            RootView().environment(model)
                .environment(\.horizontalSizeClass, pose.sizeClass)
                .trantorTheme()
        }
    }

    func testChatAndDraftSurviveCompactRegularCompact() async throws {
        let scene = try XCTUnwrap(UIApplication.shared.connectedScenes.first as? UIWindowScene)
        let previous = scene.windows.first(where: \.isKeyWindow)
        let model = AppModel(stub: DemoData.hub(), demo: true)
        await model.refreshAll()
        model.selection = .projects
        let pose = Pose()
        let host = UIHostingController(rootView: Harness(model: model, pose: pose))
        let window = UIWindow(windowScene: scene)
        window.frame = scene.screen.bounds
        window.rootViewController = host
        window.makeKeyAndVisible()
        defer {
            model.stopFeed()
            window.isHidden = true
            window.rootViewController = nil
            previous?.makeKeyAndVisible()
        }
        try await settle(window)
        model.openProject = "trantor"
        model.openProjectSection = "chat"
        try await settle(window)
        let draft = "Keep this project draft through both display changes."
        let editor = try XCTUnwrap(descendants(window).compactMap { $0 as? UITextView }.first)
        editor.text = draft
        editor.delegate?.textViewDidChange?(editor)
        try await settle(window)
        XCTAssertEqual(model.chat(project: "trantor").draft, draft)
        let navigation = try XCTUnwrap(controllers(host).compactMap { $0 as? UINavigationController }
            .first { $0.viewIfLoaded?.window != nil && $0.viewControllers.count > 1 })
        let destination = try XCTUnwrap(navigation.topViewController)

        for sizeClass: UserInterfaceSizeClass in [.regular, .compact] {
            pose.sizeClass = sizeClass
            try await settle(window)
            XCTAssertEqual(model.selection, .projects)
            XCTAssertEqual(model.openProject, "trantor")
            XCTAssertEqual(model.chat(project: "trantor").draft, draft)
            XCTAssertTrue(controllers(host).contains { $0 === destination }, "The displayed chat must survive, not be reconstructed")
            XCTAssertTrue(destination.viewIfLoaded?.window === window)
            XCTAssertTrue(descendants(window).compactMap { $0 as? UITextView }.contains { $0.text == draft },
                          "The draft must remain visible in the composer")
            let attachment = XCTAttachment(image: UIGraphicsImageRenderer(bounds: window.bounds).image { _ in
                window.drawHierarchy(in: window.bounds, afterScreenUpdates: true)
            })
            attachment.name = sizeClass == .regular ? "chat-open-size-class" : "chat-closed-size-class"
            attachment.lifetime = .keepAlways
            add(attachment)
        }
    }

    func testSingleColumnControlsAvoidVerticalAndHorizontalDivisions() {
        let available = CGRect(x: 0, y: 0, width: 800, height: 600)
        let vertical = CGRect(x: 390, y: 0, width: 20, height: 600)
        let right = duoSingleColumnBounds(in: available, divisions: [vertical], toolbarEdge: .trailing)
        XCTAssertEqual(right, CGRect(x: 410, y: 0, width: 390, height: 600))
        XCTAssertFalse(right.intersects(vertical))
        let horizontal = CGRect(x: 0, y: 290, width: 800, height: 20)
        let bottom = duoSingleColumnBounds(in: available, divisions: [horizontal], toolbarEdge: nil)
        XCTAssertEqual(bottom, CGRect(x: 0, y: 310, width: 800, height: 290))
        XCTAssertFalse(bottom.intersects(horizontal))
        XCTAssertEqual(duoSingleColumnBounds(in: available, divisions: [], toolbarEdge: .trailing), available)
        XCTAssertEqual(duoSingleColumnBounds(in: available, divisions: [vertical], toolbarEdge: .leading),
                       CGRect(x: 0, y: 0, width: 390, height: 600))
    }

    private func settle(_ window: UIWindow) async throws {
        try await Task.sleep(for: .seconds(1))
        window.layoutIfNeeded()
    }

    private func descendants(_ view: UIView) -> [UIView] {
        [view] + view.subviews.flatMap(descendants)
    }

    private func controllers(_ controller: UIViewController) -> [UIViewController] {
        [controller] + controller.children.flatMap(controllers)
    }
}
