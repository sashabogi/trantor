import Foundation

/// Hub JSON is loose: fields go missing, numbers arrive as strings, unknown keys appear.
/// These helpers return nil instead of throwing, so one odd field never drops a whole row.
extension KeyedDecodingContainer {
    func lenient<T: Decodable>(_ type: T.Type, _ key: Key) -> T? {
        (try? decodeIfPresent(type, forKey: key)) ?? nil
    }

    func lenientString(_ key: Key) -> String {
        if let s = lenient(String.self, key) { return s }
        if let i = lenient(Int.self, key) { return String(i) }
        if let d = lenient(Double.self, key) { return String(d) }
        return ""
    }

    func lenientInt(_ key: Key) -> Int {
        if let i = lenient(Int.self, key) { return i }
        if let d = lenient(Double.self, key) { return Int(d) }
        if let s = lenient(String.self, key), let i = Int(s) { return i }
        return 0
    }

    func lenientDouble(_ key: Key) -> Double {
        if let d = lenient(Double.self, key) { return d }
        if let s = lenient(String.self, key), let d = Double(s) { return d }
        return 0
    }

    func lenientBool(_ key: Key) -> Bool {
        if let b = lenient(Bool.self, key) { return b }
        if let i = lenient(Int.self, key) { return i != 0 }
        return false
    }

    func lenientArray<T: Decodable>(_ type: T.Type, _ key: Key) -> [T] {
        guard var c = try? nestedUnkeyedContainer(forKey: key) else { return [] }
        var out: [T] = []
        while !c.isAtEnd {
            if let v = try? c.decode(T.self) { out.append(v) } else { _ = try? c.decode(JSONValue.self) }
        }
        return out
    }
}

/// Decode an array leniently: bad elements are skipped.
public struct LenientArray<T: Decodable & Sendable>: Decodable, Sendable {
    public let items: [T]
    public init(from decoder: Decoder) throws {
        guard var c = try? decoder.unkeyedContainer() else { items = []; return }
        var out: [T] = []
        while !c.isAtEnd {
            if let v = try? c.decode(T.self) { out.append(v) } else { _ = try? c.decode(JSONValue.self) }
        }
        items = out
    }
}
