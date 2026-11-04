// Copyright 2011 The Go Authors. All rights reserved.
// Use of this source code is governed by a BSD-style
// license that can be found in the LICENSE file of the Go distribution
// (reproduced in THIRD_PARTY_NOTICES.md).

// The forward DCT of Go's image/jpeg (src/image/jpeg/dct.go), unchanged.

package jpegstrip

// Constants needed for the implementation.
// These are all 60-bit precision fixed-point constants.
// The function c(val, b) rounds the constant to b bits.
// c is simple enough that calls to it with constant args
// are inlined and constant-propagated down to an inline constant.
// Each constant is commented with its Ivy definition (see robpike.io/ivy),
// using this scaling helper function:
//
//	op fix x = floor 0.5 + x * 2**60
const (
	cos1          = 1130768441178740757 // fix cos 1*pi/16
	sin1          = 224923827593068887  // fix sin 1*pi/16
	cos3          = 958619196450722178  // fix cos 3*pi/16
	sin3          = 640528868967736374  // fix sin 3*pi/16
	sqrt2         = 1630477228166597777 // fix sqrt 2
	sqrt2_cos6    = 623956622067911264  // fix (sqrt 2)*cos 6*pi/16
	sqrt2_sin6    = 1506364539328854985 // fix (sqrt 2)*sin 6*pi/16
	sqrt2inv      = 815238614083298888  // fix 1/sqrt 2
	sqrt2inv_cos6 = 311978311033955632  // fix (1/sqrt 2)*cos 6*pi/16
	sqrt2inv_sin6 = 753182269664427492  // fix (1/sqrt 2)*sin 6*pi/16
)

func c(x uint64, bits int) int32 {
	return int32((x + (1 << (59 - bits))) >> (60 - bits))
}

// fdct implements the forward DCT.
// Inputs are UQ8.0; outputs are Q13.0.
func fdct(b *block) {
	fdctCols(b)
	fdctRows(b)
}

// fdctCols applies the 1D DCT to the columns of b.
// Inputs are UQ8.0 in [0,255] but interpreted as [-128,127].
// Outputs are Q10.18.
func fdctCols(b *block) {
	for i := range 8 {
		x0 := b[0*8+i]
		x1 := b[1*8+i]
		x2 := b[2*8+i]
		x3 := b[3*8+i]
		x4 := b[4*8+i]
		x5 := b[5*8+i]
		x6 := b[6*8+i]
		x7 := b[7*8+i]

		// x[01234567] are UQ8.0 in [0,255].

		// Stage 1: four butterflies.
		// In general a butterfly of QN.M inputs produces Q(N+1).M outputs.
		// A butterfly of UQN.M inputs produces a UQ(N+1).M sum and a QN.M difference.

		x0, x7 = x0+x7, x0-x7
		x1, x6 = x1+x6, x1-x6
		x2, x5 = x2+x5, x2-x5
		x3, x4 = x3+x4, x3-x4
		// x[0123] now UQ9.0 in [0, 510].
		// x[4567] now Q8.0 in [-255,255].

		// Stage 2: two boxes and two butterflies.
		// A box on QN.M inputs with B-bit constants
		// produces Q(N+1).(M+B) outputs.
		// (The +1 is from the addition.)

		x4, x7 = dctBox(x4, x7, c(cos3, 18), c(sin3, 18))
		x5, x6 = dctBox(x5, x6, c(cos1, 18), c(sin1, 18))
		// x[47] now Q9.18 in [-354, 354].
		// x[56] now Q9.18 in [-300, 300].

		x0, x3 = x0+x3, x0-x3
		x1, x2 = x1+x2, x1-x2
		// x[01] now UQ10.0 in [0, 1020].
		// x[23] now Q9.0 in [-510, 510].

		// Stage 3: one box and three butterflies.

		x2, x3 = dctBox(x2, x3, c(sqrt2_cos6, 18), c(sqrt2_sin6, 18))
		// x[23] now Q10.18 in [-943, 943].

		x0, x1 = x0+x1, x0-x1
		// x0 now UQ11.0 in [0, 2040].
		// x1 now Q10.0 in [-1020, 1020].

		// Store x0, x1, x2, x3 to their permuted targets.
		// The original +128 in every input value
		// has cancelled out except in the “DC signal” x0.
		// Subtracting 128*8 here is equivalent to subtracting 128
		// from every input before we started, but cheaper.
		// It also converts x0 from UQ11.18 to Q10.18.
		b[0*8+i] = (x0 - 128*8) << 18
		b[4*8+i] = x1 << 18
		b[2*8+i] = x2
		b[6*8+i] = x3

		x4, x6 = x4+x6, x4-x6
		x7, x5 = x7+x5, x7-x5
		// x[4567] now Q10.18 in [-654, 654].

		// Stage 4: two √2 scalings and one butterfly.

		x5 = (x5 >> 12) * c(sqrt2, 12)
		x6 = (x6 >> 12) * c(sqrt2, 12)
		// x[56] still Q10.18 in [-925, 925] (= 654√2).
		x7, x4 = x7+x4, x7-x4
		// x[47] still Q10.18 in [-925, 925] (not Q11.18!).
		// This is not obvious at all! See “Note on 925” below.

		// Store x4 x5 x6 x7 to their permuted targets.
		b[1*8+i] = x7
		b[3*8+i] = x5
		b[5*8+i] = x6
		b[7*8+i] = x4
	}
}

// fdctRows applies the 1D DCT to the rows of b.
// Inputs are Q10.18; outputs are Q13.0.
func fdctRows(b *block) {
	for i := range 8 {
		x := b[8*i : 8*i+8 : 8*i+8]
		x0 := x[0]
		x1 := x[1]
		x2 := x[2]
		x3 := x[3]
		x4 := x[4]
		x5 := x[5]
		x6 := x[6]
		x7 := x[7]

		// x[01234567] are Q10.18 [-1020, 1020].

		// Stage 1: four butterflies.

		x0, x7 = x0+x7, x0-x7
		x1, x6 = x1+x6, x1-x6
		x2, x5 = x2+x5, x2-x5
		x3, x4 = x3+x4, x3-x4
		// x[01234567] now Q11.18 in [-2040, 2040].

		// Stage 2: two boxes and two butterflies.

		x4, x7 = dctBox(x4>>14, x7>>14, c(cos3, 14), c(sin3, 14))
		x5, x6 = dctBox(x5>>14, x6>>14, c(cos1, 14), c(sin1, 14))
		// x[47] now Q12.18 in [-2830, 2830].
		// x[56] now Q12.18 in [-2400, 2400].
		x0, x3 = x0+x3, x0-x3
		x1, x2 = x1+x2, x1-x2
		// x[01234567] now Q12.18 in [-4080, 4080].

		// Stage 3: one box and three butterflies.

		x2, x3 = dctBox(x2>>14, x3>>14, c(sqrt2_cos6, 14), c(sqrt2_sin6, 14))
		// x[23] now Q13.18 in [-7539, 7539].
		x0, x1 = x0+x1, x0-x1
		// x[01] now Q13.18 in [-8160, 8160].
		x4, x6 = x4+x6, x4-x6
		x7, x5 = x7+x5, x7-x5
		// x[4567] now Q13.18 in [-5230, 5230].

		// Stage 4: two √2 scalings and one butterfly.

		x5 = (x5 >> 14) * c(sqrt2, 14)
		x6 = (x6 >> 14) * c(sqrt2, 14)
		// x[56] still Q13.18 in [-7397, 7397] (= 5230√2).
		x7, x4 = x7+x4, x7-x4
		// x[47] still Q13.18 in [-7395, 7395] (= 2040*3.6246).
		// See “Note on 925” below.

		// Cut from Q13.18 to Q13.0.
		x0 = (x0 + 1<<17) >> 18
		x1 = (x1 + 1<<17) >> 18
		x2 = (x2 + 1<<17) >> 18
		x3 = (x3 + 1<<17) >> 18
		x4 = (x4 + 1<<17) >> 18
		x5 = (x5 + 1<<17) >> 18
		x6 = (x6 + 1<<17) >> 18
		x7 = (x7 + 1<<17) >> 18

		// Note: Unlike in fdctCols, saved all stores for the end
		// because they are adjacent memory locations and some systems
		// can use multiword stores.
		x[0] = x0
		x[1] = x7
		x[2] = x2
		x[3] = x5
		x[4] = x1
		x[5] = x6
		x[6] = x3
		x[7] = x4
	}
}

func dctBox(x0, x1, kcos, ksin int32) (y0, y1 int32) {
	// y0 = x0*kcos + x1*ksin
	// y1 = -x0*ksin + x1*kcos
	ksum := kcos * (x0 + x1)
	y0 = ksum + (ksin-kcos)*x1
	y1 = ksum - (kcos+ksin)*x0
	return y0, y1
}
