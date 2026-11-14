import Foundation

/// The terminals of the machines a client subscribed to, kept current from
/// the core's snapshots and events.
public final class TerminalStore {
    public private(set) var backends: [String: BackendState] = [:]
    private var records: [String: [String: TerminalRecord]] = [:]

    public init() {}

    /// A machine's terminals, oldest first.
    public func terminals(of machine: String) -> [TerminalRecord] {
        (records[machine] ?? [:]).values.sorted {
            ($0.createdMS, $0.address) < ($1.createdMS, $1.address)
        }
    }

    public func terminal(_ address: String, on machine: String) -> TerminalRecord? {
        records[machine]?[address]
    }

    /// Applies a text message of the protocol; true when it changed
    /// something this store holds.
    @discardableResult
    public func apply(_ msg: [String: Any]) -> Bool {
        guard let type = msg["t"] as? String, let machine = msg["m"] as? String else { return false }
        switch type {
        case "backend":
            guard let phase = BackendState.Phase(rawValue: msg["state"] as? String ?? "") else { return false }
            backends[machine] = BackendState(phase: phase, code: msg["code"] as? String ?? "", version: msg["version"] as? String ?? "")
            if phase != .ready { records[machine] = nil }
            return true
        case "snapshot":
            var byAddress: [String: TerminalRecord] = [:]
            for raw in msg["terminals"] as? [[String: Any]] ?? [] {
                let record = TerminalRecord(raw: raw)
                if !record.address.isEmpty { byAddress[record.address] = record }
            }
            records[machine] = byAddress
            return true
        case "event":
            return applyEvent(machine, msg)
        default:
            return false
        }
    }

    // The rules of herdr-core's event table, as the core applies them too.
    private func applyEvent(_ machine: String, _ msg: [String: Any]) -> Bool {
        guard let kind = msg["type"] as? String, let address = msg["terminal"] as? String else { return false }
        let data = msg["data"] as? [String: Any]
        var terms = records[machine] ?? [:]
        defer { records[machine] = terms }
        switch kind {
        case "created", "restarted":
            guard let data else { return false }
            terms[address] = TerminalRecord(raw: data)
        case "removed":
            return terms.removeValue(forKey: address) != nil
        case "labels":
            if let record = data?["record"] as? [String: Any] {
                terms[address] = TerminalRecord(raw: record)
            } else if var term = terms[address] {
                term.raw["labels"] = data?["labels"]
                terms[address] = term
            }
        case "turn":
            guard var term = terms[address] else { return false }
            term.raw["turn"] = data?["turn"]
            terms[address] = term
        case "foreground":
            guard var term = terms[address] else { return false }
            term.raw["foreground"] = data
            terms[address] = term
        default:
            guard var term = terms[address] else { return false }
            for (key, value) in data ?? [:] {
                term.raw[key] = value is NSNull ? nil : value
            }
            if kind == "finished" {
                term.raw["state"] = "finished"
                term.raw["foreground"] = nil
            } else if kind == "lost" {
                term.raw["pid"] = nil
                term.raw["foreground"] = nil
            }
            terms[address] = term
        }
        return true
    }
}
