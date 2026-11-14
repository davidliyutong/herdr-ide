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
    private var panelWidth: NSLayoutConstraint?
    private var panelShown = false
    private var sidebarWidth: NSLayoutConstraint?
    private var monitor: Any?

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
        let panes = PaneArea(model: model, controller: MainActor.assumeIsolated { TerminalControllerBox() })
        self.sidebar = sidebar
        self.tabs = tabs
        self.panes = panes
        let webPanel = WebPanel(core: core)
        self.webPanel = webPanel
        settings = SettingsWindow(core: core)
        let programs = ProgramWindows(core: core)
        self.programs = programs
        sidebar.onProgram = { programs.show($0) }
        let dialogs = WorkspaceDialogs(model: model, window: window)
        self.dialogs = dialogs
        sidebar.dialogs = dialogs
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
        model.onConnection = { [weak self] up in if up { self?.panes?.reattach() } }
        // A click into a pane focuses it in the layout too.
        monitor = NSEvent.addLocalMonitorForEvents(matching: .leftMouseDown) { [weak self] event in
            if let self, event.window === self.window, let hit = self.window.contentView?.hitTest(event.locationInWindow),
               let pane = self.panes?.pane(containing: hit) {
                self.model?.focus(pane.address)
            }
            return event
        }
        model.start()
        refresh()
        #if DEBUG
            DebugAids.start(window: window, model: model, panes: panes, webPanel: webPanel) { [weak self] action in
                if action == "code" { self?.togglePanel() }
                if action == "settings" { self?.showSettings() }
            }
        #endif
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
        let inPage = webPanel?.contains(window.firstResponder as? NSView) ?? false
        let terminalOnly: Set<Selector> = [#selector(newTerminal), #selector(splitRight), #selector(splitDown), #selector(closeTerminal),
                                           #selector(find), #selector(findNext), #selector(findPrevious), #selector(newWorkspace)]
        if inPage, let action = item.action, terminalOnly.contains(action) { return false }
        let workspaceActions: Set<Selector> = [#selector(newWorkspace), #selector(renameWorkspace), #selector(closeWorkspace)]
        if let action = item.action, workspaceActions.contains(action) {
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

    private func makeMenu() -> NSMenu {
        let main = NSMenu()
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
        submenu(Brand.appName) { menu in
            add(menu, "menu.about", #selector(NSApplication.orderFrontStandardAboutPanel(_:)), "", arg: Brand.appName)
            menu.addItem(.separator())
            add(menu, "menu.settings", #selector(showSettings), ",")
            menu.addItem(.separator())
            add(menu, "menu.hide", #selector(NSApplication.hide(_:)), "h", arg: Brand.appName)
            add(menu, "menu.quit", #selector(NSApplication.terminate(_:)), "q", arg: Brand.appName)
        }
        submenu(tr("menu.shell")) { menu in
            add(menu, "menu.newTerminal", #selector(newTerminal), "t")
            add(menu, "menu.splitRight", #selector(splitRight), "d")
            add(menu, "menu.splitDown", #selector(splitDown), "d", [.command, .shift])
            menu.addItem(.separator())
            add(menu, "menu.newWorkspace", #selector(newWorkspace), "n")
            add(menu, "menu.renameWorkspace", #selector(renameWorkspace), "")
            add(menu, "menu.closeWorkspace", #selector(closeWorkspace), "")
            menu.addItem(.separator())
            add(menu, "menu.closeTerminal", #selector(closeTerminal), "w")
        }
        submenu(tr("menu.edit")) { menu in
            add(menu, "menu.copy", #selector(NSText.copy(_:)), "c")
            add(menu, "menu.paste", #selector(NSText.paste(_:)), "v")
            add(menu, "menu.selectAll", #selector(NSText.selectAll(_:)), "a")
            menu.addItem(.separator())
            add(menu, "menu.find", #selector(find), "f")
            add(menu, "menu.findNext", #selector(findNext), "g")
            add(menu, "menu.findPrevious", #selector(findPrevious), "g", [.command, .shift])
        }
        submenu(tr("menu.view")) { menu in
            add(menu, "menu.toggleSidebar", #selector(toggleSidebar), "b")
            add(menu, "menu.toggleCode", #selector(togglePanel), "j")
            add(menu, "menu.nextTab", #selector(nextTab), "}")
            add(menu, "menu.previousTab", #selector(previousTab), "{")
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

    @objc private func showSettings() { settings?.show() }
    @objc private func find() { focusedPane?.showFind() }
    @objc private func findNext() { focusedPane?.findStep(true) }
    @objc private func findPrevious() { focusedPane?.findStep(false) }
    @objc private func newTerminal() { model?.newTerminal() }
    @objc private func splitRight() { model?.split(.horizontal) }
    @objc private func splitDown() { model?.split(.vertical) }
    @objc private func closeTerminal() { model?.closeFocused() }

    @objc private func newWorkspace() {
        if let machine = model?.selectedMachine { dialogs?.create(on: machine) }
    }

    @objc private func renameWorkspace() {
        guard let model, let machine = model.selectedMachine, let workspace = model.layout.selectedWorkspace else { return }
        dialogs?.rename(workspace.id, on: machine)
    }

    @objc private func closeWorkspace() {
        guard let model, let machine = model.selectedMachine, let workspace = model.layout.selectedWorkspace else { return }
        dialogs?.close(workspace.id, on: machine)
    }
    @objc private func nextTab() { model?.cycleTab(1) }
    @objc private func previousTab() { model?.cycleTab(-1) }

    @objc private func toggleSidebar() {
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
