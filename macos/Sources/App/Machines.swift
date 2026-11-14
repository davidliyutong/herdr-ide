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
}
