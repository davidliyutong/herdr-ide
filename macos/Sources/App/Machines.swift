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
