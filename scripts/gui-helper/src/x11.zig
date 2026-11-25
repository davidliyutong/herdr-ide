//! A client of the X11 protocol: the connection setup with a
//! MIT-MAGIC-COOKIE-1, the requests the window manager and the capture make
//! (core, Composite, DAMAGE, XFIXES, XTEST, MIT-SHM, X-Resource), their
//! replies by sequence number, and events queued as they arrive. One
//! thread uses a connection.
const std = @import("std");
const sys = @import("sys.zig");
const Allocator = std.mem.Allocator;

pub const Window = u32;
pub const Atom = u32;

pub const Error = error{ Sys, OutOfMemory, Closed, Protocol, Refused, XError };

pub fn put16(b: []u8, v: u16) void {
    std.mem.writeInt(u16, b[0..2], v, .little);
}
pub fn put32(b: []u8, v: u32) void {
    std.mem.writeInt(u32, b[0..4], v, .little);
}
pub fn get16(b: []const u8, off: usize) u16 {
    return std.mem.readInt(u16, b[off..][0..2], .little);
}
pub fn geti16(b: []const u8, off: usize) i16 {
    return std.mem.readInt(i16, b[off..][0..2], .little);
}
pub fn get32(b: []const u8, off: usize) u32 {
    return std.mem.readInt(u32, b[off..][0..4], .little);
}

fn pad4(n: usize) usize {
    return (n + 3) & ~@as(usize, 3);
}

// Predefined atoms.
pub const ATOM: Atom = 4;
pub const CARDINAL: Atom = 6;
pub const STRING: Atom = 31;
pub const WINDOW: Atom = 33;
pub const WM_NAME: Atom = 39;
pub const WM_TRANSIENT_FOR: Atom = 68;
pub const AnyPropertyType: Atom = 0;

// Event masks.
pub const StructureNotify: u32 = 0x20000;
pub const SubstructureNotify: u32 = 0x80000;
pub const SubstructureRedirect: u32 = 0x100000;
pub const PropertyChange: u32 = 0x400000;

// Event codes.
pub const KeyPress = 2;
pub const KeyRelease = 3;
pub const ButtonPress = 4;
pub const ButtonRelease = 5;
pub const MotionNotify = 6;
pub const DestroyNotify = 17;
pub const UnmapNotify = 18;
pub const MapNotify = 19;
pub const MapRequest = 20;
pub const ConfigureNotify = 22;
pub const ConfigureRequest = 23;
pub const PropertyNotify = 28;
pub const ClientMessage = 33;
pub const GenericEvent = 35;

// ConfigureWindow's value mask.
pub const CfgX: u16 = 1;
pub const CfgY: u16 = 2;
pub const CfgWidth: u16 = 4;
pub const CfgHeight: u16 = 8;
pub const CfgBorder: u16 = 16;
pub const CfgSibling: u16 = 32;
pub const CfgStackMode: u16 = 64;

pub const XErr = struct { code: u8, seq: u16, major: u8 };

/// An extension's numbers (QueryExtension).
pub const Ext = struct { present: bool = false, major: u8 = 0, event: u8 = 0, err: u8 = 0 };

pub const Conn = struct {
    gpa: Allocator,
    fd: sys.fd_t,
    rbuf: std.ArrayList(u8) = .empty,
    rpos: usize = 0,
    wbuf: std.ArrayList(u8) = .empty,
    /// The sequence number of the last request written.
    seq: u32 = 0,
    events: std.ArrayList([32]u8) = .empty,
    ev_head: usize = 0,
    last_err: ?XErr = null,

    root: Window = 0,
    root_depth: u8 = 0,
    root_visual: u32 = 0,
    width: u16 = 0,
    height: u16 = 0,
    id_base: u32 = 0,
    id_mask: u32 = 0,
    next_id: u32 = 0,
    /// The longest request in 4-byte units.
    max_req: u32 = 0,

    /// Opens the connection on fd (connected to the server), authenticated
    /// with cookie.
    pub fn open(gpa: Allocator, fd: sys.fd_t, cookie: []const u8) Error!*Conn {
        const c = try gpa.create(Conn);
        c.* = .{ .gpa = gpa, .fd = fd };
        errdefer c.destroy();
        const name = "MIT-MAGIC-COOKIE-1";
        var req: [12 + 20 + 16]u8 = @splat(0);
        req[0] = 'l';
        put16(req[2..], 11);
        put16(req[4..], 0);
        put16(req[6..], name.len);
        put16(req[8..], @intCast(cookie.len));
        @memcpy(req[12 .. 12 + name.len], name);
        if (cookie.len != 16) return error.Refused;
        @memcpy(req[32..48], cookie);
        try sys.writeAll(fd, &req);
        try c.need(8);
        const head = c.rbuf.items[c.rpos..];
        const more = @as(usize, get16(head, 6)) * 4;
        try c.need(8 + more);
        const s = c.rbuf.items[c.rpos .. c.rpos + 8 + more];
        if (s[0] != 1) return error.Refused;
        if (s.len < 40) return error.Protocol;
        c.id_base = get32(s, 12);
        c.id_mask = get32(s, 16);
        const vendor = get16(s, 24);
        c.max_req = get16(s, 26);
        const nformats: usize = s[29];
        var off: usize = 40 + pad4(vendor) + nformats * 8;
        if (s[28] == 0 or off + 40 > s.len) return error.Protocol;
        c.root = get32(s, off);
        c.width = get16(s, off + 20);
        c.height = get16(s, off + 22);
        c.root_visual = get32(s, off + 32);
        c.root_depth = s[off + 38];
        off += 40;
        c.rpos += 8 + more;
        return c;
    }

    pub fn destroy(c: *Conn) void {
        sys.close(c.fd);
        c.rbuf.deinit(c.gpa);
        c.wbuf.deinit(c.gpa);
        c.events.deinit(c.gpa);
        c.gpa.destroy(c);
    }

    pub fn newId(c: *Conn) u32 {
        const inc = c.id_mask & (~c.id_mask +% 1);
        c.next_id +%= inc;
        return c.id_base | (c.next_id & c.id_mask);
    }

    /// Reads until at least n unparsed bytes are buffered.
    fn need(c: *Conn, n: usize) Error!void {
        while (c.rbuf.items.len - c.rpos < n) {
            if (c.rpos > 0 and c.rpos * 2 > c.rbuf.items.len) {
                const rest = c.rbuf.items.len - c.rpos;
                std.mem.copyForwards(u8, c.rbuf.items[0..rest], c.rbuf.items[c.rpos..]);
                c.rbuf.items.len = rest;
                c.rpos = 0;
            }
            try c.rbuf.ensureUnusedCapacity(c.gpa, @max(n, 64 << 10));
            const free = c.rbuf.allocatedSlice()[c.rbuf.items.len..];
            const got = try sys.read(c.fd, free);
            if (got == 0) return error.Closed;
            c.rbuf.items.len += got;
        }
    }

    /// Reads what the server sent without waiting, queueing events.
    pub fn drain(c: *Conn) Error!void {
        var p = [_]sys.PollFd{.{ .fd = c.fd, .events = sys.POLL.IN, .revents = 0 }};
        while (true) {
            _ = try sys.poll(&p, 0);
            if (p[0].revents == 0) break;
            if (p[0].revents & sys.POLL.IN == 0) return error.Closed;
            try c.need(c.rbuf.items.len - c.rpos + 1);
            _ = try c.parse(null);
        }
        _ = try c.parse(null);
    }

    /// Parses the buffered messages: events are queued, errors kept, and
    /// the reply or error of sequence want (low 16 bits) returned when it
    /// is complete.
    fn parse(c: *Conn, want: ?u16) Error!?[]const u8 {
        while (c.rbuf.items.len - c.rpos >= 32) {
            const m = c.rbuf.items[c.rpos..];
            var size: usize = 32;
            if (m[0] == 1 or m[0] & 0x7f == GenericEvent) size += @as(usize, get32(m, 4)) * 4;
            if (m.len < size) {
                if (want != null) return null;
                return null;
            }
            const msg = m[0..size];
            c.rpos += size;
            switch (msg[0]) {
                0 => {
                    const e = XErr{ .code = msg[1], .seq = get16(msg, 2), .major = msg[10] };
                    c.last_err = e;
                    if (want) |w| if (e.seq == w) return error.XError;
                },
                1 => if (want) |w| if (get16(msg, 2) == w) return msg,
                else => {
                    if (size == 32) try c.events.append(c.gpa, msg[0..32].*);
                },
            }
        }
        return null;
    }

    /// Waits for the reply of request seq; error.XError when the server
    /// answered with an error. The slice is valid until the next call.
    pub fn reply(c: *Conn, seq: u32) Error![]const u8 {
        try c.flush();
        const w: u16 = @truncate(seq);
        while (true) {
            if (try c.parse(w)) |r| return r;
            try c.need(c.rbuf.items.len - c.rpos + 1);
        }
    }

    /// The next queued event; null when none is.
    pub fn nextEvent(c: *Conn) ?[32]u8 {
        if (c.ev_head >= c.events.items.len) {
            c.events.clearRetainingCapacity();
            c.ev_head = 0;
            return null;
        }
        const e = c.events.items[c.ev_head];
        c.ev_head += 1;
        return e;
    }

    pub fn hasEvents(c: *Conn) bool {
        return c.ev_head < c.events.items.len;
    }

    pub fn flush(c: *Conn) Error!void {
        if (c.wbuf.items.len == 0) return;
        try sys.writeAll(c.fd, c.wbuf.items);
        c.wbuf.clearRetainingCapacity();
    }

    /// Appends a request of len bytes (a multiple of 4) and returns it to
    /// be filled in, its length field set.
    fn begin(c: *Conn, major: u8, minor: u8, len: usize) Error![]u8 {
        std.debug.assert(len % 4 == 0);
        if (len / 4 > c.max_req and c.max_req != 0) return error.Protocol;
        if (c.wbuf.items.len > 256 << 10) try c.flush();
        const b = try c.wbuf.addManyAsSlice(c.gpa, len);
        @memset(b, 0);
        b[0] = major;
        b[1] = minor;
        put16(b[2..], @intCast(len / 4));
        c.seq +%= 1;
        return b;
    }

    /// Checks that request seq succeeded (a round trip).
    pub fn check(c: *Conn, seq: u32) Error!void {
        c.last_err = null;
        _ = try c.reply(try c.getInputFocus());
        if (c.last_err) |e| if (e.seq == @as(u16, @truncate(seq))) return error.XError;
    }

    pub fn queryExtension(c: *Conn, name: []const u8) Error!Ext {
        const b = try c.begin(98, 0, 8 + pad4(name.len));
        put16(b[4..], @intCast(name.len));
        @memcpy(b[8 .. 8 + name.len], name);
        const r = try c.reply(c.seq);
        return .{ .present = r[8] != 0, .major = r[9], .event = r[10], .err = r[11] };
    }

    pub fn internAtom(c: *Conn, name: []const u8) Error!Atom {
        const b = try c.begin(16, 0, 8 + pad4(name.len));
        put16(b[4..], @intCast(name.len));
        @memcpy(b[8 .. 8 + name.len], name);
        return get32(try c.reply(c.seq), 8);
    }

    pub fn createInputOnly(c: *Conn, id: Window, parent: Window) Error!u32 {
        const b = try c.begin(1, 0, 32);
        put32(b[4..], id);
        put32(b[8..], parent);
        put16(b[12..], @bitCast(@as(i16, -1)));
        put16(b[14..], @bitCast(@as(i16, -1)));
        put16(b[16..], 1);
        put16(b[18..], 1);
        put16(b[22..], 2); // InputOnly
        return c.seq;
    }

    pub fn changeWindowAttributes(c: *Conn, w: Window, mask: u32, values: []const u32) Error!u32 {
        const b = try c.begin(2, 0, 12 + 4 * values.len);
        put32(b[4..], w);
        put32(b[8..], mask);
        for (values, 0..) |v, i| put32(b[12 + 4 * i ..], v);
        return c.seq;
    }

    pub const Attrs = struct { class: u16, map_state: u8, override_redirect: bool };

    pub fn getWindowAttributes(c: *Conn, w: Window) Error!Attrs {
        const b = try c.begin(3, 0, 8);
        put32(b[4..], w);
        const r = try c.reply(c.seq);
        return .{ .class = get16(r, 12), .map_state = r[26], .override_redirect = r[27] != 0 };
    }

    pub fn mapWindow(c: *Conn, w: Window) Error!void {
        const b = try c.begin(8, 0, 8);
        put32(b[4..], w);
    }

    /// ConfigureWindow with values in the order of their mask bits.
    pub fn configureWindow(c: *Conn, w: Window, mask: u16, values: []const u32) Error!void {
        const b = try c.begin(12, 0, 12 + 4 * values.len);
        put32(b[4..], w);
        put16(b[8..], mask);
        for (values, 0..) |v, i| put32(b[12 + 4 * i ..], v);
    }

    pub const Geometry = struct { x: i16, y: i16, w: u16, h: u16 };

    pub fn getGeometry(c: *Conn, d: u32) Error!Geometry {
        const b = try c.begin(14, 0, 8);
        put32(b[4..], d);
        const r = try c.reply(c.seq);
        return .{ .x = geti16(r, 12), .y = geti16(r, 14), .w = get16(r, 16), .h = get16(r, 18) };
    }

    /// The children of w, bottom to top, into out (as many as fit), and
    /// w's parent.
    pub fn queryTree(c: *Conn, w: Window, out: *std.ArrayList(Window)) Error!Window {
        const b = try c.begin(15, 0, 8);
        put32(b[4..], w);
        const r = try c.reply(c.seq);
        const n = get16(r, 16);
        if (32 + @as(usize, n) * 4 > r.len) return error.Protocol;
        out.clearRetainingCapacity();
        var i: usize = 0;
        while (i < n) : (i += 1) try out.append(c.gpa, get32(r, 32 + 4 * i));
        return get32(r, 12);
    }

    pub fn changeProperty(c: *Conn, w: Window, prop: Atom, typ: Atom, format: u8, data: []const u8) Error!void {
        const b = try c.begin(18, 0, 24 + pad4(data.len));
        put32(b[4..], w);
        put32(b[8..], prop);
        put32(b[12..], typ);
        b[16] = format;
        put32(b[20..], @intCast(data.len / (format / 8)));
        @memcpy(b[24 .. 24 + data.len], data);
    }

    /// The value of a property, at most 64 KiB, copied into out.
    pub fn getProperty(c: *Conn, w: Window, prop: Atom, typ: Atom, out: *std.ArrayList(u8)) Error!void {
        const b = try c.begin(20, 0, 24);
        put32(b[4..], w);
        put32(b[8..], prop);
        put32(b[12..], typ);
        put32(b[16..], 0);
        put32(b[20..], 16384);
        out.clearRetainingCapacity();
        const r = c.reply(c.seq) catch |e| {
            if (e == error.XError) return;
            return e;
        };
        const format = r[1];
        const n: usize = @as(usize, get32(r, 16)) * (format / 8);
        if (32 + n > r.len) return error.Protocol;
        try out.appendSlice(c.gpa, r[32 .. 32 + n]);
    }

    pub fn sendEvent(c: *Conn, dest: Window, mask: u32, ev: *const [32]u8) Error!void {
        const b = try c.begin(25, 0, 44);
        put32(b[4..], dest);
        put32(b[8..], mask);
        @memcpy(b[12..44], ev);
    }

    pub fn setInputFocus(c: *Conn, w: Window) Error!void {
        const b = try c.begin(42, 1, 12); // revert to PointerRoot
        put32(b[4..], w);
        put32(b[8..], 0); // CurrentTime
    }

    pub fn getInputFocus(c: *Conn) Error!u32 {
        _ = try c.begin(43, 0, 4);
        return c.seq;
    }

    pub fn focusedWindow(c: *Conn) Error!Window {
        return get32(try c.reply(try c.getInputFocus()), 8);
    }

    pub fn killClient(c: *Conn, resource: u32) Error!void {
        const b = try c.begin(113, 0, 8);
        put32(b[4..], resource);
    }

    /// GetImage of a ZPixmap; returns the sequence to wait for.
    pub fn getImage(c: *Conn, d: u32, x: i16, y: i16, w: u16, h: u16) Error!u32 {
        const b = try c.begin(73, 2, 20);
        put32(b[4..], d);
        put16(b[8..], @bitCast(x));
        put16(b[10..], @bitCast(y));
        put16(b[12..], w);
        put16(b[14..], h);
        put32(b[16..], 0xffffffff);
        return c.seq;
    }

    // Extensions: the request's major opcode is the extension's.

    pub fn extVersion(c: *Conn, e: Ext, major: u32, minor: u32) Error!void {
        const b = try c.begin(e.major, 0, 12);
        put32(b[4..], major);
        put32(b[8..], minor);
        _ = try c.reply(c.seq);
    }

    pub fn compositeRedirectSubwindows(c: *Conn, e: Ext, w: Window) Error!u32 {
        const b = try c.begin(e.major, 2, 12);
        put32(b[4..], w);
        b[8] = 0; // automatic
        return c.seq;
    }

    pub fn damageCreate(c: *Conn, e: Ext, id: u32, d: u32) Error!void {
        const b = try c.begin(e.major, 1, 16);
        put32(b[4..], id);
        put32(b[8..], d);
        b[12] = 1; // DeltaRectangles
    }

    pub fn damageDestroy(c: *Conn, e: Ext, id: u32) Error!void {
        const b = try c.begin(e.major, 2, 8);
        put32(b[4..], id);
    }

    /// Empties the damage region (repair and parts: none).
    pub fn damageSubtract(c: *Conn, e: Ext, id: u32) Error!void {
        const b = try c.begin(e.major, 3, 16);
        put32(b[4..], id);
    }

    pub fn xfixesSelectCursorInput(c: *Conn, e: Ext, w: Window) Error!void {
        const b = try c.begin(e.major, 3, 12);
        put32(b[4..], w);
        put32(b[8..], 1); // DisplayCursor
    }

    pub fn xfixesGetCursorImage(c: *Conn, e: Ext) Error!u32 {
        _ = try c.begin(e.major, 4, 4);
        return c.seq;
    }

    pub fn xtestFakeInput(c: *Conn, e: Ext, typ: u8, detail: u8, root: Window, x: i16, y: i16) Error!void {
        const b = try c.begin(e.major, 2, 36);
        b[4] = typ;
        b[5] = detail;
        put32(b[12..], root);
        put16(b[24..], @bitCast(x));
        put16(b[26..], @bitCast(y));
    }

    pub fn shmQueryVersion(c: *Conn, e: Ext) Error!void {
        _ = try c.begin(e.major, 0, 4);
        _ = try c.reply(c.seq);
    }

    pub fn shmAttach(c: *Conn, e: Ext, seg: u32, shmid: u32) Error!u32 {
        const b = try c.begin(e.major, 1, 16);
        put32(b[4..], seg);
        put32(b[8..], shmid);
        b[12] = 0;
        return c.seq;
    }

    pub fn shmDetach(c: *Conn, e: Ext, seg: u32) Error!void {
        const b = try c.begin(e.major, 2, 8);
        put32(b[4..], seg);
    }

    pub fn shmGetImage(c: *Conn, e: Ext, d: u32, x: i16, y: i16, w: u16, h: u16, seg: u32, offset: u32) Error!u32 {
        const b = try c.begin(e.major, 4, 32);
        put32(b[4..], d);
        put16(b[8..], @bitCast(x));
        put16(b[10..], @bitCast(y));
        put16(b[12..], w);
        put16(b[14..], h);
        put32(b[16..], 0xffffffff);
        b[20] = 2; // ZPixmap
        put32(b[24..], seg);
        put32(b[28..], offset);
        return c.seq;
    }

    /// The pids of the clients X-Resource knows (spec client 0: all), or of
    /// the one owning resource when given; 0 for one whose pid is unknown.
    pub fn resClientPids(c: *Conn, e: Ext, resource: u32, out: *std.ArrayList(u32)) Error!void {
        const b = try c.begin(e.major, 4, 16);
        put32(b[4..], 1);
        put32(b[8..], resource);
        put32(b[12..], 2); // LocalClientPID
        const r = try c.reply(c.seq);
        const n = get32(r, 8);
        out.clearRetainingCapacity();
        var off: usize = 32;
        var i: u32 = 0;
        while (i < n) : (i += 1) {
            if (off + 12 > r.len) return error.Protocol;
            const len = get32(r, off + 8);
            if (off + 12 + len > r.len) return error.Protocol;
            try out.append(c.gpa, if (len >= 4) get32(r, off + 12) else 0);
            off += 12 + pad4(len);
        }
    }
};

/// Reads the cookie of an Xauthority file holding one MIT-MAGIC-COOKIE-1.
pub fn readCookie(path: [*:0]const u8, out: *[16]u8) bool {
    var buf: [1024]u8 = undefined;
    const b = sys.readFile(path, &buf) catch return false;
    var off: usize = 2;
    var fields: [4][]const u8 = undefined;
    for (&fields) |*f| {
        if (off + 2 > b.len) return false;
        const n = std.mem.readInt(u16, b[off..][0..2], .big);
        off += 2;
        if (off + n > b.len) return false;
        f.* = b[off .. off + n];
        off += n;
    }
    if (!std.mem.eql(u8, fields[2], "MIT-MAGIC-COOKIE-1") or fields[3].len != 16) return false;
    @memcpy(out, fields[3]);
    return true;
}

pub const ConnectError = error{ Sys, NotOurs, NoCookie };

/// Connects to the X server listening at path whose process is pid and
/// whose user is this one, on the path's socket and (Linux) the abstract
/// socket of the same name, as an X client reaches it: the cookie goes to
/// no other server.
pub fn connectChecked(path: []const u8, pid: i32) ConnectError!sys.fd_t {
    const me = sys.getuid();
    const fd = try sys.connectUnix(path, false);
    errdefer sys.close(fd);
    const cred = try sys.peerCred(fd);
    if (cred.uid != me or cred.pid != pid) return error.NotOurs;
    const afd = sys.connectUnix(path, true) catch return error.NotOurs;
    defer sys.close(afd);
    const acred = try sys.peerCred(afd);
    if (acred.uid != me or acred.pid != pid) return error.NotOurs;
    return fd;
}

test "put and get" {
    var b: [8]u8 = undefined;
    put32(&b, 0x01020304);
    try std.testing.expectEqual(@as(u32, 0x01020304), get32(&b, 0));
    put16(b[4..], 0xfffe);
    try std.testing.expectEqual(@as(i16, -2), geti16(&b, 4));
}
