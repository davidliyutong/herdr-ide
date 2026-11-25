//! A running video encoder (scripts/encoder: ffmpeg's libraries) for one
//! window size, as the Go agent's guivideo.go runs it: started with
//! `-w W -h H -kinds k,…`, it answers `ok <name> <coded w> <coded h>`, then
//! takes [u32 flags][W×H×4 BGRX] per frame and answers [u32 size][u32
//! flags][packet]. Its process is in a group of its own and is killed when
//! the helper dies; it ends at the end of its input.
const std = @import("std");
const sys = @import("sys.zig");
const proto = @import("proto.zig");

/// Bounds starting an encoder (GPU initialization) and a frame's round trip.
pub const start_ms = 15_000;
pub const frame_ms = 3_000;
/// Close waits this long for the encoder to exit on its own.
pub const exit_ms = 2_000;
const max_packet = 64 << 20;

pub const Encoder = struct {
    pid: i32,
    in: sys.fd_t,
    out: sys.fd_t,
    err: sys.fd_t,
    w: u32,
    h: u32,
    cw: u16 = 0,
    ch: u16 = 0,
    name_buf: [32]u8 = undefined,
    name_len: usize = 0,
    kind: proto.Kind = .vp8,
    /// The first line not read yet (start runs in a worker).
    ready: bool = false,

    pub fn name(e: *const Encoder) []const u8 {
        return e.name_buf[0..e.name_len];
    }

    /// The WebCodecs codec string of the stream, from its first (key)
    /// frame: avc1's profile, constraints and level from its sequence
    /// parameter set.
    pub fn codec(e: *const Encoder, first: []const u8, buf: []u8) []const u8 {
        if (e.kind != .avc1) return "vp8";
        var i: usize = 0;
        while (i + 6 < first.len) : (i += 1) {
            if (first[i] == 0 and first[i + 1] == 0 and first[i + 2] == 1 and first[i + 3] & 0x1f == 7)
                return std.fmt.bufPrint(buf, "avc1.{x:0>2}{x:0>2}{x:0>2}", .{ first[i + 4], first[i + 5], first[i + 6] }) catch "avc1.640033";
        }
        return "avc1.640033";
    }
};

/// Starts the encoder process for a w×h window making the first of kinds
/// it can; its first line is read by waitReady. Runs on the helper's main
/// thread: the process dies with the thread that started it.
pub fn spawn(gpa: std.mem.Allocator, bin: [:0]const u8, envp: [*:null]const ?[*:0]const u8, w: u32, h: u32, kinds: []const proto.Kind) !*Encoder {
    var wb: [16]u8 = undefined;
    var hb: [16]u8 = undefined;
    var kb: [32]u8 = undefined;
    const ws = try std.mem.printSentinel(&wb, "{d}", .{w}, 0);
    const hs = try std.mem.printSentinel(&hb, "{d}", .{h}, 0);
    var kl: std.ArrayList(u8) = .initBuffer(&kb);
    for (kinds, 0..) |k, i| {
        if (i > 0) kl.appendAssumeCapacity(',');
        kl.appendSliceAssumeCapacity(@tagName(k));
    }
    kl.appendAssumeCapacity(0);
    const argv = [_:null]?[*:0]const u8{ bin.ptr, "-w", ws.ptr, "-h", hs.ptr, "-kinds", @ptrCast(kl.items.ptr) };
    const in = try sys.pipe2(sys.O_CLOEXEC);
    errdefer {
        sys.close(in[0]);
        sys.close(in[1]);
    }
    const out = try sys.pipe2(sys.O_CLOEXEC);
    errdefer {
        sys.close(out[0]);
        sys.close(out[1]);
    }
    const errp = try sys.pipe2(sys.O_CLOEXEC);
    errdefer {
        sys.close(errp[0]);
        sys.close(errp[1]);
    }
    // Room for a frame's rows in fewer writes; the system may refuse.
    _ = sys.fcntl(in[1], sys.F_SETPIPE_SZ, 1 << 20) catch {};
    const pid = try sys.spawn(&argv, envp, .{ in[0], out[1], errp[1] });
    sys.close(in[0]);
    sys.close(out[1]);
    sys.close(errp[1]);
    try sys.setNonblock(in[1]);
    try sys.setNonblock(out[0]);
    try sys.setNonblock(errp[0]);
    const e = try gpa.create(Encoder);
    e.* = .{ .pid = pid, .in = in[1], .out = out[0], .err = errp[0], .w = w, .h = h };
    return e;
}

/// Reads exactly buf.len bytes from fd before deadline (monotonic µs).
fn readFull(fd: sys.fd_t, buf: []u8, deadline: i64) !void {
    var n: usize = 0;
    while (n < buf.len) {
        const got = sys.read(fd, buf[n..]) catch |e| {
            if (sys.errno() != sys.EAGAIN) return e;
            try waitFor(fd, sys.POLL.IN, deadline);
            continue;
        };
        if (got == 0) return error.EndOfStream;
        n += got;
    }
}

fn writeFull(fd: sys.fd_t, buf: []const u8, deadline: i64) !void {
    var n: usize = 0;
    while (n < buf.len) {
        const got = sys.write(fd, buf[n..]) catch |e| {
            if (sys.errno() != sys.EAGAIN) return e;
            try waitFor(fd, sys.POLL.OUT, deadline);
            continue;
        };
        n += got;
    }
}

fn waitFor(fd: sys.fd_t, ev: i16, deadline: i64) !void {
    const left = deadline - sys.nowUs();
    if (left <= 0) return error.Timeout;
    var p = [_]sys.PollFd{.{ .fd = fd, .events = ev, .revents = 0 }};
    _ = try sys.poll(&p, @intCast(@divTrunc(left + 999, 1000)));
    if (p[0].revents == 0) return error.Timeout;
}

/// What the encoder wrote on its standard error, for a message.
pub fn stderrText(e: *Encoder, buf: []u8) []const u8 {
    const n = sys.read(e.err, buf) catch 0;
    return std.mem.trim(u8, buf[0..n], " \r\n\t");
}

/// Reads the encoder's first line: ok, its name and coded size, or why
/// not.
pub fn waitReady(e: *Encoder, msg: []u8) ![]const u8 {
    const deadline = sys.nowUs() + start_ms * 1000;
    var line: [256]u8 = undefined;
    var n: usize = 0;
    while (n < line.len) {
        readFull(e.out, line[n .. n + 1], deadline) catch |err| {
            return std.fmt.bufPrint(msg, "encoder: {s} {s}", .{ @errorName(err), stderrText(e, msg[msg.len / 2 ..]) }) catch "encoder failed";
        };
        if (line[n] == '\n') break;
        n += 1;
    }
    var it = std.mem.tokenizeScalar(u8, line[0..n], ' ');
    const first = it.next() orelse "";
    if (!std.mem.eql(u8, first, "ok")) {
        const rest = std.mem.trim(u8, line[@min(n, first.len)..n], " ");
        return std.fmt.bufPrint(msg, "encoder: {s} {s}", .{ rest, stderrText(e, msg[msg.len / 2 ..]) }) catch "encoder failed";
    }
    const nm = it.next() orelse return "encoder: no name";
    e.name_len = @min(nm.len, e.name_buf.len);
    @memcpy(e.name_buf[0..e.name_len], nm[0..e.name_len]);
    e.cw = std.fmt.parseInt(u16, it.next() orelse "0", 10) catch 0;
    e.ch = std.fmt.parseInt(u16, it.next() orelse "0", 10) catch 0;
    e.kind = if (std.mem.startsWith(u8, nm, "h264")) .avc1 else .vp8;
    e.ready = true;
    return "";
}

/// Encodes one frame (w×h BGRX), a key frame when key is set; the packet
/// is appended to out. Returns whether it is a key frame.
pub fn encode(e: *Encoder, bgrx: []const u8, key: bool, out: *std.ArrayList(u8), gpa: std.mem.Allocator) !bool {
    const deadline = sys.nowUs() + frame_ms * 1000;
    var hdr: [8]u8 = @splat(0);
    hdr[0] = @intFromBool(key);
    try writeFull(e.in, hdr[0..4], deadline);
    try writeFull(e.in, bgrx[0 .. e.w * e.h * 4], deadline);
    try readFull(e.out, &hdr, deadline);
    const n = std.mem.readInt(u32, hdr[0..4], .little);
    if (n == 0 or n > max_packet) return error.BadPacket;
    const at = out.items.len;
    try out.resize(gpa, at + n);
    try readFull(e.out, out.items[at..], deadline);
    return std.mem.readInt(u32, hdr[4..8], .little) & 1 != 0;
}

/// Ends the encoder: its input closed, it exits; one that does not within
/// exit_ms is killed with its group.
pub fn close(gpa: std.mem.Allocator, e: *Encoder) void {
    sys.close(e.in);
    const deadline = sys.nowUs() + exit_ms * 1000;
    while (true) {
        const r = sys.wait4(e.pid, true) catch break;
        if (r.pid == e.pid) break;
        if (sys.nowUs() > deadline) {
            sys.kill(-e.pid, sys.SIGKILL) catch {};
            _ = sys.wait4(e.pid, false) catch {};
            break;
        }
        sys.sleepMs(20);
    }
    sys.close(e.out);
    sys.close(e.err);
    gpa.destroy(e);
}

test "codec string" {
    var e: Encoder = .{ .pid = 0, .in = -1, .out = -1, .err = -1, .w = 2, .h = 2, .kind = .avc1 };
    var buf: [32]u8 = undefined;
    try std.testing.expectEqualStrings("avc1.64001f", e.codec(&[_]u8{ 0, 0, 0, 1, 0x67, 0x64, 0x00, 0x1f, 0xac }, &buf));
    try std.testing.expectEqualStrings("avc1.640033", e.codec(&[_]u8{ 1, 2, 3 }, &buf));
    e.kind = .vp8;
    try std.testing.expectEqualStrings("vp8", e.codec(&[_]u8{}, &buf));
}
