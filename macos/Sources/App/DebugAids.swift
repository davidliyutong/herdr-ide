#if DEBUG
    import AppKit
    import GhosttyTerminal
    import TermKit

    /// Development aids of debug builds, driven by environment variables so
    /// the window can be exercised and inspected without input devices:
    /// <PREFIX>SNAPSHOT=<path> writes the window as a PNG every two seconds,
    /// <PREFIX>ACTIONS=<a;b;...> runs actions two seconds apart: new,
    /// split-right, split-down, close, next-tab, workspace:<name>[:<cwd>]
    /// (a new workspace with a terminal, without the dialog),
    /// rename-workspace:<name>, close-workspace (without asking),
    /// next-workspace, type:<text>, find:<text>, find-next, open:<path> (as
    /// if activated in the terminal), code (the VS Code panel), page (logs
    /// the panel's page), settings, key:cmd+<key> (the key as the keyboard
    /// sends it, with shift+ before the key).
    enum DebugAids {
        static func start(window: NSWindow, model: AppModel, panes: PaneArea, webPanel: WebPanel, run: @escaping (String) -> Void) {
            let env = ProcessInfo.processInfo.environment
            if let path = env[Brand.envPrefix + "SNAPSHOT"] {
                Timer.scheduledTimer(withTimeInterval: 2, repeats: true) { _ in
                    snapshot(window, to: path)
                    // Another window of the application, such as the settings.
                    if let other = NSApp.windows.first(where: { $0 !== window && $0.isVisible && $0.contentView?.layer != nil }) {
                        snapshot(other, to: path + ".window.png")
                    }
                }
            }
            var actions = (env[Brand.envPrefix + "ACTIONS"] ?? "").split(separator: ";").map(String.init)
            guard !actions.isEmpty else { return }
            Timer.scheduledTimer(withTimeInterval: 2, repeats: true) { timer in
                guard !actions.isEmpty else { return timer.invalidate() }
                let action = actions.removeFirst()
                switch action {
                case "new": model.newTerminal()
                case "split-right": model.split(.horizontal)
                case "split-down": model.split(.vertical)
                case "close": model.closeFocused()
                case "next-tab": model.cycleTab(1)
                case "next-workspace": model.cycleWorkspace(1)
                case "close-workspace":
                    if let machine = model.selectedMachine, let workspace = model.layout.selectedWorkspace {
                        model.closeWorkspace(workspace.id, on: machine)
                    }
                case "code", "settings": run(action)
                case "page": webPanel.debugDescribe { FileHandle.standardError.write(Data(("page: " + $0 + "\n").utf8)) }
                case "find-next": panes.pane(containing: window.firstResponder as? NSView)?.findStep(true)
                default:
                    if action.hasPrefix("press:") {
                        // Plain keys as the keyboard sends them to the focused view.
                        let codes: [Character: UInt16] = ["a": 0, "b": 11, "c": 8, "e": 14, "h": 4, "o": 31, " ": 49, "k": 40, "y": 16, "\r": 36]
                        for ch in action.dropFirst(6).replacingOccurrences(of: "<cr>", with: "\r") {
                            for type in [NSEvent.EventType.keyDown, .keyUp] {
                                guard let event = NSEvent.keyEvent(with: type, location: .zero, modifierFlags: [],
                                                                   timestamp: ProcessInfo.processInfo.systemUptime, windowNumber: window.windowNumber,
                                                                   context: nil, characters: String(ch), charactersIgnoringModifiers: String(ch),
                                                                   isARepeat: false, keyCode: codes[ch] ?? 0) else { continue }
                                if type == .keyDown { window.firstResponder?.keyDown(with: event) } else { window.firstResponder?.keyUp(with: event) }
                            }
                        }
                        FileHandle.standardError.write(Data("press: responder=\(window.firstResponder.map { String(describing: type(of: $0)) } ?? "none")\n".utf8))
                    } else if action.hasPrefix("key:") {
                        // A Command key as the keyboard sends it, through the
                        // application's own dispatch: the focused view first,
                        // then the menu.
                        let spec = action.dropFirst(4).split(separator: "+").map(String.init)
                        var flags: NSEvent.ModifierFlags = []
                        if spec.contains("cmd") { flags.insert(.command) }
                        if spec.contains("shift") { flags.insert(.shift) }
                        let codes: [String: UInt16] = ["t": 17, "d": 2, "w": 13, "f": 3, "g": 5, "j": 38, "b": 11, ",": 43]
                        var char = spec.last ?? ""
                        let plain = char
                        if flags.contains(.shift) { char = char.uppercased() }
                        if let event = NSEvent.keyEvent(with: .keyDown, location: .zero, modifierFlags: flags,
                                                        timestamp: ProcessInfo.processInfo.systemUptime, windowNumber: window.windowNumber,
                                                        context: nil, characters: char, charactersIgnoringModifiers: char,
                                                        isARepeat: false, keyCode: codes[plain] ?? 0) {
                            let responder = window.firstResponder.map { String(describing: type(of: $0)) } ?? "none"
                            let view = (window.firstResponder as? NSView)?.performKeyEquivalent(with: event) ?? false
                            let menu = view ? false : (NSApp.mainMenu?.performKeyEquivalent(with: event) ?? false)
                            FileHandle.standardError.write(Data("key \(action): responder=\(responder) active=\(NSApp.isActive) key=\(window.isKeyWindow) view=\(view) menu=\(menu)\n".utf8))
                        }
                    } else if action.hasPrefix("workspace:"), let machine = model.selectedMachine {
                        let spec = action.dropFirst(10).split(separator: ":", maxSplits: 1).map(String.init)
                        model.newWorkspace(name: spec.first ?? "", cwd: spec.count > 1 ? spec[1] : "", on: machine)
                    } else if action.hasPrefix("rename-workspace:"), let machine = model.selectedMachine,
                              let workspace = model.layout.selectedWorkspace {
                        model.renameWorkspace(workspace.id, to: String(action.dropFirst(17)), on: machine)
                    } else if action.hasPrefix("open:") {
                        if let pane = panes.pane(containing: window.firstResponder as? NSView) { pane.onOpenPath?(String(action.dropFirst(5))) }
                    } else if action.hasPrefix("find:") {
                        // Before the find field takes the keyboard.
                        let pane = panes.pane(containing: window.firstResponder as? NSView)
                        pane?.showFind()
                        pane?.debugFind(String(action.dropFirst(5)))
                    } else if action.hasPrefix("type:") {
                        panes.pane(containing: window.firstResponder as? NSView)?.debugType(String(action.dropFirst(5)))
                    }
                }
            }
        }

        /// The layer tree, with each terminal's own snapshot drawn over its
        /// place: Metal layers do not render into a bitmap context.
        private static func snapshot(_ window: NSWindow, to path: String) {
            guard let view = window.contentView, let layer = view.layer,
                  let rep = view.bitmapImageRepForCachingDisplay(in: view.bounds),
                  let context = NSGraphicsContext(bitmapImageRep: rep) else { return }
            NSGraphicsContext.saveGraphicsState()
            NSGraphicsContext.current = context
            layer.render(in: context.cgContext)
            func terminals(_ v: NSView) {
                if let terminal = v as? TerminalView, let image = MainActor.assumeIsolated({ terminal.snapshotImage() }) {
                    image.draw(in: terminal.convert(terminal.bounds, to: view))
                }
                v.subviews.forEach(terminals)
            }
            terminals(view)
            NSGraphicsContext.restoreGraphicsState()
            try? rep.representation(using: .png, properties: [:])?.write(to: URL(fileURLWithPath: path))
        }
    }
#endif
