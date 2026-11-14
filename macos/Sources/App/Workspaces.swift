import AppKit
import TermKit

/// The dialogs that create, rename and close workspaces, as sheets of the
/// main window.
final class WorkspaceDialogs {
    private let model: AppModel
    private weak var window: NSWindow?

    init(model: AppModel, window: NSWindow) {
        self.model = model
        self.window = window
    }

    /// What to call a workspace: its name, else the word for one.
    static func name(of workspace: Layout.Workspace) -> String {
        workspace.name.isEmpty ? tr("workspace.default") : workspace.name
    }

    private func workspace(_ id: String, on machine: String) -> Layout.Workspace? {
        model.layout(of: machine)?.workspaces.first { $0.id == id }
    }

    /// Asks for a new workspace's name and directory on a machine.
    func create(on machine: String) {
        let label = model.machines.first { $0.id == machine }?.label ?? machine
        let name = Self.field(tr("workspace.namePlaceholder"))
        let cwd = Self.field(tr("workspace.cwdPlaceholder"))
        ask(tr("workspace.newTitle", label), rows: [(tr("workspace.name"), name), (tr("workspace.cwd"), cwd)],
            confirm: tr("workspace.create")) { [weak self] in
            let trim = { (field: NSTextField) in field.stringValue.trimmingCharacters(in: .whitespacesAndNewlines) }
            self?.model.newWorkspace(name: trim(name), cwd: trim(cwd), on: machine)
        }
    }

    func rename(_ id: String, on machine: String) {
        guard let workspace = workspace(id, on: machine) else { return }
        let name = Self.field(tr("workspace.default"))
        name.stringValue = workspace.name
        ask(tr("workspace.renameTitle"), rows: [(tr("workspace.name"), name)], confirm: tr("workspace.rename")) { [weak self] in
            self?.model.renameWorkspace(id, to: name.stringValue.trimmingCharacters(in: .whitespacesAndNewlines), on: machine)
        }
    }

    /// Closes a workspace, after asking when programs would end with it.
    func close(_ id: String, on machine: String) {
        guard let workspace = workspace(id, on: machine) else { return }
        let live = Set(model.store.terminals(of: machine).filter(\.isLive).map(\.address))
        let count = workspace.terminals.filter(live.contains).count
        guard count > 0, let window else { return model.closeWorkspace(id, on: machine) }
        let alert = NSAlert()
        alert.messageText = tr("workspace.closeTitle", Self.name(of: workspace))
        alert.informativeText = tr("workspace.closeInfo", String(count))
        alert.addButton(withTitle: tr("workspace.close"))
        alert.addButton(withTitle: tr("workspace.cancel"))
        alert.beginSheetModal(for: window) { [weak self] response in
            if response == .alertFirstButtonReturn { self?.model.closeWorkspace(id, on: machine) }
        }
    }

    private static func field(_ placeholder: String) -> NSTextField {
        let field = NSTextField(string: "")
        field.placeholderString = placeholder
        field.widthAnchor.constraint(equalToConstant: 260).isActive = true
        return field
    }

    /// A sheet with a labelled field per row; `done` runs when confirmed.
    private func ask(_ title: String, rows: [(String, NSTextField)], confirm: String, done: @escaping () -> Void) {
        guard let window else { return }
        let alert = NSAlert()
        alert.messageText = title
        alert.addButton(withTitle: confirm)
        alert.addButton(withTitle: tr("workspace.cancel"))
        let grid = NSGridView(views: rows.map { [NSTextField(labelWithString: $0.0), $0.1] })
        grid.rowSpacing = 8
        grid.column(at: 0).xPlacement = .trailing
        grid.frame.size = grid.fittingSize
        alert.accessoryView = grid
        alert.window.initialFirstResponder = rows.first?.1
        alert.beginSheetModal(for: window) { response in
            if response == .alertFirstButtonReturn { done() }
        }
    }
}
