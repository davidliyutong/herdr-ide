//! The GUI helper of Linux machines (docs/features/14-gui-windows.md):
//! `zig build` makes it for x86-64 and arm64, static and without a C
//! library, so that one executable per architecture runs on glibc and musl
//! machines alike; `zig build test` runs its tests on this host.
//! scripts/build-gui-helper.sh (make gui-helper) builds, tests and records
//! the digests.
const std = @import("std");

pub fn build(b: *std.Build) void {
    const optimize = b.option(std.builtin.OptimizeMode, "optimize", "of the executables (ReleaseSafe)") orelse .safe;
    const platforms = [_]struct { arch: std.Target.Cpu.Arch, name: []const u8 }{
        .{ .arch = .x86_64, .name = "amd64" },
        .{ .arch = .aarch64, .name = "arm64" },
    };
    for (platforms) |p| {
        const target = b.resolveTargetQuery(.{ .cpu_arch = p.arch, .os_tag = .linux, .abi = .musl, .cpu_model = .baseline });
        const exe = b.addExecutable(.{
            .name = b.fmt("gui-helper-linux-{s}", .{p.name}),
            .root_module = b.createModule(.{
                .root_source_file = b.path("src/main.zig"),
                .target = target,
                .optimize = optimize,
                .strip = true,
            }),
        });
        b.installArtifact(exe);
    }

    const tests = b.addTest(.{ .root_module = b.createModule(.{
        .root_source_file = b.path("src/main.zig"),
        .target = b.graph.host,
        .optimize = .Debug,
    }) });
    const run = b.addRunArtifact(tests);
    b.step("test", "Run the helper's tests").dependOn(&run.step);
}
