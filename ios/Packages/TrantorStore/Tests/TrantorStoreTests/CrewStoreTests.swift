import XCTest
import HubClient
import TrantorCore
@testable import TrantorStore

@MainActor
final class CrewStoreTests: XCTestCase {
    private func setup(auth: CrewAuthenticator? = nil) async -> (StubHub, CrewStore) {
        let hub = StubHub()
        hub.chatsData = ["trantor": ChatSnapshot(host: "demo-mac")]
        hub.rosterData = [
            RosterSeat(agent: "glm", spec: "glm", metered: false, available: true),
            RosterSeat(agent: "kimi", spec: "kimi", metered: true, available: true),
            RosterSeat(agent: "deepseek", spec: "deepseek", metered: true, available: false, reason: "No API key"),
            RosterSeat(agent: "claude", spec: "claude", metered: false, available: true),
        ]
        let store = CrewStore(project: "trantor", fleet: FleetStore(api: hub), api: hub, authenticator: auth ?? CrewAuthenticator())
        store.mayControl = { true }
        await store.refresh()
        addTeardownBlock { await store.disconnect() }
        return (hub, store)
    }

    func testRosterUsesOnlyHostingMachineAndNoHostDisablesCommands() async {
        let (hub, store) = await setup()
        hub.rosterMachinesData = [
            CrewRosterMachine(machine: "other-mac", seats: [RosterSeat(agent: "kimi", spec: "kimi", metered: false, available: true)]),
            CrewRosterMachine(machine: "demo-mac", seats: [RosterSeat(agent: "glm", spec: "glm", metered: false, available: true)]),
        ]
        await store.refresh()
        XCTAssertEqual(store.roster.map(\.agent), ["glm"])
        hub.chatsData = [:]
        await store.refresh()
        XCTAssertEqual(store.disabledReason, "No Mac is hosting this project's orchestrator")
        XCTAssertTrue(store.roster.isEmpty)
        let sent = await store.command(.down)
        XCTAssertFalse(sent)
        XCTAssertFalse(hub.calls.contains { $0.hasPrefix("crew:") })
    }

    func testLaunchSpecsAreSentForAddAndSwapAndKeepCostGate() async {
        let (hub, store) = await setup()
        hub.rosterData = [RosterSeat(agent: "glm", spec: "glm:zai-coding-plan", label: "GLM", metered: true, available: true)]
        await store.refresh()
        XCTAssertEqual(store.roster.first?.agent, "glm")
        XCTAssertTrue(store.needsCostConfirmation(seats: ["glm:zai-coding-plan"]))
        let bare = await store.command(.up, seats: ["glm"], costConfirmed: true)
        XCTAssertFalse(bare)
        let unconfirmed = await store.command(.up, seats: ["glm:zai-coding-plan"])
        XCTAssertFalse(unconfirmed)
        XCTAssertFalse(hub.calls.contains { $0.hasPrefix("crew:") })
        let sent = await store.command(.up, seats: ["glm:zai-coding-plan"], costConfirmed: true)
        XCTAssertTrue(sent)
        XCTAssertTrue(hub.calls.contains("crew:trantor:up:[\"glm:zai-coding-plan\"]::"))
        hub.crewCommandsData["1"] = CrewCommandStatus(id: "1", status: "done")
        await store.refreshCommands()
        let swapped = await store.command(.swap, from: "kimi", to: "glm:zai-coding-plan", costConfirmed: true)
        XCTAssertTrue(swapped)
        XCTAssertTrue(hub.calls.contains("crew:trantor:swap:[]:kimi:glm:zai-coding-plan"))
    }

    func testMissingOrInvalidSpecStaysVisibleButCannotLaunch() async {
        let auth = CrewAuthenticator()
        let (hub, store) = await setup(auth: auth)
        for spec in ["", "--all", "claude:opus"] {
            hub.rosterData = [RosterSeat(agent: "glm", spec: spec, metered: false, available: true)]
            await store.refresh()
            XCTAssertEqual(store.roster.count, 1)
            XCTAssertFalse(store.roster[0].available)
            XCTAssertEqual(store.roster[0].reason, "Can't launch this seat from the phone")
            XCTAssertEqual(store.roster[0].launchSpec, spec.isEmpty ? "glm" : spec)
            let up = await store.command(.up, seats: [store.roster[0].launchSpec])
            let swap = await store.command(.swap, from: "kimi", to: store.roster[0].launchSpec)
            XCTAssertFalse(up)
            XCTAssertFalse(swap)
        }
        XCTAssertEqual(auth.calls, 0)
        XCTAssertFalse(hub.calls.contains { $0.hasPrefix("crew:") })
    }

    func testRegexBoundariesAndForbiddenSeat() {
        for spec in ["glm", "codex-9", "kimi:model/v1.0_x-y", "a" + String(repeating: "b", count: 30), "glm:" + String(repeating: "x", count: 80)] {
            XCTAssertTrue(CrewStore.validSpec(spec), spec)
        }
        for spec in ["", "--all", "--help", "Claude", "claude", "claude:opus", "1seat", "glm\n", "glm;touch", "glm:a b", "glm:", "glm:a:b", "a" + String(repeating: "b", count: 31), "glm:" + String(repeating: "x", count: 81)] {
            XCTAssertFalse(CrewStore.validSpec(spec), spec)
        }
    }

    func testValidationAndMeteredConfirmationBeforeAuthentication() async {
        let auth = CrewAuthenticator()
        let (hub, store) = await setup(auth: auth)
        XCTAssertFalse(store.roster.contains { $0.agent == "claude" })
        for seats in [[], ["claude"], ["--all"], ["glm", "glm"], ["unknown"], ["deepseek"], Array(repeating: "glm", count: 7)] {
            let sent = await store.command(.up, seats: seats)
            XCTAssertFalse(sent)
        }
        let unconfirmed = await store.command(.up, seats: ["glm", "kimi"])
        XCTAssertFalse(unconfirmed)
        XCTAssertEqual(store.error, "This seat costs money per token")
        XCTAssertEqual(auth.calls, 0)
        XCTAssertFalse(hub.calls.contains { $0.hasPrefix("crew:") })
        let confirmed = await store.command(.up, seats: ["glm", "kimi"], costConfirmed: true)
        XCTAssertTrue(confirmed)
        XCTAssertEqual(auth.calls, 1)
        XCTAssertEqual(store.commands.first?.status, "queued")
    }

    func testSubscriptionRequiresAuthenticationAndDenialNeverPosts() async {
        let auth = CrewAuthenticator(); auth.allowed = false
        let (hub, store) = await setup(auth: auth)
        let denied = await store.command(.up, seats: ["glm"])
        XCTAssertFalse(denied)
        XCTAssertEqual(store.error, "Not confirmed")
        XCTAssertFalse(hub.calls.contains { $0.hasPrefix("crew:") })
        store.requiresAuthentication = { false }
        let allowed = await store.command(.up, seats: ["glm"])
        XCTAssertTrue(allowed)
        XCTAssertEqual(auth.calls, 1)
    }

    func testProjectFilteringAndSeatStates() async {
        let (hub, store) = await setup()
        hub.peersData = [
            Peer(session: "glm:trantor", online: true, status: "working", project: "trantor", kind: "agent"),
            Peer(session: "kimi:trantor", online: true, status: "idle", project: "trantor", kind: "agent"),
            Peer(session: "codex:trantor", online: false, health: "stale", project: "trantor", kind: "agent"),
            Peer(session: "deepseek:trantor", health: "down", project: "trantor", kind: "agent"),
            Peer(session: "claude:trantor", project: "trantor", kind: "agent"),
            Peer(session: "MacBook:trantor", project: "trantor", kind: "human"),
            Peer(session: "glm:other", project: "other", kind: "agent"),
        ]
        await store.refresh()
        XCTAssertEqual(Set(store.seats.map(CrewStore.spec)), ["glm", "kimi", "codex", "deepseek"])
        XCTAssertEqual(Set(store.seats.map(CrewStore.state)), ["working", "idle", "stale", "down"])
    }

    func testAutomaticPollingToFinalRefreshesFleetAndStopsPolling() async throws {
        let (hub, store) = await setup()
        let sent = await store.command(.up, seats: ["glm"])
        XCTAssertTrue(sent)
        hub.crewStatusSequences = ["1": [CrewCommandStatus(id: "1", status: "claimed"),
                                         CrewCommandStatus(id: "1", status: "done", output: "glm started")]]
        hub.peersData = [Peer(session: "glm:trantor", online: true, status: "working", project: "trantor", kind: "agent")]
        for _ in 0..<70 where store.commands.first?.status != "claimed" {
            try await Task.sleep(for: .milliseconds(50))
        }
        XCTAssertEqual(store.commands.first?.label, "Running")
        for _ in 0..<70 where store.commands.first?.isFinal != true {
            try await Task.sleep(for: .milliseconds(50))
        }
        XCTAssertEqual(store.commands.first?.status, "done")
        XCTAssertEqual(store.commands.first?.output, "glm started")
        XCTAssertEqual(store.seats.first?.session, "glm:trantor")
        let count = hub.calls.filter { $0.hasPrefix("crewStatus:") }.count
        await store.refreshCommands()
        XCTAssertEqual(hub.calls.filter { $0.hasPrefix("crewStatus:") }.count, count)
        XCTAssertFalse(store.busy)
    }

    func testSwapCostGateAndStopCommandShapes() async {
        let (hub, store) = await setup()
        let denied = await store.command(.swap, from: "glm", to: "kimi")
        XCTAssertFalse(denied)
        let swapped = await store.command(.swap, from: "glm", to: "kimi", costConfirmed: true)
        XCTAssertTrue(swapped)
        XCTAssertTrue(hub.calls.contains("crew:trantor:swap:[]:glm:kimi"))
        hub.crewCommandsData = ["1": CrewCommandStatus(id: "1", status: "done")]
        await store.refreshCommands()
        let stopped = await store.command(.down, seats: ["kimi"])
        XCTAssertTrue(stopped)
        XCTAssertTrue(hub.calls.contains("crew:trantor:down:[\"kimi\"]::"))
        hub.crewCommandsData["2"] = CrewCommandStatus(id: "2", status: "done")
        await store.refreshCommands()
        let stoppedAll = await store.command(.down)
        XCTAssertTrue(stoppedAll)
        XCTAssertTrue(hub.calls.contains("crew:trantor:down:[]::"))
    }

    func testFailureExpiryAndTransientPollingErrorPreserveOutput() async {
        for status in ["failed", "expired"] {
            let (hub, store) = await setup()
            _ = await store.command(.up, seats: ["glm"])
            hub.readError = .offline(op: nil)
            await store.refreshCommands()
            XCTAssertEqual(store.commands.first?.status, "queued")
            XCTAssertNotNil(store.error)
            hub.readError = nil
            hub.crewCommandsData = ["1": CrewCommandStatus(id: "1", status: status, output: "CLI failure", error: "No Mac")]
            await store.refreshCommands()
            XCTAssertEqual(store.commands.first?.status, status)
            XCTAssertEqual(store.commands.first?.output, "CLI failure")
            XCTAssertEqual(store.commands.first?.error, "No Mac")
            XCTAssertFalse(store.busy)
        }
    }

    func testScopeAndUnpairDuringAuthenticationPreventWrites() async {
        XCTAssertFalse(CrewStore.allowsControl(scopes: [Scope(project: "*", role: "write")], project: "trantor"))
        XCTAssertFalse(CrewStore.allowsControl(scopes: [Scope(project: "other", role: "owner")], project: "trantor"))
        XCTAssertTrue(CrewStore.allowsControl(scopes: [Scope(project: "*", role: "approver")], project: "trantor"))
        let auth = CrewAuthenticator(); auth.suspended = true
        let (hub, store) = await setup(auth: auth)
        let sending = Task { await store.command(.up, seats: ["glm"]) }
        for _ in 0..<100 where auth.continuation == nil { await Task.yield() }
        store.disconnect()
        auth.continuation?.resume(returning: true)
        let sent = await sending.value
        XCTAssertFalse(sent)
        XCTAssertTrue(store.commands.isEmpty)
        XCTAssertFalse(hub.calls.contains { $0.hasPrefix("crew:") })
    }

    func testConcurrentTapAndDisconnectDuringPost() async {
        let (hub, store) = await setup()
        hub.holdWrites()
        let sending = Task { await store.command(.up, seats: ["glm"]) }
        for _ in 0..<100 where !hub.calls.contains(where: { $0.hasPrefix("crew:") }) { await Task.yield() }
        let duplicate = await store.command(.up, seats: ["glm"])
        XCTAssertFalse(duplicate)
        store.disconnect(); hub.releaseWrites()
        let sent = await sending.value
        XCTAssertFalse(sent)
        XCTAssertEqual(hub.calls.filter { $0.hasPrefix("crew:") }.count, 1)
        XCTAssertTrue(store.commands.isEmpty)
    }

    func testReconcileCommittedOperationWithoutRepeatingCommand() async throws {
        let (hub, store) = await setup()
        hub.writeError = .timeout(op: "op-crew")
        hub.outcome = OpOutcome(status: "committed", code: 200, body: .object(["id": .number(7), "status": .string("queued")]))
        let sent = await store.command(.up, seats: ["glm"])
        XCTAssertTrue(sent)
        XCTAssertEqual(store.commands.first?.id, "7")
        XCTAssertTrue(hub.calls.contains("reconcile:op-crew"))
        XCTAssertEqual(hub.calls.filter { $0.hasPrefix("crew:") }.count, 1)
    }

    func testAppModelUsesSharedAuthenticatorAndPerProjectStore() async {
        let auth = CrewAuthenticator(); auth.allowed = false
        let hub = StubHub()
        hub.chatsData = ["trantor": ChatSnapshot(host: "demo-mac")]
        let model = AppModel(stub: hub, demo: true, authenticator: auth)
        model.settings.requireBiometrics = true
        let store = model.crew(project: "trantor")
        XCTAssertTrue(store === model.crew(project: "trantor"))
        XCTAssertFalse(store === model.crew(project: "another"))
        await store.refresh()
        _ = await store.command(.down)
        XCTAssertEqual(auth.calls, 1)
        XCTAssertFalse(hub.calls.contains { $0.hasPrefix("crew:") })
        model.settings.requireBiometrics = false
        _ = await store.command(.down)
        XCTAssertTrue(hub.calls.contains("crew:trantor:down:[]::"))
        await model.unpair()
        XCTAssertNil(store.api)
        XCTAssertTrue(store.commands.isEmpty)
    }
}

@MainActor
private final class CrewAuthenticator: Authenticator {
    var calls = 0
    var allowed = true
    var suspended = false
    var continuation: CheckedContinuation<Bool, Never>?
    func authenticate() async -> Bool {
        calls += 1
        if suspended { return await withCheckedContinuation { continuation = $0 } }
        return allowed
    }
}
