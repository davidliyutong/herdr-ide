//! The display keeper (the Go agent's guikeep.go): Xvfb and Xwayland exit
//! a minute after their last client left; the keeper is a client while the
//! instance's terminal core runs, whose programs use the display. It holds
//! a connection to the display until no server listens on the terminal
//! core's socket and none came back within grace, or the display ended.
//! One keeper runs per instance (its lock file), whichever build started
//! it.
const std = @import("std");
const sys = @import("sys.zig");
const x11 = @import("x11.zig");

pub const poll_ms = 5_000;
pub const grace_ms = 30_000;

/// A process, told apart from a later one with its pid by its start time.
pub const Proc = struct {
    pid: i32 = 0,
    start: u64 = 0,

    pub fn alive(p: Proc) bool {
        if (p.pid == 0) return false;
        return startOf(p.pid) == p.start;
    }
};

/// A process's start time (field 22 of /proc/<pid>/stat); 0 when gone.
pub fn startOf(pid: i32) u64 {
    var path: [64]u8 = undefined;
    const p = std.mem.printSentinel(&path, "/proc/{d}/stat", .{pid}, 0) catch return 0;
    var buf: [1024]u8 = undefined;
    const b = sys.readFile(p, &buf) catch return 0;
    return parseStart(b);
}

pub fn parseStart(b: []const u8) u64 {
    // The command name in parentheses may contain spaces; the fields after
    // it start with the third.
    const i = std.mem.lastIndexOfScalar(u8, b, ')') orelse return 0;
    var it = std.mem.tokenizeAny(u8, b[i + 1 ..], " \n");
    var k: usize = 0;
    while (it.next()) |f| : (k += 1) if (k == 19) return std.fmt.parseInt(u64, f, 10) catch 0;
    return 0;
}

/// This user's process listening on socket.
fn findServer(socket: []const u8) Proc {
    const fd = sys.connectUnix(socket, false) catch return .{};
    defer sys.close(fd);
    const c = sys.peerCred(fd) catch return .{};
    if (c.uid != sys.getuid() or c.pid <= 0) return .{};
    const start = startOf(c.pid);
    if (start == 0) return .{};
    return .{ .pid = c.pid, .start = start };
}

pub const Options = struct {
    lock: [:0]const u8,
    socket: []const u8,
    pid: i32,
    xauth: [:0]const u8,
    hc_socket: []const u8,
    display: []const u8,
};

pub fn run(gpa: std.mem.Allocator, o: Options) !void {
    const lock = sys.open(o.lock.ptr, sys.O_RDWR | sys.O_CREAT | sys.O_NOFOLLOW) catch |e| {
        log("cannot open the lock: {s}", .{sys.errName(sys.errno())});
        return e;
    };
    defer sys.close(lock);
    sys.flock(lock, sys.LOCK_EX | sys.LOCK_NB) catch return; // another keeper
    var cookie: [16]u8 = undefined;
    if (!x11.readCookie(o.xauth.ptr, &cookie)) return error.NoCookie;
    const fd = x11.connectChecked(o.socket, o.pid) catch |e| {
        log("display {s} is not this instance's: {s}", .{ o.display, @errorName(e) });
        return;
    };
    const x = try x11.Conn.open(gpa, fd, &cookie);
    defer x.destroy();
    log("keeping display {s} while a server at {s} runs", .{ o.display, o.hc_socket });
    var srv: Proc = .{};
    var gone = sys.nowUs();
    while (true) {
        if (!srv.alive()) srv = findServer(o.hc_socket);
        if (srv.pid != 0) {
            gone = sys.nowUs();
        } else if (sys.nowUs() - gone > grace_ms * 1000) {
            log("done: the terminal core is gone", .{});
            return;
        }
        // No events are selected: the connection is readable when the
        // display ends.
        var p = [_]sys.PollFd{.{ .fd = x.fd, .events = sys.POLL.IN, .revents = 0 }};
        _ = try sys.poll(&p, poll_ms);
        if (p[0].revents != 0) {
            var buf: [4096]u8 = undefined;
            const n = sys.read(x.fd, &buf) catch 0;
            if (n == 0) {
                log("done: the display ended", .{});
                return;
            }
        }
    }
}

fn log(comptime fmt: []const u8, args: anytype) void {
    var buf: [1024]u8 = undefined;
    const s = std.fmt.bufPrint(&buf, "gui-keep: " ++ fmt ++ "\n", args) catch return;
    sys.writeAll(2, s) catch {};
}

test "start time from stat" {
    const stat = "1234 (a (b) c) S 1 1234 1234 0 -1 4194560 100 0 0 0 1 2 0 0 20 0 1 0 987654 1000 10";
    try std.testing.expectEqual(@as(u64, 987654), parseStart(stat));
    try std.testing.expectEqual(@as(u64, 0), parseStart("garbage"));
}
