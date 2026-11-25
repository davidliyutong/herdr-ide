//! PNG of captured pixels: 8-bit RGB from the 32-bit BGRX rows of a
//! window (opaque, as Go's encoder writes an opaque picture), RGBA for the
//! pointer image; each row filtered as libpng chooses (the filter whose
//! bytes sum least in absolute value), compressed with the standard
//! library's deflate at its fastest level.
const std = @import("std");
const flate = std.compress.flate;

const signature = [_]u8{ 0x89, 'P', 'N', 'G', '\r', '\n', 0x1a, '\n' };

fn chunkStart(out: *std.ArrayList(u8), gpa: std.mem.Allocator, typ: *const [4]u8) !usize {
    const at = out.items.len;
    try out.appendSlice(gpa, &[_]u8{ 0, 0, 0, 0 });
    try out.appendSlice(gpa, typ);
    return at;
}

fn chunkEnd(out: *std.ArrayList(u8), gpa: std.mem.Allocator, at: usize) !void {
    const n: u32 = @intCast(out.items.len - at - 8);
    std.mem.writeInt(u32, out.items[at..][0..4], n, .big);
    const crc = std.hash.Crc32.hash(out.items[at + 4 ..]);
    var b: [4]u8 = undefined;
    std.mem.writeInt(u32, &b, crc, .big);
    try out.appendSlice(gpa, &b);
}

fn paeth(a: u8, b: u8, c: u8) u8 {
    const p: i16 = @as(i16, a) + b - c;
    const pa = @abs(p - a);
    const pb = @abs(p - b);
    const pc = @abs(p - c);
    if (pa <= pb and pa <= pc) return a;
    if (pb <= pc) return b;
    return c;
}

/// Filters row cur (previous row prev, bpp bytes per pixel) into the five
/// candidates and returns the index of the one to use.
fn filterRow(cand: *[5][]u8, cur: []const u8, prev: []const u8, bpp: usize) usize {
    var best: usize = 0;
    var best_sum: u64 = std.math.maxInt(u64);
    for (0..5) |f| {
        const o = cand[f];
        var sum: u64 = 0;
        for (cur, 0..) |x, i| {
            const a: u8 = if (i >= bpp) cur[i - bpp] else 0;
            const b = prev[i];
            const c: u8 = if (i >= bpp) prev[i - bpp] else 0;
            const v: u8 = switch (f) {
                0 => x,
                1 => x -% a,
                2 => x -% b,
                3 => x -% @as(u8, @intCast((@as(u16, a) + b) / 2)),
                else => x -% paeth(a, b, c),
            };
            o[i] = v;
            sum += @abs(@as(i8, @bitCast(v)));
        }
        if (sum < best_sum) {
            best_sum = sum;
            best = f;
        }
    }
    return best;
}

pub const Format = enum { bgrx, rgba };

/// Appends the PNG of a w×h picture: BGRX rows (stride bytes apart),
/// written as RGB, or RGBA rows written as they are.
pub fn encode(out: *std.ArrayList(u8), gpa: std.mem.Allocator, pix: []const u8, stride: usize, w: u32, h: u32, format: Format) !void {
    if (w == 0 or h == 0) return error.BadSize;
    if (pix.len < (h - 1) * stride + w * 4) return error.ShortBuffer;
    const bpp: usize = if (format == .bgrx) 3 else 4;
    const row_len = w * bpp;
    const rows = try gpa.alloc(u8, row_len * 7);
    defer gpa.free(rows);
    var cur = rows[0..row_len];
    var prev = rows[row_len .. 2 * row_len];
    @memset(prev, 0);
    var cand: [5][]u8 = undefined;
    for (0..5) |f| cand[f] = rows[(2 + f) * row_len .. (3 + f) * row_len];

    try out.appendSlice(gpa, &signature);
    var at = try chunkStart(out, gpa, "IHDR");
    var hdr: [13]u8 = undefined;
    std.mem.writeInt(u32, hdr[0..4], w, .big);
    std.mem.writeInt(u32, hdr[4..8], h, .big);
    hdr[8] = 8;
    hdr[9] = if (format == .bgrx) 2 else 6;
    hdr[10] = 0;
    hdr[11] = 0;
    hdr[12] = 0;
    try out.appendSlice(gpa, &hdr);
    try chunkEnd(out, gpa, at);

    at = try chunkStart(out, gpa, "IDAT");
    {
        var aw: std.Io.Writer.Allocating = .fromArrayList(gpa, out);
        defer out.* = aw.toArrayList();
        const window = try gpa.alloc(u8, flate.max_window_len);
        defer gpa.free(window);
        const c = try gpa.create(flate.Compress);
        defer gpa.destroy(c);
        c.* = try flate.Compress.init(&aw.writer, window, .zlib, .level_1);
        var y: u32 = 0;
        while (y < h) : (y += 1) {
            const src = pix[y * stride ..][0 .. w * 4];
            if (format == .bgrx) {
                var x: usize = 0;
                while (x < w) : (x += 1) {
                    cur[x * 3] = src[x * 4 + 2];
                    cur[x * 3 + 1] = src[x * 4 + 1];
                    cur[x * 3 + 2] = src[x * 4];
                }
            } else @memcpy(cur, src);
            const f = filterRow(&cand, cur, prev, bpp);
            c.writer.writeByte(@intCast(f)) catch return error.OutOfMemory;
            c.writer.writeAll(cand[f]) catch return error.OutOfMemory;
            const t = prev;
            prev = cur;
            cur = t;
        }
        c.finish() catch return error.OutOfMemory;
        aw.writer.flush() catch return error.OutOfMemory;
    }
    try chunkEnd(out, gpa, at);
    at = try chunkStart(out, gpa, "IEND");
    try chunkEnd(out, gpa, at);
}

const testing = std.testing;

/// Decodes what encode wrote (RGB, one IDAT): the pixels as RGB rows.
fn decodeRGB(gpa: std.mem.Allocator, png: []const u8, w: u32, h: u32) ![]u8 {
    try testing.expectEqualSlices(u8, &signature, png[0..8]);
    var off: usize = 8;
    var idat: std.ArrayList(u8) = .empty;
    defer idat.deinit(gpa);
    while (off + 12 <= png.len) {
        const n = std.mem.readInt(u32, png[off..][0..4], .big);
        const typ = png[off + 4 .. off + 8];
        const data = png[off + 8 .. off + 8 + n];
        const crc = std.mem.readInt(u32, png[off + 8 + n ..][0..4], .big);
        try testing.expectEqual(std.hash.Crc32.hash(png[off + 4 .. off + 8 + n]), crc);
        if (std.mem.eql(u8, typ, "IDAT")) try idat.appendSlice(gpa, data);
        off += 12 + n;
    }
    var in: std.Io.Reader = .fixed(idat.items);
    var window: [flate.max_window_len]u8 = undefined;
    var d: flate.Decompress = .init(&in, .zlib, &window);
    const raw = try d.reader.allocRemaining(gpa, .unlimited);
    defer gpa.free(raw);
    const row = w * 3;
    try testing.expectEqual(@as(usize, (row + 1) * h), raw.len);
    const pix = try gpa.alloc(u8, row * h);
    const prev = try gpa.alloc(u8, row);
    defer gpa.free(prev);
    @memset(prev, 0);
    for (0..h) |y| {
        const f = raw[y * (row + 1)];
        const src = raw[y * (row + 1) + 1 ..][0..row];
        const dst = pix[y * row ..][0..row];
        for (0..row) |i| {
            const a: u8 = if (i >= 3) dst[i - 3] else 0;
            const b = prev[i];
            const c: u8 = if (i >= 3) prev[i - 3] else 0;
            dst[i] = src[i] +% switch (f) {
                0 => @as(u8, 0),
                1 => a,
                2 => b,
                3 => @as(u8, @intCast((@as(u16, a) + b) / 2)),
                else => paeth(a, b, c),
            };
        }
        @memcpy(prev, dst);
    }
    return pix;
}

test "a picture decodes to its pixels" {
    const gpa = testing.allocator;
    const w = 53;
    const h = 31;
    const pix = try gpa.alloc(u8, w * h * 4);
    defer gpa.free(pix);
    for (0..w * h) |i| {
        pix[i * 4] = @truncate(i * 3);
        pix[i * 4 + 1] = @truncate(i / w * 9);
        pix[i * 4 + 2] = if (i % 7 == 0) 255 else 10;
        pix[i * 4 + 3] = 0;
    }
    var out: std.ArrayList(u8) = .empty;
    defer out.deinit(gpa);
    try encode(&out, gpa, pix, w * 4, w, h, .bgrx);
    const rgb = try decodeRGB(gpa, out.items, w, h);
    defer gpa.free(rgb);
    for (0..w * h) |i| {
        try testing.expectEqual(pix[i * 4 + 2], rgb[i * 3]);
        try testing.expectEqual(pix[i * 4 + 1], rgb[i * 3 + 1]);
        try testing.expectEqual(pix[i * 4], rgb[i * 3 + 2]);
    }
}
