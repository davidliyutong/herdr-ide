import AppKit
import GhosttyTerminal
import Quartz
import TermKit

final class AppDelegate: NSObject, NSApplicationDelegate, NSMenuItemValidation {
    private var window: NSWindow!
    private var model: AppModel?
    private let coreProcess = CoreProcess()
    private var sidebar: SidebarView?
    private var tabs: TabBar?
    private var panes: PaneArea?
    private var webPanel: WebPanel?
    private var quickLook: QuickLook?
    private var settings: SettingsWindow?
    private var programs: ProgramWindows?
    private var dialogs: WorkspaceDialogs?
    private var machineDialogs: MachineDialogs?
    private var panelWidth: NSLayoutConstraint?
    private var panelShown = false
    private var sidebarWidth: NSLayoutConstraint?
    private var monitor: Any?
    private var keyMonitor: Any?
    private var controllerBox: TerminalControllerBox?
    /// Chords (and keys no menu item shows) are matched here, before the
    /// terminal sees them.
    private var matcher = KeyMatcher()
    private var pendingKey: NSEvent?
    private var pendingTimer: Timer?
    /// The keys the menu shows, by command; the matcher leaves them to it.
    private var menuKeys: [String: String] = [:]

    func applicationDidFinishLaunching(_: Notification) {
        NSApp.mainMenu = makeMenu()
        window = NSWindow(contentRect: NSRect(x: 0, y: 0, width: 1180, height: 760),
                          styleMask: [.titled, .closable, .miniaturizable, .resizable, .fullSizeContentView], backing: .buffered, defer: false)
        window.title = Brand.appName
        window.titlebarAppearsTransparent = true
        window.titleVisibility = .hidden
        window.backgroundColor = Theme.background
        window.minSize = NSSize(width: 640, height: 400)
        window.setFrameAutosaveName(Brand.appSlug + ".main")
        if window.frame.origin == .zero { window.center() }
        window.makeKeyAndOrderFront(nil)
        NSApp.activate(ignoringOtherApps: true)

        // A core that already runs (development), else the bundled one.
        let env = ProcessInfo.processInfo.environment
        if let text = env[Brand.envPrefix + "CORE"], let url = URL(string: text) {
            connect(url)
            return
        }
        let dev = env[Brand.envPrefix + "DEV"] == "1"
        let binary = (Bundle.main.resourceURL ?? Bundle.main.bundleURL).appendingPathComponent("bin/" + Brand.appSlug)
        coreProcess.start(binary: binary, dev: dev, ready: { [weak self] result in
            switch result {
            case let .success(url): self?.connect(url)
            case let .failure(.missing(path)): self?.fatal(tr("core.missing", path))
            case let .failure(.exited(code)): self?.fatal(tr("core.exited", String(code)))
            case .failure(.timeout): self?.fatal(tr("core.timeout"))
            }
        }, exited: { [weak self] in self?.fatal(tr("core.lost")) })
    }

    private func fatal(_ message: String) {
        let alert = NSAlert()
        alert.alertStyle = .critical
        alert.messageText = Brand.appName
        alert.informativeText = message
        alert.addButton(withTitle: tr("alert.quit"))
        alert.runModal()
        NSApp.terminate(nil)
    }

    private func connect(_ core: URL) {
        let model = AppModel(core: core)
        self.model = model
        let sidebar = SidebarView(model: model)
        let tabs = TabBar(model: model)
        let box = MainActor.assumeIsolated { TerminalControllerBox() }
        controllerBox = box
        let panes = PaneArea(model: model, controller: box)
        self.sidebar = sidebar
        self.tabs = tabs
        self.panes = panes
        let webPanel = WebPanel(core: core)
        self.webPanel = webPanel
        settings = SettingsWindow(model: model, supported: Self.supported)
        let programs = ProgramWindows(core: core)
        self.programs = programs
        sidebar.onProgram = { programs.show($0) }
        let dialogs = WorkspaceDialogs(model: model, window: window)
        self.dialogs = dialogs
        sidebar.dialogs = dialogs
        let machineDialogs = MachineDialogs(model: model, window: window)
        self.machineDialogs = machineDialogs
        sidebar.machineDialogs = machineDialogs
        let quickLook = QuickLook(core: core)
        self.quickLook = quickLook
        quickLook.onFailure = { [weak self] key, path in self?.notice(tr(key, path)) }
        panes.onOpenPath = { [weak self] machine, terminal, text in
            guard let self, let path = TerminalPath.resolve(text, cwd: model.directory(of: terminal, on: machine) ?? "") else { return }
            self.quickLook?.preview(path, on: machine)
        }
        let root = NSView()
        // The title bar is part of the content: the tab bar's color runs
        // up to the window's edge behind the window buttons.
        let titlebar = FillView(Theme.tabBar)
        for view in [titlebar, sidebar, tabs, panes, webPanel] as [NSView] {
            view.translatesAutoresizingMaskIntoConstraints = false
            root.addSubview(view)
        }
        let width = sidebar.widthAnchor.constraint(equalToConstant: Theme.sidebarWidth)
        sidebarWidth = width
        NSLayoutConstraint.activate([
            width,
            titlebar.topAnchor.constraint(equalTo: root.topAnchor), titlebar.bottomAnchor.constraint(equalTo: tabs.topAnchor),
            titlebar.leadingAnchor.constraint(equalTo: sidebar.trailingAnchor), titlebar.trailingAnchor.constraint(equalTo: root.trailingAnchor),
            sidebar.topAnchor.constraint(equalTo: root.topAnchor), sidebar.bottomAnchor.constraint(equalTo: root.bottomAnchor),
            sidebar.leadingAnchor.constraint(equalTo: root.leadingAnchor),
            tabs.topAnchor.constraint(equalTo: root.safeAreaLayoutGuide.topAnchor), tabs.leadingAnchor.constraint(equalTo: sidebar.trailingAnchor),
            tabs.trailingAnchor.constraint(equalTo: root.trailingAnchor),
            panes.topAnchor.constraint(equalTo: tabs.bottomAnchor), panes.bottomAnchor.constraint(equalTo: root.bottomAnchor),
            panes.leadingAnchor.constraint(equalTo: sidebar.trailingAnchor), panes.trailingAnchor.constraint(equalTo: webPanel.leadingAnchor),
            webPanel.topAnchor.constraint(equalTo: tabs.bottomAnchor), webPanel.bottomAnchor.constraint(equalTo: root.bottomAnchor),
            webPanel.trailingAnchor.constraint(equalTo: root.trailingAnchor),
        ])
        // The panel takes half of the room beside the sidebar when shown.
        let hidden = webPanel.widthAnchor.constraint(equalToConstant: 0)
        hidden.isActive = true
        panelWidth = hidden
        webPanel.isHidden = true
        window.contentView = root
        model.onChange = { [weak self] in self?.refresh() }
        model.onSettings = { [weak self] in self?.applySettings() }
        model.onKeybindings = { [weak self] in self?.applyKeybindings() }
        model.onConnection = { [weak self] up in if up { self?.panes?.reattach() } }
        // A click into a pane focuses it in the layout too.
        monitor = NSEvent.addLocalMonitorForEvents(matching: .leftMouseDown) { [weak self] event in
            if let self, event.window === self.window, let hit = self.window.contentView?.hitTest(event.locationInWindow),
               let pane = self.panes?.pane(containing: hit) {
                self.model?.focus(pane.address)
            }
            return event
        }
        keyMonitor = NSEvent.addLocalMonitorForEvents(matching: .keyDown) { [weak self] event in
            self?.matchKey(event) ?? event
        }
        model.start()
        refresh()
        #if DEBUG
            DebugAids.start(window: window, model: model, panes: panes, webPanel: webPanel) { [weak self] action in
                if action == "code" { self?.togglePanel() }
                if action == "settings" { self?.showSettings() }
                if action == "keys" { self?.settings?.show(page: SettingsWindow.keysPage) }
                if action.hasPrefix("settings:") { self?.settings?.show(page: String(action.dropFirst(9))) }
                if action.hasPrefix("strokes:") {
                    for stroke in action.dropFirst(8).split(separator: " ") {
                        let result = self?.feed(String(stroke), context: "terminal")
                        FileHandle.standardError.write(Data("stroke \(stroke): \(String(describing: result))\n".utf8))
                    }
                }
            }
        #endif
    }

    // MARK: - Settings and keybindings

    /// Applies the settings: the theme, the interface's size, and the
    /// terminals' font, colors, cursor, scrollback and keys.
    private func applySettings() {
        guard let model else { return }
        let s = model.settings
        switch s.string("appearance.theme", "system") {
        case "dark": NSApp.appearance = NSAppearance(named: .darkAqua)
        case "light": NSApp.appearance = NSAppearance(named: .aqua)
        default: NSApp.appearance = nil
        }
        Theme.scale = CGFloat(s.number("appearance.uiFontSize", 13)) / 13
        TerminalPane.history = Int(min(100_000, max(0, s.number("terminal.scrollback", 10000))))
        TerminalPane.bell = s.string("terminal.bell", "visual")
        MainActor.assumeIsolated { controllerBox?.apply(s, menuKeys: Array(menuKeys.values)) }
        settings?.refresh()
        refresh()
    }

    /// Rebuilds the menu with the keys in effect and gives the terminals
    /// the keys the menu now has.
    private func applyKeybindings() {
        matcher.reset()
        NSApp.mainMenu = makeMenu()
        if let model { MainActor.assumeIsolated { controllerBox?.apply(model.settings, menuKeys: Array(menuKeys.values)) } }
        settings?.refresh()
    }

    /// The bindings the matcher handles: all but the keys menu items show.
    private var matcherBindings: [KeyBinding] {
        (model?.keybindings.effective ?? []).filter { menuKeys[$0.command] != $0.key }
    }

    /// Feeds one stroke to the matcher and runs what it finds.
    @discardableResult
    private func feed(_ stroke: String, context: String) -> KeyMatcher.Result {
        let result = matcher.feed(stroke, bindings: matcherBindings, context: context)
        pendingTimer?.invalidate()
        if result == .pending {
            // A chord waits 3 s for its next stroke, as herdr's prefix does.
            pendingTimer = Timer.scheduledTimer(withTimeInterval: 3, repeats: false) { [weak self] _ in
                self?.matcher.reset()
                self?.pendingKey = nil
            }
        }
        if case let .run(command) = result { perform(command) }
        return result
    }

    /// The key handler in front of the main window's views: chords and
    /// keys without a menu item. Keys typed in the find field and the web
    /// panel's (VS Code) are matched in their own contexts.
    private func matchKey(_ event: NSEvent) -> NSEvent? {
        guard let window, event.window === window, window.attachedSheet == nil else { return event }
        let responder = window.firstResponder as? NSView
        let context = webPanel?.contains(responder) == true ? "vscode" : responder is NSTextView ? "dialog" : "terminal"
        let flags = event.modifierFlags
        guard let stroke = Keys.stroke(characters: event.charactersIgnoringModifiers ?? "", keyCode: event.keyCode,
                                       cmd: flags.contains(.command), ctrl: flags.contains(.control),
                                       alt: flags.contains(.option), shift: flags.contains(.shift)) else { return event }
        let first = pendingKey
        switch feed(stroke, context: context) {
        case .none:
            pendingKey = nil
            return event
        case .pending:
            if first == nil { pendingKey = event }
            return nil
        case .literal:
            // The chord's first stroke twice: the terminal gets it.
            pendingKey = nil
            if let first { window.firstResponder?.keyDown(with: first) }
            return nil
        case .run, .swallow:
            pendingKey = nil
            return nil
        }
    }

    /// The commands this application runs (the settings mark the others).
    static let supported: Set<String> = {
        var out: Set<String> = [
            "app.settings", "app.keyboardShortcuts", "workspace.new", "workspace.rename", "workspace.close", "tab.new", "tab.close",
            "tab.next", "tab.previous", "pane.splitRight", "pane.splitDown", "pane.close", "pane.focusNext", "pane.focusPrevious",
            "view.toggleSidebar", "view.toggleCode", "find.open", "find.next", "find.previous", "code.open",
        ]
        for i in 1 ... 9 { out.insert("tab.select\(i)") }
        return out
    }()

    /// Runs a command; those this application does not have do nothing.
    private func perform(_ command: String) {
        if command.hasPrefix("tab.select"), let n = Int(command.dropFirst(10)) {
            model?.selectTab(n - 1)
            return
        }
        switch command {
        case "app.settings": showSettings()
        case "app.keyboardShortcuts": settings?.show(page: SettingsWindow.keysPage)
        case "workspace.new": newWorkspace()
        case "workspace.rename": renameWorkspace()
        case "workspace.close": closeWorkspace()
        case "tab.new": model?.newTerminal()
        case "tab.close": model?.closeTab()
        case "tab.next": model?.cycleTab(1)
        case "tab.previous": model?.cycleTab(-1)
        case "pane.splitRight": model?.split(.horizontal)
        case "pane.splitDown": model?.split(.vertical)
        case "pane.close": model?.closeFocused()
        case "pane.focusNext": model?.cycleFocus(1)
        case "pane.focusPrevious": model?.cycleFocus(-1)
        case "view.toggleSidebar": toggleSidebar()
        case "view.toggleCode": togglePanel()
        case "code.open": if !panelShown { togglePanel() }
        case "find.open": find()
        case "find.next": findNext()
        case "find.previous": findPrevious()
        default: break
        }
    }

    @objc private func runCommand(_ sender: NSMenuItem) {
        if let command = sender.representedObject as? String { perform(command) }
    }


    private var refreshing = false

    /// Redraws after the changes of this turn of the run loop.
    private func refresh() {
        guard !refreshing else { return }
        refreshing = true
        DispatchQueue.main.async { [weak self] in
            guard let self else { return }
            self.refreshing = false
            self.sidebar?.update()
            if let model = self.model { self.programs?.reconcile(model.programs) }
            self.tabs?.update()
            self.panes?.update()
            self.panes?.reattach()
            self.showPanelFolder()
        }
    }

    /// Shows or hides VS Code beside the terminals, for the directory of
    /// the focused terminal.
    @objc private func togglePanel() {
        guard let webPanel, let panes, let old = panelWidth else { return }
        panelShown.toggle()
        old.isActive = false
        let next = panelShown ? webPanel.widthAnchor.constraint(equalTo: panes.widthAnchor) : webPanel.widthAnchor.constraint(equalToConstant: 0)
        next.isActive = true
        panelWidth = next
        webPanel.isHidden = !panelShown
        showPanelFolder()
        if !panelShown { refresh() }
    }

    /// The panel follows the machine; within a machine it keeps the folder
    /// it was opened for until it is hidden and shown again.
    private var panelMachine: String?

    private func showPanelFolder() {
        guard panelShown, let model, let webPanel else {
            panelMachine = nil
            return
        }
        guard panelMachine != model.selectedMachine else { return }
        panelMachine = model.selectedMachine
        let folder = model.selectedMachine.flatMap { machine in model.focusedTerminal.flatMap { model.directory(of: $0, on: machine) } }
        webPanel.showCode(machine: model.selectedMachine, folder: folder)
    }

    private func notice(_ message: String) {
        let alert = NSAlert()
        alert.messageText = message
        alert.beginSheetModal(for: window)
    }

    // Quick Look asks the responder chain for a controller; the delegate
    // is at its end.
    override func acceptsPreviewPanelControl(_: QLPreviewPanel!) -> Bool { quickLook != nil }

    override func beginPreviewPanelControl(_ panel: QLPreviewPanel!) {
        panel.dataSource = quickLook
        panel.delegate = quickLook
    }

    override func endPreviewPanelControl(_ panel: QLPreviewPanel!) {
        panel.dataSource = nil
        panel.delegate = nil
    }

    /// While a web page has the keyboard its shortcuts are its own: the
    /// commands for terminals are off, so their keys reach the page.
    /// Workspaces change once the machine's layout was read.
    func validateMenuItem(_ item: NSMenuItem) -> Bool {
        guard let command = item.representedObject as? String else { return true }
        let inPage = webPanel?.contains(window.firstResponder as? NSView) ?? false
        // Keys of commands for everywhere also work in the page.
        let when = model?.keybindings.commands.first { $0.id == command }?.when ?? "terminal"
        if inPage, when != "always", when != "vscode" { return false }
        if command.hasPrefix("workspace.") {
            return model?.selectedMachine.flatMap { model?.layout(of: $0) } != nil
        }
        return true
    }

    func applicationWillTerminate(_: Notification) {
        QuickLook.clear()
        model?.stop()
        coreProcess.stop()
    }

    func applicationShouldTerminateAfterLastWindowClosed(_: NSApplication) -> Bool { true }

    // MARK: - Menu

    /// The main menu. Items of commands show the first single-stroke key
    /// the keybindings give them (chords cannot be key equivalents; the
    /// matcher runs them); the terminals leave those keys to the menu.
    private func makeMenu() -> NSMenu {
        let main = NSMenu()
        let bindings = model?.keybindings.effective ?? []
        menuKeys = [:]
        func submenu(_ title: String, _ build: (NSMenu) -> Void) {
            let item = NSMenuItem()
            let menu = NSMenu(title: title)
            build(menu)
            item.submenu = menu
            main.addItem(item)
        }
        func add(_ menu: NSMenu, _ key: String, _ action: Selector, _ equivalent: String, _ modifiers: NSEvent.ModifierFlags = .command, arg: String? = nil) {
            // A shifted letter is its capital, as menus name it: Shift is
            // then part of the key, on every keyboard layout.
            var equivalent = equivalent, modifiers = modifiers
            if modifiers.contains(.shift), equivalent.count == 1, equivalent.uppercased() != equivalent {
                equivalent = equivalent.uppercased()
                modifiers.remove(.shift)
            }
            let item = menu.addItem(withTitle: arg.map { tr(key, $0) } ?? tr(key), action: action, keyEquivalent: equivalent)
            item.keyEquivalentModifierMask = modifiers
        }
        func command(_ menu: NSMenu, _ key: String, _ id: String) {
            let item = menu.addItem(withTitle: tr(key), action: #selector(runCommand(_:)), keyEquivalent: "")
            item.representedObject = id
            guard let binding = bindings.first(where: { $0.command == id && Keys.menuEquivalent($0.key) != nil }),
                  let equivalent = Keys.menuEquivalent(binding.key) else { return }
            var mask: NSEvent.ModifierFlags = []
            if equivalent.cmd { mask.insert(.command) }
            if equivalent.ctrl { mask.insert(.control) }
            if equivalent.alt { mask.insert(.option) }
            if equivalent.shift { mask.insert(.shift) }
            item.keyEquivalent = equivalent.key
            item.keyEquivalentModifierMask = mask
            menuKeys[id] = binding.key
        }
        submenu(Brand.appName) { menu in
            add(menu, "menu.about", #selector(NSApplication.orderFrontStandardAboutPanel(_:)), "", arg: Brand.appName)
            menu.addItem(.separator())
            command(menu, "menu.settings", "app.settings")
            command(menu, "menu.keyboardShortcuts", "app.keyboardShortcuts")
            menu.addItem(.separator())
            add(menu, "menu.hide", #selector(NSApplication.hide(_:)), "h", arg: Brand.appName)
            add(menu, "menu.quit", #selector(NSApplication.terminate(_:)), "q", arg: Brand.appName)
        }
        submenu(tr("menu.shell")) { menu in
            command(menu, "menu.newTerminal", "tab.new")
            command(menu, "menu.splitRight", "pane.splitRight")
            command(menu, "menu.splitDown", "pane.splitDown")
            menu.addItem(.separator())
            command(menu, "menu.newWorkspace", "workspace.new")
            command(menu, "menu.renameWorkspace", "workspace.rename")
            command(menu, "menu.closeWorkspace", "workspace.close")
            menu.addItem(.separator())
            command(menu, "menu.closeTerminal", "pane.close")
            command(menu, "menu.closeTab", "tab.close")
        }
        submenu(tr("menu.edit")) { menu in
            add(menu, "menu.copy", #selector(NSText.copy(_:)), "c")
            add(menu, "menu.paste", #selector(NSText.paste(_:)), "v")
            add(menu, "menu.selectAll", #selector(NSText.selectAll(_:)), "a")
            menu.addItem(.separator())
            command(menu, "menu.find", "find.open")
            command(menu, "menu.findNext", "find.next")
            command(menu, "menu.findPrevious", "find.previous")
        }
        submenu(tr("menu.view")) { menu in
            command(menu, "menu.toggleSidebar", "view.toggleSidebar")
            command(menu, "menu.toggleCode", "view.toggleCode")
            menu.addItem(.separator())
            command(menu, "menu.nextTab", "tab.next")
            command(menu, "menu.previousTab", "tab.previous")
            command(menu, "menu.nextPane", "pane.focusNext")
            command(menu, "menu.previousPane", "pane.focusPrevious")
        }
        submenu(tr("menu.window")) { menu in
            add(menu, "menu.minimize", #selector(NSWindow.performMiniaturize(_:)), "m")
        }
        return main
    }

    /// The pane the layout focuses: where the menu's commands go, also
    /// while the find field has the keyboard.
    private var focusedPane: TerminalPane? {
        guard let model, let machine = model.selectedMachine, let address = model.focusedTerminal else { return nil }
        return panes?.pane(machine, address)
    }

    private func showSettings() { settings?.show() }
    private func find() { focusedPane?.showFind() }
    private func findNext() { focusedPane?.findStep(true) }
    private func findPrevious() { focusedPane?.findStep(false) }

    private func newWorkspace() {
        if let machine = model?.selectedMachine { dialogs?.create(on: machine) }
    }

    private func renameWorkspace() {
        guard let model, let machine = model.selectedMachine, let workspace = model.layout.selectedWorkspace else { return }
        dialogs?.rename(workspace.id, on: machine)
    }

    private func closeWorkspace() {
        guard let model, let machine = model.selectedMachine, let workspace = model.layout.selectedWorkspace else { return }
        dialogs?.close(workspace.id, on: machine)
    }
    private func toggleSidebar() {
        guard let sidebar, let sidebarWidth else { return }
        sidebar.isHidden.toggle()
        sidebarWidth.constant = sidebar.isHidden ? 0 : Theme.sidebarWidth
    }
}

MainActor.assumeIsolated {
    let delegate = AppDelegate()
    let app = NSApplication.shared
    app.setActivationPolicy(.regular)
    app.delegate = delegate
    app.run()
}
