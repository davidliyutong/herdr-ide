//! The GPU display's compositor (the Go agent's guiwl.go): Xwayland, an X
//! server that draws with the GPU (glamor) and gives its clients DRI3,
//! shows its screen in a window of a Wayland compositor; nobody looks at
//! that window here, since windows are captured from the X side. So the
//! compositor is this one, which shows nothing, for one client: the
//! Xwayland on the other end of a socket pair (file descriptor 3). It tells
//! Xwayland which GPU to use (wl_drm, which Xwayland before 24.1 cannot do
//! without) and which buffer layouts clients may share with it
//! (linux-dmabuf), releases every buffer as soon as it is committed, and
//! answers frame callbacks at frame_rate. It opens no file and listens
//! nowhere; it ends when its client does.
const std = @import("std");
const sys = @import("sys.zig");

/// Paces Xwayland's own screen updates and the frames of programs that
/// wait for the display (vertical sync).
pub const frame_rate = 60;
/// Bounds on what the one client may make the compositor hold.
pub const max_objects = 4096;
pub const max_fds = 64;
/// A Wayland message is at most this long.
pub const max_message = 4096;
/// Where the ids of objects the server creates begin.
const server_ids: u32 = 0xff000000;

pub const screen_w = 2560;
pub const screen_h = 1440;

/// DRM formats (fourcc) of the buffers Xwayland makes for the depths 24, 32
/// and 30, and the same with red and blue swapped.
pub const formats = [_]u32{ 0x34325258, 0x34325241, 0x34324258, 0x34324241, 0x30335241, 0x30334241 };

pub const Modifier = struct { format: u32, mod: u64 };

/// The buffer layouts offered on an NVIDIA GPU: every layout the fields of
/// DRM_FORMAT_MOD_NVIDIA_BLOCK_LINEAR_2D can name, and linear. Which ones a
/// GPU has is known to its driver alone; Xwayland and the programs take
/// those their driver has.
pub fn nvidiaModifiers(gpa: std.mem.Allocator) ![]Modifier {
    var out: std.ArrayList(Modifier) = .empty;
    for (formats) |f| {
        try out.append(gpa, .{ .format = f, .mod = 0 }); // DRM_FORMAT_MOD_LINEAR
        for ([_]u64{ 0xfe, 0x06, 0x08 }) |kind| {
            var gen: u64 = 0;
            while (gen < 3) : (gen += 1) {
                var sector: u64 = 0;
                while (sector < 2) : (sector += 1) {
                    var compression: u64 = 0;
                    while (compression < 5) : (compression += 1) {
                        var height: u64 = 0;
                        while (height < 6) : (height += 1)
                            try out.append(gpa, .{ .format = f, .mod = 0x03 << 56 | 0x10 | height | kind << 12 | gen << 20 | sector << 22 | compression << 23 });
                    }
                }
            }
        }
    }
    return out.toOwnedSlice(gpa);
}

const Iface = enum {
    wl_display,
    wl_registry,
    wl_compositor,
    wl_surface,
    wl_region,
    wl_callback,
    wl_shm,
    wl_shm_pool,
    wl_buffer,
    wl_output,
    xdg_wm_base,
    xdg_positioner,
    xdg_surface,
    xdg_toplevel,
    xdg_popup,
    wl_drm,
    zwp_linux_dmabuf_v1,
    zwp_linux_buffer_params_v1,
};

const Object = struct {
    iface: Iface,
    version: u32,
    // wl_surface: the buffer and the frame callbacks of the next commit,
    // whether it is a toplevel's, and whether that was configured.
    buffer: u32 = 0,
    attached: bool = false,
    frames: std.ArrayList(u32) = .empty,
    toplevel: bool = false,
    configured: bool = false,
    // xdg_surface: its wl_surface; xdg_toplevel: its xdg_surface.
    parent: u32 = 0,
};

const Global = struct { iface: Iface, version: u32 };

pub const Server = struct {
    gpa: std.mem.Allocator,
    fd: sys.fd_t,
    device: []const u8,
    mods: []const Modifier,
    globals: std.ArrayList(Global) = .empty,
    in: std.ArrayList(u8) = .empty,
    fds: std.ArrayList(i32) = .empty,
    out: std.ArrayList(u8) = .empty,
    objects: std.AutoHashMapUnmanaged(u32, Object) = .empty,
    next_id: u32 = server_ids,
    serial: u32 = 0,
    /// The frame callbacks answered at the next tick.
    due: std.ArrayList(u32) = .empty,
    /// The object and request with which the client broke the protocol.
    broke: [2]u32 = .{ 0, 0 },

    pub fn init(gpa: std.mem.Allocator, fd: sys.fd_t, device: []const u8, mods: []const Modifier) !Server {
        var s: Server = .{ .gpa = gpa, .fd = fd, .device = device, .mods = mods };
        try s.objects.put(gpa, 1, .{ .iface = .wl_display, .version = 1 });
        try s.globals.appendSlice(gpa, &.{
            .{ .iface = .wl_compositor, .version = 4 },
            .{ .iface = .wl_shm, .version = 1 },
            .{ .iface = .wl_output, .version = 2 },
            .{ .iface = .xdg_wm_base, .version = 1 },
            .{ .iface = .wl_drm, .version = 2 },
        });
        if (mods.len > 0) try s.globals.append(gpa, .{ .iface = .zwp_linux_dmabuf_v1, .version = 3 });
        return s;
    }

    pub fn closeFds(s: *Server) void {
        for (s.fds.items) |fd| sys.close(fd);
        s.fds.clearRetainingCapacity();
    }

    /// Queues an event of object id; values are u32, i32, strings and
    /// arrays ([]const u8 after .array).
    fn event(s: *Server, id: u32, opcode: u16, vals: anytype) !void {
        const at = s.out.items.len;
        try s.int(id);
        try s.int(0);
        inline for (vals) |v| {
            const T = @TypeOf(v);
            if (T == u32 or T == comptime_int) {
                try s.int(@as(u32, v));
            } else if (T == i32) {
                try s.int(@bitCast(v));
            } else if (T == Arr) {
                try s.int(@intCast(v.b.len));
                try s.out.appendSlice(s.gpa, v.b);
                try s.out.appendNTimes(s.gpa, 0, (v.b.len + 3 & ~@as(usize, 3)) - v.b.len);
            } else {
                const str: []const u8 = v;
                const n = str.len + 1;
                try s.int(@intCast(n));
                try s.out.appendSlice(s.gpa, str);
                try s.out.appendNTimes(s.gpa, 0, (n + 3 & ~@as(usize, 3)) - str.len);
            }
        }
        const size: u32 = @intCast(s.out.items.len - at);
        std.mem.writeInt(u32, s.out.items[at + 4 ..][0..4], size << 16 | opcode, .little);
    }

    fn int(s: *Server, v: u32) !void {
        var b: [4]u8 = undefined;
        std.mem.writeInt(u32, &b, v, .little);
        try s.out.appendSlice(s.gpa, &b);
    }

    /// Closes the next file descriptor the client sent: a request that
    /// carries one (a buffer's memory) is answered without looking at it.
    fn dropFd(s: *Server) bool {
        if (s.fds.items.len == 0) return false;
        sys.close(s.fds.orderedRemove(0));
        return true;
    }

    fn add(s: *Server, id: u32, iface: Iface, version: u32) !bool {
        if (id == 0 or id >= server_ids or s.objects.contains(id) or s.objects.count() >= max_objects) return false;
        try s.objects.put(s.gpa, id, .{ .iface = iface, .version = version });
        return true;
    }

    /// Forgets an object; the client may use the id of one of its own
    /// again once it is told so.
    fn destroy(s: *Server, id: u32) !void {
        if (s.objects.fetchRemove(id)) |kv| {
            var o = kv.value;
            o.frames.deinit(s.gpa);
        }
        if (id < server_ids) try s.event(1, 1, .{id}); // wl_display.delete_id
    }

    /// Handles one request; false when the client broke the protocol.
    pub fn request(s: *Server, id: u32, opcode: u16, args_in: []const u8) !bool {
        const o = s.objects.getPtr(id) orelse return false;
        var a: Args = .{ .b = args_in };
        var ok = true;
        const version = o.version;
        switch (o.iface) {
            .wl_display => switch (opcode) {
                0 => { // sync
                    const cb = a.u32_();
                    s.serial +%= 1;
                    try s.event(cb, 0, .{s.serial});
                    try s.event(1, 1, .{cb});
                },
                1 => { // get_registry
                    const reg = a.u32_();
                    if (!try s.add(reg, .wl_registry, 1)) return false;
                    for (s.globals.items, 0..) |g, i| try s.event(reg, 0, .{ @as(u32, @intCast(i + 1)), @tagName(g.iface), g.version });
                },
                else => {},
            },
            .wl_registry => if (opcode == 0) { // bind
                const name = a.u32_();
                const iface = a.str();
                const ver = a.u32_();
                const nid = a.u32_();
                if (a.bad or name == 0 or name > s.globals.items.len) return false;
                const g = s.globals.items[name - 1];
                if (!std.mem.eql(u8, @tagName(g.iface), iface) or ver == 0 or ver > g.version) return false;
                if (!try s.add(nid, g.iface, ver)) return false;
                switch (g.iface) {
                    .wl_shm => {
                        try s.event(nid, 0, .{@as(u32, 0)}); // ARGB8888
                        try s.event(nid, 0, .{@as(u32, 1)}); // XRGB8888
                    },
                    .wl_output => {
                        try s.event(nid, 0, .{ @as(i32, 0), @as(i32, 0), @as(i32, screen_w * 254 / 960), @as(i32, screen_h * 254 / 960), @as(i32, 0), "virtual", "display", @as(i32, 0) });
                        try s.event(nid, 1, .{ @as(u32, 3), @as(i32, screen_w), @as(i32, screen_h), @as(i32, frame_rate * 1000) });
                        try s.event(nid, 3, .{@as(i32, 1)}); // scale
                        try s.event(nid, 2, .{}); // done
                    },
                    .wl_drm => {
                        try s.event(nid, 0, .{s.device});
                        try s.event(nid, 1, .{formats[0]});
                        try s.event(nid, 1, .{formats[1]});
                        try s.event(nid, 3, .{@as(u32, 1)}); // capabilities: PRIME
                    },
                    .zwp_linux_dmabuf_v1 => for (s.mods) |m| try s.event(nid, 1, .{ m.format, @as(u32, @truncate(m.mod >> 32)), @as(u32, @truncate(m.mod)) }),
                    else => {},
                }
            },
            .wl_compositor => switch (opcode) {
                0 => ok = try s.add(a.u32_(), .wl_surface, version),
                1 => ok = try s.add(a.u32_(), .wl_region, 1),
                else => {},
            },
            .wl_surface => switch (opcode) {
                0 => try s.destroy(id),
                1 => { // attach
                    o.buffer = a.u32_();
                    o.attached = true;
                },
                3 => { // frame
                    const cb = a.u32_();
                    if (!try s.add(cb, .wl_callback, 1)) return false;
                    // add may have moved the objects: look the surface up again.
                    try s.objects.getPtr(id).?.frames.append(s.gpa, cb);
                },
                6 => try s.commit(id),
                else => {},
            },
            .xdg_wm_base => switch (opcode) {
                0 => try s.destroy(id),
                1 => ok = try s.add(a.u32_(), .xdg_positioner, 1),
                2 => {
                    const nid = a.u32_();
                    const surf = a.u32_();
                    ok = try s.add(nid, .xdg_surface, 1);
                    if (ok) s.objects.getPtr(nid).?.parent = surf;
                },
                else => {},
            },
            .xdg_surface => switch (opcode) {
                0 => try s.destroy(id),
                1 => {
                    const nid = a.u32_();
                    const parent = o.parent;
                    ok = try s.add(nid, .xdg_toplevel, 1);
                    if (ok) {
                        s.objects.getPtr(nid).?.parent = id;
                        if (s.objects.getPtr(parent)) |surf| if (surf.iface == .wl_surface) {
                            surf.toplevel = true;
                        };
                    }
                },
                2 => ok = try s.add(a.u32_(), .xdg_popup, 1),
                else => {},
            },
            .wl_shm => if (opcode == 0) { // create_pool
                ok = try s.add(a.u32_(), .wl_shm_pool, 1);
                ok = ok and s.dropFd();
            },
            .wl_shm_pool => switch (opcode) {
                0 => ok = try s.add(a.u32_(), .wl_buffer, 1),
                1 => try s.destroy(id),
                else => {},
            },
            .wl_drm => switch (opcode) {
                0 => try s.event(id, 2, .{}), // authenticate: a render node needs none
                1, 2 => ok = try s.add(a.u32_(), .wl_buffer, 1),
                3 => { // create_prime_buffer
                    ok = try s.add(a.u32_(), .wl_buffer, 1);
                    ok = ok and s.dropFd();
                },
                else => {},
            },
            .zwp_linux_dmabuf_v1 => switch (opcode) {
                0 => try s.destroy(id),
                1 => ok = try s.add(a.u32_(), .zwp_linux_buffer_params_v1, 1),
                else => {},
            },
            .zwp_linux_buffer_params_v1 => switch (opcode) {
                0 => try s.destroy(id),
                1 => ok = s.dropFd(), // add
                2 => { // create: the buffer is an object of the server's
                    if (s.objects.count() >= max_objects or s.next_id == std.math.maxInt(u32)) return false;
                    s.next_id += 1;
                    try s.objects.put(s.gpa, s.next_id, .{ .iface = .wl_buffer, .version = 1 });
                    try s.event(id, 0, .{s.next_id});
                },
                3 => ok = try s.add(a.u32_(), .wl_buffer, 1), // create_immed
                else => {},
            },
            // Their first request destroys them (wl_output's from version
            // 3, which is not offered); what the others say changes nothing.
            .wl_region, .wl_buffer, .xdg_positioner, .xdg_toplevel, .xdg_popup, .wl_output => if (opcode == 0) try s.destroy(id),
            .wl_callback => {},
        }
        return ok and !a.bad;
    }

    /// Applies a surface's pending state: a toplevel is configured at its
    /// first commit, the buffer released (nothing shows it) and the frame
    /// callbacks answered at the next tick.
    fn commit(s: *Server, id: u32) !void {
        const o = s.objects.getPtr(id).?;
        if (o.toplevel and !o.configured) {
            o.configured = true;
            var it = s.objects.iterator();
            var xdgs: std.ArrayList(u32) = .empty;
            defer xdgs.deinit(s.gpa);
            while (it.next()) |e| if (e.value_ptr.iface == .xdg_surface and e.value_ptr.parent == id) try xdgs.append(s.gpa, e.key_ptr.*);
            for (xdgs.items) |xid| {
                var it2 = s.objects.iterator();
                while (it2.next()) |t| if (t.value_ptr.iface == .xdg_toplevel and t.value_ptr.parent == xid) {
                    // No size: the client keeps the one it asked for.
                    try s.event(t.key_ptr.*, 0, .{ @as(i32, 0), @as(i32, 0), Arr{ .b = &.{} } });
                };
                s.serial +%= 1;
                try s.event(xid, 0, .{s.serial});
            }
        }
        const o2 = s.objects.getPtr(id).?;
        if (o2.attached) {
            o2.attached = false;
            if (s.objects.get(o2.buffer)) |b| if (b.iface == .wl_buffer) try s.event(o2.buffer, 0, .{}); // release
        }
        try s.due.appendSlice(s.gpa, o2.frames.items);
        o2.frames.clearRetainingCapacity();
    }

    /// Handles the complete requests read so far.
    pub fn parse(s: *Server) !void {
        var pos: usize = 0;
        defer {
            const rest = s.in.items.len - pos;
            std.mem.copyForwards(u8, s.in.items[0..rest], s.in.items[pos..]);
            s.in.items.len = rest;
        }
        while (s.in.items.len - pos >= 8) {
            const m = s.in.items[pos..];
            const id = std.mem.readInt(u32, m[0..4], .little);
            const word = std.mem.readInt(u32, m[4..8], .little);
            const size: usize = word >> 16;
            if (size < 8 or size > max_message or size % 4 != 0) return error.Protocol;
            if (m.len < size) return;
            if (!try s.request(id, @truncate(word), m[8..size])) {
                s.broke = .{ id, @truncate(word) };
                return error.Protocol;
            }
            pos += size;
        }
    }

    /// Answers the frame callbacks that are due.
    fn tick(s: *Server, ms: u32) !void {
        for (s.due.items) |cb| {
            const o = s.objects.get(cb) orelse continue;
            if (o.iface != .wl_callback) continue;
            try s.event(cb, 0, .{ms});
            try s.destroy(cb);
        }
        s.due.clearRetainingCapacity();
    }

    fn flush(s: *Server) !void {
        try sys.writeAll(s.fd, s.out.items);
        s.out.clearRetainingCapacity();
    }

    /// Serves the client until it is gone.
    pub fn serve(s: *Server) !void {
        var buf: [64 << 10]u8 = undefined;
        // libwayland sends at most 28 descriptors at once.
        var cbuf: [16 + 4 * 28 + 16]u8 align(8) = undefined;
        const period_us: i64 = 1_000_000 / frame_rate;
        const start = sys.nowUs();
        var last: i64 = 0;
        var next: i64 = 0;
        try sys.setNonblock(s.fd);
        while (true) {
            // Ticks are a period apart while callbacks are due, and none
            // happen otherwise: an idle display costs nothing.
            var timeout: i32 = -1;
            if (s.due.items.len > 0) {
                if (next == 0) next = last + period_us;
                timeout = @intCast(@max(0, @divTrunc(next - sys.nowUs() + 999, 1000)));
            }
            var p = [_]sys.PollFd{.{ .fd = s.fd, .events = sys.POLL.IN, .revents = 0 }};
            _ = try sys.poll(&p, timeout);
            if (p[0].revents & (sys.POLL.IN | sys.POLL.HUP | sys.POLL.ERR) != 0) {
                const r = recvmsg(s.fd, &buf, &cbuf) catch |e| {
                    if (sys.errno() == sys.EAGAIN) continue;
                    return e;
                };
                if (r.n == 0 and r.fds.len == 0) return; // the client is gone
                try s.fds.appendSlice(s.gpa, r.fds);
                if (s.fds.items.len > max_fds) return error.Protocol;
                try s.in.appendSlice(s.gpa, buf[0..r.n]);
                if (s.in.items.len > 1 << 20) return error.Protocol;
                try s.parse();
            }
            const now = sys.nowUs();
            if (s.due.items.len > 0 and next != 0 and now >= next) {
                try s.tick(@truncate(@as(u64, @intCast(now - start)) / 1000));
                last = now;
                next = 0;
            }
            try s.flush();
        }
    }
};

const Arr = struct { b: []const u8 };

const Args = struct {
    b: []const u8,
    bad: bool = false,

    fn u32_(a: *Args) u32 {
        if (a.b.len < 4) {
            a.bad = true;
            return 0;
        }
        const v = std.mem.readInt(u32, a.b[0..4], .little);
        a.b = a.b[4..];
        return v;
    }

    fn str(a: *Args) []const u8 {
        const n: u64 = a.u32_();
        const padded = (n + 3) & ~@as(u64, 3);
        if (n == 0 or padded > a.b.len) {
            if (n != 0) a.bad = true;
            return "";
        }
        const v = a.b[0 .. n - 1];
        a.b = a.b[@intCast(padded)..];
        return v;
    }
};

/// recvmsg with the descriptors of SCM_RIGHTS messages (close-on-exec).
fn recvmsg(fd: sys.fd_t, buf: []u8, cbuf: []align(8) u8) !struct { n: usize, fds: []const i32 } {
    var iov = [_]extern struct { base: [*]u8, len: usize }{.{ .base = buf.ptr, .len = buf.len }};
    var msg: extern struct {
        name: ?*anyopaque = null,
        namelen: u32 = 0,
        iov: *anyopaque,
        iovlen: usize = 1,
        control: *anyopaque,
        controllen: usize,
        flags: i32 = 0,
    } = .{ .iov = &iov, .control = cbuf.ptr, .controllen = cbuf.len };
    const MSG_DONTWAIT = 0x40;
    const MSG_CMSG_CLOEXEC = 0x40000000;
    const n = try sys.check(std.os.linux.syscall3(.recvmsg, @intCast(fd), @intFromPtr(&msg), MSG_DONTWAIT | MSG_CMSG_CLOEXEC));
    // struct cmsghdr { size_t len; int level; int type; data }
    var fds_out: []const i32 = &.{};
    var off: usize = 0;
    while (off + 16 <= msg.controllen) {
        const len = std.mem.readInt(usize, cbuf[off..][0..8], .little);
        const level = std.mem.readInt(i32, cbuf[off + 8 ..][0..4], .little);
        const typ = std.mem.readInt(i32, cbuf[off + 12 ..][0..4], .little);
        if (len < 16 or off + len > msg.controllen) break;
        if (level == 1 and typ == 1) { // SOL_SOCKET, SCM_RIGHTS
            const count = (len - 16) / 4;
            fds_out = @as([*]const i32, @ptrCast(@alignCast(cbuf.ptr + off + 16)))[0..count];
        }
        off += (len + 7) & ~@as(usize, 7);
    }
    return .{ .n = n, .fds = fds_out };
}

pub fn run(gpa: std.mem.Allocator, device: []const u8, nvidia: bool) !void {
    const mods = if (nvidia) try nvidiaModifiers(gpa) else &[_]Modifier{};
    var s = try Server.init(gpa, 3, device, mods);
    defer s.closeFds();
    s.serve() catch |e| {
        if (e == error.Protocol) {
            var buf: [128]u8 = undefined;
            const m = std.fmt.bufPrint(&buf, "gui-wl: the client broke the protocol (object {d}, request {d})\n", .{ s.broke[0], s.broke[1] }) catch "";
            sys.writeAll(2, m) catch {};
        }
        return e;
    };
}

const testing = std.testing;

/// A client's request.
fn req(b: *std.ArrayList(u8), id: u32, opcode: u16, args: []const u32) !void {
    var w: [4]u8 = undefined;
    std.mem.writeInt(u32, &w, id, .little);
    try b.appendSlice(testing.allocator, &w);
    std.mem.writeInt(u32, &w, @as(u32, @intCast(8 + 4 * args.len)) << 16 | opcode, .little);
    try b.appendSlice(testing.allocator, &w);
    for (args) |a| {
        std.mem.writeInt(u32, &w, a, .little);
        try b.appendSlice(testing.allocator, &w);
    }
}

fn testServer(mods: []const Modifier) !Server {
    return Server.init(testing.allocator, -1, "/dev/dri/renderD128", mods);
}

fn deinit(s: *Server) void {
    var it = s.objects.valueIterator();
    while (it.next()) |o| o.frames.deinit(testing.allocator);
    s.objects.deinit(testing.allocator);
    s.globals.deinit(testing.allocator);
    s.in.deinit(testing.allocator);
    s.out.deinit(testing.allocator);
    s.fds.deinit(testing.allocator);
    s.due.deinit(testing.allocator);
}

/// The events queued, as (object, opcode).
fn events(s: *Server) ![]const [2]u32 {
    var out: std.ArrayList([2]u32) = .empty;
    var off: usize = 0;
    while (off + 8 <= s.out.items.len) {
        const id = std.mem.readInt(u32, s.out.items[off..][0..4], .little);
        const word = std.mem.readInt(u32, s.out.items[off + 4 ..][0..4], .little);
        try out.append(testing.allocator, .{ id, word & 0xffff });
        off += word >> 16;
    }
    s.out.clearRetainingCapacity();
    return out.toOwnedSlice(testing.allocator);
}

fn bindReq(b: *std.ArrayList(u8), name: u32, iface: []const u8, version: u32, nid: u32) !void {
    var args: std.ArrayList(u32) = .empty;
    defer args.deinit(testing.allocator);
    try args.append(testing.allocator, name);
    const n = iface.len + 1;
    try args.append(testing.allocator, @intCast(n));
    var padded: [64]u8 = @splat(0);
    @memcpy(padded[0..iface.len], iface);
    var i: usize = 0;
    while (i < (n + 3) / 4) : (i += 1) try args.append(testing.allocator, std.mem.readInt(u32, padded[i * 4 ..][0..4], .little));
    try args.append(testing.allocator, version);
    try args.append(testing.allocator, nid);
    try req(b, 2, 0, args.items);
}

// The protocol as Xwayland drives it: the registry, binding the globals,
// a toplevel surface configured at its first commit, a buffer released
// at once, a frame callback answered at the tick.
test "the compositor serves a client" {
    var s = try testServer(&.{});
    defer deinit(&s);
    try req(&s.in, 1, 1, &.{2}); // get_registry → 2
    try s.parse();
    const reg = try events(&s);
    defer testing.allocator.free(reg);
    try testing.expectEqual(@as(usize, 5), reg.len);
    try bindReq(&s.in, 1, "wl_compositor", 4, 3);
    try bindReq(&s.in, 4, "xdg_wm_base", 1, 4);
    try bindReq(&s.in, 5, "wl_drm", 2, 5);
    try s.parse();
    const drm = try events(&s);
    defer testing.allocator.free(drm);
    try testing.expectEqual(@as(usize, 4), drm.len); // device, two formats, capabilities
    try req(&s.in, 3, 0, &.{10}); // create_surface → 10
    try req(&s.in, 4, 2, &.{ 11, 10 }); // get_xdg_surface → 11 of 10
    try req(&s.in, 11, 1, &.{12}); // get_toplevel → 12
    try req(&s.in, 5, 1, &.{ 13, 0, 0, 0, 0, 0, 0 }); // create_buffer → 13
    try req(&s.in, 10, 1, &.{ 13, 0, 0 }); // attach
    try req(&s.in, 10, 3, &.{14}); // frame → 14
    try req(&s.in, 10, 6, &.{}); // commit
    try s.parse();
    const ev = try events(&s);
    defer testing.allocator.free(ev);
    // toplevel configure, xdg_surface configure, buffer release.
    try testing.expectEqualSlices([2]u32, &.{ .{ 12, 0 }, .{ 11, 0 }, .{ 13, 0 } }, ev);
    try s.tick(16);
    const t = try events(&s);
    defer testing.allocator.free(t);
    try testing.expectEqualSlices([2]u32, &.{ .{ 14, 0 }, .{ 1, 1 } }, t); // done, delete_id
}

test "protocol errors end the client" {
    var s = try testServer(&.{});
    defer deinit(&s);
    // An unknown object.
    try req(&s.in, 99, 0, &.{});
    try testing.expectError(error.Protocol, s.parse());
    s.in.clearRetainingCapacity();
    // A message whose size is not a multiple of four, or too large.
    try s.in.appendSlice(testing.allocator, &[_]u8{ 1, 0, 0, 0, 0, 0, 9, 0 });
    try testing.expectError(error.Protocol, s.parse());
    s.in.clearRetainingCapacity();
    // Binding a global under another interface's name.
    try req(&s.in, 1, 1, &.{2});
    try s.parse();
    testing.allocator.free(try events(&s));
    try bindReq(&s.in, 1, "wl_shm", 1, 3);
    try testing.expectError(error.Protocol, s.parse());
    s.in.clearRetainingCapacity();
    // An id the server owns.
    try req(&s.in, 1, 1, &.{0xff000005});
    try testing.expectError(error.Protocol, s.parse());
    s.in.clearRetainingCapacity();
    // A request that needs a descriptor without one.
    try bindReq(&s.in, 2, "wl_shm", 1, 3);
    try s.parse();
    testing.allocator.free(try events(&s));
    try req(&s.in, 3, 0, &.{ 4, 4096 });
    try testing.expectError(error.Protocol, s.parse());
}

test "the objects a client may make are bounded" {
    var s = try testServer(&.{});
    defer deinit(&s);
    try req(&s.in, 1, 1, &.{2});
    try bindReq(&s.in, 1, "wl_compositor", 4, 3);
    try s.parse();
    testing.allocator.free(try events(&s));
    var id: u32 = 10;
    while (s.objects.count() < max_objects) : (id += 1) {
        try req(&s.in, 3, 1, &.{id});
        try s.parse();
    }
    try req(&s.in, 3, 1, &.{id});
    try testing.expectError(error.Protocol, s.parse());
}

test "nvidia modifiers" {
    const mods = try nvidiaModifiers(testing.allocator);
    defer testing.allocator.free(mods);
    try testing.expectEqual(formats.len * (1 + 3 * 3 * 2 * 5 * 6), mods.len);
    try testing.expectEqual(@as(u64, 0), mods[0].mod);
    // Block linear 2D, kind 0xfe, generation 0, sector layout 0, no
    // compression, height 0.
    try testing.expectEqual(@as(u64, 0x0300000000000000 | 0x10 | 0xfe << 12), mods[1].mod);
}
