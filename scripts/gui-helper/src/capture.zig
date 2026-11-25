//! Capturing and encoding a batch of the node's jobs (the Go agent's
//! guiframes.go grab and encode, guishm.go): the damage of each window
//! captured is emptied, every rectangle is requested before the first
//! reply is read, into one MIT-SHM segment where they fit (else through
//! the connection), and the captures are encoded on worker threads at the
//! same time (JPEG in row groups, PNG, video frames through the window's
//! encoder). The frames go to the node in the jobs' order as each is
//! ready; all are waited for before the next batch, since captures may lie
//! in the segment the next one reuses.
const std = @import("std");
const sys = @import("sys.zig");
const x11 = @import("x11.zig");
const proto = @import("proto.zig");
const jpeg = @import("jpeg.zig");
const png = @import("png.zig");
const video = @import("video.zig");
const wmod = @import("wm.zig");

/// JPEG quality of changing areas (they are sent as PNG once settled).
pub const jpeg_quality = 85;
/// A JPEG is coded in up to this many row groups of at least
/// jpeg_group_pixels pixels at the same time.
const jpeg_groups = 8;
const jpeg_group_pixels = 64 << 10;
/// The shared segment is at most this large.
pub const shm_max = 64 << 20;

const Seg = struct { id: u32, shmid: i32, ptr: [*]u8, size: usize };

const Item = struct {
    job: proto.Job,
    pix: ?[]const u8 = null,
    managed: bool = false,
    own: ?[]u8 = null,
    capture_us: u32 = 0,
    data: std.ArrayList(u8) = .empty,
    enc: u8 = proto.Enc.none,
    encode_us: u32 = 0,
    plan: jpeg.Plan = undefined,
    scans: []std.ArrayList(u8) = &.{},
    left: std.atomic.Value(u32) = .init(0),
    start_us: std.atomic.Value(i64) = .init(0),
    /// Video: the stream's encoder (one started for this frame: started).
    vid: ?*video.Encoder = null,
    started: bool = false,
    err: [512]u8 = undefined,
    err_len: usize = 0,
    done: std.atomic.Value(bool) = .init(false),

    fn setErr(it: *Item, comptime fmt: []const u8, args: anytype) void {
        const s = std.fmt.bufPrint(&it.err, fmt, args) catch it.err[0..];
        it.err_len = s.len;
    }
};

const Task = struct { item: u32, group: u32 };

pub const Capture = struct {
    gpa: std.mem.Allocator,
    wm: *wmod.WM,
    envp: [*:null]const ?[*:0]const u8,
    shm_ok: bool,
    seg: ?Seg = null,
    quant: jpeg.Quant,
    cpus: u32,
    efd: sys.fd_t,
    encoder: ?[:0]u8 = null,
    streams: std.AutoHashMapUnmanaged(u32, *video.Encoder) = .empty,

    items: []Item = &.{},
    tasks: std.ArrayList(Task) = .empty,
    next_task: std.atomic.Value(u32) = .init(0),
    threads: std.ArrayList(std.Thread) = .empty,
    written: usize = 0,
    busy: bool = false,

    pub fn init(gpa: std.mem.Allocator, wm: *wmod.WM, envp: [*:null]const ?[*:0]const u8) !Capture {
        return .{
            .gpa = gpa,
            .wm = wm,
            .envp = envp,
            .shm_ok = wm.shm.present,
            .quant = jpeg.quantTables(jpeg_quality),
            .cpus = cpuCount(),
            .efd = try sys.eventfd(sys.O_CLOEXEC | sys.O_NONBLOCK),
        };
    }

    pub fn setEncoder(c: *Capture, path: []const u8) !void {
        if (c.encoder) |e| c.gpa.free(e);
        c.encoder = try c.gpa.dupeSentinel(u8, path, 0);
    }

    pub fn closeStream(c: *Capture, stream: u32) void {
        if (c.streams.fetchRemove(stream)) |kv| retire(c.gpa, kv.value);
    }

    /// Ends every stream and the segment (the window manager is ending).
    pub fn deinit(c: *Capture) void {
        var it = c.streams.valueIterator();
        while (it.next()) |e| video.close(c.gpa, e.*);
        c.streams.deinit(c.gpa);
        if (c.seg) |s| c.freeSeg(s);
    }

    fn freeSeg(c: *Capture, s: Seg) void {
        c.wm.x.shmDetach(c.wm.shm, s.id) catch {};
        sys.shmdt(s.ptr);
        c.seg = null;
    }

    /// A shared segment of at least need bytes (up to shm_max); null
    /// without MIT-SHM. Private to this user (0600) and marked for removal
    /// once attached here, which Linux lets the server attach afterwards:
    /// it goes away with the helper's and the server's attachments.
    fn segment(c: *Capture, need_in: usize) ?Seg {
        if (!c.shm_ok) {
            if (c.seg) |s| c.freeSeg(s);
            return null;
        }
        if (need_in == 0) return null;
        const need = @min(need_in, shm_max);
        if (c.seg) |s| {
            if (s.size >= need) return s;
            c.freeSeg(s);
        }
        var size: usize = 8 << 20;
        while (size < need) size *= 2;
        size = @min(size, shm_max);
        const shmid = sys.shmget(size, sys.IPC_CREAT | 0o600) catch {
            wmod.log("gui-wm: no shared memory capture: shmget {s}", .{sys.errName(sys.errno())});
            c.shm_ok = false;
            return null;
        };
        const ptr = sys.shmat(shmid) catch {
            sys.shmrm(shmid);
            wmod.log("gui-wm: no shared memory capture: shmat {s}", .{sys.errName(sys.errno())});
            c.shm_ok = false;
            return null;
        };
        sys.shmrm(shmid);
        const id = c.wm.x.newId();
        const ok = blk: {
            const seq = c.wm.x.shmAttach(c.wm.shm, id, @intCast(shmid)) catch break :blk false;
            c.wm.x.check(seq) catch break :blk false;
            break :blk true;
        };
        if (!ok) {
            sys.shmdt(ptr);
            wmod.log("gui-wm: no shared memory capture: the server did not attach the segment", .{});
            c.shm_ok = false;
            return null;
        }
        c.seg = .{ .id = id, .shmid = shmid, .ptr = ptr, .size = size };
        return c.seg;
    }

    /// Starts a batch: captures every job's rectangle and hands the
    /// encoding to worker threads. jobs were checked (proto.job).
    pub fn start(c: *Capture, jobs: []const u8) !void {
        std.debug.assert(!c.busy);
        const n = jobs.len / proto.job_len;
        c.items = try c.gpa.alloc(Item, n);
        var need: usize = 0;
        for (c.items, 0..) |*it, i| {
            it.* = .{ .job = try proto.job(jobs, i) };
            // Only the display's managed windows and their layers are
            // captured: another drawable (the root, another client's
            // pixmap) gives nothing.
            it.managed = c.wm.owns(it.job.window, it.job.drawable);
            if (it.managed) need += @as(usize, it.job.w) * it.job.h * 4;
        }
        c.busy = true;
        c.written = 0;
        try c.grab(need);
        try c.startEncoders();
        try c.dispatch();
    }

    fn grab(c: *Capture, need: usize) !void {
        const x = c.wm.x;
        // The damage of what is captured: changes from here on are
        // reported again.
        for (c.items, 0..) |*it, i| {
            if (!it.managed) continue;
            var seen = false;
            for (c.items[0..i]) |o| if (o.job.drawable == it.job.drawable) {
                seen = true;
            };
            if (seen) continue;
            const d = c.wm.damageOf(it.job.drawable);
            if (d != 0) try x.damageSubtract(c.wm.damage, d);
        }
        const seg = c.segment(need);
        const Pending = struct { seq: u32, shm: bool, off: usize, skip: bool = false };
        const ps = try c.gpa.alloc(Pending, c.items.len);
        defer c.gpa.free(ps);
        var off: usize = 0;
        for (c.items, 0..) |*it, i| {
            const j = it.job;
            const size = @as(usize, j.w) * j.h * 4;
            if (!it.managed) {
                ps[i] = .{ .seq = 0, .shm = false, .off = 0, .skip = true };
            } else if (seg != null and off + size <= seg.?.size) {
                ps[i] = .{ .seq = try x.shmGetImage(c.wm.shm, j.drawable, j.x, j.y, j.w, j.h, seg.?.id, @intCast(off)), .shm = true, .off = off };
                off += size;
            } else {
                ps[i] = .{ .seq = try x.getImage(j.drawable, j.x, j.y, j.w, j.h), .shm = false, .off = 0 };
            }
        }
        var last = sys.nowUs();
        for (c.items, 0..) |*it, i| {
            const j = it.job;
            const size = @as(usize, j.w) * j.h * 4;
            if (ps[i].skip) continue;
            const r = x.reply(ps[i].seq) catch |e| blk: {
                if (e != error.XError) return e;
                if (ps[i].shm) if (x.last_err) |xe| if (xe.code == c.wm.shm.err or xe.code == 10) {
                    // The segment, not the window: capture without it from
                    // the next batch on (this one's pixels may lie in it).
                    wmod.log("gui-wm: shared memory capture failed, reading through the connection", .{});
                    c.shm_ok = false;
                };
                break :blk null;
            };
            if (r) |rep| {
                if (ps[i].shm) {
                    if (x11.get32(rep, 12) >= size) it.pix = seg.?.ptr[ps[i].off .. ps[i].off + size];
                } else if (rep.len >= 32 + size) {
                    const own = try c.gpa.alloc(u8, size);
                    @memcpy(own, rep[32 .. 32 + size]);
                    it.own = own;
                    it.pix = own;
                }
            }
            const now = sys.nowUs();
            it.capture_us = @intCast(@max(0, now - last));
            last = now;
        }
    }

    /// Starts the encoders of the video frames that begin a stream (on
    /// this thread, which outlives them; their first answer is waited for
    /// by a worker), and finds the running ones.
    fn startEncoders(c: *Capture) !void {
        for (c.items) |*it| {
            if (it.job.enc != proto.Enc.video or it.pix == null) continue;
            if (it.job.nkinds == 0) {
                it.vid = c.streams.get(it.job.stream);
                if (it.vid == null) it.setErr("no encoder runs for the stream", .{});
                continue;
            }
            const bin = c.encoder orelse {
                it.setErr("no encoder", .{});
                continue;
            };
            it.vid = video.spawn(c.gpa, bin, c.envp, it.job.w, it.job.h, it.job.kinds[0..it.job.nkinds]) catch |e| {
                it.setErr("encoder: {s}", .{@errorName(e)});
                continue;
            };
            it.started = true;
        }
    }

    fn dispatch(c: *Capture) !void {
        c.tasks.clearRetainingCapacity();
        for (c.items, 0..) |*it, i| {
            const idx: u32 = @intCast(i);
            if (it.pix == null or it.err_len > 0) {
                it.done.store(true, .release);
                continue;
            }
            it.start_us.store(sys.nowUs(), .monotonic);
            if (it.job.enc == proto.Enc.jpeg) {
                const px = @as(u32, it.job.w) * it.job.h;
                const parts = @max(1, @min(jpeg_groups, c.cpus, px / jpeg_group_pixels));
                it.plan = jpeg.Plan.of(it.job.w, it.job.h, parts);
                it.scans = try c.gpa.alloc(std.ArrayList(u8), it.plan.groups);
                for (it.scans) |*s| s.* = .empty;
                it.left.store(it.plan.groups, .release);
                var g: u32 = 0;
                while (g < it.plan.groups) : (g += 1) try c.tasks.append(c.gpa, .{ .item = idx, .group = g });
            } else try c.tasks.append(c.gpa, .{ .item = idx, .group = 0 });
        }
        c.next_task.store(0, .release);
        const nthreads = @min(c.tasks.items.len, @max(c.cpus, 1), 16);
        c.threads.clearRetainingCapacity();
        var i: usize = 0;
        while (i < nthreads) : (i += 1) {
            const t = std.Thread.spawn(.{ .stack_size = 2 << 20 }, worker, .{c}) catch {
                if (i == 0) worker(c); // no thread: encode here
                break;
            };
            try c.threads.append(c.gpa, t);
        }
        sys.writeAll(c.efd, std.mem.asBytes(&@as(u64, 1))) catch {};
    }

    fn worker(c: *Capture) void {
        while (true) {
            const i = c.next_task.fetchAdd(1, .acq_rel);
            if (i >= c.tasks.items.len) return;
            const t = c.tasks.items[i];
            const it = &c.items[t.item];
            c.run(it, t.group);
        }
    }

    fn finish(c: *Capture, it: *Item) void {
        it.encode_us = @intCast(@max(0, sys.nowUs() - it.start_us.load(.monotonic)));
        it.done.store(true, .release);
        sys.writeAll(c.efd, std.mem.asBytes(&@as(u64, 1))) catch {};
    }

    fn run(c: *Capture, it: *Item, group: u32) void {
        const j = it.job;
        const pix = it.pix.?;
        switch (j.enc) {
            proto.Enc.jpeg => {
                const pic: jpeg.Picture = .{ .pix = pix, .stride = @as(usize, j.w) * 4, .w = j.w, .h = j.h };
                const r = it.plan.range(group);
                pic.scan(&c.quant, r.from, r.to, it.plan.cols, &it.scans[group], c.gpa) catch {
                    it.setErr("out of memory", .{});
                };
                if (it.left.fetchSub(1, .acq_rel) != 1) return;
                if (it.err_len == 0) {
                    const views = c.gpa.alloc([]const u8, it.scans.len) catch {
                        it.setErr("out of memory", .{});
                        return c.finish(it);
                    };
                    defer c.gpa.free(views);
                    for (it.scans, 0..) |s, g| views[g] = s.items;
                    if (jpeg.assemble(&it.data, c.gpa, &c.quant, j.w, j.h, it.plan, views)) |_| {
                        it.enc = proto.Enc.jpeg;
                    } else |_| it.setErr("out of memory", .{});
                }
                c.finish(it);
            },
            proto.Enc.png => {
                if (png.encode(&it.data, c.gpa, pix, @as(usize, j.w) * 4, j.w, j.h, .bgrx)) |_| {
                    it.enc = proto.Enc.png;
                } else |_| it.setErr("out of memory", .{});
                c.finish(it);
            },
            else => {
                const e = it.vid.?;
                if (!e.ready) {
                    const why = video.waitReady(e, &it.err);
                    if (why) |msg| {
                        if (msg.len > 0) {
                            it.err_len = msg.len;
                            return c.finish(it);
                        }
                    } else |_| {
                        it.setErr("encoder did not start", .{});
                        return c.finish(it);
                    }
                }
                const key = j.key or it.started;
                if (video.encode(e, pix, key, &it.data, c.gpa)) |is_key| {
                    it.enc = if (is_key) proto.Enc.video_key else proto.Enc.video;
                } else |err| {
                    var tmp: [256]u8 = undefined;
                    it.setErr("encoder: {s} {s}", .{ @errorName(err), video.stderrText(e, &tmp) });
                }
                c.finish(it);
            },
        }
    }

    /// Writes the frames that are ready, in order; true once the batch is
    /// done (all written and the workers joined).
    pub fn collect(c: *Capture) !bool {
        if (!c.busy) return false;
        var buf: [8]u8 = undefined;
        _ = sys.read(c.efd, &buf) catch {};
        const out = c.wm.out;
        while (c.written < c.items.len and c.items[c.written].done.load(.acquire)) : (c.written += 1) {
            const it = &c.items[c.written];
            try c.frame(out, it);
        }
        if (c.written < c.items.len) return false;
        for (c.threads.items) |t| t.join();
        c.threads.clearRetainingCapacity();
        for (c.items) |*it| {
            it.data.deinit(c.gpa);
            for (it.scans) |*s| s.deinit(c.gpa);
            if (it.scans.len > 0) c.gpa.free(it.scans);
            if (it.own) |o| c.gpa.free(o);
        }
        c.gpa.free(c.items);
        c.items = &.{};
        c.busy = false;
        const at = try out.begin(.batch_done);
        out.finish(at);
        return true;
    }

    fn frame(c: *Capture, out: *proto.Writer, it: *Item) !void {
        const j = it.job;
        if (it.started) {
            if (it.enc != proto.Enc.none) {
                // The node decides whether the stream goes on (video_close).
                try c.streams.put(c.gpa, j.stream, it.vid.?);
            } else retire(c.gpa, it.vid.?);
        }
        const at = try out.begin(.frame);
        try out.int(u32, j.window);
        try out.int(u32, j.drawable);
        try out.int(i16, j.x);
        try out.int(i16, j.y);
        try out.int(u16, j.w);
        try out.int(u16, j.h);
        try out.int(u32, j.seq);
        try out.int(u8, it.enc);
        try out.int(u32, it.capture_us);
        try out.int(u32, it.encode_us);
        try out.int(u32, j.stream);
        const started = it.started and it.enc != proto.Enc.none;
        try out.int(u8, @intFromBool(started));
        if (started) {
            const e = it.vid.?;
            var cb: [32]u8 = undefined;
            try out.str(u8, e.name());
            try out.str(u8, e.codec(it.data.items, &cb));
            try out.int(u16, e.cw);
            try out.int(u16, e.ch);
        }
        try out.str(u16, it.err[0..it.err_len]);
        if (it.enc != proto.Enc.none) try out.bytes(it.data.items);
        out.finish(at);
    }
};

pub fn retire(gpa: std.mem.Allocator, e: *video.Encoder) void {
    // Closing waits for the encoder to exit: not on the main thread.
    const t = std.Thread.spawn(.{ .stack_size = 256 << 10 }, video.close, .{ gpa, e }) catch return video.close(gpa, e);
    t.detach();
}

fn cpuCount() u32 {
    var set: [128]u8 = @splat(0);
    const rc = std.os.linux.syscall3(.sched_getaffinity, 0, set.len, @intFromPtr(&set));
    _ = sys.check(rc) catch return 1;
    var n: u32 = 0;
    for (set) |b| n += @popCount(b);
    return @max(n, 1);
}
