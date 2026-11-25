//! The window manager's messages with its node (backend/features/gui/
//! machine/helper.ts speaks the same): over the helper's stdin and stdout,
//! each [u32 little-endian n][u8 type][n-1 bytes], numbers little-endian.
//! Everything the node sends is checked here before it is used: a message
//! of an unknown type, of the wrong length, or naming a rectangle or a
//! batch out of bounds ends the helper.
const std = @import("std");

/// The longest message the node may send.
pub const max_in = 1 << 20;

/// The node's messages.
pub const In = enum(u8) {
    focus = 1, // win u32
    close = 2, // win u32
    pointer = 3, // win u32, x i32, y i32
    button = 4, // win u32, x i32, y i32, button u8, down u8
    wheel = 5, // win u32, x i32, y i32, dx i32, dy i32
    key = 6, // win u32, keycode u8, down u8
    release = 7, // nothing
    capture = 8, // n u16, n jobs (Job)
    video_close = 9, // stream u32
    encoder = 10, // the encoder's path
};

/// The helper's messages.
pub const Out = enum(u8) {
    ready = 1, // shm u8, width u16, height u16
    window = 2, // id u32, w u16, h u16, pid u32, transient u32, title (u16 n, bytes), terminal (u16 n, bytes)
    gone = 3, // id u32
    layer = 4, // id u32, owner u32, x i32, y i32, w u16, h u16
    layer_gone = 5, // id u32, owner u32
    damage = 6, // n u16, n × (drawable u32, x i32, y i32, w i32, h i32)
    cursor = 7, // xhot u16, yhot u16, PNG
    frame = 8, // FrameHead, then name, codec (u8 n, bytes each) and coded w, h (u16) when started, error (u16 n, bytes), data
    batch_done = 9, // nothing
};

pub const Enc = struct {
    pub const none: u8 = 0;
    pub const jpeg: u8 = 1;
    pub const png: u8 = 2;
    pub const video: u8 = 3;
    pub const video_key: u8 = 4;
};

/// Video stream kinds as the node names them.
pub const Kind = enum(u8) { avc1 = 1, vp8 = 2 };

pub const max_jobs = 1024;
pub const max_side = 8192;
/// Encoders take at most this (NVENC's H.264).
pub const max_video_side = 4096;
/// The most pixels of one batch: what a full budget of tiles can hold.
pub const max_batch_pixels = 256 << 20;

pub const Job = struct {
    window: u32,
    drawable: u32,
    x: i16,
    y: i16,
    w: u16,
    h: u16,
    seq: u32,
    /// Enc.jpeg, Enc.png, or Enc.video for a frame of stream.
    enc: u8,
    stream: u32,
    key: bool,
    /// The kinds a new stream may be of, in order (none: the stream runs).
    kinds: [2]Kind,
    nkinds: u8,
};

/// The bytes of a job: window, drawable, x, y, w, h, seq, enc, stream, key,
/// nkinds, kinds[2].
pub const job_len = 4 + 4 + 2 + 2 + 2 + 2 + 4 + 1 + 4 + 1 + 1 + 2;

pub const Error = error{BadMessage};

fn rd(comptime T: type, b: []const u8, off: usize) T {
    return std.mem.readInt(T, b[off..][0..@sizeOf(T)], .little);
}

/// A checked message of the node.
pub const Msg = union(In) {
    focus: u32,
    close: u32,
    pointer: struct { win: u32, x: i32, y: i32 },
    button: struct { win: u32, x: i32, y: i32, button: u8, down: bool },
    wheel: struct { win: u32, x: i32, y: i32, dx: i32, dy: i32 },
    key: struct { win: u32, keycode: u8, down: bool },
    release: void,
    capture: []const u8, // the jobs, each checked by job()
    video_close: u32,
    encoder: []const u8,
};

fn want(p: []const u8, n: usize) Error!void {
    if (p.len != n) return error.BadMessage;
}

/// Checks message t with payload p.
pub fn parse(t: u8, p: []const u8) Error!Msg {
    const kind = std.enums.fromInt(In, t) orelse return error.BadMessage;
    switch (kind) {
        .focus => {
            try want(p, 4);
            return .{ .focus = rd(u32, p, 0) };
        },
        .close => {
            try want(p, 4);
            return .{ .close = rd(u32, p, 0) };
        },
        .pointer => {
            try want(p, 12);
            return .{ .pointer = .{ .win = rd(u32, p, 0), .x = rd(i32, p, 4), .y = rd(i32, p, 8) } };
        },
        .button => {
            try want(p, 14);
            if (p[13] > 1) return error.BadMessage;
            return .{ .button = .{ .win = rd(u32, p, 0), .x = rd(i32, p, 4), .y = rd(i32, p, 8), .button = p[12], .down = p[13] == 1 } };
        },
        .wheel => {
            try want(p, 20);
            return .{ .wheel = .{ .win = rd(u32, p, 0), .x = rd(i32, p, 4), .y = rd(i32, p, 8), .dx = rd(i32, p, 12), .dy = rd(i32, p, 16) } };
        },
        .key => {
            try want(p, 6);
            if (p[5] > 1) return error.BadMessage;
            return .{ .key = .{ .win = rd(u32, p, 0), .keycode = p[4], .down = p[5] == 1 } };
        },
        .release => {
            try want(p, 0);
            return .release;
        },
        .capture => {
            if (p.len < 2) return error.BadMessage;
            const n = rd(u16, p, 0);
            if (n == 0 or n > max_jobs or p.len != 2 + @as(usize, n) * job_len) return error.BadMessage;
            var pixels: u64 = 0;
            var i: usize = 0;
            while (i < n) : (i += 1) {
                const j = try job(p[2..], i);
                pixels += @as(u64, j.w) * j.h;
            }
            if (pixels > max_batch_pixels) return error.BadMessage;
            return .{ .capture = p[2..] };
        },
        .video_close => {
            try want(p, 4);
            return .{ .video_close = rd(u32, p, 0) };
        },
        .encoder => {
            if (p.len == 0 or p.len > 4096 or p[0] != '/' or std.mem.indexOfScalar(u8, p, 0) != null) return error.BadMessage;
            return .{ .encoder = p };
        },
    }
}

/// Job i of a capture's jobs, checked: a rectangle of at most max_side a
/// side within the coordinates X has, a known encoding, kinds only for a
/// video frame.
pub fn job(jobs: []const u8, i: usize) Error!Job {
    const b = jobs[i * job_len ..][0..job_len];
    var j: Job = .{
        .window = rd(u32, b, 0),
        .drawable = rd(u32, b, 4),
        .x = rd(i16, b, 8),
        .y = rd(i16, b, 10),
        .w = rd(u16, b, 12),
        .h = rd(u16, b, 14),
        .seq = rd(u32, b, 16),
        .enc = b[20],
        .stream = rd(u32, b, 21),
        .key = b[25] == 1,
        .nkinds = b[26],
        .kinds = undefined,
    };
    if (b[25] > 1 or j.w == 0 or j.h == 0 or j.w > max_side or j.h > max_side or j.x < 0 or j.y < 0) return error.BadMessage;
    if (@as(i32, j.x) + j.w > 32767 or @as(i32, j.y) + j.h > 32767) return error.BadMessage;
    switch (j.enc) {
        Enc.jpeg, Enc.png => if (j.nkinds != 0 or j.stream != 0 or j.key) return error.BadMessage,
        Enc.video => {
            if (j.stream == 0 or j.nkinds > 2 or j.x != 0 or j.y != 0 or j.w > max_video_side or j.h > max_video_side) return error.BadMessage;
            var k: usize = 0;
            while (k < j.nkinds) : (k += 1) j.kinds[k] = std.enums.fromInt(Kind, b[27 + k]) orelse return error.BadMessage;
        },
        else => return error.BadMessage,
    }
    return j;
}

/// Splits the bytes read so far into messages.
pub const Reader = struct {
    buf: std.ArrayList(u8) = .empty,
    pos: usize = 0,

    /// The next complete message, null until one is; error for a frame
    /// whose length is out of bounds.
    pub fn next(r: *Reader) Error!?struct { t: u8, p: []const u8 } {
        const avail = r.buf.items[r.pos..];
        if (avail.len < 4) return null;
        const n = rd(u32, avail, 0);
        if (n == 0 or n > max_in) return error.BadMessage;
        if (avail.len < 4 + n) return null;
        r.pos += 4 + n;
        return .{ .t = avail[4], .p = avail[5 .. 4 + n] };
    }

    /// Drops what was taken; call before reading more.
    pub fn compact(r: *Reader) void {
        if (r.pos == 0) return;
        const rest = r.buf.items.len - r.pos;
        std.mem.copyForwards(u8, r.buf.items[0..rest], r.buf.items[r.pos..]);
        r.buf.items.len = rest;
        r.pos = 0;
    }
};

/// Messages to the node, queued until its pipe takes them.
pub const Writer = struct {
    gpa: std.mem.Allocator,
    buf: std.ArrayList(u8) = .empty,
    pos: usize = 0,

    pub fn pending(w: *const Writer) usize {
        return w.buf.items.len - w.pos;
    }

    /// Starts a message; returns the offset of its length to finish.
    pub fn begin(w: *Writer, t: Out) !usize {
        const at = w.buf.items.len;
        try w.buf.appendSlice(w.gpa, &[_]u8{ 0, 0, 0, 0, @intFromEnum(t) });
        return at;
    }

    pub fn finish(w: *Writer, at: usize) void {
        const n: u32 = @intCast(w.buf.items.len - at - 4);
        std.mem.writeInt(u32, w.buf.items[at..][0..4], n, .little);
    }

    pub fn int(w: *Writer, comptime T: type, v: T) !void {
        var b: [@sizeOf(T)]u8 = undefined;
        std.mem.writeInt(T, &b, v, .little);
        try w.buf.appendSlice(w.gpa, &b);
    }

    pub fn bytes(w: *Writer, b: []const u8) !void {
        try w.buf.appendSlice(w.gpa, b);
    }

    /// A string of at most maxInt(T) bytes, its length first.
    pub fn str(w: *Writer, comptime T: type, s: []const u8) !void {
        const n = @min(s.len, std.math.maxInt(T));
        try w.int(T, @intCast(n));
        try w.bytes(s[0..n]);
    }

    /// Writes what fd takes without waiting; error when the node is gone.
    pub fn flushTo(w: *Writer, fd: i32, write: anytype) !void {
        while (w.pending() > 0) {
            const n = write(fd, w.buf.items[w.pos..]) catch |e| return e;
            if (n == 0) break;
            w.pos += n;
        }
        if (w.pos == w.buf.items.len) {
            w.buf.clearRetainingCapacity();
            w.pos = 0;
        } else if (w.pos > 1 << 20) {
            const rest = w.buf.items.len - w.pos;
            std.mem.copyForwards(u8, w.buf.items[0..rest], w.buf.items[w.pos..]);
            w.buf.items.len = rest;
            w.pos = 0;
        }
    }
};

fn jobBytes(j: Job) [job_len]u8 {
    var b: [job_len]u8 = @splat(0);
    std.mem.writeInt(u32, b[0..4], j.window, .little);
    std.mem.writeInt(u32, b[4..8], j.drawable, .little);
    std.mem.writeInt(i16, b[8..10], j.x, .little);
    std.mem.writeInt(i16, b[10..12], j.y, .little);
    std.mem.writeInt(u16, b[12..14], j.w, .little);
    std.mem.writeInt(u16, b[14..16], j.h, .little);
    std.mem.writeInt(u32, b[16..20], j.seq, .little);
    b[20] = j.enc;
    std.mem.writeInt(u32, b[21..25], j.stream, .little);
    b[25] = @intFromBool(j.key);
    b[26] = j.nkinds;
    var k: usize = 0;
    while (k < j.nkinds) : (k += 1) b[27 + k] = @intFromEnum(j.kinds[k]);
    return b;
}

const testing = std.testing;

test "messages of the wrong length or kind are refused" {
    try testing.expectError(error.BadMessage, parse(0, ""));
    try testing.expectError(error.BadMessage, parse(99, ""));
    try testing.expectError(error.BadMessage, parse(@intFromEnum(In.focus), "abc"));
    try testing.expectError(error.BadMessage, parse(@intFromEnum(In.release), "x"));
    try testing.expectError(error.BadMessage, parse(@intFromEnum(In.key), &[_]u8{ 1, 0, 0, 0, 38, 2 }));
    const k = try parse(@intFromEnum(In.key), &[_]u8{ 1, 0, 0, 0, 38, 1 });
    try testing.expectEqual(@as(u8, 38), k.key.keycode);
    try testing.expect(k.key.down);
    try testing.expectError(error.BadMessage, parse(@intFromEnum(In.encoder), "relative/path"));
    try testing.expectError(error.BadMessage, parse(@intFromEnum(In.encoder), "/a\x00b"));
}

test "capture jobs are checked" {
    const good: Job = .{ .window = 5, .drawable = 5, .x = 0, .y = 0, .w = 100, .h = 50, .seq = 1, .enc = Enc.jpeg, .stream = 0, .key = false, .kinds = undefined, .nkinds = 0 };
    var msg: [2 + job_len]u8 = undefined;
    std.mem.writeInt(u16, msg[0..2], 1, .little);
    msg[2..].* = jobBytes(good);
    const m = try parse(@intFromEnum(In.capture), &msg);
    const j = try job(m.capture, 0);
    try testing.expectEqual(@as(u16, 100), j.w);

    var bad = good;
    bad.w = 0;
    msg[2..].* = jobBytes(bad);
    try testing.expectError(error.BadMessage, parse(@intFromEnum(In.capture), &msg));
    bad = good;
    bad.w = 9000;
    msg[2..].* = jobBytes(bad);
    try testing.expectError(error.BadMessage, parse(@intFromEnum(In.capture), &msg));
    bad = good;
    bad.x = 32000;
    bad.w = 2000;
    msg[2..].* = jobBytes(bad);
    try testing.expectError(error.BadMessage, parse(@intFromEnum(In.capture), &msg));
    bad = good;
    bad.enc = 7;
    msg[2..].* = jobBytes(bad);
    try testing.expectError(error.BadMessage, parse(@intFromEnum(In.capture), &msg));
    bad = good;
    bad.nkinds = 1; // kinds on a picture
    msg[2..].* = jobBytes(bad);
    try testing.expectError(error.BadMessage, parse(@intFromEnum(In.capture), &msg));
    bad = good;
    bad.enc = Enc.video; // a video frame of no stream
    msg[2..].* = jobBytes(bad);
    try testing.expectError(error.BadMessage, parse(@intFromEnum(In.capture), &msg));
    var vid = good;
    vid.enc = Enc.video;
    vid.stream = 3;
    vid.nkinds = 2;
    vid.kinds = .{ .avc1, .vp8 };
    msg[2..].* = jobBytes(vid);
    const v = try job((try parse(@intFromEnum(In.capture), &msg)).capture, 0);
    try testing.expectEqual(Kind.vp8, v.kinds[1]);
    msg[2 + 28] = 9; // an unknown kind
    try testing.expectError(error.BadMessage, parse(@intFromEnum(In.capture), &msg));
    // The count must match the bytes.
    std.mem.writeInt(u16, msg[0..2], 2, .little);
    try testing.expectError(error.BadMessage, parse(@intFromEnum(In.capture), &msg));
}

test "reader frames messages and refuses huge ones" {
    var r: Reader = .{};
    defer r.buf.deinit(testing.allocator);
    try r.buf.appendSlice(testing.allocator, &[_]u8{ 1, 0, 0, 0, 7, 5, 0, 0 });
    const m = (try r.next()).?;
    try testing.expectEqual(@as(u8, 7), m.t);
    // Three bytes of a length: not yet a message.
    try testing.expect((try r.next()) == null);
    r.compact();
    try testing.expectEqual(@as(usize, 3), r.buf.items.len);
    // A length over max_in.
    try r.buf.appendSlice(testing.allocator, &[_]u8{0x10});
    try testing.expectError(error.BadMessage, r.next());
}
