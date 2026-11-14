import Foundation

/// The arrangement of a machine's terminals that every client shares:
/// workspaces (a name and a directory), each with tabs, each a tree of split
/// panes whose leaves are terminals. It is the document `layout` in the
/// machine's terminal core (docs/features/22-terminal-protocol.md).
/// web/src/term/layout.ts implements the same operations, and both run the
/// vectors in design/testdata/layout. Fields this version does not know are
/// kept at every level and written back.
public struct Layout: Equatable {
    public static let documentName = "layout"
    /// The id of the workspace a version 1 document's tabs are read into.
    public static let defaultWorkspaceID = "default"

    public typealias Extra = [String: JSONValue]

    public var workspaces: [Workspace]
    public var selected: Int
    public var extra: Extra

    public init(workspaces: [Workspace] = [], selected: Int = 0, extra: Extra = [:]) {
        self.workspaces = workspaces
        self.selected = selected
        self.extra = extra
    }

    public enum Axis: String { case horizontal, vertical }

    /// In the document a leaf is {"terminal": "t1"} and a split
    /// {"split": "horizontal", "ratio": 0.5, "children": [first, second]};
    /// `ratio` is the first child's share, 0.1 to 0.9.
    public indirect enum Node: Equatable {
        case terminal(String, extra: Extra = [:])
        case split(Axis, ratio: Double, first: Node, second: Node, extra: Extra = [:])
        /// A node of a kind this version does not know, kept as it is.
        case other(JSONValue)
    }

    public struct Tab: Equatable {
        /// Set only when the user named the tab.
        public var name: String?
        public var root: Node
        /// The terminal with the keyboard focus.
        public var focused: String
        public var extra: Extra

        public init(name: String? = nil, root: Node, focused: String, extra: Extra = [:]) {
            self.name = name
            self.root = root
            self.focused = focused
            self.extra = extra
        }
    }

    public struct Workspace: Equatable {
        public var id: String
        public var name: String
        /// Where new terminals start; empty for none.
        public var cwd: String
        public var tabs: [Tab]
        public var selected: Int
        public var extra: Extra

        public init(id: String, name: String, cwd: String = "", tabs: [Tab] = [], selected: Int = 0, extra: Extra = [:]) {
            self.id = id
            self.name = name
            self.cwd = cwd
            self.tabs = tabs
            self.selected = selected
            self.extra = extra
        }

        public var terminals: [String] { tabs.flatMap(\.root.terminals) }
        public var selectedTab: Tab? { tabs.indices.contains(selected) ? tabs[selected] : nil }
    }

    // MARK: - Reading and writing the document

    /// The layout a document's value holds. A version 1 document (tabs at
    /// the top) is one workspace with those tabs; anything unreadable is
    /// left out.
    public init(document value: JSONValue?) {
        self.init()
        guard var fields = value?.object else { return }
        let rawWorkspaces = fields["workspaces"]?.array
        let tabs = fields["tabs"]?.array
        let rawSelected = fields["selected"]
        for key in ["version", "workspaces", "selected"] { fields[key] = nil }
        if let rawWorkspaces {
            var seen: Set<String> = []
            for raw in rawWorkspaces {
                guard let workspace = Workspace(raw, seen: seen) else { continue }
                seen.insert(workspace.id)
                workspaces.append(workspace)
            }
            selected = Self.index(rawSelected, count: workspaces.count)
        } else {
            fields["tabs"] = nil
            if let tabs {
                let raw: JSONValue = .object(["id": .string(Self.defaultWorkspaceID), "tabs": .array(tabs), "selected": rawSelected ?? .null])
                workspaces = [Workspace(raw, seen: [])!]
            }
        }
        extra = fields
    }

    /// The document's value, always version 2.
    public var document: JSONValue {
        var fields = extra
        fields["version"] = .number(2)
        fields["workspaces"] = .array(workspaces.map(\.document))
        fields["selected"] = .number(Double(selected))
        return .object(fields)
    }

    static func clamp(_ index: Int, _ count: Int) -> Int { count > 0 ? min(max(index, 0), count - 1) : 0 }

    /// An index the document holds: a whole number, clamped to the list.
    static func index(_ value: JSONValue?, count: Int) -> Int {
        guard let number = value?.number, number.isFinite, number == number.rounded() else { return 0 }
        return clamp(Int(min(max(number, -1), Double(max(count, 1)))), count)
    }

    /// A short random id for a new workspace.
    public static func newWorkspaceID() -> String {
        let alphabet = Array("abcdefghijklmnopqrstuvwxyz0123456789")
        return String((0..<8).map { _ in alphabet.randomElement()! })
    }

    // MARK: - Reading the layout

    public var terminals: [String] { workspaces.flatMap(\.terminals) }
    public var selectedWorkspace: Workspace? { workspaces.indices.contains(selected) ? workspaces[selected] : nil }
    public var selectedTab: Tab? { selectedWorkspace?.selectedTab }
    public var focusedTerminal: String? { selectedTab.flatMap { $0.focused.isEmpty ? nil : $0.focused } }

    public func workspaceIndex(_ id: String) -> Int? { workspaces.firstIndex { $0.id == id } }

    /// Where a terminal is: the indexes of its workspace and tab.
    public func locate(_ address: String) -> (workspace: Int, tab: Int)? {
        for (w, workspace) in workspaces.enumerated() {
            if let t = workspace.tabs.firstIndex(where: { $0.root.terminals.contains(address) }) { return (w, t) }
        }
        return nil
    }

    private func leaf(_ address: String) -> Node? {
        guard let at = locate(address) else { return nil }
        return workspaces[at.workspace].tabs[at.tab].root.leaf(address)
    }

    // MARK: - Workspaces

    /// Adds an empty workspace at the end and selects it; nothing for an id in use.
    public mutating func createWorkspace(id: String, name: String, cwd: String = "") {
        guard !id.isEmpty, workspaceIndex(id) == nil else { return }
        workspaces.append(Workspace(id: id, name: name, cwd: cwd))
        selected = workspaces.count - 1
    }

    public mutating func renameWorkspace(_ id: String, to name: String) {
        if let index = workspaceIndex(id) { workspaces[index].name = name }
    }

    /// Removes a workspace with its tabs; its terminals keep running until
    /// the caller ends them.
    public mutating func closeWorkspace(_ id: String) {
        guard let index = workspaceIndex(id) else { return }
        selected = Self.afterRemoval(selected, index, workspaces.count)
        workspaces.remove(at: index)
    }

    public mutating func moveWorkspace(_ id: String, to: Int) {
        guard let from = workspaceIndex(id) else { return }
        let target = Self.clamp(to, workspaces.count)
        guard from != target else { return }
        workspaces.insert(workspaces.remove(at: from), at: target)
        selected = Self.afterMove(selected, from, target)
    }

    public mutating func selectWorkspace(_ id: String) {
        if let index = workspaceIndex(id) { selected = index }
    }

    // MARK: - Tabs

    /// Names a tab; an empty name gives it its terminal's name again.
    public mutating func renameTab(_ tab: Int, in workspace: String, to name: String) {
        guard let w = workspaceIndex(workspace), workspaces[w].tabs.indices.contains(tab) else { return }
        workspaces[w].tabs[tab].name = name.isEmpty ? nil : name
    }

    /// Removes a tab; its terminals keep running until the caller ends them.
    public mutating func closeTab(_ tab: Int, in workspace: String) {
        guard let w = workspaceIndex(workspace), workspaces[w].tabs.indices.contains(tab) else { return }
        workspaces[w].selected = Self.afterRemoval(workspaces[w].selected, tab, workspaces[w].tabs.count)
        workspaces[w].tabs.remove(at: tab)
    }

    public mutating func moveTab(_ from: Int, to: Int, in workspace: String) {
        guard let w = workspaceIndex(workspace), workspaces[w].tabs.indices.contains(from) else { return }
        let target = Self.clamp(to, workspaces[w].tabs.count)
        guard from != target else { return }
        workspaces[w].tabs.insert(workspaces[w].tabs.remove(at: from), at: target)
        workspaces[w].selected = Self.afterMove(workspaces[w].selected, from, target)
    }

    /// Selects a tab and its workspace.
    public mutating func selectTab(_ tab: Int, in workspace: String) {
        guard let w = workspaceIndex(workspace), workspaces[w].tabs.indices.contains(tab) else { return }
        workspaces[w].selected = tab
        selected = w
    }

    // MARK: - Terminals

    /// Selects a terminal's workspace and tab and gives it the focus.
    public mutating func focus(_ address: String) {
        guard let at = locate(address) else { return }
        selected = at.workspace
        workspaces[at.workspace].selected = at.tab
        workspaces[at.workspace].tabs[at.tab].focused = address
    }

    /// Opens a terminal in a new tab of a workspace (the selected one by
    /// default) and selects it; an open one is focused where it is.
    public mutating func open(_ address: String, in workspace: String? = nil) {
        guard !address.isEmpty else { return }
        if locate(address) != nil { return focus(address) }
        var w = selected
        if let workspace {
            guard let index = workspaceIndex(workspace) else { return }
            w = index
        }
        guard workspaces.indices.contains(w) else { return }
        workspaces[w].tabs.append(Tab(root: .terminal(address), focused: address))
        workspaces[w].selected = workspaces[w].tabs.count - 1
        selected = w
    }

    /// Splits the focused terminal of the selected tab, the new terminal
    /// second and focused; false when there is none to split.
    @discardableResult
    public mutating func split(_ axis: Axis, new address: String) -> Bool {
        guard let tab = selectedTab, !address.isEmpty, locate(address) == nil, tab.root.terminals.contains(tab.focused) else { return false }
        let w = selected, t = workspaces[w].selected
        workspaces[w].tabs[t].root = tab.root.splitting(tab.focused, axis: axis, with: .terminal(address), before: false)
        workspaces[w].tabs[t].focused = address
        return true
    }

    /// Removes a terminal from every tab: its sibling takes its parent's
    /// place and the focus, and a tab without terminals goes. Workspaces stay.
    public mutating func close(_ address: String) {
        for w in workspaces.indices where workspaces[w].terminals.contains(address) {
            let workspace = workspaces[w]
            var kept: [Tab] = []
            var selected = workspace.selected
            for (index, tab) in workspace.tabs.enumerated() {
                guard tab.root.terminals.contains(address) else {
                    kept.append(tab)
                    continue
                }
                guard let root = tab.root.removing(address) else {
                    if index < workspace.selected || (index == workspace.selected && index == workspace.tabs.count - 1) { selected -= 1 }
                    continue
                }
                var next = tab
                next.root = root
                let terminals = root.terminals
                if !terminals.contains(tab.focused) {
                    next.focused = tab.root.sibling(of: address)?.terminals.first ?? terminals.first ?? ""
                }
                kept.append(next)
            }
            workspaces[w].tabs = kept
            workspaces[w].selected = Self.clamp(selected, kept.count)
        }
    }

    /// Drops terminals that no longer exist; true when that changed it.
    @discardableResult
    public mutating func prune(keeping live: Set<String>) -> Bool {
        let gone = terminals.filter { !live.contains($0) }
        gone.forEach { close($0) }
        return !gone.isEmpty
    }

    /// Sets the ratio of the split at `path` (false: first child, true:
    /// second) in the selected tab.
    public mutating func setRatio(_ ratio: Double, at path: [Bool]) {
        guard let tab = selectedTab, ratio.isFinite else { return }
        workspaces[selected].tabs[workspaces[selected].selected].root = tab.root.settingRatio(ratio, at: path[...])
    }

    /// Swaps the panes of two terminals, also across tabs and workspaces;
    /// each tab keeps its focus on the pane's place.
    public mutating func swap(_ a: String, _ b: String) {
        guard a != b, let leafA = leaf(a), let leafB = leaf(b) else { return }
        for w in workspaces.indices {
            for t in workspaces[w].tabs.indices {
                var tab = workspaces[w].tabs[t]
                tab.root = tab.root.replacingLeaves([a: leafB, b: leafA])
                if !tab.root.terminals.contains(tab.focused) {
                    if tab.focused == a { tab.focused = b } else if tab.focused == b { tab.focused = a }
                }
                workspaces[w].tabs[t] = tab
            }
        }
    }

    /// Moves a terminal's pane beside another terminal's (after it, or
    /// before), selects it and gives it the focus.
    public mutating func move(_ address: String, beside target: String, axis: Axis, before: Bool = false) {
        guard address != target, let leaf = leaf(address), locate(target) != nil else { return }
        close(address)
        guard let at = locate(target) else { return }
        let root = workspaces[at.workspace].tabs[at.tab].root
        workspaces[at.workspace].tabs[at.tab].root = root.splitting(target, axis: axis, with: leaf, before: before)
        workspaces[at.workspace].tabs[at.tab].focused = address
        workspaces[at.workspace].selected = at.tab
        selected = at.workspace
    }

    /// Moves a terminal's pane into a new tab at the end of a workspace and
    /// selects it.
    public mutating func moveToNewTab(_ address: String, in workspace: String) {
        guard let leaf = leaf(address), workspaceIndex(workspace) != nil else { return }
        close(address)
        guard let w = workspaceIndex(workspace) else { return }
        workspaces[w].tabs.append(Tab(root: leaf, focused: address))
        workspaces[w].selected = workspaces[w].tabs.count - 1
        selected = w
    }

    /// The selection after moving the item at `from` to `to`: it stays on its item.
    static func afterMove(_ selected: Int, _ from: Int, _ to: Int) -> Int {
        if selected == from { return to }
        if from < selected, selected <= to { return selected - 1 }
        if to <= selected, selected < from { return selected + 1 }
        return selected
    }

    /// The selection after removing the item at `index` of `count`: its
    /// next item, else the one before.
    static func afterRemoval(_ selected: Int, _ index: Int, _ count: Int) -> Int {
        clamp(index < selected || (index == selected && index == count - 1) ? selected - 1 : selected, count - 1)
    }
}

// MARK: - Nodes

extension Layout.Node {
    public var terminals: [String] {
        switch self {
        case let .terminal(address, _): return [address]
        case let .split(_, _, first, second, _): return first.terminals + second.terminals
        case .other: return []
        }
    }

    /// The tree with the leaf of `target` split in two, `node` after it
    /// (or before).
    func splitting(_ target: String, axis: Layout.Axis, with node: Layout.Node, before: Bool) -> Layout.Node {
        switch self {
        case let .terminal(address, _) where address == target:
            return before ? .split(axis, ratio: 0.5, first: node, second: self) : .split(axis, ratio: 0.5, first: self, second: node)
        case let .split(ax, ratio, first, second, extra):
            return .split(ax, ratio: ratio, first: first.splitting(target, axis: axis, with: node, before: before),
                          second: second.splitting(target, axis: axis, with: node, before: before), extra: extra)
        default:
            return self
        }
    }

    /// The tree without the leaf of `address`, nil when nothing is left;
    /// the sibling of a removed leaf takes its parent's place.
    func removing(_ address: String) -> Layout.Node? {
        switch self {
        case let .terminal(a, _):
            return a == address ? nil : self
        case let .split(axis, ratio, first, second, extra):
            switch (first.removing(address), second.removing(address)) {
            case (nil, nil): return nil
            case let (left?, nil): return left
            case let (nil, right?): return right
            case let (left?, right?): return .split(axis, ratio: ratio, first: left, second: right, extra: extra)
            }
        case .other:
            return self
        }
    }

    /// The other child of the split holding the leaf of `address`.
    func sibling(of address: String) -> Layout.Node? {
        guard case let .split(_, _, first, second, _) = self else { return nil }
        if case let .terminal(a, _) = first, a == address { return second }
        if case let .terminal(b, _) = second, b == address { return first }
        return first.sibling(of: address) ?? second.sibling(of: address)
    }

    func leaf(_ address: String) -> Layout.Node? {
        switch self {
        case let .terminal(a, _): return a == address ? self : nil
        case let .split(_, _, first, second, _): return first.leaf(address) ?? second.leaf(address)
        case .other: return nil
        }
    }

    func replacingLeaves(_ leaves: [String: Layout.Node]) -> Layout.Node {
        switch self {
        case let .terminal(address, _): return leaves[address] ?? self
        case let .split(axis, ratio, first, second, extra):
            return .split(axis, ratio: ratio, first: first.replacingLeaves(leaves), second: second.replacingLeaves(leaves), extra: extra)
        case .other: return self
        }
    }

    /// The tree with the ratio of the split at `path` set, clamped so both
    /// sides stay usable; a path that does not end at a split changes nothing.
    public func settingRatio(_ ratio: Double, at path: ArraySlice<Bool>) -> Layout.Node {
        guard case let .split(axis, old, first, second, extra) = self else { return self }
        guard let step = path.first else {
            return .split(axis, ratio: min(max(ratio, 0.1), 0.9), first: first, second: second, extra: extra)
        }
        let rest = path.dropFirst()
        return .split(axis, ratio: old, first: step ? first : first.settingRatio(ratio, at: rest),
                      second: step ? second.settingRatio(ratio, at: rest) : second, extra: extra)
    }

    init(_ value: JSONValue) {
        guard var fields = value.object else {
            self = .other(value)
            return
        }
        if let address = fields["terminal"]?.string, !address.isEmpty {
            fields["terminal"] = nil
            self = .terminal(address, extra: fields)
            return
        }
        guard let axis = fields["split"]?.string.flatMap(Layout.Axis.init(rawValue:)),
              let children = fields["children"]?.array, children.count == 2,
              children.allSatisfy({ $0.object != nil }) else {
            self = .other(value)
            return
        }
        let ratio = fields["ratio"]?.number.map { min(max($0, 0.1), 0.9) } ?? 0.5
        for key in ["split", "ratio", "children"] { fields[key] = nil }
        self = .split(axis, ratio: ratio, first: Layout.Node(children[0]), second: Layout.Node(children[1]), extra: fields)
    }

    var document: JSONValue {
        switch self {
        case let .terminal(address, extra):
            var fields = extra
            fields["terminal"] = .string(address)
            return .object(fields)
        case let .split(axis, ratio, first, second, extra):
            var fields = extra
            fields["split"] = .string(axis.rawValue)
            fields["ratio"] = .number(ratio)
            fields["children"] = .array([first.document, second.document])
            return .object(fields)
        case let .other(value):
            return value
        }
    }
}

extension Layout.Tab {
    init?(_ value: JSONValue) {
        guard var fields = value.object, let raw = fields["root"], raw.object != nil else { return nil }
        root = Layout.Node(raw)
        let terminals = root.terminals
        let name = fields["name"]?.string
        self.name = name?.isEmpty == false ? name : nil
        let focused = fields["focused"]?.string ?? ""
        self.focused = terminals.contains(focused) ? focused : terminals.first ?? ""
        for key in ["name", "root", "focused"] { fields[key] = nil }
        extra = fields
    }

    var document: JSONValue {
        var fields = extra
        if let name { fields["name"] = .string(name) }
        fields["root"] = root.document
        fields["focused"] = .string(focused)
        return .object(fields)
    }
}

extension Layout.Workspace {
    init?(_ value: JSONValue, seen: Set<String>) {
        guard var fields = value.object, let id = fields["id"]?.string, !id.isEmpty, !seen.contains(id) else { return nil }
        self.id = id
        name = fields["name"]?.string ?? ""
        cwd = fields["cwd"]?.string ?? ""
        tabs = (fields["tabs"]?.array ?? []).compactMap(Layout.Tab.init)
        selected = Layout.index(fields["selected"], count: tabs.count)
        for key in ["id", "name", "cwd", "tabs", "selected"] { fields[key] = nil }
        extra = fields
    }

    var document: JSONValue {
        var fields = extra
        fields["id"] = .string(id)
        fields["name"] = .string(name)
        fields["cwd"] = .string(cwd)
        fields["tabs"] = .array(tabs.map(\.document))
        fields["selected"] = .number(Double(selected))
        return .object(fields)
    }
}
