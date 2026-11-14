import XCTest
@testable import TermKit

final class ProtocolTests: XCTestCase {
    func testFrames() {
        let frame = Frame(stream: 0x0102_0304, kind: .automatic, payload: Data("ab".utf8))
        XCTAssertEqual(Array(frame.encoded()), [4, 3, 2, 1, 6, 97, 98])
        XCTAssertEqual(Frame(frame.encoded()), frame)
        XCTAssertNil(Frame(Data([1, 2, 3, 4])))
        // A frame cut from a larger buffer keeps its own indices.
        let slice = (Data([9, 9]) + Frame(stream: 7, kind: .resize, payload: Data([100, 0, 30, 1])).encoded()).dropFirst(2)
        let resize = Frame(slice)
        XCTAssertEqual(resize?.stream, 7)
        XCTAssertEqual(resize?.grid?.cols, 100)
        XCTAssertEqual(resize?.grid?.rows, 286)
        XCTAssertNil(Frame(stream: 7, kind: .data, payload: Data([1, 0, 2, 0])).grid)
    }

    func testRecordNames() {
        XCTAssertEqual(TerminalRecord(raw: ["address": "t1", "name": "build", "title": "x"]).displayName, "build")
        XCTAssertEqual(TerminalRecord(raw: ["address": "t1", "title": "vim a.txt"]).displayName, "vim a.txt")
        XCTAssertEqual(TerminalRecord(raw: ["address": "t1", "foreground": ["name": "zsh"]]).displayName, "zsh")
        XCTAssertEqual(TerminalRecord(raw: ["address": "t1", "argv": ["/bin/bash", "-l"]]).displayName, "bash")
        XCTAssertEqual(TerminalRecord(raw: ["address": "t1"]).displayName, "t1")
        XCTAssertEqual(TerminalRecord(raw: ["address": "t1", "status": ["state": "working"]]).status, "working")
    }
}

final class EventTests: XCTestCase {
    func testDecode() {
        XCTAssertEqual(EventConnection.decode(#"{"t":"machines","list":[{"id":"local","label":"Mac","status":"ready","snapshot":{}},{"id":"b","label":"","status":"connecting"},{"label":"no id"}]}"#),
                       .machines([Machine(id: "local", label: "Mac", status: "ready"), Machine(id: "b", label: "b", status: "connecting")]))
        XCTAssertEqual(EventConnection.decode(#"{"t":"machine","state":{"id":"b","label":"Box","status":"degraded","error":"x"}}"#),
                       .machine(Machine(id: "b", label: "Box", status: "degraded")))
        XCTAssertEqual(EventConnection.decode(#"{"t":"gui","state":{"m":"b","phase":"ready","windows":[{"id":3,"title":"plot","w":640,"h":480,"pid":9},{"id":4,"title":"Save","w":300,"h":200,"transient":3},{"title":"no id"}]}}"#),
                       .gui(machine: "b", windows: [ProgramWindow(machine: "b", id: 3, title: "plot", width: 640, height: 480),
                                                    ProgramWindow(machine: "b", id: 4, title: "Save", width: 300, height: 200, transient: 3)]))
        XCTAssertEqual(EventConnection.decode(#"{"t":"gui","state":{"m":"b","phase":"off","windows":null}}"#), .gui(machine: "b", windows: []))
        // Messages the application does not use.
        for text in [#"{"t":"agent","m":"b","data":{}}"#, #"{"t":"session","state":"busy"}"#, #"{"t":"machine"}"#, "nonsense", "[]"] {
            XCTAssertNil(EventConnection.decode(text), text)
        }
    }
}

final class TerminalPathTests: XCTestCase {
    func testResolve() {
        XCTAssertEqual(TerminalPath.resolve("/etc/hosts", cwd: "/home/u"), "/etc/hosts")
        XCTAssertEqual(TerminalPath.resolve("src/main.go:12:5", cwd: "/home/u/p"), "/home/u/p/src/main.go")
        XCTAssertEqual(TerminalPath.resolve("./a.png:3:", cwd: "/w"), "/w/./a.png")
        XCTAssertEqual(TerminalPath.resolve(" ~/notes.md ", cwd: ""), "~/notes.md")
        XCTAssertEqual(TerminalPath.resolve("file:///tmp/a%20b.txt", cwd: "/"), "/tmp/a b.txt")
        XCTAssertNil(TerminalPath.resolve("file://other-host/tmp/a", cwd: "/"))
        XCTAssertNil(TerminalPath.resolve("a.txt", cwd: "")) // no directory to start from
        XCTAssertNil(TerminalPath.resolve("ssh://host/x", cwd: "/"))
        XCTAssertNil(TerminalPath.resolve("", cwd: "/"))
        XCTAssertEqual(TerminalPath.fileName("/a/b/report.pdf"), "report.pdf")
        XCTAssertEqual(TerminalPath.fileName("/"), "file")
        XCTAssertEqual(TerminalPath.fileName("x/.."), "file")
        XCTAssertEqual(TerminalPath.fileName("~"), "file")
    }
}

final class TerminalStoreTests: XCTestCase {
    func testSnapshotsAndEvents() {
        let store = TerminalStore()
        XCTAssertFalse(store.apply(["t": "pong"]))
        store.apply(["t": "backend", "m": "x", "state": "ready", "code": "", "version": "0.1.21"])
        XCTAssertEqual(store.backends["x"], BackendState(phase: .ready, version: "0.1.21"))
        store.apply(["t": "snapshot", "m": "x", "terminals": [
            ["address": "t2", "state": "live", "created_ms": 20, "pid": 5, "foreground": ["name": "zsh"]],
            ["address": "t1", "state": "live", "created_ms": 10],
        ]])
        XCTAssertEqual(store.terminals(of: "x").map(\.address), ["t1", "t2"])

        func event(_ type: String, _ terminal: String, _ data: [String: Any]) {
            store.apply(["t": "event", "m": "x", "type": type, "terminal": terminal, "data": data])
        }
        event("status", "t1", ["status": ["state": "working"], "records": [:] as [String: Any], "reported": true])
        XCTAssertEqual(store.terminal("t1", on: "x")?.status, "working")
        event("status", "t1", ["status": NSNull(), "records": [:] as [String: Any], "reported": true])
        XCTAssertNil(store.terminal("t1", on: "x")?.status)
        event("title", "t1", ["title": "make"])
        event("size", "t1", ["cols": 120, "rows": 40])
        XCTAssertEqual(store.terminal("t1", on: "x")?.title, "make")
        XCTAssertEqual(store.terminal("t1", on: "x")?.raw["cols"] as? Int, 120)
        event("foreground", "t1", ["pid": 9, "name": "vim", "argv": ["vim"], "cwd": "/"])
        XCTAssertEqual(store.terminal("t1", on: "x")?.foreground, "vim")
        event("finished", "t2", ["reason": "exited", "exit_code": 0])
        XCTAssertEqual(store.terminal("t2", on: "x")?.isLive, false)
        XCTAssertNil(store.terminal("t2", on: "x")?.foreground)
        event("created", "t3", ["address": "t3", "state": "live", "created_ms": 30])
        event("labels", "t3", ["labels": ["app": "x"]])
        XCTAssertEqual(store.terminal("t3", on: "x")?.labels, ["app": "x"])
        event("removed", "t2", [:])
        XCTAssertEqual(store.terminals(of: "x").map(\.address), ["t1", "t3"])
        // Events for terminals the store does not have change nothing.
        XCTAssertFalse(store.apply(["t": "event", "m": "x", "type": "title", "terminal": "t9", "data": ["title": "x"]]))

        // A backend that is not ready has no terminals.
        store.apply(["t": "backend", "m": "x", "state": "error", "code": "disconnected", "version": ""])
        XCTAssertEqual(store.backends["x"]?.code, "disconnected")
        XCTAssertTrue(store.terminals(of: "x").isEmpty)
    }
}

/// The vectors of design/testdata/layout, which web/src/__tests__/term.test.ts
/// runs against the TypeScript layout too.
final class LayoutTests: XCTestCase {
    private func apply(_ op: JSONValue, to layout: inout Layout) {
        func s(_ key: String) -> String { op[key]?.string ?? "" }
        func n(_ key: String) -> Int { Int(op[key]?.number ?? -1) }
        func axis() -> Layout.Axis { Layout.Axis(rawValue: s("axis")) ?? .horizontal }
        switch s("op") {
        case "createWorkspace": layout.createWorkspace(id: s("id"), name: s("name"), cwd: s("cwd"))
        case "renameWorkspace": layout.renameWorkspace(s("workspace"), to: s("name"))
        case "closeWorkspace": layout.closeWorkspace(s("workspace"))
        case "moveWorkspace": layout.moveWorkspace(s("workspace"), to: n("to"))
        case "selectWorkspace": layout.selectWorkspace(s("workspace"))
        case "openTerminal": layout.open(s("terminal"), in: op["workspace"]?.string)
        case "renameTab": layout.renameTab(n("tab"), in: s("workspace"), to: s("name"))
        case "closeTab": layout.closeTab(n("tab"), in: s("workspace"))
        case "moveTab": layout.moveTab(n("from"), to: n("to"), in: s("workspace"))
        case "selectTab": layout.selectTab(n("tab"), in: s("workspace"))
        case "splitFocused": layout.split(axis(), new: s("terminal"))
        case "closeTerminal": layout.close(s("terminal"))
        case "prune": layout.prune(keeping: Set((op["live"]?.array ?? []).compactMap(\.string)))
        case "setRatio": layout.setRatio(op["ratio"]?.number ?? .nan, at: (op["path"]?.array ?? []).compactMap(\.bool))
        case "focus": layout.focus(s("terminal"))
        case "swap": layout.swap(s("a"), s("b"))
        case "moveTerminal": layout.move(s("terminal"), beside: s("target"), axis: axis(), before: op["before"]?.bool ?? false)
        case "moveToNewTab": layout.moveToNewTab(s("terminal"), in: s("workspace"))
        default: XCTFail("unknown op \(s("op"))")
        }
    }

    func testVectors() throws {
        let directory = URL(fileURLWithPath: #filePath).deletingLastPathComponent()
            .appendingPathComponent("../../../design/testdata/layout").standardizedFileURL
        let files = try FileManager.default.contentsOfDirectory(atPath: directory.path).filter { $0.hasSuffix(".json") }.sorted()
        XCTAssertGreaterThan(files.count, 5)
        for file in files {
            let data = try Data(contentsOf: directory.appendingPathComponent(file))
            let vector = JSONValue(any: try JSONSerialization.jsonObject(with: data))
            let input = Layout(document: vector["input"])
            var layout = input
            for op in vector["ops"]?.array ?? [] { apply(op, to: &layout) }
            XCTAssertEqual(layout.document, vector["expected"], file)
            XCTAssertEqual(layout == input, !(vector["changed"]?.bool ?? true), "\(file): changed")
            XCTAssertEqual(Layout(document: vector["expected"]), layout, "\(file): reads back")
            // Through the serializer the core's documents pass.
            let written = try JSONSerialization.data(withJSONObject: layout.document.any)
            XCTAssertEqual(Layout(document: JSONValue(any: try JSONSerialization.jsonObject(with: written))), layout, "\(file): round trip")
        }
    }

    func testHelpers() {
        let id = Layout.newWorkspaceID()
        XCTAssertNotNil(id.range(of: "^[a-z0-9]{8}$", options: .regularExpression))
        XCTAssertNotEqual(Layout.newWorkspaceID(), id)
        var layout = Layout()
        layout.createWorkspace(id: id, name: "x", cwd: "/w")
        layout.open("t1")
        XCTAssertTrue(layout.split(.vertical, new: "t2"))
        XCTAssertFalse(layout.split(.vertical, new: "t2"))
        XCTAssertEqual(layout.terminals, ["t1", "t2"])
        XCTAssertEqual(layout.focusedTerminal, "t2")
        XCTAssertEqual(layout.selectedWorkspace?.cwd, "/w")
        XCTAssertEqual(layout.locate("t2")?.tab, 0)
        XCTAssertNil(layout.locate("t3"))
        XCTAssertEqual(JSONValue(any: ["a": [true, 1.5, "x", NSNull()]]).any as? NSDictionary, ["a": [true, 1.5, "x", NSNull()]])
        XCTAssertEqual(JSONValue(any: true), .bool(true))
        XCTAssertEqual(JSONValue(any: 1), .number(1))
    }
}

final class CoreProcessTests: XCTestCase {
    func testArgumentsAndReadyLine() {
        XCTAssertEqual(CoreProcess.arguments(dev: false), ["serve", "--parent-stdio", "--listen", "127.0.0.1:0", "--instance", "desktop"])
        XCTAssertTrue(CoreProcess.arguments(dev: true).contains(Brand.appSlug + "-dev"))
        XCTAssertEqual(CoreProcess.readyURL(#"{"event":"ready","url":"http://127.0.0.1:7781"}"#)?.port, 7781)
        XCTAssertNil(CoreProcess.readyURL(#"{"event":"ready","url":"http://example.com:7781"}"#))
        XCTAssertNil(CoreProcess.readyURL(#"{"event":"log","url":"http://127.0.0.1:1"}"#))
        XCTAssertNil(CoreProcess.readyURL("listening"))
        let env = CoreProcess.environment(["PATH": "/x"], home: "/Users/u")
        XCTAssertEqual(env["PATH"], "/x:/Users/u/.local/bin:/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin")
        XCTAssertEqual(Brand.envPrefix, Brand.appSlug.uppercased().replacingOccurrences(of: "-", with: "_") + "_")
    }

    func testMissingBinary() {
        let done = expectation(description: "answered")
        CoreProcess().start(binary: URL(fileURLWithPath: "/nonexistent/core"), dev: true, ready: { result in
            XCTAssertEqual(try? result.get(), nil)
            done.fulfill()
        }, exited: {})
        wait(for: [done], timeout: 5)
    }
}

final class LocalizationTests: XCTestCase {
    /// Every locale has the keys of the English strings, with the same
    /// placeholders.
    func testLocalesAgree() throws {
        let resources = URL(fileURLWithPath: #filePath).deletingLastPathComponent()
            .appendingPathComponent("../../Sources/App/Resources").standardizedFileURL
        func strings(_ locale: String) throws -> [String: String] {
            let url = resources.appendingPathComponent(locale + ".lproj/Localizable.strings")
            return try XCTUnwrap(NSDictionary(contentsOf: url) as? [String: String], url.path)
        }
        let english = try strings("en")
        XCTAssertFalse(english.isEmpty)
        let locales = try FileManager.default.contentsOfDirectory(atPath: resources.path)
            .filter { $0.hasSuffix(".lproj") }.map { String($0.dropLast(6)) }
        XCTAssertTrue(locales.contains("zh-Hans"))
        for locale in locales where locale != "en" {
            let other = try strings(locale)
            XCTAssertEqual(Set(other.keys), Set(english.keys), locale)
            for (key, text) in english {
                XCTAssertEqual(other[key]?.components(separatedBy: "%@").count, text.components(separatedBy: "%@").count, "\(locale) \(key)")
            }
        }
    }

    /// Every key the sources ask for exists, and none is unused.
    func testKeysAreUsed() throws {
        let sources = URL(fileURLWithPath: #filePath).deletingLastPathComponent().appendingPathComponent("../../Sources/App").standardizedFileURL
        let english = try XCTUnwrap(NSDictionary(contentsOf: sources.appendingPathComponent("Resources/en.lproj/Localizable.strings")) as? [String: String])
        var code = ""
        for file in try FileManager.default.contentsOfDirectory(atPath: sources.path) where file.hasSuffix(".swift") {
            code += try String(contentsOf: sources.appendingPathComponent(file), encoding: .utf8)
        }
        let literal = try NSRegularExpression(pattern: #"tr\("([a-z_.A-Z]+)"|add\(menu, "([a-z_.A-Z]+)""#)
        var used: Set<String> = []
        for match in literal.matches(in: code, range: NSRange(code.startIndex..., in: code)) {
            for group in 1...2 {
                if let range = Range(match.range(at: group), in: code) { used.insert(String(code[range])) }
            }
        }
        // Keys built from a state or code: tr("backend." + code).
        let prefixes = ["backend.", "machine.", "status.", "quicklook.", "settings."]
        for key in used where !prefixes.contains(key) {
            XCTAssertNotNil(english[key], "missing string \(key)")
        }
        for key in english.keys where !used.contains(key) && !prefixes.contains(where: key.hasPrefix) {
            XCTFail("unused string \(key)")
        }
    }
}
