//! The GUI helper of Linux machines (docs/features/14-gui-windows.md): what
//! of program windows is native work, for the machine side in TypeScript
//! (backend/features/gui/machine), which runs it as
//!
//!   gui-wm    --socket S --pid P --xauth F --hc-socket H --name N
//!             the display's window manager and capture, driven over
//!             stdin and stdout (proto.zig) by its node
//!   gui-probe --socket S --pid P --xauth F
//!             one connection to the display: whether it has DRI3 and the
//!             processes of its clients, as a line of JSON
//!   gui-keep  --socket S --pid P --xauth F --hc-socket H --lock L --display D
//!             holds the display while the terminal core runs (keep.zig)
//!   gui-wl    --device D [--nvidia]
//!             the GPU display's compositor on descriptor 3 (wl.zig)
//!
//! Every X connection goes only to the server whose process is P and whose
//! user is this one, on the socket S and its abstract twin.
const std = @import("std");
const sys = @import("sys.zig");
const x11 = @import("x11.zig");
const proto = @import("proto.zig");
const wmod = @import("wm.zig");
const capture = @import("capture.zig");
const keep = @import("keep.zig");
const wl = @import("wl.zig");

const gpa = std.heap.smp_allocator;

const Args = struct {
    socket: []const u8 = "",
    pid: i32 = 0,
    xauth: [:0]const u8 = "",
    hc_socket: []const u8 = "",
    name: []const u8 = "",
    lock: [:0]const u8 = "",
    display: []const u8 = "",
    device: []const u8 = "",
    nvidia: bool = false,
};

fn usage() noreturn {
    wmod.log("usage: gui-wm|gui-probe|gui-keep|gui-wl [flags] (see the source)", .{});
    sys.exit(2);
}

fn parseArgs(it: anytype) Args {
    var a: Args = .{};
    while (it.next()) |flag| {
        if (std.mem.eql(u8, flag, "--nvidia")) {
            a.nvidia = true;
            continue;
        }
        const v = it.next() orelse usage();
        if (std.mem.eql(u8, flag, "--socket")) a.socket = v //
        else if (std.mem.eql(u8, flag, "--pid")) a.pid = std.fmt.parseInt(i32, v, 10) catch usage() //
        else if (std.mem.eql(u8, flag, "--xauth")) a.xauth = v //
        else if (std.mem.eql(u8, flag, "--hc-socket")) a.hc_socket = v //
        else if (std.mem.eql(u8, flag, "--name")) a.name = v //
        else if (std.mem.eql(u8, flag, "--lock")) a.lock = v //
        else if (std.mem.eql(u8, flag, "--display")) a.display = v //
        else if (std.mem.eql(u8, flag, "--device")) a.device = v //
        else usage();
    }
    return a;
}

pub fn main(init: std.process.Init.Minimal) void {
    sys.ignoreSigpipe();
    var it = init.args.iterate();
    _ = it.next();
    const cmd = it.next() orelse usage();
    const a = parseArgs(&it);
    const envp: [*:null]const ?[*:0]const u8 = init.environ.block.slice.ptr;
    const r = if (std.mem.eql(u8, cmd, "gui-wm"))
        windowManager(a, envp)
    else if (std.mem.eql(u8, cmd, "gui-probe"))
        probe(a)
    else if (std.mem.eql(u8, cmd, "gui-keep"))
        keep.run(gpa, .{ .lock = a.lock, .socket = a.socket, .pid = a.pid, .xauth = a.xauth, .hc_socket = a.hc_socket, .display = a.display })
    else if (std.mem.eql(u8, cmd, "gui-wl"))
        wl.run(gpa, a.device, a.nvidia)
    else
        usage();
    r catch |e| {
        wmod.log("{s}: {s} ({s})", .{ cmd, @errorName(e), if (e == error.Sys) sys.errName(sys.errno()) else "" });
        sys.exit(1);
    };
    sys.exit(0);
}

/// Opens the X connection to the instance's display server.
fn connect(a: Args) !*x11.Conn {
    if (a.socket.len == 0 or a.pid <= 0 or a.xauth.len == 0) usage();
    var cookie: [16]u8 = undefined;
    if (!x11.readCookie(a.xauth.ptr, &cookie)) return error.NoCookie;
    const fd = try x11.connectChecked(a.socket, a.pid);
    return x11.Conn.open(gpa, fd, &cookie) catch |e| {
        sys.close(fd);
        return e;
    };
}

fn probe(a: Args) !void {
    const x = try connect(a);
    defer x.destroy();
    const dri3 = try x.queryExtension("DRI3");
    const res = try x.queryExtension("X-Resource");
    var pids: std.ArrayList(u32) = .empty;
    if (res.present) try x.resClientPids(res, 0, &pids);
    var out: std.ArrayList(u8) = .empty;
    try out.print(gpa, "{{\"dri3\":{},\"res\":{},\"pids\":[", .{ dri3.present, res.present });
    for (pids.items, 0..) |p, i| try out.print(gpa, "{s}{d}", .{ if (i > 0) "," else "", p });
    try out.appendSlice(gpa, "]}\n");
    try sys.writeAll(1, out.items);
}

/// Most of what may wait for the node to read before the helper gives up
/// on it (frames of one batch, events).
const max_backlog = 256 << 20;

fn windowManager(a: Args, envp: [*:null]const ?[*:0]const u8) !void {
    const x = try connect(a);
    var out: proto.Writer = .{ .gpa = gpa };
    const wm = try wmod.WM.init(gpa, x, &out, a.hc_socket, a.name);
    var cap = try capture.Capture.init(gpa, wm, envp);
    defer cap.deinit();
    try wm.adopt();
    try wm.sendCursor();
    {
        const at = try out.begin(.ready);
        try out.int(u8, @intFromBool(wm.shm.present));
        try out.int(u16, x.width);
        try out.int(u16, x.height);
        out.finish(at);
    }
    try sys.setNonblock(0);
    try sys.setNonblock(1);
    var in: proto.Reader = .{};
    // A batch that came while one runs, taken after it.
    var queued: std.ArrayList(u8) = .empty;
    var has_queued = false;
    var stdin_open = true;
    while (true) {
        try x.flush();
        while (x.nextEvent()) |ev| try wm.handle(&ev);
        try x.flush();
        // Damage waits while the node reads slowly: it is a union.
        if (out.pending() < 1 << 20) try wm.reportDamage();
        if (out.pending() > max_backlog) return error.NodeNotReading;
        if (!stdin_open and !cap.busy) return;

        var fds = [_]sys.PollFd{
            .{ .fd = x.fd, .events = sys.POLL.IN, .revents = 0 },
            .{ .fd = 0, .events = if (stdin_open) sys.POLL.IN else 0, .revents = 0 },
            .{ .fd = 1, .events = if (out.pending() > 0) sys.POLL.OUT else 0, .revents = 0 },
            .{ .fd = cap.efd, .events = sys.POLL.IN, .revents = 0 },
        };
        // Events read while waiting for a reply (a capture, a window's
        // properties) are handled without waiting for more to arrive.
        _ = try sys.poll(&fds, if (x.hasEvents()) 0 else -1);
        if (fds[0].revents != 0) x.drain() catch |e| {
            if (e == error.Closed) {
                wmod.log("gui-wm: the display ended", .{});
                return;
            }
            return e;
        };
        if (fds[3].revents != 0) {
            if (try cap.collect() and has_queued) {
                has_queued = false;
                try cap.start(queued.items);
            }
        }
        if (fds[1].revents != 0) {
            in.compact();
            try in.buf.ensureUnusedCapacity(gpa, 64 << 10);
            const free = in.buf.allocatedSlice()[in.buf.items.len..];
            const n = sys.read(0, free) catch |e| blk: {
                if (sys.errno() == sys.EAGAIN) break :blk @as(usize, 1 << 40);
                return e;
            };
            if (n == 0) stdin_open = false else if (n != 1 << 40) in.buf.items.len += n;
            while (in.next() catch return error.BadMessage) |m| {
                const msg = proto.parse(m.t, m.p) catch {
                    wmod.log("gui-wm: the node sent a bad message of type {d} ({d} bytes)", .{ m.t, m.p.len });
                    return error.BadMessage;
                };
                switch (msg) {
                    .capture => |jobs| {
                        if (cap.busy) {
                            if (has_queued) return error.BadMessage; // one batch at a time
                            queued.clearRetainingCapacity();
                            try queued.appendSlice(gpa, jobs);
                            has_queued = true;
                        } else try cap.start(jobs);
                    },
                    .video_close => |s| cap.closeStream(s),
                    .encoder => |p| try cap.setEncoder(p),
                    else => try wm.input(msg),
                }
            }
        }
        if (fds[2].revents & (sys.POLL.ERR | sys.POLL.HUP) != 0) return; // the node is gone
        if (out.pending() > 0) out.flushTo(1, sys.write) catch |e| {
            if (sys.errno() != sys.EAGAIN) return e;
        };
    }
}

test {
    _ = @import("sys.zig");
    _ = @import("proto.zig");
    _ = @import("x11.zig");
    _ = @import("jpeg.zig");
    _ = @import("png.zig");
    _ = @import("wm.zig");
    _ = @import("video.zig");
    _ = @import("keep.zig");
    _ = @import("wl.zig");
    _ = @import("capture.zig");
}
