//! The display's window manager (the Go agent's guiwm.go): windows keep
//! the size their program asks for and all sit at the origin; the window
//! receiving input is raised first. Contents come from Composite's
//! automatic redirection (each window has its own pixmap, so overlapping
//! does not matter), changes from DAMAGE, which it reports to the node;
//! input goes through XTEST. Override-redirect windows (menus, tooltips)
//! are layers of their transient-for window or the focused one.
const std = @import("std");
const sys = @import("sys.zig");
const x11 = @import("x11.zig");
const proto = @import("proto.zig");
const png = @import("png.zig");

pub const Rect = struct {
    x: i32 = 0,
    y: i32 = 0,
    w: i32 = 0,
    h: i32 = 0,

    pub fn empty(r: Rect) bool {
        return r.w <= 0 or r.h <= 0;
    }

    pub fn join(r: Rect, o: Rect) Rect {
        if (r.empty()) return o;
        if (o.empty()) return r;
        const x0 = @min(r.x, o.x);
        const y0 = @min(r.y, o.y);
        const x1 = @max(r.x + r.w, o.x + o.w);
        const y1 = @max(r.y + r.h, o.y + o.h);
        return .{ .x = x0, .y = y0, .w = x1 - x0, .h = y1 - y0 };
    }
};

pub const Managed = struct {
    x: i32 = 0,
    y: i32 = 0,
    w: i32,
    h: i32,
    damage: u32 = 0,
    title: std.ArrayList(u8) = .empty,
    terminal: std.ArrayList(u8) = .empty,
    pid: u32 = 0,
    transient: u32 = 0,
    delete_win: bool = false,
    take_focus: bool = false,
    layers: std.ArrayList(u32) = .empty,
};

pub const Layer = struct {
    x: i32,
    y: i32,
    w: i32,
    h: i32,
    damage: u32 = 0,
    owner: u32,
};

const Atoms = struct {
    WM_PROTOCOLS: x11.Atom = 0,
    WM_DELETE_WINDOW: x11.Atom = 0,
    WM_TAKE_FOCUS: x11.Atom = 0,
    WM_STATE: x11.Atom = 0,
    UTF8_STRING: x11.Atom = 0,
    _NET_WM_NAME: x11.Atom = 0,
    _NET_WM_PID: x11.Atom = 0,
    _NET_SUPPORTED: x11.Atom = 0,
    _NET_SUPPORTING_WM_CHECK: x11.Atom = 0,
    _NET_ACTIVE_WINDOW: x11.Atom = 0,
    _NET_FRAME_EXTENTS: x11.Atom = 0,
    _NET_CLIENT_LIST: x11.Atom = 0,
    _NET_WM_STATE: x11.Atom = 0,
};

pub const Error = x11.Error || error{ NoExtension, OtherWM };

/// A cursor image larger than this a side is not sent.
const max_cursor = 512;

pub const WM = struct {
    gpa: std.mem.Allocator,
    x: *x11.Conn,
    out: *proto.Writer,
    composite: x11.Ext = .{},
    damage: x11.Ext = .{},
    xfixes: x11.Ext = .{},
    xtest: x11.Ext = .{},
    shm: x11.Ext = .{},
    res: x11.Ext = .{},
    check_win: u32 = 0,
    atoms: Atoms = .{},
    wins: std.AutoHashMapUnmanaged(u32, *Managed) = .empty,
    layers: std.AutoHashMapUnmanaged(u32, *Layer) = .empty,
    focused: u32 = 0,
    top: u32 = 0,
    cursor: u32 = 0,
    keys: [256]bool = @splat(false),
    buttons: [256]bool = @splat(false),
    /// The instance's terminal core: windows of programs in its terminals
    /// name their terminal.
    hc_socket: []const u8,
    /// Damage not reported yet, by drawable.
    damaged: std.AutoArrayHashMapUnmanaged(u32, Rect) = .empty,
    prop: std.ArrayList(u8) = .empty,
    ids: std.ArrayList(u32) = .empty,

    /// Makes conn the display's window manager.
    pub fn init(gpa: std.mem.Allocator, conn: *x11.Conn, out: *proto.Writer, hc_socket: []const u8, name: []const u8) Error!*WM {
        const wm = try gpa.create(WM);
        errdefer gpa.destroy(wm);
        wm.* = .{ .gpa = gpa, .x = conn, .out = out, .hc_socket = hc_socket };
        const x = conn;
        wm.composite = try x.queryExtension("Composite");
        wm.damage = try x.queryExtension("DAMAGE");
        wm.xfixes = try x.queryExtension("XFIXES");
        wm.xtest = try x.queryExtension("XTEST");
        inline for (.{ "composite", "damage", "xfixes", "xtest" }) |f| {
            if (!@field(wm, f).present) {
                log("the display lacks the {s} extension", .{f});
                return error.NoExtension;
            }
        }
        try x.extVersion(wm.composite, 0, 4);
        try x.extVersion(wm.damage, 1, 1);
        try x.extVersion(wm.xfixes, 5, 0);
        wm.res = try x.queryExtension("X-Resource");
        wm.shm = try x.queryExtension("MIT-SHM");
        if (wm.shm.present) x.shmQueryVersion(wm.shm) catch {
            wm.shm.present = false;
        };
        inline for (@typeInfo(Atoms).@"struct".field_names) |f| @field(wm.atoms, f) = try x.internAtom(f);
        // Only one client may redirect the root's substructure. A manager
        // being replaced may still hold it for a moment.
        const mask = x11.SubstructureRedirect | x11.SubstructureNotify | x11.PropertyChange;
        var i: usize = 0;
        while (true) : (i += 1) {
            const seq = try x.changeWindowAttributes(x.root, 0x800, &.{mask});
            if (x.check(seq)) |_| break else |e| if (e != error.XError) return e;
            if (i >= 30) return error.OtherWM;
            sys.sleepMs(100);
        }
        try x.check(try x.compositeRedirectSubwindows(wm.composite, x.root));
        try x.xfixesSelectCursorInput(wm.xfixes, x.root);
        wm.check_win = x.newId();
        try x.check(try x.createInputOnly(wm.check_win, x.root));
        for ([_]u32{ x.root, wm.check_win }) |w| try wm.setWindows(w, wm.atoms._NET_SUPPORTING_WM_CHECK, &.{wm.check_win});
        try x.changeProperty(wm.check_win, wm.atoms._NET_WM_NAME, wm.atoms.UTF8_STRING, 8, name);
        var supported: [6 * 4]u8 = undefined;
        for ([_]x11.Atom{ wm.atoms._NET_WM_NAME, wm.atoms._NET_WM_PID, wm.atoms._NET_ACTIVE_WINDOW, wm.atoms._NET_FRAME_EXTENTS, wm.atoms._NET_CLIENT_LIST, wm.atoms._NET_SUPPORTING_WM_CHECK }, 0..) |a, k| x11.put32(supported[k * 4 ..], a);
        try x.changeProperty(x.root, wm.atoms._NET_SUPPORTED, x11.ATOM, 32, &supported);
        try x.flush();
        return wm;
    }

    fn setWindows(wm: *WM, w: u32, prop: x11.Atom, ids: []const u32) Error!void {
        wm.prop.clearRetainingCapacity();
        const max = (@as(usize, wm.x.max_req) * 4 -| 64) / 4;
        for (ids[0..@min(ids.len, max)]) |id| try wm.prop.appendSlice(wm.gpa, std.mem.asBytes(&std.mem.nativeToLittle(u32, id)));
        try wm.x.changeProperty(w, prop, x11.WINDOW, 32, wm.prop.items);
    }

    fn setCardinals(wm: *WM, w: u32, prop: x11.Atom, typ: x11.Atom, vals: []const u32) Error!void {
        var b: [16]u8 = undefined;
        for (vals, 0..) |v, i| x11.put32(b[i * 4 ..], v);
        try wm.x.changeProperty(w, prop, typ, 32, b[0 .. vals.len * 4]);
    }

    /// Takes over windows left on the display by a previous manager.
    pub fn adopt(wm: *WM) Error!void {
        var children: std.ArrayList(u32) = .empty;
        defer children.deinit(wm.gpa);
        _ = try wm.x.queryTree(wm.x.root, &children);
        for (children.items) |w| {
            if (w == wm.check_win) continue;
            const a = wm.x.getWindowAttributes(w) catch |e| {
                if (e == error.XError) continue;
                return e;
            };
            if (a.map_state != 2 or a.class == 2) continue; // viewable, not InputOnly
            if (a.override_redirect) try wm.addLayer(w) else try wm.manage(w);
        }
    }

    pub fn handle(wm: *WM, ev: *const [32]u8) !void {
        const t = ev[0] & 0x7f;
        switch (t) {
            x11.MapRequest => try wm.manage(x11.get32(ev, 8)),
            x11.ConfigureRequest => try wm.configureRequest(ev),
            x11.MapNotify => {
                const w = x11.get32(ev, 8);
                if (ev[12] != 0 and wm.layers.get(w) == null) try wm.addLayer(w);
            },
            x11.UnmapNotify, x11.DestroyNotify => try wm.forget(x11.get32(ev, 8)),
            x11.ConfigureNotify => try wm.configured(ev),
            x11.PropertyNotify => {
                const w = x11.get32(ev, 4);
                const atom = x11.get32(ev, 8);
                if (wm.wins.get(w)) |m| if (atom == x11.WM_NAME or atom == wm.atoms._NET_WM_NAME) {
                    try wm.readTitle(w);
                    if (!std.mem.eql(u8, wm.prop.items, m.title.items)) {
                        m.title.clearRetainingCapacity();
                        try m.title.appendSlice(wm.gpa, wm.prop.items);
                        try wm.emitWindow(w, m);
                    }
                };
            },
            else => {
                if (wm.damage.present and t == wm.damage.event) {
                    const d = x11.get32(ev, 4);
                    if (wm.wins.get(d) != null or wm.layers.get(d) != null) {
                        const r: Rect = .{ .x = x11.geti16(ev, 16), .y = x11.geti16(ev, 18), .w = x11.get16(ev, 20), .h = x11.get16(ev, 22) };
                        const g = try wm.damaged.getOrPut(wm.gpa, d);
                        g.value_ptr.* = if (g.found_existing) g.value_ptr.join(r) else r;
                    }
                } else if (t == wm.xfixes.event + 1) {
                    const serial = x11.get32(ev, 8);
                    if (serial != wm.cursor) {
                        wm.cursor = serial;
                        try wm.sendCursor();
                    }
                }
            },
        }
    }

    /// Reports the damage collected since the last report.
    pub fn reportDamage(wm: *WM) !void {
        if (wm.damaged.count() == 0) return;
        const at = try wm.out.begin(.damage);
        const n = @min(wm.damaged.count(), 8192);
        try wm.out.int(u16, @intCast(n));
        var it = wm.damaged.iterator();
        var i: usize = 0;
        while (it.next()) |e| : (i += 1) {
            if (i >= n) break;
            try wm.out.int(u32, e.key_ptr.*);
            inline for (.{ "x", "y", "w", "h" }) |f| try wm.out.int(i32, @field(e.value_ptr.*, f));
        }
        wm.out.finish(at);
        wm.damaged.clearRetainingCapacity();
    }

    fn newDamage(wm: *WM, w: u32) Error!u32 {
        const id = wm.x.newId();
        try wm.x.damageCreate(wm.damage, id, w);
        return id;
    }

    /// The damage object of a window or layer, 0 for none.
    pub fn damageOf(wm: *WM, d: u32) u32 {
        if (wm.wins.get(d)) |m| return m.damage;
        if (wm.layers.get(d)) |l| return l.damage;
        return 0;
    }

    /// Takes a top-level window: it goes to the origin, gets the window
    /// manager properties programs wait for, and is announced.
    fn manage(wm: *WM, w: u32) Error!void {
        const x = wm.x;
        if (wm.wins.get(w) != null) return x.mapWindow(w);
        const geo = x.getGeometry(w) catch |e| {
            if (e == error.XError) return;
            return e;
        };
        try x.configureWindow(w, x11.CfgX | x11.CfgY | x11.CfgBorder, &.{ 0, 0, 0 });
        _ = try x.changeWindowAttributes(w, 0x800, &.{x11.PropertyChange});
        try wm.setCardinals(w, wm.atoms.WM_STATE, wm.atoms.WM_STATE, &.{ 1, 0 }); // NormalState
        try wm.setCardinals(w, wm.atoms._NET_FRAME_EXTENTS, x11.CARDINAL, &.{ 0, 0, 0, 0 });
        try x.mapWindow(w);
        const m = try wm.gpa.create(Managed);
        m.* = .{ .w = geo.w, .h = geo.h };
        try wm.readTitle(w);
        try m.title.appendSlice(wm.gpa, wm.prop.items);
        m.transient = try wm.window(w, x11.WM_TRANSIENT_FOR);
        try wm.protocols(w, m);
        m.pid = try wm.pidOf(w);
        try terminalOf(wm.gpa, m.pid, wm.hc_socket, &m.terminal);
        m.damage = try wm.newDamage(w);
        try wm.wins.put(wm.gpa, w, m);
        try wm.clientList();
        // A new window takes focus only when nothing has it or it is a
        // dialog of the focused window: keys typed meanwhile go where the
        // user meant.
        if (wm.wins.get(wm.focused) == null or m.transient == wm.focused) try wm.focus(w, m);
        try wm.emitWindow(w, m);
    }

    fn emitWindow(wm: *WM, id: u32, m: *const Managed) !void {
        const o = wm.out;
        const at = try o.begin(.window);
        try o.int(u32, id);
        try o.int(u16, @intCast(@max(0, @min(m.w, 65535))));
        try o.int(u16, @intCast(@max(0, @min(m.h, 65535))));
        try o.int(u32, m.pid);
        try o.int(u32, m.transient);
        try o.str(u16, m.title.items[0..@min(m.title.items.len, 4096)]);
        try o.str(u16, m.terminal.items);
        o.finish(at);
    }

    fn clientList(wm: *WM) Error!void {
        wm.ids.clearRetainingCapacity();
        var it = wm.wins.keyIterator();
        while (it.next()) |k| try wm.ids.append(wm.gpa, k.*);
        try wm.setWindows(wm.x.root, wm.atoms._NET_CLIENT_LIST, wm.ids.items);
    }

    /// Grants sizes; managed windows stay at the origin and in the
    /// stacking order the window manager chose.
    fn configureRequest(wm: *WM, e: *const [32]u8) Error!void {
        const w = x11.get32(e, 8);
        const m = wm.wins.get(w);
        const vm = x11.get16(e, 26);
        var mask: u16 = 0;
        var vals: [7]u32 = undefined;
        var n: usize = 0;
        const add = struct {
            fn f(mk: *u16, vs: *[7]u32, k: *usize, bit: u16, v: u32) void {
                mk.* |= bit;
                vs[k.*] = v;
                k.* += 1;
            }
        }.f;
        if (m == null) {
            if (vm & x11.CfgX != 0) add(&mask, &vals, &n, x11.CfgX, @bitCast(@as(i32, x11.geti16(e, 16))));
            if (vm & x11.CfgY != 0) add(&mask, &vals, &n, x11.CfgY, @bitCast(@as(i32, x11.geti16(e, 18))));
        }
        if (vm & x11.CfgWidth != 0) add(&mask, &vals, &n, x11.CfgWidth, x11.get16(e, 20));
        if (vm & x11.CfgHeight != 0) add(&mask, &vals, &n, x11.CfgHeight, x11.get16(e, 22));
        if (m == null) {
            if (vm & x11.CfgBorder != 0) add(&mask, &vals, &n, x11.CfgBorder, x11.get16(e, 24));
            if (vm & x11.CfgSibling != 0) add(&mask, &vals, &n, x11.CfgSibling, x11.get32(e, 12));
            if (vm & x11.CfgStackMode != 0) add(&mask, &vals, &n, x11.CfgStackMode, e[1]);
        }
        if (mask != 0) try wm.x.configureWindow(w, mask, vals[0..n]);
        if (m) |mw| {
            // ICCCM: tell the client where it is when the request was not
            // granted as asked.
            const nw: u16 = if (vm & x11.CfgWidth != 0) x11.get16(e, 20) else @intCast(@max(0, @min(mw.w, 65535)));
            const nh: u16 = if (vm & x11.CfgHeight != 0) x11.get16(e, 22) else @intCast(@max(0, @min(mw.h, 65535)));
            var ev: [32]u8 = @splat(0);
            ev[0] = x11.ConfigureNotify;
            x11.put32(ev[4..], w);
            x11.put32(ev[8..], w);
            x11.put16(ev[20..], nw);
            x11.put16(ev[22..], nh);
            try wm.x.sendEvent(w, x11.StructureNotify, &ev);
        }
    }

    fn configured(wm: *WM, e: *const [32]u8) Error!void {
        const w = x11.get32(e, 8);
        const ex: i32 = x11.geti16(e, 16);
        const ey: i32 = x11.geti16(e, 18);
        const ew: i32 = x11.get16(e, 20);
        const eh: i32 = x11.get16(e, 22);
        if (wm.wins.get(w)) |m| {
            m.x = ex;
            m.y = ey;
            if (ew != m.w or eh != m.h) {
                m.w = ew;
                m.h = eh;
                try wm.emitWindow(w, m);
            }
            return;
        }
        if (wm.layers.get(w)) |l| {
            l.* = .{ .x = ex, .y = ey, .w = ew, .h = eh, .damage = l.damage, .owner = l.owner };
            try wm.emitLayer(w, l);
        }
    }

    /// Attaches an override-redirect window to the window it belongs to:
    /// its transient-for window, else the focused one.
    fn addLayer(wm: *WM, w: u32) Error!void {
        const geo = wm.x.getGeometry(w) catch |e| {
            if (e == error.XError) return;
            return e;
        };
        var owner_id = try wm.window(w, x11.WM_TRANSIENT_FOR);
        if (wm.wins.get(owner_id) == null) owner_id = wm.focused;
        if (wm.wins.get(owner_id) == null) {
            var it = wm.wins.keyIterator();
            owner_id = if (it.next()) |k| k.* else return; // nothing to show it with
        }
        const owner = wm.wins.get(owner_id).?;
        const l = try wm.gpa.create(Layer);
        l.* = .{ .x = geo.x, .y = geo.y, .w = geo.w, .h = geo.h, .owner = owner_id };
        l.damage = try wm.newDamage(w);
        try wm.layers.put(wm.gpa, w, l);
        try owner.layers.append(wm.gpa, w);
        try wm.emitLayer(w, l);
    }

    pub fn emitLayer(wm: *WM, id: u32, l: *const Layer) !void {
        const owner = wm.wins.get(l.owner) orelse return;
        const o = wm.out;
        const at = try o.begin(.layer);
        try o.int(u32, id);
        try o.int(u32, l.owner);
        try o.int(i32, l.x - owner.x);
        try o.int(i32, l.y - owner.y);
        try o.int(u16, @intCast(@max(0, @min(l.w, 65535))));
        try o.int(u16, @intCast(@max(0, @min(l.h, 65535))));
        o.finish(at);
    }

    /// Drops a window that was unmapped or destroyed.
    fn forget(wm: *WM, w: u32) Error!void {
        _ = wm.damaged.swapRemove(w);
        if (wm.wins.fetchRemove(w)) |kv| {
            const m = kv.value;
            if (m.damage != 0) try wm.x.damageDestroy(wm.damage, m.damage);
            for (m.layers.items) |id| if (wm.layers.get(id)) |l| {
                l.owner = 0;
            };
            if (wm.focused == w) wm.focused = 0;
            if (wm.top == w) wm.top = 0;
            m.title.deinit(wm.gpa);
            m.terminal.deinit(wm.gpa);
            m.layers.deinit(wm.gpa);
            wm.gpa.destroy(m);
            try wm.clientList();
            const at = try wm.out.begin(.gone);
            try wm.out.int(u32, w);
            wm.out.finish(at);
            return;
        }
        if (wm.layers.fetchRemove(w)) |kv| {
            const l = kv.value;
            defer wm.gpa.destroy(l);
            if (l.damage != 0) try wm.x.damageDestroy(wm.damage, l.damage);
            if (wm.wins.get(l.owner)) |owner| {
                if (std.mem.indexOfScalar(u32, owner.layers.items, w)) |i| _ = owner.layers.orderedRemove(i);
                const at = try wm.out.begin(.layer_gone);
                try wm.out.int(u32, w);
                try wm.out.int(u32, l.owner);
                wm.out.finish(at);
            }
        }
    }

    /// Reads a window's title into prop.
    fn readTitle(wm: *WM, w: u32) Error!void {
        try wm.x.getProperty(w, wm.atoms._NET_WM_NAME, wm.atoms.UTF8_STRING, &wm.prop);
        if (wm.prop.items.len == 0) try wm.x.getProperty(w, x11.WM_NAME, x11.AnyPropertyType, &wm.prop);
        while (wm.prop.items.len > 0 and wm.prop.items[wm.prop.items.len - 1] == 0) wm.prop.items.len -= 1;
    }

    fn window(wm: *WM, w: u32, prop: x11.Atom) Error!u32 {
        try wm.x.getProperty(w, prop, x11.WINDOW, &wm.prop);
        return if (wm.prop.items.len >= 4) x11.get32(wm.prop.items, 0) else 0;
    }

    fn protocols(wm: *WM, w: u32, m: *Managed) Error!void {
        try wm.x.getProperty(w, wm.atoms.WM_PROTOCOLS, x11.ATOM, &wm.prop);
        var i: usize = 0;
        while (i + 4 <= wm.prop.items.len) : (i += 4) {
            const a = x11.get32(wm.prop.items, i);
            if (a == wm.atoms.WM_DELETE_WINDOW) m.delete_win = true;
            if (a == wm.atoms.WM_TAKE_FOCUS) m.take_focus = true;
        }
    }

    /// The process that owns a window: _NET_WM_PID, else the X-Resource
    /// extension's view of the client (local connections only).
    fn pidOf(wm: *WM, w: u32) Error!u32 {
        try wm.x.getProperty(w, wm.atoms._NET_WM_PID, x11.CARDINAL, &wm.prop);
        if (wm.prop.items.len >= 4) return x11.get32(wm.prop.items, 0);
        if (!wm.res.present) return 0;
        wm.x.resClientPids(wm.res, w, &wm.ids) catch |e| {
            if (e == error.XError) return 0;
            return e;
        };
        for (wm.ids.items) |p| if (p != 0) return p;
        return 0;
    }

    /// Puts a window and its layers on top, so input at its position
    /// reaches it.
    fn raise(wm: *WM, w: u32, m: *const Managed) Error!void {
        if (wm.top == w) return;
        try wm.x.configureWindow(w, x11.CfgStackMode, &.{0}); // Above
        for (m.layers.items) |id| try wm.x.configureWindow(id, x11.CfgStackMode, &.{0});
        wm.top = w;
    }

    fn focus(wm: *WM, w: u32, m: *const Managed) Error!void {
        try wm.raise(w, m);
        try wm.x.setInputFocus(w);
        if (m.take_focus) try wm.clientMessage(w, wm.atoms.WM_PROTOCOLS, &.{ wm.atoms.WM_TAKE_FOCUS, 0 });
        try wm.setWindows(wm.x.root, wm.atoms._NET_ACTIVE_WINDOW, &.{w});
        wm.focused = w;
    }

    /// Whether the keyboard focus is in w or one of its subwindows.
    fn hasFocus(wm: *WM, w: u32) Error!bool {
        var f = try wm.x.focusedWindow();
        var i: usize = 0;
        while (f > 1 and f != wm.x.root and i < 32) : (i += 1) {
            if (f == w) return true;
            f = wm.x.queryTree(f, &wm.ids) catch |e| {
                if (e == error.XError) return false;
                return e;
            };
        }
        return false;
    }

    fn clientMessage(wm: *WM, w: u32, typ: x11.Atom, data: []const u32) Error!void {
        var ev: [32]u8 = @splat(0);
        ev[0] = x11.ClientMessage;
        ev[1] = 32;
        x11.put32(ev[4..], w);
        x11.put32(ev[8..], typ);
        for (data, 0..) |d, i| x11.put32(ev[12 + 4 * i ..], d);
        try wm.x.sendEvent(w, 0, &ev);
    }

    /// Asks the program to close the window (WM_DELETE_WINDOW), or
    /// disconnects it when it does not support that.
    fn closeWindow(wm: *WM, w: u32, m: *const Managed) Error!void {
        if (m.delete_win) return wm.clientMessage(w, wm.atoms.WM_PROTOCOLS, &.{ wm.atoms.WM_DELETE_WINDOW, 0 });
        try wm.x.killClient(w);
    }

    fn motion(wm: *WM, m: *const Managed, x: i32, y: i32) Error!void {
        const cx = std.math.clamp(m.x +| x, -32768, 32767);
        const cy = std.math.clamp(m.y +| y, -32768, 32767);
        try wm.x.xtestFakeInput(wm.xtest, x11.MotionNotify, 0, wm.x.root, @intCast(cx), @intCast(cy));
    }

    fn fake(wm: *WM, down: bool, key: bool, detail: u8) Error!void {
        const typ: u8 = if (key) (if (down) x11.KeyPress else x11.KeyRelease) else (if (down) x11.ButtonPress else x11.ButtonRelease);
        if (key) wm.keys[detail] = down else wm.buttons[detail] = down;
        try wm.x.xtestFakeInput(wm.xtest, typ, detail, wm.x.root, 0, 0);
    }

    /// Lets go of keys and buttons held (control moved to another core).
    fn releaseAll(wm: *WM) Error!void {
        for (0..256) |k| if (wm.keys[k]) try wm.fake(false, true, @intCast(k));
        for (0..256) |b| if (wm.buttons[b]) try wm.fake(false, false, @intCast(b));
    }

    /// Applies the node's input for a window (the controlling core's).
    pub fn input(wm: *WM, msg: proto.Msg) Error!void {
        switch (msg) {
            .release => return wm.releaseAll(),
            .focus => |w| if (wm.wins.get(w)) |m| try wm.focus(w, m),
            .close => |w| if (wm.wins.get(w)) |m| try wm.closeWindow(w, m),
            .pointer => |p| if (wm.wins.get(p.win)) |m| {
                try wm.raise(p.win, m);
                try wm.motion(m, p.x, p.y);
            },
            .button => |b| if (wm.wins.get(b.win)) |m| {
                if (b.down and wm.focused != b.win) try wm.focus(b.win, m); // click to focus
                try wm.raise(b.win, m);
                try wm.motion(m, b.x, b.y);
                if (b.button >= 1 and b.button <= 9) try wm.fake(b.down, false, b.button);
            },
            .wheel => |v| if (wm.wins.get(v.win)) |m| {
                try wm.raise(v.win, m);
                try wm.motion(m, v.x, v.y);
                const clicks = [_]struct { d: i32, neg: u8, pos: u8 }{ .{ .d = v.dy, .neg = 4, .pos = 5 }, .{ .d = v.dx, .neg = 6, .pos = 7 } };
                for (clicks) |c| {
                    if (c.d == 0) continue;
                    const b = if (c.d < 0) c.neg else c.pos;
                    const n = @min(@abs(c.d), 10);
                    var i: u32 = 0;
                    while (i < n) : (i += 1) {
                        try wm.fake(true, false, b);
                        try wm.fake(false, false, b);
                    }
                }
            },
            .key => |k| if (wm.wins.get(k.win)) |_| {
                if (k.keycode >= 8) {
                    // Programs can move the focus themselves; a key goes to
                    // the window it was typed for.
                    if (k.down and !try wm.hasFocus(k.win)) try wm.focus(k.win, wm.wins.get(k.win).?);
                    try wm.fake(k.down, true, k.keycode);
                }
            },
            else => {},
        }
    }

    /// Sends the current pointer image.
    pub fn sendCursor(wm: *WM) !void {
        const r = wm.x.reply(try wm.x.xfixesGetCursorImage(wm.xfixes)) catch |e| {
            if (e == error.XError) return;
            return e;
        };
        const w: u32 = x11.get16(r, 12);
        const h: u32 = x11.get16(r, 14);
        if (w == 0 or h == 0 or w > max_cursor or h > max_cursor or r.len < 32 + w * h * 4) return;
        const xhot = x11.get16(r, 16);
        const yhot = x11.get16(r, 18);
        const rgba = try wm.gpa.alloc(u8, w * h * 4);
        defer wm.gpa.free(rgba);
        for (0..w * h) |i| {
            const v = x11.get32(r, 32 + i * 4);
            const a: u32 = v >> 24;
            var c = [3]u32{ (v >> 16) & 0xff, (v >> 8) & 0xff, v & 0xff };
            if (a != 0 and a != 0xff) for (&c) |*ch| {
                ch.* = @min(ch.* * 255 / a, 255); // premultiplied
            };
            rgba[i * 4] = @intCast(c[0]);
            rgba[i * 4 + 1] = @intCast(c[1]);
            rgba[i * 4 + 2] = @intCast(c[2]);
            rgba[i * 4 + 3] = @intCast(a);
        }
        var data: std.ArrayList(u8) = .empty;
        defer data.deinit(wm.gpa);
        try png.encode(&data, wm.gpa, rgba, w * 4, w, h, .rgba);
        const at = try wm.out.begin(.cursor);
        try wm.out.int(u16, xhot);
        try wm.out.int(u16, yhot);
        try wm.out.bytes(data.items);
        wm.out.finish(at);
    }
};

/// The terminal of the instance's terminal core that process pid was
/// started in, from its environment or that of its nearest ancestor that
/// has one: HC_TERMINAL_ID, when HC_TERMINAL_SOCKET is hc_socket. A
/// terminal of another terminal core (the user's own) is not named.
pub fn terminalOf(gpa: std.mem.Allocator, pid_in: u32, hc_socket: []const u8, out: *std.ArrayList(u8)) !void {
    out.clearRetainingCapacity();
    var pid = pid_in;
    const buf = try gpa.alloc(u8, 256 << 10);
    defer gpa.free(buf);
    var i: usize = 0;
    while (i < 8 and pid > 1) : (i += 1) {
        var path: [64]u8 = undefined;
        const p = std.mem.printSentinel(&path, "/proc/{d}/environ", .{pid}, 0) catch return;
        if (sys.readFile(p, buf)) |env| {
            if (terminalFromEnv(env, hc_socket)) |term| {
                try out.appendSlice(gpa, term[0..@min(term.len, 256)]);
                return;
            }
        } else |_| {}
        pid = parentPid(pid);
    }
}

/// What a process's environment (NUL-separated) says: null when it names
/// no terminal, else its terminal when it is one of hc_socket's ("" for
/// another core's).
pub fn terminalFromEnv(env: []const u8, hc_socket: []const u8) ?[]const u8 {
    var id: ?[]const u8 = null;
    var socket: []const u8 = "";
    var it = std.mem.splitScalar(u8, env, 0);
    while (it.next()) |kv| {
        const eq = std.mem.indexOfScalar(u8, kv, '=') orelse continue;
        const k = kv[0..eq];
        if (std.mem.eql(u8, k, "HC_TERMINAL_ID")) id = kv[eq + 1 ..];
        if (std.mem.eql(u8, k, "HC_TERMINAL_SOCKET")) socket = kv[eq + 1 ..];
    }
    const term = id orelse return null;
    if (term.len == 0) return null;
    if (hc_socket.len > 0 and std.mem.eql(u8, socket, hc_socket)) return term;
    return "";
}

fn parentPid(pid: u32) u32 {
    var path: [64]u8 = undefined;
    const p = std.mem.printSentinel(&path, "/proc/{d}/stat", .{pid}, 0) catch return 0;
    var buf: [1024]u8 = undefined;
    const b = sys.readFile(p, &buf) catch return 0;
    // The command name in parentheses may contain spaces.
    const i = std.mem.lastIndexOfScalar(u8, b, ')') orelse return 0;
    var it = std.mem.tokenizeScalar(u8, b[i + 1 ..], ' ');
    _ = it.next() orelse return 0; // state
    const pp = it.next() orelse return 0;
    return std.fmt.parseInt(u32, pp, 10) catch 0;
}

pub fn log(comptime fmt: []const u8, args: anytype) void {
    var buf: [1024]u8 = undefined;
    const s = std.fmt.bufPrint(&buf, fmt ++ "\n", args) catch return;
    sys.writeAll(2, s) catch {};
}

const testing = std.testing;

test "terminal from the environment" {
    const env = "A=1\x00HC_TERMINAL_ID=t2\x00HC_TERMINAL_SOCKET=/run/hc.sock\x00";
    try testing.expectEqualStrings("t2", terminalFromEnv(env, "/run/hc.sock").?);
    // Another terminal core's terminal: named as none, and the search stops.
    try testing.expectEqualStrings("", terminalFromEnv(env, "/other.sock").?);
    try testing.expect(terminalFromEnv("A=1\x00", "/run/hc.sock") == null);
    try testing.expect(terminalFromEnv("HC_TERMINAL_ID=\x00", "/run/hc.sock") == null);
}

test "rect join" {
    const a: Rect = .{ .x = 1, .y = 2, .w = 3, .h = 4 };
    try testing.expectEqual(a, (Rect{}).join(a));
    const u = a.join(.{ .x = 10, .y = 0, .w = 1, .h = 1 });
    try testing.expectEqual(Rect{ .x = 1, .y = 0, .w = 10, .h = 6 }, u);
}
