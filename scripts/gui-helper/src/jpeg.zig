//! Baseline JPEG of program windows (4:2:0, the standard Huffman tables of
//! section K.3 of the spec), read from 32-bit BGRX rows as X servers hand
//! them out, with groups of rows entropy-coded at the same time: each group
//! but the last ends with a restart marker, so the result is one ordinary
//! JPEG. It is the Go agent's encoder (internal/jpegstrip: Go's image/jpeg
//! with the colour conversion reading BGRX and the scan split into restart
//! intervals), ported: for one group the output is byte for byte what
//! image/jpeg writes, for any number the same pixels.
//!
//! Derived from Go's src/image/jpeg (writer.go, dct.go):
//! Copyright 2011 The Go Authors. All rights reserved. Use of this source
//! code is governed by a BSD-style license (THIRD_PARTY_NOTICES.md).
const std = @import("std");

pub const Block = [64]i32;

const unscaled_quant = [2][64]u8{
    .{
        16, 11, 12,  14,  12,  10,  16,  14,
        13, 14, 18,  17,  16,  19,  24,  40,
        26, 24, 22,  22,  24,  49,  35,  37,
        29, 40, 58,  51,  61,  60,  57,  51,
        56, 55, 64,  72,  92,  78,  64,  68,
        87, 69, 55,  56,  80,  109, 81,  87,
        95, 98, 103, 104, 103, 62,  77,  113,
        121, 112, 100, 120, 92, 101, 103, 99,
    },
    .{
        17, 18, 18, 24, 21, 24, 47, 26,
        26, 47, 99, 66, 56, 66, 99, 99,
        99, 99, 99, 99, 99, 99, 99, 99,
        99, 99, 99, 99, 99, 99, 99, 99,
        99, 99, 99, 99, 99, 99, 99, 99,
        99, 99, 99, 99, 99, 99, 99, 99,
        99, 99, 99, 99, 99, 99, 99, 99,
        99, 99, 99, 99, 99, 99, 99, 99,
    },
};

const HuffSpec = struct { count: [16]u8, value: []const u8 };

const huff_spec = [4]HuffSpec{
    .{ .count = .{ 0, 1, 5, 1, 1, 1, 1, 1, 1, 0, 0, 0, 0, 0, 0, 0 }, .value = &.{ 0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11 } },
    .{ .count = .{ 0, 2, 1, 3, 3, 2, 4, 3, 5, 5, 4, 4, 0, 0, 1, 125 }, .value = &.{
        0x01, 0x02, 0x03, 0x00, 0x04, 0x11, 0x05, 0x12, 0x21, 0x31, 0x41, 0x06, 0x13, 0x51, 0x61, 0x07,
        0x22, 0x71, 0x14, 0x32, 0x81, 0x91, 0xa1, 0x08, 0x23, 0x42, 0xb1, 0xc1, 0x15, 0x52, 0xd1, 0xf0,
        0x24, 0x33, 0x62, 0x72, 0x82, 0x09, 0x0a, 0x16, 0x17, 0x18, 0x19, 0x1a, 0x25, 0x26, 0x27, 0x28,
        0x29, 0x2a, 0x34, 0x35, 0x36, 0x37, 0x38, 0x39, 0x3a, 0x43, 0x44, 0x45, 0x46, 0x47, 0x48, 0x49,
        0x4a, 0x53, 0x54, 0x55, 0x56, 0x57, 0x58, 0x59, 0x5a, 0x63, 0x64, 0x65, 0x66, 0x67, 0x68, 0x69,
        0x6a, 0x73, 0x74, 0x75, 0x76, 0x77, 0x78, 0x79, 0x7a, 0x83, 0x84, 0x85, 0x86, 0x87, 0x88, 0x89,
        0x8a, 0x92, 0x93, 0x94, 0x95, 0x96, 0x97, 0x98, 0x99, 0x9a, 0xa2, 0xa3, 0xa4, 0xa5, 0xa6, 0xa7,
        0xa8, 0xa9, 0xaa, 0xb2, 0xb3, 0xb4, 0xb5, 0xb6, 0xb7, 0xb8, 0xb9, 0xba, 0xc2, 0xc3, 0xc4, 0xc5,
        0xc6, 0xc7, 0xc8, 0xc9, 0xca, 0xd2, 0xd3, 0xd4, 0xd5, 0xd6, 0xd7, 0xd8, 0xd9, 0xda, 0xe1, 0xe2,
        0xe3, 0xe4, 0xe5, 0xe6, 0xe7, 0xe8, 0xe9, 0xea, 0xf1, 0xf2, 0xf3, 0xf4, 0xf5, 0xf6, 0xf7, 0xf8,
        0xf9, 0xfa,
    } },
    .{ .count = .{ 0, 3, 1, 1, 1, 1, 1, 1, 1, 1, 1, 0, 0, 0, 0, 0 }, .value = &.{ 0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11 } },
    .{ .count = .{ 0, 2, 1, 2, 4, 4, 3, 4, 7, 5, 4, 4, 0, 1, 2, 119 }, .value = &.{
        0x00, 0x01, 0x02, 0x03, 0x11, 0x04, 0x05, 0x21, 0x31, 0x06, 0x12, 0x41, 0x51, 0x07, 0x61, 0x71,
        0x13, 0x22, 0x32, 0x81, 0x08, 0x14, 0x42, 0x91, 0xa1, 0xb1, 0xc1, 0x09, 0x23, 0x33, 0x52, 0xf0,
        0x15, 0x62, 0x72, 0xd1, 0x0a, 0x16, 0x24, 0x34, 0xe1, 0x25, 0xf1, 0x17, 0x18, 0x19, 0x1a, 0x26,
        0x27, 0x28, 0x29, 0x2a, 0x35, 0x36, 0x37, 0x38, 0x39, 0x3a, 0x43, 0x44, 0x45, 0x46, 0x47, 0x48,
        0x49, 0x4a, 0x53, 0x54, 0x55, 0x56, 0x57, 0x58, 0x59, 0x5a, 0x63, 0x64, 0x65, 0x66, 0x67, 0x68,
        0x69, 0x6a, 0x73, 0x74, 0x75, 0x76, 0x77, 0x78, 0x79, 0x7a, 0x82, 0x83, 0x84, 0x85, 0x86, 0x87,
        0x88, 0x89, 0x8a, 0x92, 0x93, 0x94, 0x95, 0x96, 0x97, 0x98, 0x99, 0x9a, 0xa2, 0xa3, 0xa4, 0xa5,
        0xa6, 0xa7, 0xa8, 0xa9, 0xaa, 0xb2, 0xb3, 0xb4, 0xb5, 0xb6, 0xb7, 0xb8, 0xb9, 0xba, 0xc2, 0xc3,
        0xc4, 0xc5, 0xc6, 0xc7, 0xc8, 0xc9, 0xca, 0xd2, 0xd3, 0xd4, 0xd5, 0xd6, 0xd7, 0xd8, 0xd9, 0xda,
        0xe2, 0xe3, 0xe4, 0xe5, 0xe6, 0xe7, 0xe8, 0xe9, 0xea, 0xf2, 0xf3, 0xf4, 0xf5, 0xf6, 0xf7, 0xf8,
        0xf9, 0xfa,
    } },
};

/// Each value: the codeword's length in bits in the top 8 bits, the
/// codeword in the low 24.
const huff_lut: [4][256]u32 = blk: {
    @setEvalBranchQuota(20000);
    var out: [4][256]u32 = undefined;
    for (huff_spec, 0..) |s, h| {
        var t: [256]u32 = @splat(0);
        var code: u32 = 0;
        var k: usize = 0;
        for (s.count, 0..) |n, i| {
            const nbits: u32 = @as(u32, i + 1) << 24;
            var j: usize = 0;
            while (j < n) : (j += 1) {
                t[s.value[k]] = nbits | code;
                code += 1;
                k += 1;
            }
            code <<= 1;
        }
        out[h] = t;
    }
    break :blk out;
};

const bit_count: [256]u8 = blk: {
    @setEvalBranchQuota(10000);
    var t: [256]u8 = undefined;
    for (&t, 0..) |*v, i| v.* = if (i == 0) 0 else std.math.log2_int(u32, i) + 1;
    break :blk t;
};

const unzig = [64]u8{
    0,  1,  8,  16, 9,  2,  3,  10,
    17, 24, 32, 25, 18, 11, 4,  5,
    12, 19, 26, 33, 40, 48, 41, 34,
    27, 20, 13, 6,  7,  14, 21, 28,
    35, 42, 49, 56, 57, 50, 43, 36,
    29, 22, 15, 23, 30, 37, 44, 51,
    58, 59, 52, 45, 38, 31, 39, 46,
    53, 60, 61, 54, 47, 55, 62, 63,
};

const sos_header = [_]u8{ 0xff, 0xda, 0x00, 0x0c, 0x03, 0x01, 0x00, 0x02, 0x11, 0x03, 0x11, 0x00, 0x3f, 0x00 };

pub const Quant = [2][64]u8;

/// The tables for a quality, as image/jpeg scales them.
pub fn quantTables(quality: i32) Quant {
    const q = @max(1, @min(quality, 100));
    const s: i32 = if (q < 50) @divTrunc(5000, q) else 200 - q * 2;
    var out: Quant = undefined;
    for (0..2) |i| for (0..64) |j| {
        const x = @divTrunc(@as(i32, unscaled_quant[i][j]) * s + 50, 100);
        out[i][j] = @intCast(@max(1, @min(x, 255)));
    };
    return out;
}

/// How a w×h picture is cut into groups of MCU rows.
pub const Plan = struct {
    cols: u32,
    mcu_rows: u32,
    /// MCU rows per group, and groups.
    rows: u32,
    groups: u32,

    pub fn of(w: u32, h: u32, parts: u32) Plan {
        const cols = (w + 15) / 16;
        const mcu_rows = (h + 15) / 16;
        const p = @max(1, @min(parts, mcu_rows));
        var rows = (mcu_rows + p - 1) / p;
        // The restart interval counts MCUs in 16 bits.
        if (rows * cols > 0xffff) rows = @max(1, 0xffff / cols);
        return .{ .cols = cols, .mcu_rows = mcu_rows, .rows = rows, .groups = (mcu_rows + rows - 1) / rows };
    }

    /// The MCU rows of group g.
    pub fn range(p: Plan, g: u32) struct { from: u32, to: u32 } {
        return .{ .from = g * p.rows, .to = @min((g + 1) * p.rows, p.mcu_rows) };
    }
};

pub const Picture = struct {
    pix: []const u8,
    stride: usize,
    w: u32,
    h: u32,

    /// Entropy-codes MCU rows [from, to) as one restart interval: DC
    /// predictions start from zero and the last byte is padded with ones.
    pub fn scan(p: *const Picture, quant: *const Quant, from: u32, to: u32, cols: u32, out: *std.ArrayList(u8), gpa: std.mem.Allocator) !void {
        var e: Bits = .{ .quant = quant, .out = out, .gpa = gpa };
        var b: Block = undefined;
        var cb: [4]Block = undefined;
        var cr: [4]Block = undefined;
        var prev_y: i32 = 0;
        var prev_cb: i32 = 0;
        var prev_cr: i32 = 0;
        try out.ensureUnusedCapacity(gpa, (to - from) * cols * 16 * 16 / 8);
        var my = from;
        while (my < to) : (my += 1) {
            var mx: u32 = 0;
            while (mx < cols) : (mx += 1) {
                for (0..4) |i| {
                    const x_off: u32 = @intCast((i & 1) * 8);
                    const y_off: u32 = @intCast((i & 2) * 4);
                    p.toYCbCr(mx * 16 + x_off, my * 16 + y_off, &b, &cb[i], &cr[i]);
                    prev_y = try e.writeBlock(&b, 0, prev_y);
                }
                scale(&b, &cb);
                prev_cb = try e.writeBlock(&b, 1, prev_cb);
                scale(&b, &cr);
                prev_cr = try e.writeBlock(&b, 1, prev_cr);
            }
        }
        try e.emit(0x7f, 7);
    }

    fn toYCbCr(p: *const Picture, x: u32, y: u32, yb: *Block, cbb: *Block, crb: *Block) void {
        const xmax = p.w - 1;
        const ymax = p.h - 1;
        for (0..8) |j| {
            const row = p.pix[@min(y + @as(u32, @intCast(j)), ymax) * p.stride ..];
            for (0..8) |i| {
                const o = @min(x + @as(u32, @intCast(i)), xmax) * 4;
                const c = rgbToYCbCr(row[o + 2], row[o + 1], row[o]);
                yb[8 * j + i] = c[0];
                cbb[8 * j + i] = c[1];
                crb[8 * j + i] = c[2];
            }
        }
    }
};

/// Go's color.RGBToYCbCr.
fn rgbToYCbCr(r: u8, g: u8, b: u8) [3]i32 {
    const r1: i32 = r;
    const g1: i32 = g;
    const b1: i32 = b;
    const yy = (19595 * r1 + 38470 * g1 + 7471 * b1 + (1 << 15)) >> 16;
    var cb = -11056 * r1 - 21712 * g1 + 32768 * b1 + (257 << 15);
    if (@as(u32, @bitCast(cb)) & 0xff000000 == 0) cb >>= 16 else cb = ~(cb >> 31);
    var cr = 32768 * r1 - 27440 * g1 - 5328 * b1 + (257 << 15);
    if (@as(u32, @bitCast(cr)) & 0xff000000 == 0) cr >>= 16 else cr = ~(cr >> 31);
    return .{ yy, @as(u8, @truncate(@as(u32, @bitCast(cb)))), @as(u8, @truncate(@as(u32, @bitCast(cr)))) };
}

fn scale(dst: *Block, src: *const [4]Block) void {
    for (0..4) |i| {
        const off = (i & 2) << 4 | (i & 1) << 2;
        for (0..4) |y| for (0..4) |x| {
            const j = 16 * y + 2 * x;
            const sum = src[i][j] + src[i][j + 1] + src[i][j + 8] + src[i][j + 9];
            dst[8 * y + x + off] = (sum + 2) >> 2;
        };
    }
}

fn div(a: i32, b: i32) i32 {
    if (a >= 0) return @divTrunc(a + (b >> 1), b);
    return -@divTrunc(-a + (b >> 1), b);
}

const Bits = struct {
    quant: *const Quant,
    out: *std.ArrayList(u8),
    gpa: std.mem.Allocator,
    bits: u32 = 0,
    nbits: u32 = 0,

    fn emit(e: *Bits, bits_in: u32, nbits_in: u32) !void {
        const nbits = nbits_in + e.nbits;
        var bits = bits_in << @intCast(32 - nbits);
        bits |= e.bits;
        var n = nbits;
        while (n >= 8) {
            const b: u8 = @truncate(bits >> 24);
            try e.out.append(e.gpa, b);
            if (b == 0xff) try e.out.append(e.gpa, 0);
            bits <<= 8;
            n -= 8;
        }
        e.bits = bits;
        e.nbits = n;
    }

    fn emitHuff(e: *Bits, h: usize, value: i32) !void {
        const x = huff_lut[h][@intCast(value)];
        try e.emit(x & ((1 << 24) - 1), x >> 24);
    }

    fn emitHuffRLE(e: *Bits, h: usize, run: i32, value: i32) !void {
        var a = value;
        var b = value;
        if (a < 0) {
            a = -value;
            b = value - 1;
        }
        const nbits: u32 = if (a < 0x100) bit_count[@intCast(a)] else 8 + @as(u32, bit_count[@intCast(a >> 8)]);
        try e.emitHuff(h, run << 4 | @as(i32, @intCast(nbits)));
        if (nbits > 0) try e.emit(@as(u32, @bitCast(b)) & ((@as(u32, 1) << @intCast(nbits)) - 1), nbits);
    }

    fn writeBlock(e: *Bits, b: *Block, q: usize, prev_dc: i32) !i32 {
        fdct(b);
        const dc = div(b[0], 8 * @as(i32, e.quant[q][0]));
        try e.emitHuffRLE(2 * q, 0, dc - prev_dc);
        const h = 2 * q + 1;
        var run: i32 = 0;
        for (1..64) |zig| {
            const ac = div(b[unzig[zig]], 8 * @as(i32, e.quant[q][zig]));
            if (ac == 0) {
                run += 1;
            } else {
                while (run > 15) {
                    try e.emitHuff(h, 0xf0);
                    run -= 16;
                }
                try e.emitHuffRLE(h, run, ac);
                run = 0;
            }
        }
        if (run > 0) try e.emitHuff(h, 0x00);
        return dc;
    }
};

// The forward DCT of Go's image/jpeg (dct.go), with its wrapping int32
// arithmetic.
fn fix(x: u64, bits: u6) i32 {
    return @truncate(@as(i64, @intCast((x + (@as(u64, 1) << (59 - bits))) >> (60 - bits))));
}
const cos1: u64 = 1130768441178740757;
const sin1: u64 = 224923827593068887;
const cos3: u64 = 958619196450722178;
const sin3: u64 = 640528868967736374;
const sqrt2: u64 = 1630477228166597777;
const sqrt2_cos6: u64 = 623956622067911264;
const sqrt2_sin6: u64 = 1506364539328854985;

inline fn box(x0: i32, x1: i32, kcos: i32, ksin: i32) [2]i32 {
    const ksum = kcos *% (x0 +% x1);
    return .{ ksum +% (ksin -% kcos) *% x1, ksum -% (kcos +% ksin) *% x0 };
}

pub fn fdct(b: *Block) void {
    // Columns: inputs UQ8.0, outputs Q10.18.
    for (0..8) |i| {
        var x0 = b[0 * 8 + i];
        var x1 = b[1 * 8 + i];
        var x2 = b[2 * 8 + i];
        var x3 = b[3 * 8 + i];
        var x4 = b[4 * 8 + i];
        var x5 = b[5 * 8 + i];
        var x6 = b[6 * 8 + i];
        var x7 = b[7 * 8 + i];
        var t = x0;
        x0 = t +% x7;
        x7 = t -% x7;
        t = x1;
        x1 = t +% x6;
        x6 = t -% x6;
        t = x2;
        x2 = t +% x5;
        x5 = t -% x5;
        t = x3;
        x3 = t +% x4;
        x4 = t -% x4;
        var r = box(x4, x7, fix(cos3, 18), fix(sin3, 18));
        x4 = r[0];
        x7 = r[1];
        r = box(x5, x6, fix(cos1, 18), fix(sin1, 18));
        x5 = r[0];
        x6 = r[1];
        t = x0;
        x0 = t +% x3;
        x3 = t -% x3;
        t = x1;
        x1 = t +% x2;
        x2 = t -% x2;
        r = box(x2, x3, fix(sqrt2_cos6, 18), fix(sqrt2_sin6, 18));
        x2 = r[0];
        x3 = r[1];
        t = x0;
        x0 = t +% x1;
        x1 = t -% x1;
        b[0 * 8 + i] = (x0 -% 128 * 8) << 18;
        b[4 * 8 + i] = x1 << 18;
        b[2 * 8 + i] = x2;
        b[6 * 8 + i] = x3;
        t = x4;
        x4 = t +% x6;
        x6 = t -% x6;
        t = x7;
        x7 = t +% x5;
        x5 = t -% x5;
        x5 = (x5 >> 12) *% fix(sqrt2, 12);
        x6 = (x6 >> 12) *% fix(sqrt2, 12);
        t = x7;
        x7 = t +% x4;
        x4 = t -% x4;
        b[1 * 8 + i] = x7;
        b[3 * 8 + i] = x5;
        b[5 * 8 + i] = x6;
        b[7 * 8 + i] = x4;
    }
    // Rows: inputs Q10.18, outputs Q13.0.
    for (0..8) |i| {
        const x = b[8 * i .. 8 * i + 8];
        var x0 = x[0];
        var x1 = x[1];
        var x2 = x[2];
        var x3 = x[3];
        var x4 = x[4];
        var x5 = x[5];
        var x6 = x[6];
        var x7 = x[7];
        var t = x0;
        x0 = t +% x7;
        x7 = t -% x7;
        t = x1;
        x1 = t +% x6;
        x6 = t -% x6;
        t = x2;
        x2 = t +% x5;
        x5 = t -% x5;
        t = x3;
        x3 = t +% x4;
        x4 = t -% x4;
        var r = box(x4 >> 14, x7 >> 14, fix(cos3, 14), fix(sin3, 14));
        x4 = r[0];
        x7 = r[1];
        r = box(x5 >> 14, x6 >> 14, fix(cos1, 14), fix(sin1, 14));
        x5 = r[0];
        x6 = r[1];
        t = x0;
        x0 = t +% x3;
        x3 = t -% x3;
        t = x1;
        x1 = t +% x2;
        x2 = t -% x2;
        r = box(x2 >> 14, x3 >> 14, fix(sqrt2_cos6, 14), fix(sqrt2_sin6, 14));
        x2 = r[0];
        x3 = r[1];
        t = x0;
        x0 = t +% x1;
        x1 = t -% x1;
        t = x4;
        x4 = t +% x6;
        x6 = t -% x6;
        t = x7;
        x7 = t +% x5;
        x5 = t -% x5;
        x5 = (x5 >> 14) *% fix(sqrt2, 14);
        x6 = (x6 >> 14) *% fix(sqrt2, 14);
        t = x7;
        x7 = t +% x4;
        x4 = t -% x4;
        const half: i32 = 1 << 17;
        x[0] = (x0 +% half) >> 18;
        x[1] = (x7 +% half) >> 18;
        x[2] = (x2 +% half) >> 18;
        x[3] = (x5 +% half) >> 18;
        x[4] = (x1 +% half) >> 18;
        x[5] = (x6 +% half) >> 18;
        x[6] = (x3 +% half) >> 18;
        x[7] = (x4 +% half) >> 18;
    }
}

fn marker(out: *std.ArrayList(u8), gpa: std.mem.Allocator, m: u8, n: usize) !void {
    try out.appendSlice(gpa, &[_]u8{ 0xff, m, @intCast(n >> 8), @truncate(n) });
}

/// Appends the JPEG of a w×h picture whose groups of plan were coded into
/// scans to out.
pub fn assemble(out: *std.ArrayList(u8), gpa: std.mem.Allocator, quant: *const Quant, w: u32, h: u32, plan: Plan, scans: []const []const u8) !void {
    var total: usize = 600;
    for (scans) |s| total += s.len + 2;
    try out.ensureUnusedCapacity(gpa, total);
    try out.appendSlice(gpa, &[_]u8{ 0xff, 0xd8 });
    try marker(out, gpa, 0xdb, 2 + 2 * (1 + 64));
    for (0..2) |i| {
        try out.append(gpa, @intCast(i));
        try out.appendSlice(gpa, &quant[i]);
    }
    try marker(out, gpa, 0xc0, 8 + 3 * 3);
    try out.appendSlice(gpa, &[_]u8{ 8, @intCast(h >> 8), @truncate(h), @intCast(w >> 8), @truncate(w), 3 });
    try out.appendSlice(gpa, &[_]u8{ 1, 0x22, 0, 2, 0x11, 1, 3, 0x11, 1 });
    var n: usize = 2;
    for (huff_spec) |s| n += 1 + 16 + s.value.len;
    try marker(out, gpa, 0xc4, n);
    for (huff_spec, 0..) |s, i| {
        try out.append(gpa, "\x00\x10\x01\x11"[i]);
        try out.appendSlice(gpa, &s.count);
        try out.appendSlice(gpa, s.value);
    }
    if (plan.groups > 1) {
        const mcus = plan.rows * plan.cols;
        try out.appendSlice(gpa, &[_]u8{ 0xff, 0xdd, 0x00, 0x04, @intCast(mcus >> 8), @truncate(mcus) });
    }
    try out.appendSlice(gpa, &sos_header);
    for (scans, 0..) |s, g| {
        try out.appendSlice(gpa, s);
        if (g + 1 < scans.len) try out.appendSlice(gpa, &[_]u8{ 0xff, 0xd0 + @as(u8, @intCast(g % 8)) });
    }
    try out.appendSlice(gpa, &[_]u8{ 0xff, 0xd9 });
}

/// Encodes a picture in one thread, all groups in turn (tests and small
/// pictures).
pub fn encode(out: *std.ArrayList(u8), gpa: std.mem.Allocator, pix: []const u8, stride: usize, w: u32, h: u32, quality: i32, parts: u32) !void {
    if (w == 0 or h == 0 or w >= 1 << 16 or h >= 1 << 16) return error.BadSize;
    if (stride < w * 4 or pix.len < (h - 1) * stride + w * 4) return error.ShortBuffer;
    const quant = quantTables(quality);
    const plan = Plan.of(w, h, parts);
    const pic: Picture = .{ .pix = pix, .stride = stride, .w = w, .h = h };
    var scans = try gpa.alloc(std.ArrayList(u8), plan.groups);
    defer {
        for (scans) |*s| s.deinit(gpa);
        gpa.free(scans);
    }
    for (scans) |*s| s.* = .empty;
    const views = try gpa.alloc([]const u8, plan.groups);
    defer gpa.free(views);
    for (0..plan.groups) |g| {
        const r = plan.range(@intCast(g));
        try pic.scan(&quant, r.from, r.to, plan.cols, &scans[g], gpa);
        views[g] = scans[g].items;
    }
    try assemble(out, gpa, &quant, w, h, plan, views);
}

const testing = std.testing;

fn testPicture(gpa: std.mem.Allocator, w: u32, h: u32) ![]u8 {
    const pix = try gpa.alloc(u8, w * h * 4);
    var x: u32 = 0;
    while (x < w * h) : (x += 1) {
        const px = x % w;
        const py = x / w;
        pix[x * 4 + 0] = @truncate(px * 7 + py);
        pix[x * 4 + 1] = @truncate(py * 3);
        pix[x * 4 + 2] = @truncate((px ^ py) * 5);
        pix[x * 4 + 3] = 0;
    }
    return pix;
}

// The vectors are what the Go agent's jpegstrip writes for the same
// pixels (testdata/jpeg, written by scripts/gui-helper/testdata/gen.go).
test "the same bytes as the Go agent's encoder" {
    const gpa = testing.allocator;
    inline for (.{ .{ 37, 21, 1, "jpeg-37x21-1.jpg" }, .{ 100, 70, 3, "jpeg-100x70-3.jpg" }, .{ 64, 64, 8, "jpeg-64x64-8.jpg" } }) |c| {
        const pix = try testPicture(gpa, c[0], c[1]);
        defer gpa.free(pix);
        var out: std.ArrayList(u8) = .empty;
        defer out.deinit(gpa);
        try encode(&out, gpa, pix, c[0] * 4, c[0], c[1], 85, c[2]);
        try testing.expectEqualSlices(u8, @embedFile("testdata/" ++ c[3]), out.items);
    }
}

test "bad sizes are refused" {
    var out: std.ArrayList(u8) = .empty;
    defer out.deinit(testing.allocator);
    try testing.expectError(error.BadSize, encode(&out, testing.allocator, &.{}, 0, 0, 1, 85, 1));
    try testing.expectError(error.ShortBuffer, encode(&out, testing.allocator, &@as([8]u8, @splat(0)), 8, 2, 2, 85, 1));
}

test "plan" {
    const p = Plan.of(2500, 1000, 8);
    try testing.expectEqual(@as(u32, 157), p.cols);
    try testing.expectEqual(@as(u32, 63), p.mcu_rows);
    try testing.expectEqual(@as(u32, 8), p.rows);
    try testing.expectEqual(@as(u32, 8), p.groups);
}
