import XCTest
import HubClient
import TrantorCore
@testable import TrantorStore

@MainActor
final class ChatAnswerTests: XCTestCase {
    private func snapshot(session: String = "s1", tool: String = "q1", answer: String? = nil, multi: Bool = false, count: Int = 1) -> ChatSnapshot {
        let question = ChatQuestion(question: "Which?", options: [.init(label: "A"), .init(label: "B")], multiSelect: multi)
        return ChatSnapshot(session: session, total: 1, turns: [ChatTurn(idx: 0, role: "assistant", blocks: [
            ChatBlock(kind: "ask", ask: Array(repeating: question, count: count), toolID: tool, answer: answer),
        ])], host: "mac")
    }

    private func store(_ hub: StubHub, auth: AnswerAuthenticator = AnswerAuthenticator()) -> ChatStore {
        let store = ChatStore(project: "trantor", api: hub, authenticator: auth)
        store.mayWrite = { true }
        store.merge(snapshot())
        return store
    }

    func testSendingWaitsForAckAndPublishedAnswerWinsOverReceipts() async {
        let hub = StubHub(), auth = AnswerAuthenticator()
        let store = store(hub, auth: auth)
        hub.holdWrites()
        let task = Task { await store.answer(toolId: "q1", picks: [1]) }
        for _ in 0..<100 where hub.calls.isEmpty { await Task.yield() }
        XCTAssertEqual(auth.calls, 1)
        XCTAssertEqual(store.answers["q1"], .sending)
        await store.answer(toolId: "q1", picks: [0])
        XCTAssertEqual(hub.calls.filter { $0.hasPrefix("answer:") }.count, 1)
        hub.releaseWrites()
        await task.value
        XCTAssertEqual(store.answers["q1"], .sending)
        hub.promptsData = ["1": PromptStatus(id: "1", status: "delivered")]
        await store.refreshReceipts()
        XCTAssertEqual(store.answers["q1"], .delivered)
        store.merge(snapshot(answer: "B"))
        XCTAssertEqual(store.answers["q1"], .answered("B"))
        hub.promptsData = ["1": PromptStatus(id: "1", status: "failed", outcome: "stale")]
        await store.refreshReceipts()
        XCTAssertEqual(store.answers["q1"], .answered("B"))
    }

    func testStaleAckExplainsAndPreventsResubmission() async {
        let hub = StubHub(), store = store(StubHub())
        store.api = hub
        await store.answer(toolId: "q1", picks: [0])
        hub.promptsData = ["1": PromptStatus(id: "1", status: "failed", outcome: "stale")]
        await store.refreshReceipts()
        XCTAssertEqual(store.answers["q1"], .stale("That question was already answered or replaced."))
        await store.answer(toolId: "q1", picks: [1])
        XCTAssertEqual(hub.calls.filter { $0.hasPrefix("answer:") }.count, 1)
    }

    func testAuthenticationDenialAndSettingsGate() async {
        let hub = StubHub(), auth = AnswerAuthenticator()
        auth.allowed = false
        let store = store(hub, auth: auth)
        await store.answer(toolId: "q1", picks: [0])
        XCTAssertEqual(store.answers["q1"], .failed("Not confirmed"))
        XCTAssertTrue(hub.calls.isEmpty)
        store.requiresAuthentication = { false }
        await store.answer(toolId: "q1", picks: [0])
        XCTAssertEqual(auth.calls, 1)
        XCTAssertTrue(hub.calls.contains("answer:trantor:s1:q1:[0]:"))
    }

    func testReplacementWhileAuthenticatingNeverWrites() async {
        let hub = StubHub(), auth = AnswerAuthenticator()
        auth.suspended = true
        let store = store(hub, auth: auth)
        let task = Task { await store.answer(toolId: "q1", picks: [0]) }
        for _ in 0..<100 where auth.continuation == nil { await Task.yield() }
        store.merge(snapshot(tool: "q2"))
        auth.resume()
        await task.value
        XCTAssertTrue(hub.calls.isEmpty)
        XCTAssertEqual(store.answers["q1"], .stale("That question was already answered or replaced."))
    }

    func testAnswerPublishedWhilePostPendingCannotRegress() async {
        let hub = StubHub(), store = store(StubHub())
        store.api = hub
        hub.holdWrites()
        let task = Task { await store.answer(toolId: "q1", picks: [0]) }
        for _ in 0..<100 where hub.calls.isEmpty { await Task.yield() }
        store.merge(snapshot(answer: "A"))
        hub.releaseWrites()
        await task.value
        XCTAssertEqual(store.answers["q1"], .answered("A"))
    }

    func testMultiSelectOtherValidationAndMultiQuestionReadOnly() async {
        let hub = StubHub(), store = store(StubHub())
        store.api = hub
        store.merge(snapshot(multi: true))
        await store.answer(toolId: "q1", picks: [1, 0], other: "  custom  ")
        XCTAssertTrue(hub.calls.contains("answer:trantor:s1:q1:[0, 1]:custom"))
        for (picks, other) in [([2], nil), ([0, 1], nil), ([], ""), ([], String(repeating: "a", count: 2001))] as [([Int], String?)] {
            let invalidHub = StubHub(), invalid = self.store(StubHub())
            invalid.api = invalidHub
            await invalid.answer(toolId: "q1", picks: picks, other: other)
            XCTAssertTrue(invalidHub.calls.isEmpty)
        }
        let readonly = self.store(hub)
        readonly.merge(snapshot(count: 2))
        await readonly.answer(toolId: "q1", picks: [0])
        XCTAssertEqual(readonly.answers["q1"], .failed("Answer it on the Mac"))
        let textHub = StubHub(), textStore = self.store(StubHub())
        textStore.api = textHub
        await textStore.answer(toolId: "q1", picks: [], other: "Custom")
        XCTAssertTrue(textHub.calls.contains("answer:trantor:s1:q1:[]:Custom"))
    }

    func testWriteAccessAndLiveConnectionAreRequired() async {
        let hub = StubHub(), store = store(StubHub())
        store.api = hub
        store.mayWrite = { false }
        await store.answer(toolId: "q1", picks: [0])
        XCTAssertTrue(hub.calls.isEmpty)
        let cached = ChatStore(project: "trantor", api: hub)
        cached.mayWrite = { true }
        await cached.answer(toolId: "q1", picks: [0])
        XCTAssertTrue(hub.calls.isEmpty)
    }

    func testNetworkReconciliationAndFailures() async {
        let hub = StubHub(), store = store(StubHub())
        store.api = hub
        hub.writeError = .timeout(op: "op-1")
        hub.outcome = OpOutcome(status: "committed", code: 200,
                               body: .object(["id": .string("receipt"), "status": .string("queued")]))
        await store.answer(toolId: "q1", picks: [0])
        XCTAssertEqual(store.answers["q1"], .sending)
        hub.promptsData = ["receipt": PromptStatus(id: "receipt", status: "expired")]
        await store.refreshReceipts()
        XCTAssertEqual(store.answers["q1"], .failed(PromptStatus(status: "expired").failureReason))
        hub.outcome = nil
        await store.answer(toolId: "q1", picks: [1])
        XCTAssertEqual(store.answers["q1"], .stale("Delivery is unconfirmed. Check the question on your Mac before answering again."))
    }

    func testDisconnectDuringPostDoesNotRestoreState() async {
        let hub = StubHub(), store = store(StubHub())
        store.api = hub
        hub.holdWrites()
        let task = Task { await store.answer(toolId: "q1", picks: [0]) }
        for _ in 0..<100 where hub.calls.isEmpty { await Task.yield() }
        store.disconnect()
        hub.releaseWrites()
        await task.value
        XCTAssertTrue(store.answers.isEmpty)
        XCTAssertFalse(store.hasLiveSnapshot)
    }

    func testAppModelSharesAuthenticatorAndSettingWithChat() async {
        let hub = StubHub(), auth = AnswerAuthenticator()
        auth.allowed = false
        let model = AppModel(stub: hub, demo: true, authenticator: auth)
        let store = model.chat(project: "trantor")
        store.merge(snapshot())
        model.settings.requireBiometrics = true
        await store.answer(toolId: "q1", picks: [0])
        XCTAssertTrue(hub.calls.isEmpty)
        model.settings.requireBiometrics = false
        await store.answer(toolId: "q1", picks: [1])
        XCTAssertEqual(auth.calls, 1)
        XCTAssertTrue(hub.calls.contains("answer:trantor:s1:q1:[1]:"))
    }
}

@MainActor
private final class AnswerAuthenticator: Authenticator {
    var allowed = true
    var calls = 0
    var suspended = false
    var continuation: CheckedContinuation<Bool, Never>?
    func authenticate() async -> Bool {
        calls += 1
        if suspended { return await withCheckedContinuation { continuation = $0 } }
        return allowed
    }
    func resume() { continuation?.resume(returning: allowed); continuation = nil }
}
