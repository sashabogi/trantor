import Foundation

/// Which network a hub address lives on. Only a plain-http hub on Tailscale's CGNAT range
/// (100.64.0.0/10) should ever suggest Tailscale; an https hub is reachable over the internet.
public enum HubNetwork {
    /// A 100.x address: 100.64.0.0 through 100.127.255.255.
    public static func isTailnetHost(_ host: String?) -> Bool {
        guard let host, host.hasPrefix("100.") else { return false }
        guard let second = host.split(separator: ".").dropFirst().first, let octet = Int(second) else { return false }
        return (64...127).contains(octet)
    }

    public static func needsTailscale(_ hub: URL) -> Bool {
        (hub.scheme ?? "http").lowercased() == "http" && isTailnetHost(hub.host)
    }

    public static func needsTailscale(_ hub: String) -> Bool {
        guard let url = URL(string: hub) else { return false }
        return needsTailscale(url)
    }
}
