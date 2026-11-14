import AppKit
import TermKit

/// What a machine's menu does to its terminal core: start, restart (the
/// programs keep running) and stop (asked first: every terminal there
/// ends), with a sheet when the core refused.
final class MachineDialogs {
    private let model: AppModel
    private weak var window: NSWindow?

    init(model: AppModel, window: NSWindow) {
        self.model = model
        self.window = window
    }

    private func label(_ machine: String) -> String {
        model.machines.first { $0.id == machine }?.label ?? machine
    }

    /// What the sidebar's free space offers.
    func addItems(to _: ClosureMenu) {}

    /// A machine's menu: new terminal or workspace, and its terminal core:
    /// started when it was stopped (or none runs), else restarted (programs
    /// keep running) or stopped.
    func items(for machine: Machine, in menu: ClosureMenu, dialogs: Dialogs?) {
        guard machine.status == "ready" else { return }
        menu.item(tr("menu.newTerminal"), symbol: "plus") { [weak self] in self?.model.newTerminal(on: machine.id) }
        if model.layout(of: machine.id) != nil {
            menu.item(tr("menu.newWorkspace"), symbol: "rectangle.stack.badge.plus") { dialogs?.createWorkspace(on: machine.id) }
        }
        menu.separator()
        let code = (model.backend(of: machine.id) ?? machine.hc)?.code
        if code == "stopped" || code == "not_running" {
            menu.item(tr("menu.startCore"), symbol: "play") { [weak self] in self?.core("start", on: machine.id) }
        } else {
            menu.item(tr("menu.restartCore"), symbol: "arrow.clockwise") { [weak self] in self?.core("restart", on: machine.id) }
            menu.item(tr("menu.stopCore"), symbol: "stop") { [weak self] in self?.stopCore(on: machine.id) }
        }
    }

    /// Stops the machine's terminal core after asking.
    func stopCore(on machine: String) {
        guard let window else { return }
        let alert = NSAlert()
        alert.messageText = tr("core.stopTitle", label(machine))
        alert.informativeText = tr("core.stopInfo")
        alert.addButton(withTitle: tr("core.stop"))
        alert.addButton(withTitle: tr("workspace.cancel"))
        alert.beginSheetModal(for: window) { [weak self] response in
            if response == .alertFirstButtonReturn { self?.core("stop", on: machine) }
        }
    }

    /// Runs start, restart or stop on the machine's terminal core.
    func core(_ action: String, on machine: String) {
        model.terminalCore(action, on: machine) { [weak self] code in
            guard let self, let code, let window = self.window else { return }
            let alert = NSAlert()
            alert.messageText = tr("core.failed", self.label(machine))
            alert.informativeText = tr("backend." + code)
            alert.beginSheetModal(for: window)
        }
    }

    /// Gives a terminal's shell the machine's virtual display, so programs
    /// started there open their windows (POST /api/m/{id}/gui/enable): a
    /// shell at its prompt gets the variables typed in; one running a
    /// program is left alone, and the sheet offers the command to copy.
    func enableWindows(_ terminal: String, on machine: String) {
        model.api.request("POST", "api/m/\(machine)/gui/enable", body: ["terminals": [terminal]]) { [weak self] status, reply in
            guard let self, let window = self.window else { return }
            let alert = NSAlert()
            var command = ""
            if status != 200 {
                alert.messageText = tr("gui.enableFailed")
                alert.informativeText = tr("gui.error." + (reply?["error"]?.string ?? "transport"))
            } else if (reply?["enabled"]?.number ?? 0) > 0 {
                alert.messageText = tr("gui.enabled")
            } else if (reply?["already"]?.number ?? 0) > 0 {
                alert.messageText = tr("gui.already")
            } else if !(reply?["busy"]?.array ?? []).isEmpty {
                alert.messageText = tr("gui.busy")
                command = reply?["command"]?.string ?? ""
                alert.informativeText = command.trimmingCharacters(in: .whitespaces)
                alert.addButton(withTitle: tr("gui.copyCommand"))
                alert.addButton(withTitle: tr("workspace.cancel"))
            } else {
                alert.messageText = tr("gui.enableFailed")
                alert.informativeText = tr("gui.error.transport")
            }
            alert.beginSheetModal(for: window) { response in
                if !command.isEmpty, response == .alertFirstButtonReturn {
                    NSPasteboard.general.clearContents()
                    NSPasteboard.general.setString(command.trimmingCharacters(in: .whitespaces), forType: .string)
                }
            }
        }
    }
}
