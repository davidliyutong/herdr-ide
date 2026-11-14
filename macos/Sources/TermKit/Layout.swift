import Foundation

/// What a window shows of one machine: tabs, each a tree of split panes
/// whose leaves are terminals. Stored as a document in the machine's
/// terminal core, so every client of the machine sees the same arrangement.
public struct Layout: Codable, Equatable {
    public static let documentName = "layout"

    public var tabs: [Tab]
    public var selected: Int

    public init(tabs: [Tab] = [], selected: Int = 0) {
        self.tabs = tabs
        self.selected = selected
    }

    public struct Tab: Codable, Equatable {
        public var root: Node
        /// The terminal with the keyboard focus.
        public var focused: String

        public init(root: Node, focused: String) {
            self.root = root
            self.focused = focused
        }
    }

    public enum Axis: String, Codable { case horizontal, vertical }

    /// In the document a leaf is {"terminal": "t1"} and a split
    /// {"split": "horizontal", "ratio": 0.5, "children": [first, second]}.
    public indirect enum Node: Codable, Equatable {
        case terminal(String)
        /// `ratio` is the first child's share of the split, 0 to 1.
        case split(axis: Axis, ratio: Double, first: Node, second: Node)

        private enum Key: String, CodingKey { case terminal, split, ratio, children }

        public init(from decoder: Decoder) throws {
            let c = try decoder.container(keyedBy: Key.self)
            if let address = try c.decodeIfPresent(String.self, forKey: .terminal) {
                self = .terminal(address)
                return
            }
            let children = try c.decode([Node].self, forKey: .children)
            guard children.count == 2 else {
                throw DecodingError.dataCorruptedError(forKey: .children, in: c, debugDescription: "a split has two children")
            }
            let ratio = try c.decodeIfPresent(Double.self, forKey: .ratio) ?? 0.5
            self = .split(axis: try c.decode(Axis.self, forKey: .split), ratio: min(max(ratio, 0.1), 0.9),
                          first: children[0], second: children[1])
        }

        public func encode(to encoder: Encoder) throws {
            var c = encoder.container(keyedBy: Key.self)
            switch self {
            case let .terminal(address):
                try c.encode(address, forKey: .terminal)
            case let .split(axis, ratio, first, second):
                try c.encode(axis, forKey: .split)
                try c.encode(ratio, forKey: .ratio)
                try c.encode([first, second], forKey: .children)
            }
        }

        public var terminals: [String] {
            switch self {
            case let .terminal(address): return [address]
            case let .split(_, _, first, second): return first.terminals + second.terminals
            }
        }

        /// The tree with `address` split in two, the new terminal second.
        public func splitting(_ address: String, axis: Axis, new: String) -> Node {
            switch self {
            case let .terminal(a) where a == address:
                return .split(axis: axis, ratio: 0.5, first: self, second: .terminal(new))
            case .terminal:
                return self
            case let .split(ax, ratio, first, second):
                return .split(axis: ax, ratio: ratio, first: first.splitting(address, axis: axis, new: new),
                              second: second.splitting(address, axis: axis, new: new))
            }
        }

        /// The tree without `address`, nil when nothing is left; the
        /// sibling of a removed leaf takes its parent's place.
        public func removing(_ address: String) -> Node? {
            switch self {
            case let .terminal(a):
                return a == address ? nil : self
            case let .split(axis, ratio, first, second):
                switch (first.removing(address), second.removing(address)) {
                case (nil, nil): return nil
                case let (left?, nil): return left
                case let (nil, right?): return right
                case let (left?, right?): return .split(axis: axis, ratio: ratio, first: left, second: right)
                }
            }
        }

        /// The tree with the ratio of the split at `path` (false: first
        /// child, true: second) set, clamped so both sides stay usable.
        public func settingRatio(_ ratio: Double, at path: ArraySlice<Bool>) -> Node {
            guard case let .split(axis, old, first, second) = self else { return self }
            guard let step = path.first else {
                return .split(axis: axis, ratio: min(max(ratio, 0.1), 0.9), first: first, second: second)
            }
            let rest = path.dropFirst()
            return .split(axis: axis, ratio: old,
                          first: step ? first : first.settingRatio(ratio, at: rest),
                          second: step ? second.settingRatio(ratio, at: rest) : second)
        }
    }

    /// Every terminal the layout shows.
    public var terminals: [String] { tabs.flatMap(\.root.terminals) }

    /// Opens `address` in a new tab and selects it; an open terminal is
    /// selected where it is.
    public mutating func open(_ address: String) {
        if let index = tabs.firstIndex(where: { $0.root.terminals.contains(address) }) {
            selected = index
            tabs[index].focused = address
            return
        }
        tabs.append(Tab(root: .terminal(address), focused: address))
        selected = tabs.count - 1
    }

    /// Splits the focused terminal of the selected tab; false without one.
    @discardableResult
    public mutating func split(_ axis: Axis, new address: String) -> Bool {
        guard tabs.indices.contains(selected) else { return false }
        let focused = tabs[selected].focused
        guard tabs[selected].root.terminals.contains(focused) else { return false }
        tabs[selected].root = tabs[selected].root.splitting(focused, axis: axis, new: address)
        tabs[selected].focused = address
        return true
    }

    /// Removes a terminal from every tab; a tab without terminals goes.
    public mutating func close(_ address: String) {
        var kept: [Tab] = []
        var newSelected = selected
        for (index, tab) in tabs.enumerated() {
            guard let root = tab.root.removing(address) else {
                if index < selected || (index == selected && index == tabs.count - 1) { newSelected -= 1 }
                continue
            }
            var tab = tab
            tab.root = root
            if !root.terminals.contains(tab.focused) { tab.focused = root.terminals[0] }
            kept.append(tab)
        }
        tabs = kept
        selected = kept.isEmpty ? 0 : min(max(newSelected, 0), kept.count - 1)
    }

    /// Drops terminals that no longer exist; true when that changed it.
    @discardableResult
    public mutating func prune(keeping live: Set<String>) -> Bool {
        let gone = terminals.filter { !live.contains($0) }
        gone.forEach { close($0) }
        return !gone.isEmpty
    }
}
