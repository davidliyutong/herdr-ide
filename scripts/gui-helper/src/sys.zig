//! Linux system calls as the helper makes them: raw, without a C library
//! (the helper is one static executable for glibc and musl machines alike),
//! each failure an error with its errno kept for the message.
const std = @import("std");
const builtin = @import("builtin");
const linux = std.os.linux;

pub const fd_t = i32;
pub const is_linux = builtin.os.tag == .linux;

/// A failed system call; errno() tells which.
pub const Error = error{Sys};

threadlocal var last: u16 = 0;

/// The errno of the last failed call of this thread.
pub fn errno() u16 {
    return last;
}

pub fn errName(e: u16) []const u8 {
    return @tagName(@as(linux.E, @enumFromInt(e)));
}

pub fn check(rc: usize) Error!usize {
    const signed: isize = @bitCast(rc);
    if (signed < 0 and signed > -4096) {
        last = @intCast(-signed);
        return error.Sys;
    }
    return rc;
}

/// Retries a call interrupted by a signal.
fn retry(comptime f: anytype, args: anytype) Error!usize {
    while (true) {
        const rc = @call(.auto, f, args);
        return check(rc) catch |e| {
            if (last == @intFromEnum(linux.E.INTR)) continue;
            return e;
        };
    }
}

pub const EAGAIN: u16 = @intFromEnum(linux.E.AGAIN);
pub const EINTR: u16 = @intFromEnum(linux.E.INTR);
pub const ENOENT: u16 = @intFromEnum(linux.E.NOENT);
pub const ECONNREFUSED: u16 = @intFromEnum(linux.E.CONNREFUSED);
pub const ESRCH: u16 = @intFromEnum(linux.E.SRCH);
pub const EPERM: u16 = @intFromEnum(linux.E.PERM);
pub const EWOULDBLOCK = EAGAIN;

fn sc(comptime n: linux.SYS) linux.SYS {
    return n;
}

pub fn read(fd: fd_t, buf: []u8) Error!usize {
    return retry(linux.syscall3, .{ sc(.read), @as(usize, @bitCast(@as(isize, fd))), @intFromPtr(buf.ptr), buf.len });
}

pub fn write(fd: fd_t, buf: []const u8) Error!usize {
    return retry(linux.syscall3, .{ sc(.write), @as(usize, @bitCast(@as(isize, fd))), @intFromPtr(buf.ptr), buf.len });
}

/// Writes all of buf, waiting for room when fd is non-blocking.
pub fn writeAll(fd: fd_t, buf: []const u8) Error!void {
    var b = buf;
    while (b.len > 0) {
        const n = write(fd, b) catch |e| {
            if (last == EAGAIN) {
                var p = [_]PollFd{.{ .fd = fd, .events = POLL.OUT, .revents = 0 }};
                _ = try poll(&p, -1);
                continue;
            }
            return e;
        };
        b = b[n..];
    }
}

pub fn close(fd: fd_t) void {
    _ = linux.syscall1(sc(.close), @as(usize, @bitCast(@as(isize, fd))));
}

pub const PollFd = extern struct { fd: i32, events: i16, revents: i16 };
pub const POLL = struct {
    pub const IN: i16 = 0x001;
    pub const OUT: i16 = 0x004;
    pub const ERR: i16 = 0x008;
    pub const HUP: i16 = 0x010;
    pub const NVAL: i16 = 0x020;
};

/// poll(2) with a timeout in milliseconds (-1: none).
pub fn poll(fds: []PollFd, timeout_ms: i32) Error!usize {
    // ppoll: the only poll on arm64.
    var ts: Timespec = undefined;
    var tp: usize = 0;
    if (timeout_ms >= 0) {
        ts = .{ .sec = @divTrunc(timeout_ms, 1000), .nsec = @rem(timeout_ms, 1000) * 1_000_000 };
        tp = @intFromPtr(&ts);
    }
    return retry(linux.syscall5, .{ sc(.ppoll), @intFromPtr(fds.ptr), fds.len, tp, 0, 8 });
}

pub const Timespec = extern struct { sec: isize, nsec: isize };

/// Monotonic microseconds.
pub fn nowUs() i64 {
    var ts: Timespec = undefined;
    _ = linux.syscall2(sc(.clock_gettime), 1, @intFromPtr(&ts)); // CLOCK_MONOTONIC
    return @as(i64, ts.sec) * 1_000_000 + @divTrunc(@as(i64, ts.nsec), 1000);
}

pub fn sleepMs(ms: u32) void {
    var ts: Timespec = .{ .sec = @intCast(ms / 1000), .nsec = @intCast(@as(u64, ms % 1000) * 1_000_000) };
    while (true) {
        const rc = linux.syscall2(sc(.nanosleep), @intFromPtr(&ts), @intFromPtr(&ts));
        _ = check(rc) catch {
            if (last == EINTR) continue;
        };
        return;
    }
}

pub fn getuid() u32 {
    return @truncate(linux.syscall0(sc(.getuid)));
}

pub fn getpid() i32 {
    return @truncate(@as(isize, @bitCast(linux.syscall0(sc(.getpid)))));
}

pub const AF_UNIX = 1;
pub const SOCK_STREAM = 1;
pub const SOCK_CLOEXEC = 0o2000000;
pub const SOCK_NONBLOCK = 0o4000;
pub const O_CLOEXEC = 0o2000000;
pub const O_NONBLOCK = 0o4000;
pub const O_RDONLY = 0;
pub const O_RDWR = 2;
pub const O_CREAT = 0o100;
pub const O_NOFOLLOW = 0o400000;
pub const O_DIRECTORY = 0o200000;
pub const AT_FDCWD: isize = -100;

const SockaddrUn = extern struct { family: u16, path: [108]u8 };

/// Connects to the unix socket at path, or to the abstract one of that name
/// when abstract is set.
pub fn connectUnix(path: []const u8, abstract: bool) Error!fd_t {
    var sa: SockaddrUn = .{ .family = AF_UNIX, .path = @splat(0) };
    const off: usize = if (abstract) 1 else 0;
    if (path.len + off >= sa.path.len) {
        last = @intFromEnum(linux.E.NAMETOOLONG);
        return error.Sys;
    }
    @memcpy(sa.path[off .. off + path.len], path);
    const fd: fd_t = @intCast(try check(linux.syscall3(sc(.socket), AF_UNIX, SOCK_STREAM | SOCK_CLOEXEC, 0)));
    errdefer close(fd);
    const len: usize = @sizeOf(u16) + off + path.len + (if (abstract) @as(usize, 0) else 1);
    _ = try retry(linux.syscall3, .{ sc(.connect), @as(usize, @intCast(fd)), @intFromPtr(&sa), len });
    return fd;
}

pub const Cred = struct { pid: i32, uid: u32 };

/// The process and user at the other end of a unix socket.
pub fn peerCred(fd: fd_t) Error!Cred {
    var cred: extern struct { pid: i32, uid: u32, gid: u32 } = undefined;
    var len: u32 = @sizeOf(@TypeOf(cred));
    _ = try check(linux.syscall5(sc(.getsockopt), @as(usize, @intCast(fd)), 1, 17, @intFromPtr(&cred), @intFromPtr(&len))); // SOL_SOCKET, SO_PEERCRED
    return .{ .pid = cred.pid, .uid = cred.uid };
}

pub fn openat(dir: isize, path: [*:0]const u8, flags: usize, mode: usize) Error!fd_t {
    return @intCast(try retry(linux.syscall4, .{ sc(.openat), @as(usize, @bitCast(dir)), @intFromPtr(path), flags, mode }));
}

pub fn open(path: [*:0]const u8, flags: usize) Error!fd_t {
    return openat(AT_FDCWD, path, flags | O_CLOEXEC, 0);
}

/// Reads at most buf.len bytes of the file at path.
pub fn readFile(path: [*:0]const u8, buf: []u8) Error![]u8 {
    const fd = try open(path, O_RDONLY | O_NOFOLLOW);
    defer close(fd);
    var n: usize = 0;
    while (n < buf.len) {
        const got = try read(fd, buf[n..]);
        if (got == 0) break;
        n += got;
    }
    return buf[0..n];
}

pub fn flock(fd: fd_t, op: usize) Error!void {
    _ = try retry(linux.syscall2, .{ sc(.flock), @as(usize, @intCast(fd)), op });
}
pub const LOCK_EX = 2;
pub const LOCK_NB = 4;

pub fn kill(pid: i32, sig: u32) Error!void {
    _ = try check(linux.syscall2(sc(.kill), @as(usize, @bitCast(@as(isize, pid))), sig));
}
pub const SIGKILL = 9;
pub const SIGTERM = 15;
pub const SIGPIPE = 13;

pub fn pipe2(flags: usize) Error![2]fd_t {
    var fds: [2]i32 = undefined;
    _ = try check(linux.syscall2(sc(.pipe2), @intFromPtr(&fds), flags));
    return fds;
}

pub fn eventfd(flags: usize) Error!fd_t {
    return @intCast(try check(linux.syscall2(sc(.eventfd2), 0, flags)));
}

pub fn fcntl(fd: fd_t, cmd: usize, arg: usize) Error!usize {
    return check(linux.syscall3(sc(.fcntl), @as(usize, @intCast(fd)), cmd, arg));
}
pub const F_GETFL = 3;
pub const F_SETFL = 4;
pub const F_SETPIPE_SZ = 1031;

pub fn setNonblock(fd: fd_t) Error!void {
    const fl = try fcntl(fd, F_GETFL, 0);
    _ = try fcntl(fd, F_SETFL, fl | O_NONBLOCK);
}

/// Ignores SIGPIPE: writes to a pipe whose reader left fail with EPIPE.
pub fn ignoreSigpipe() void {
    // struct kernel_sigaction { handler, flags, restorer, mask }
    var act: extern struct { handler: usize, flags: usize, restorer: usize, mask: u64 } = .{ .handler = 1, .flags = 0, .restorer = 0, .mask = 0 }; // SIG_IGN
    _ = linux.syscall4(sc(.rt_sigaction), SIGPIPE, @intFromPtr(&act), 0, 8);
}

// System V shared memory.
pub const IPC_PRIVATE = 0;
pub const IPC_CREAT = 0o1000;
pub const IPC_RMID = 0;

pub fn shmget(size: usize, flags: usize) Error!i32 {
    return @intCast(try check(linux.syscall3(sc(.shmget), IPC_PRIVATE, size, flags)));
}

pub fn shmat(id: i32) Error![*]u8 {
    return @ptrFromInt(try check(linux.syscall3(sc(.shmat), @as(usize, @intCast(id)), 0, 0)));
}

pub fn shmdt(p: [*]u8) void {
    _ = linux.syscall1(sc(.shmdt), @intFromPtr(p));
}

pub fn shmrm(id: i32) void {
    _ = linux.syscall3(sc(.shmctl), @as(usize, @intCast(id)), IPC_RMID, 0);
}

pub fn futexWait(p: *const std.atomic.Value(u32), expect: u32) void {
    _ = linux.syscall4(sc(.futex), @intFromPtr(p), 128, expect, 0); // FUTEX_WAIT | FUTEX_PRIVATE_FLAG
}

pub fn futexWake(p: *const std.atomic.Value(u32), n: u32) void {
    _ = linux.syscall3(sc(.futex), @intFromPtr(p), 129, n); // FUTEX_WAKE | FUTEX_PRIVATE_FLAG
}

pub fn exit(code: u8) noreturn {
    linux.exit_group(code);
}

pub fn wait4(pid: i32, nohang: bool) Error!struct { pid: i32, status: u32 } {
    var status: u32 = 0;
    const rc = try retry(linux.syscall4, .{ sc(.wait4), @as(usize, @bitCast(@as(isize, pid))), @intFromPtr(&status), @as(usize, if (nohang) 1 else 0), 0 });
    return .{ .pid = @intCast(rc), .status = status };
}

/// Starts argv[0] with stdin, stdout and stderr from fds (-1: /dev/null), in a
/// process group of its own, killed when the helper dies; envp as given.
pub fn spawn(argv: [*:null]const ?[*:0]const u8, envp: [*:null]const ?[*:0]const u8, fds: [3]fd_t) Error!i32 {
    // arm64 has no fork: clone with SIGCHLD.
    const pid = try check(if (@hasField(linux.SYS, "fork")) linux.syscall0(.fork) else linux.syscall5(.clone, 17, 0, 0, 0, 0));
    if (pid == 0) {
        // The child: only system calls until exec.
        _ = linux.syscall2(sc(.setpgid), 0, 0);
        _ = linux.syscall5(sc(.prctl), 1, SIGKILL, 0, 0, 0); // PR_SET_PDEATHSIG
        // SIGPIPE as programs expect it (an ignored signal stays ignored
        // across exec).
        var dfl: extern struct { handler: usize, flags: usize, restorer: usize, mask: u64 } = .{ .handler = 0, .flags = 0, .restorer = 0, .mask = 0 };
        _ = linux.syscall4(sc(.rt_sigaction), SIGPIPE, @intFromPtr(&dfl), 0, 8);
        for (fds, 0..) |fd, i| {
            var src = fd;
            if (src < 0) {
                const rc = linux.syscall4(sc(.openat), @as(usize, @bitCast(AT_FDCWD)), @intFromPtr("/dev/null"), O_RDWR, 0);
                src = @truncate(@as(isize, @bitCast(rc)));
            }
            _ = linux.syscall3(sc(.dup3), @as(usize, @bitCast(@as(isize, src))), i, 0);
        }
        _ = linux.syscall3(sc(.execve), @intFromPtr(argv[0].?), @intFromPtr(argv), @intFromPtr(envp));
        linux.exit_group(127);
    }
    return @intCast(pid);
}

test "check maps errno" {
    if (!is_linux) return error.SkipZigTest;
    const rc = check(@bitCast(@as(isize, -2)));
    try std.testing.expectError(error.Sys, rc);
    try std.testing.expectEqual(ENOENT, errno());
}
