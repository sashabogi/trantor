import LocalAuthentication

@MainActor
public protocol Authenticator {
    func authenticate() async -> Bool
}

public struct DeviceAuthenticator: Authenticator {
    public init() {}

    public func authenticate() async -> Bool {
        let context = LAContext()
        do {
            return try await context.evaluatePolicy(.deviceOwnerAuthentication,
                                                     localizedReason: "Confirm this Trantor decision")
        } catch {
            return false
        }
    }
}
