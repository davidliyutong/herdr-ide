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
    private var dialogs: Dialogs?
    private var machineDialogs: MachineDialogs?
    private var palette: Palette?
    private var transfers: Transfers?
    private var transfersButton: TransfersButton?
    private var files: FilesWindow?
    private let toasts = Toasts()
    private var panelSize: NSLayoutConstraint?
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
    /// Folders to open as workspaces on the local machine once it is ready,
    /// and until when they wait.
    private var pendingFolders: [String] = []
    private var foldersDeadline = Date.distantPast

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
        sidebar.onFolders = { [weak self] in self?.openFolders($0) }
        let dialogs = Dialogs(model: model, window: window)
        self.dialogs = dialogs
        sidebar.dialogs = dialogs
        tabs.dialogs = dialogs
        let machineDialogs = MachineDialogs(model: model, window: window)
        machineDialogs.toast = { [weak self] in self?.toasts.show($0) }
        machineDialogs.controller = box.controller
        self.machineDialogs = machineDialogs
        sidebar.machineDialogs = machineDialogs
        palette = Palette(parent: window)
        let transfers = Transfers(model: model)
        transfers.toast = { [weak self] in self?.toasts.show($0) }
        self.transfers = transfers
        let transfersButton = TransfersButton(transfers: transfers)
        self.transfersButton = transfersButton
        tabs.trailing.addArrangedSubview(transfersButton)
        let quickLook = QuickLook(core: core)
        self.quickLook = quickLook
        quickLook.onFailure = { [weak self] key, path in self?.notice(tr(key, path)) }
        panes.configure = { [weak self] pane in self?.configure(pane) }
        let root = NSView()
        // The title bar is part of the content: the tab bar's color runs
        // up to the window's edge behind the window buttons.
        let titlebar = FillView(Theme.tabBar)
        for view in [titlebar, sidebar, tabs, panes, webPanel, toasts] as [NSView] {
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
            panes.topAnchor.constraint(equalTo: tabs.bottomAnchor), panes.leadingAnchor.constraint(equalTo: sidebar.trailingAnchor),
            toasts.centerXAnchor.constraint(equalTo: panes.centerXAnchor), toasts.bottomAnchor.constraint(equalTo: root.bottomAnchor, constant: -16),
            toasts.widthAnchor.constraint(lessThanOrEqualToConstant: 520),
        ])
        window.contentView = root
        placePanel()
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
            DebugAids.start(window: window, model: model, panes: panes, webPanel: webPanel) { [weak self] action in self?.debug(action) }
        #endif
    }

    #if DEBUG
        /// Actions of DebugAids that need the window's parts.
        private func debug(_ action: String) {
            switch action {
            case "code": togglePanel()
            case "settings": showSettings()
            case "keys": settings?.show(page: SettingsWindow.keysPage)
            default:
                if action.hasPrefix("settings:") { settings?.show(page: String(action.dropFirst(9))) }
                if action.hasPrefix("command:") { perform(String(action.dropFirst(8))) }
                if action.hasPrefix("folder:") { openFolders([String(action.dropFirst(7))]) }
                if action.hasPrefix("palette:") { palette?.debugType(String(action.dropFirst(8))) }
                if action == "add-machine" { machineDialogs?.add() }
                if action == "transfers" { transfersButton?.show() }
                if action.hasPrefix("record:") {
                    let spec = action.dropFirst(7).split(separator: ":").map(String.init)
                    if spec.count == 2 { settings?.debugRecord(spec[0], spec[1].split(separator: ",").map(String.init)) }
                }
                debugFiles(action)
                if action.hasPrefix("machine:") {
                    let spec = action.dropFirst(8).split(separator: ":", maxSplits: 1).map(String.init)
                    if spec.count == 2 { machineDialogs?.debug(spec[0], spec[1]) }
                }
                if action.hasPrefix("drag:") { debugDrag(action.dropFirst(5).split(separator: ":").map(String.init)) }
                if action.hasPrefix("strokes:") {
                    for stroke in action.dropFirst(8).split(separator: " ") {
                        let result = feed(String(stroke), context: "terminal")
                        FileHandle.standardError.write(Data("stroke \(stroke): \(String(describing: result))\n".utf8))
                    }
                }
            }
        }

        /// Development: the files window and transfers. files:<dir> shows a
        /// directory of the selected machine, select:<a,b> chooses entries,
        /// download-to:<file> downloads them there without the save panel,
        /// upload-file:<file> uploads a file into the directory shown,
        /// paste-file:<file> and paste-image:<png> paste into the focused
        /// terminal from a pasteboard of their own (not the user's).
        private func debugFiles(_ action: String) {
            let arg = String(action.drop { $0 != ":" }.dropFirst())
            if action.hasPrefix("files:"), let machine = model?.selectedMachine { showFiles(machine: machine, directory: arg) }
            if action.hasPrefix("select:") { files?.debugSelect(arg.split(separator: ",").map(String.init)) }
            if action.hasPrefix("download-to:"), let files { files.debugDownload(to: URL(fileURLWithPath: arg)) }
            if action.hasPrefix("upload-file:") { files?.uploadFiles([URL(fileURLWithPath: arg)]) }
            if action.hasPrefix("paste-file:") || action.hasPrefix("paste-image:"), let pane = focusedPane {
                let board = NSPasteboard(name: NSPasteboard.Name(Brand.appSlug + ".debug"))
                board.clearContents()
                if action.hasPrefix("paste-file:") {
                    board.writeObjects([URL(fileURLWithPath: arg) as NSURL])
                } else if let data = FileManager.default.contents(atPath: arg) {
                    board.setData(data, forType: .png)
                }
                FileHandle.standardError.write(Data("paste: \(takeFiles(board, into: pane, dir: nil))\n".utf8))
            }
        }

        /// Development: drags pane `from` (its header) to the middle of pane
        /// `to` or near an edge ("left"…), or tab `from` onto the slot before
        /// tab `to` ("tab"), with mouse events posted to this application's
        /// own queue: [from, to, zone].
        private func debugDrag(_ spec: [String]) {
            guard spec.count == 3, let from = Int(spec[0]), let to = Int(spec[1]), let model, let panes, let tabs,
                  let content = window.contentView, let tab = model.layout.selectedTab else { return }
            let all = tab.root.terminals
            func center(_ view: NSView) -> NSPoint { let f = view.convert(view.bounds, to: nil); return NSPoint(x: f.midX, y: f.midY) }
            var start: NSPoint, end: NSPoint
            var press: (NSEvent) -> Void
            if spec[2] == "tab" {
                guard tabs.buttons.indices.contains(from), tabs.buttons.indices.contains(to) else { return }
                start = center(tabs.buttons[from])
                let f = tabs.buttons[to].convert(tabs.buttons[to].bounds, to: nil)
                end = NSPoint(x: f.minX + 2, y: f.midY)
                press = { tabs.buttons[from].mouseDown(with: $0) }
            } else {
                guard all.indices.contains(from), all.indices.contains(to), let machine = model.selectedMachine else { return }
                let source = panes.pane(machine, all[from]), target = panes.pane(machine, all[to])
                start = center(source.header)
                let f = target.convert(target.bounds, to: nil)
                let offsets: [String: (CGFloat, CGFloat)] = ["left": (0.1, 0.5), "right": (0.9, 0.5), "top": (0.5, 0.9), "bottom": (0.5, 0.1)]
                let (fx, fy) = offsets[spec[2]] ?? (0.5, 0.5)
                end = NSPoint(x: f.minX + f.width * fx, y: f.minY + f.height * fy)
                press = { source.header.mouseDown(with: $0) }
            }
            _ = content
            func event(_ type: NSEvent.EventType, _ p: NSPoint) -> NSEvent? {
                NSEvent.mouseEvent(with: type, location: p, modifierFlags: [], timestamp: ProcessInfo.processInfo.systemUptime,
                                   windowNumber: window.windowNumber, context: nil, eventNumber: 0, clickCount: 1, pressure: 1)
            }
            let mid = NSPoint(x: (start.x + end.x) / 2, y: (start.y + end.y) / 2)
            for (type, p) in [(NSEvent.EventType.leftMouseDragged, mid), (.leftMouseDragged, end), (.leftMouseUp, end)] {
                if let e = event(type, p) { NSApp.postEvent(e, atStart: false) }
            }
            if let down = event(.leftMouseDown, start) { press(down) }
            FileHandle.standardError.write(Data("drag \(spec): \(model.layout.selectedTab.map { "\($0.root.terminals)" } ?? "")\n".utf8))
        }
    #endif

    // MARK: - Panes

    /// Wires a new pane: its header's commands, drag and menu, its text's
    /// menu and the paths activated in it.
    private func configure(_ pane: TerminalPane) {
        pane.header.onCommand = { [weak self] command in
            self?.model?.focus(pane.address)
            self?.perform(command)
        }
        pane.header.onPress = { [weak self] event in self?.pressHeader(pane, event) }
        pane.header.menuBuilder = { [weak self] in self?.paneMenu(pane) }
        pane.terminalView.menuBuilder = { [weak self] _ in self?.textMenu(pane) }
        pane.terminalView.onPaste = { [weak self, weak pane] in pane.map { self?.pasteFiles(into: $0) ?? false } ?? false }
        pane.terminalView.onDrop = { [weak self, weak pane] board in pane.map { self?.dropFiles(board, on: $0) ?? false } ?? false }
        pane.onOpenPath = { [weak self] text in self?.openPath(text, in: pane) }
    }

    // MARK: - Files

    /// The files window, showing a directory of a machine.
    private func showFiles(machine: String, directory: String) {
        guard let model, let transfers else { return }
        if files == nil {
            let files = FilesWindow(model: model, transfers: transfers)
            files.onPreview = { [weak self] machine, path in self?.quickLook?.preview(path, on: machine) }
            files.onCode = { [weak self] machine, path in self?.openInCode(path, on: machine) }
            self.files = files
        }
        files?.show(machine: machine, directory: directory)
    }

    @objc private func showFilesOfFocused() {
        guard let model, let machine = model.selectedMachine else { return }
        showFiles(machine: machine, directory: model.focusedTerminal.flatMap { model.directory(of: $0, on: machine) } ?? "~")
    }

    /// The files of the clipboard (or an image without text) pasted into a
    /// terminal: those of the local machine where they are, the others
    /// uploaded into the machine's upload directory first; their paths are
    /// pasted, shell-quoted. False leaves the paste to the terminal (text).
    private func pasteFiles(into pane: TerminalPane) -> Bool {
        guard let model, !model.readOnly else { return false }
        return takeFiles(NSPasteboard.general, into: pane, dir: nil)
    }

    /// Files dropped on a terminal: as pasted, but uploaded into the
    /// terminal's directory (else the upload directory); folders of other
    /// machines are skipped. Files of the local machine are left to the
    /// terminal, which pastes their paths.
    private func dropFiles(_ board: NSPasteboard, on pane: TerminalPane) -> Bool {
        guard let model, !model.readOnly else { return false }
        if isLocal(pane.machine), board.canReadObject(forClasses: [NSURL.self], options: [.urlReadingFileURLsOnly: true]) { return false }
        return takeFiles(board, into: pane, dir: model.directory(of: pane.address, on: pane.machine))
    }

    private func isLocal(_ machine: String) -> Bool { model?.machines.first { $0.id == machine }?.kind == "local" }

    private func takeFiles(_ board: NSPasteboard, into pane: TerminalPane, dir: String?) -> Bool {
        guard let transfers else { return false }
        let urls = (board.readObjects(forClasses: [NSURL.self], options: [.urlReadingFileURLsOnly: true]) as? [URL]) ?? []
        let paste = { [weak pane] (paths: [String]) in
            if !paths.isEmpty { pane?.paste(paths.map(shellQuote).joined(separator: " ") + " ") }
        }
        if !urls.isEmpty {
            if isLocal(pane.machine) {
                paste(urls.map(\.path))
                return true
            }
            let folders = urls.filter { (try? $0.resourceValues(forKeys: [.isDirectoryKey]).isDirectory) == true }
            if !folders.isEmpty { toasts.show(tr("transfers.noFolders", String(folders.count))) }
            let uploads = urls.filter { !folders.contains($0) }
            guard !uploads.isEmpty else { return true }
            announceUploads(uploads.count, to: pane.machine)
            transfers.upload(uploads, to: pane.machine, dir: dir, done: paste)
            return true
        }
        // An image without a file of its own (a screenshot, a browser's).
        guard board.string(forType: .string) == nil, let type = board.availableType(from: [.png, .tiff]),
              let raw = board.data(forType: type),
              let png = type == .png ? raw : NSBitmapImageRep(data: raw)?.representation(using: .png, properties: [:]) else { return false }
        announceUploads(1, to: pane.machine)
        transfers.upload([], data: (png, "paste.png"), to: pane.machine, dir: nil, done: paste)
        return true
    }

    private func announceUploads(_ count: Int, to machine: String) {
        let label = model?.machines.first { $0.id == machine }?.label ?? machine
        toasts.show(tr("transfers.uploading", String(count), label), button: tr("transfers.show"), ttl: 5) { [weak self] in
            self?.transfersButton?.show()
        }
    }

    /// Chooses files of this Mac to upload into a terminal's directory; their
    /// paths are pasted.
    private func uploadInto(_ pane: TerminalPane) {
        let panel = NSOpenPanel()
        panel.allowsMultipleSelection = true
        panel.canChooseDirectories = false
        panel.beginSheetModal(for: window) { [weak self, weak pane] response in
            guard let self, let pane, response == .OK, let model = self.model else { return }
            self.announceUploads(panel.urls.count, to: pane.machine)
            self.transfers?.upload(panel.urls, to: pane.machine, dir: model.directory(of: pane.address, on: pane.machine)) { [weak pane] paths in
                if !paths.isEmpty { pane?.paste(paths.map(shellQuote).joined(separator: " ") + " ") }
            }
        }
    }

    /// Shows VS Code for a folder of a machine.
    private func showCode(machine: String, folder: String) {
        if !panelShown {
            panelShown = true
            placePanel()
        }
        panelMachine = machine
        webPanel?.showCode(machine: machine, folder: folder)
    }

    /// Opens a file of a machine in VS Code: in the folder of the focused
    /// terminal when the file is below it, else in the file's directory
    /// (POST /api/m/{id}/bridge); a folder opens as itself.
    private func openInCode(_ path: String, on machine: String, line: Int? = nil, isFolder: Bool = false) {
        guard let model else { return }
        let cwd = model.selectedMachine == machine ? model.focusedTerminal.flatMap { model.directory(of: $0, on: machine) } : nil
        if isFolder { return showCode(machine: machine, folder: path) }
        let folder = cwd.flatMap { path.hasPrefix($0.hasSuffix("/") ? $0 : $0 + "/") ? $0 : nil } ?? RemoteEntry.parent(path)
        showCode(machine: machine, folder: folder)
        var body: [String: Any] = ["cmd": "openFile", "path": path, "folder": folder]
        if let line { body["line"] = line }
        bridge(machine, body)
    }

    /// Sends a command to the VS Code window of a folder (the bridge
    /// extension); a refusal is shown as a note.
    private func bridge(_ machine: String, _ body: [String: Any]) {
        let encoded = machine.addingPercentEncoding(withAllowedCharacters: .urlPathAllowed) ?? machine
        model?.api.request("POST", "api/m/\(encoded)/bridge", body: body) { [weak self] status, reply in
            if status != 200 { self?.toasts.show(tr("code.failed", reply?["error"]?.string ?? String(status))) }
        }
    }

    /// A press on a pane's header: a double click renames the pane, a drag
    /// moves it, a click focuses it.
    private func pressHeader(_ pane: TerminalPane, _ event: NSEvent) {
        guard let model else { return }
        if event.clickCount == 2, !model.readOnly { return dialogs?.renamePane(pane.address) ?? () }
        if !model.readOnly, DragTracker.track(event, target: { [weak self] in self?.paneDropTarget(pane.address, at: $0) }) { return }
        model.focus(pane.address)
    }

    /// Where a dragged pane would go: onto another pane (its middle swaps,
    /// an edge places it there), onto a tab (beside its focused terminal),
    /// onto the plus button (a new tab).
    private func paneDropTarget(_ source: String, at point: NSPoint) -> (NSRect, () -> Void)? {
        guard let model, let content = window.contentView else { return nil }
        if let pane = panes?.pane(at: point), pane.address != source {
            let f = pane.convert(pane.bounds, to: content)
            let zone = Layout.dropZone(Double((point.x - f.minX) / f.width), Double((f.maxY - point.y) / f.height))
            var mark = f
            switch zone {
            case .left: mark.size.width /= 2
            case .right: mark.origin.x += f.width / 2; mark.size.width /= 2
            case .top: mark.origin.y += f.height / 2; mark.size.height /= 2
            case .bottom: mark.size.height /= 2
            case .center: break
            }
            return (mark, { model.drop(source, on: pane.address, zone: zone) })
        }
        if let (index, frame) = tabs?.target(at: point) {
            if let index, model.layout.selectedWorkspace?.tabs[safe: index]?.root.terminals.contains(source) == true { return nil }
            return (frame, { model.movePane(source, toTab: index) })
        }
        return nil
    }

    /// The menu of a pane's header.
    private func paneMenu(_ pane: TerminalPane) -> NSMenu? {
        guard let model, !model.readOnly else { return nil }
        let menu = ClosureMenu()
        let run = { [weak self] (command: String) in
            self?.model?.focus(pane.address)
            self?.perform(command)
        }
        menu.item(tr("menu.renamePane"), symbol: "pencil") { [weak self] in self?.dialogs?.renamePane(pane.address) }
        menu.separator()
        menu.item(tr("menu.splitRight"), symbol: "rectangle.split.2x1") { run("pane.splitRight") }
        menu.item(tr("menu.splitDown"), symbol: "rectangle.split.1x2") { run("pane.splitDown") }
        menu.item(model.zoomedTerminal == pane.address ? tr("menu.restore") : tr("menu.zoom"), symbol: "arrow.up.left.and.arrow.down.right") {
            run("pane.zoom")
        }
        menu.separator()
        menu.item(tr("menu.openCode"), symbol: "chevron.left.forwardslash.chevron.right") { run("code.open") }
        menu.separator()
        menu.item(tr("menu.closeTerminal"), symbol: "xmark") { run("pane.close") }
        return menu
    }

    /// The menu of a terminal's text (a right click without a selection):
    /// paste, find, and the files of its directory.
    private func textMenu(_ pane: TerminalPane) -> NSMenu? {
        let menu = ClosureMenu()
        menu.item(tr("menu.paste"), symbol: "doc.on.clipboard") { [weak pane] in MainActor.assumeIsolated { pane?.terminalView.paste(nil) } }
        menu.item(tr("menu.find"), symbol: "magnifyingglass") { [weak self, weak pane] in
            guard let pane else { return }
            self?.model?.focus(pane.address)
            pane.showFind()
        }
        menu.separator()
        let dir = model?.directory(of: pane.address, on: pane.machine) ?? "~"
        menu.item(tr("menu.files"), symbol: "folder") { [weak self] in self?.showFiles(machine: pane.machine, directory: dir) }
        if model?.readOnly == false {
            menu.item(tr("menu.uploadFiles"), symbol: "arrow.up.doc") { [weak self, weak pane] in pane.map { self?.uploadInto($0) } }
        }
        return menu
    }

    /// A path activated in a terminal (⌘-click): shown with Quick Look.
    private func openPath(_ text: String, in pane: TerminalPane) {
        guard let model, let path = TerminalPath.resolve(text, cwd: model.directory(of: pane.address, on: pane.machine) ?? "") else { return }
        quickLook?.preview(path, on: pane.machine)
    }

    // MARK: - Folders

    /// Folders dropped on the sidebar or the Dock icon become workspaces on
    /// the local machine, one each, as if made in the new workspace dialog;
    /// they wait up to 30 s for the local machine's terminals.
    private func openFolders(_ paths: [String]) {
        var folders: [String] = []
        for path in paths {
            var isDir: ObjCBool = false
            if FileManager.default.fileExists(atPath: path, isDirectory: &isDir), isDir.boolValue { folders.append(path) }
        }
        if folders.count < paths.count { toasts.show(tr("sidebar.dropFoldersOnly", String(paths.count - folders.count))) }
        guard !folders.isEmpty else { return }
        pendingFolders += folders
        foldersDeadline = Date().addingTimeInterval(30)
        if let local = model?.machines.first(where: { $0.kind == "local" }) { model?.select(machine: local.id) }
        DispatchQueue.main.asyncAfter(deadline: .now() + 30.5) { [weak self] in self?.openPendingFolders() }
        openPendingFolders()
    }

    private func openPendingFolders() {
        guard !pendingFolders.isEmpty, let model else { return }
        let local = model.machines.first { $0.kind == "local" }
        if let local, !model.readOnly, model.layout(of: local.id) != nil, model.backend(of: local.id)?.phase == .ready {
            let folders = pendingFolders
            pendingFolders = []
            for folder in folders { model.newWorkspace(name: "", cwd: folder, on: local.id) }
        } else if Date() > foldersDeadline || model.readOnly || local?.status == "disabled" {
            toasts.show(tr("sidebar.openFoldersFailed", String(pendingFolders.count)))
            pendingFolders = []
        }
    }

    func application(_: NSApplication, open urls: [URL]) {
        let paths = urls.filter(\.isFileURL).map(\.path)
        if model == nil {
            pendingFolders += paths
            foldersDeadline = Date().addingTimeInterval(30)
        } else {
            openFolders(paths)
        }
    }

    // MARK: - Settings and keybindings

    /// Applies the settings: the theme, the interface's size, and the
    /// terminals' font, colors, cursor, scrollback and keys.
    private func applySettings() {
        guard let model else { return }
        let s = model.settings
        if Localization.set(s.string("appearance.language", "auto")) { NSApp.mainMenu = makeMenu() }
        switch s.string("appearance.theme", "system") {
        case "dark": NSApp.appearance = NSAppearance(named: .darkAqua)
        case "light": NSApp.appearance = NSAppearance(named: .aqua)
        default: NSApp.appearance = nil
        }
        Theme.scale = CGFloat(s.number("appearance.uiFontSize", 13)) / 13
        TerminalPane.history = Int(min(100_000, max(0, s.number("terminal.scrollback", 10000))))
        TerminalPane.bell = s.string("terminal.bell", "visual")
        MainActor.assumeIsolated { controllerBox?.apply(s, menuKeys: Array(menuKeys.values)) }
        placePanel()
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
            // A chord waits 3 s for its next stroke, as the browser UI's does.
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

    // MARK: - Commands

    /// The commands this application runs (the settings mark the others).
    static let supported: Set<String> = {
        var out: Set<String> = [
            "app.commandPalette", "app.settings", "app.keyboardShortcuts",
            "workspace.switch", "workspace.next", "workspace.previous", "workspace.new", "workspace.rename", "workspace.close",
            "tab.new", "tab.rename", "tab.close", "tab.next", "tab.previous",
            "pane.splitRight", "pane.splitDown", "pane.close", "pane.zoom", "pane.focusLeft", "pane.focusRight", "pane.focusUp",
            "pane.focusDown", "pane.focusNext", "pane.focusPrevious",
            "view.toggleSidebar", "view.toggleCode", "find.open", "find.next", "find.previous", "code.open",
        ]
        for i in 1 ... 9 { out.insert("tab.select\(i)") }
        return out
    }()

    /// Commands that change something: none runs while the core is read-only.
    private static let changing: Set<String> = [
        "workspace.new", "workspace.rename", "workspace.close", "tab.new", "tab.rename", "tab.close", "pane.splitRight", "pane.splitDown",
        "pane.close", "code.open", "code.diff", "code.gitGraph", "view.toggleCode",
    ]

    /// Runs a command; those this application does not have do nothing.
    private func perform(_ command: String) {
        guard let model else { return }
        if model.readOnly, Self.changing.contains(command) { return }
        if command.hasPrefix("tab.select"), let n = Int(command.dropFirst(10)) {
            model.selectTab(n - 1)
            return
        }
        let machine = model.selectedMachine
        let workspace = model.layout.selectedWorkspace
        let focused = model.focusedTerminal
        switch command {
        case "app.commandPalette": showPalette(workspacesOnly: false)
        case "app.settings": showSettings()
        case "app.keyboardShortcuts": settings?.show(page: SettingsWindow.keysPage)
        case "workspace.switch": showPalette(workspacesOnly: true)
        case "workspace.next": model.cycleWorkspace(1)
        case "workspace.previous": model.cycleWorkspace(-1)
        case "workspace.new": if let machine { dialogs?.createWorkspace(on: machine) }
        case "workspace.rename": if let machine, let workspace { dialogs?.renameWorkspace(workspace.id, on: machine) }
        case "workspace.close": if let machine, let workspace { dialogs?.closeWorkspace(workspace.id, on: machine) }
        case "tab.new": model.newTerminal()
        case "tab.rename": if let workspace { dialogs?.renameTab(workspace.selected) }
        case "tab.close": if let workspace { dialogs?.closeTab(workspace.selected) }
        case "tab.next": model.cycleTab(1)
        case "tab.previous": model.cycleTab(-1)
        case "pane.splitRight": model.split(.horizontal)
        case "pane.splitDown": model.split(.vertical)
        case "pane.close": if let focused { dialogs?.closePane(focused) }
        case "pane.zoom": model.toggleZoom()
        case "pane.focusLeft": model.focus(.left)
        case "pane.focusRight": model.focus(.right)
        case "pane.focusUp": model.focus(.up)
        case "pane.focusDown": model.focus(.down)
        case "pane.focusNext": model.cycleFocus(1)
        case "pane.focusPrevious": model.cycleFocus(-1)
        case "view.toggleSidebar": toggleSidebar()
        case "view.toggleCode": togglePanel()
        case "code.open": if !panelShown { togglePanel() }
        case "find.open": focusedPane?.showFind()
        case "find.next": focusedPane?.findStep(true)
        case "find.previous": focusedPane?.findStep(false)
        default: break
        }
    }

    @objc private func runCommand(_ sender: NSMenuItem) {
        if let command = sender.representedObject as? String { perform(command) }
    }

    /// The palette: the commands this application runs with their keys and
    /// every machine's workspaces, or the workspaces alone.
    private func showPalette(workspacesOnly: Bool) {
        guard let model else { return }
        var items: [Palette.Item] = []
        if !workspacesOnly {
            let hidden: Set<String> = ["app.commandPalette", "workspace.switch"]
            for command in model.keybindings.commands where Self.supported.contains(command.id) && !hidden.contains(command.id)
                && !command.id.hasPrefix("tab.select") && !(model.readOnly && Self.changing.contains(command.id)) {
                let key = model.keybindings.keys(of: command.id).sorted { !$0.contains(" ") && $1.contains(" ") }.first
                items.append(Palette.Item(label: SettingsWindow.text("command." + command.id) ?? command.id,
                                          hint: key.map(Keys.label) ?? "") { [weak self] in self?.perform(command.id) })
            }
        }
        for machine in model.machines {
            for (index, workspace) in (model.layout(of: machine.id)?.workspaces ?? []).enumerated() {
                items.append(Palette.Item(label: "\(index + 1)  " + Dialogs.name(of: workspace), hint: machine.label) {
                    model.selectWorkspace(workspace.id, on: machine.id)
                })
            }
        }
        palette?.show(placeholder: workspacesOnly ? tr("palette.workspaces") : tr("palette.commands"), items: items)
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
            self.openPendingFolders()
            self.machineDialogs?.machinesChanged()
        }
    }

    // MARK: - VS Code

    /// Places the VS Code panel beside the terminals or below them
    /// (layout.panelPosition), half of the room when shown.
    private func placePanel() {
        guard let webPanel, let panes, let root = window.contentView else { return }
        let bottom = model?.settings.string("layout.panelPosition", "right") == "bottom"
        NSLayoutConstraint.deactivate(root.constraints.filter { c in
            [c.firstItem, c.secondItem].contains { $0 === webPanel } || (c.firstItem === panes && [.bottom, .trailing].contains(c.firstAttribute))
        })
        panelSize?.isActive = false
        let shown = panelShown
        if bottom {
            panelSize = shown ? webPanel.heightAnchor.constraint(equalTo: panes.heightAnchor) : webPanel.heightAnchor.constraint(equalToConstant: 0)
            NSLayoutConstraint.activate([
                panes.trailingAnchor.constraint(equalTo: root.trailingAnchor), panes.bottomAnchor.constraint(equalTo: webPanel.topAnchor),
                webPanel.leadingAnchor.constraint(equalTo: panes.leadingAnchor), webPanel.trailingAnchor.constraint(equalTo: root.trailingAnchor),
                webPanel.bottomAnchor.constraint(equalTo: root.bottomAnchor), panelSize!,
            ])
        } else {
            panelSize = shown ? webPanel.widthAnchor.constraint(equalTo: panes.widthAnchor) : webPanel.widthAnchor.constraint(equalToConstant: 0)
            NSLayoutConstraint.activate([
                panes.bottomAnchor.constraint(equalTo: root.bottomAnchor), panes.trailingAnchor.constraint(equalTo: webPanel.leadingAnchor),
                webPanel.topAnchor.constraint(equalTo: panes.topAnchor), webPanel.bottomAnchor.constraint(equalTo: root.bottomAnchor),
                webPanel.trailingAnchor.constraint(equalTo: root.trailingAnchor), panelSize!,
            ])
        }
        webPanel.isHidden = !shown
    }

    /// Shows or hides VS Code beside the terminals, for the directory of
    /// the focused terminal.
    @objc private func togglePanel() {
        panelShown.toggle()
        placePanel()
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
    /// Workspaces change once the machine's layout was read; nothing
    /// changes while the core is read-only.
    func validateMenuItem(_ item: NSMenuItem) -> Bool {
        if item.action == #selector(addMachine) { return model?.readOnly == false }
        if item.action == #selector(showFilesOfFocused) { return model?.selectedMachine != nil }
        guard let command = item.representedObject as? String else { return true }
        let inPage = webPanel?.contains(window.firstResponder as? NSView) ?? false
        // Keys of commands for everywhere also work in the page.
        let when = model?.keybindings.commands.first { $0.id == command }?.when ?? "terminal"
        if inPage, when != "always", when != "vscode" { return false }
        if model?.readOnly == true, Self.changing.contains(command) { return false }
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
            command(menu, "menu.renameTab", "tab.rename")
            command(menu, "menu.closeTerminal", "pane.close")
            command(menu, "menu.closeTab", "tab.close")
            menu.addItem(.separator())
            add(menu, "menu.files", #selector(showFilesOfFocused), "")
            add(menu, "menu.addMachine", #selector(addMachine), "")
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
            command(menu, "menu.commandPalette", "app.commandPalette")
            command(menu, "menu.switchWorkspace", "workspace.switch")
            menu.addItem(.separator())
            command(menu, "menu.toggleSidebar", "view.toggleSidebar")
            command(menu, "menu.toggleCode", "view.toggleCode")
            command(menu, "menu.zoom", "pane.zoom")
            menu.addItem(.separator())
            command(menu, "menu.nextTab", "tab.next")
            command(menu, "menu.previousTab", "tab.previous")
            command(menu, "menu.nextWorkspace", "workspace.next")
            command(menu, "menu.previousWorkspace", "workspace.previous")
            menu.addItem(.separator())
            command(menu, "menu.nextPane", "pane.focusNext")
            command(menu, "menu.previousPane", "pane.focusPrevious")
            command(menu, "menu.focusLeft", "pane.focusLeft")
            command(menu, "menu.focusRight", "pane.focusRight")
            command(menu, "menu.focusUp", "pane.focusUp")
            command(menu, "menu.focusDown", "pane.focusDown")
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

    @objc private func addMachine() { machineDialogs?.add() }

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
