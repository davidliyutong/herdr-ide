// Copyright 2011 The Go Authors. All rights reserved.
// Use of this source code is governed by a BSD-style
// license that can be found in the LICENSE file of the Go distribution
// (reproduced in THIRD_PARTY_NOTICES.md).

// Package jpegstrip encodes pictures of program windows as baseline JPEG
// (4:2:0, the standard Huffman tables of section K.3 of the spec). It reads
// 32-bit BGRX rows as X servers hand them out and entropy-codes groups of
// rows at the same time; each group but the last ends with a restart
// marker, so the result is one ordinary JPEG that every decoder reads.
//
// It is Go's image/jpeg encoder (src/image/jpeg/writer.go) with the colour
// conversion reading BGRX and the scan split into restart intervals. For a
// single group the output is byte for byte what image/jpeg writes for the
// same pixels, and every group count decodes to the same pixels.
package jpegstrip

import (
	"errors"
	"image/color"
	"sync"
)

const (
	dqtMarker  = 0xdb
	sof0Marker = 0xc0
	dhtMarker  = 0xc4
	driMarker  = 0xdd
	rst0Marker = 0xd0
)

// Encode appends the JPEG of the w×h picture in pix (stride bytes per row,
// 4 bytes per pixel: blue, green, red, unused) at quality 1 to 100 to dst.
// The picture is cut into at most parts groups of 16-pixel rows, coded at
// the same time.
func Encode(dst, pix []byte, stride, w, h, quality, parts int) ([]byte, error) {
	if w <= 0 || h <= 0 || w >= 1<<16 || h >= 1<<16 {
		return dst, errors.New("jpegstrip: bad size")
	}
	if stride < w*4 || len(pix) < (h-1)*stride+w*4 {
		return dst, errors.New("jpegstrip: short pixel buffer")
	}
	quant := quantTables(quality)
	mcuCols, mcuRows := (w+15)/16, (h+15)/16
	parts = max(1, min(parts, mcuRows))
	rows := (mcuRows + parts - 1) / parts
	// The restart interval counts MCUs in 16 bits.
	if rows*mcuCols > 0xffff {
		rows = max(1, 0xffff/mcuCols)
	}
	groups := (mcuRows + rows - 1) / rows
	scans := make([][]byte, groups)
	img := picture{pix: pix, stride: stride, w: w, h: h}
	code := func(g int) {
		scans[g] = img.scan(&quant, g*rows, min((g+1)*rows, mcuRows), mcuCols)
	}
	if groups == 1 {
		code(0)
	} else {
		var wg sync.WaitGroup
		for g := range groups {
			wg.Add(1)
			go func() {
				defer wg.Done()
				code(g)
			}()
		}
		wg.Wait()
	}

	dst = append(dst, 0xff, 0xd8) // Start Of Image
	dst = appendDQT(dst, &quant)
	dst = appendSOF0(dst, w, h)
	dst = appendDHT(dst)
	if groups > 1 {
		n := rows * mcuCols
		dst = append(dst, 0xff, driMarker, 0x00, 0x04, byte(n>>8), byte(n))
	}
	dst = append(dst, sosHeaderYCbCr...)
	for g, s := range scans {
		dst = append(dst, s...)
		if g < groups-1 {
			dst = append(dst, 0xff, rst0Marker+byte(g%8))
		}
	}
	return append(dst, 0xff, 0xd9), nil // End Of Image
}

// quantTables scales the tables for a quality, as image/jpeg does.
func quantTables(quality int) (q [nQuantIndex][blockSize]byte) {
	quality = max(1, min(quality, 100))
	var s int
	if quality < 50 {
		s = 5000 / quality
	} else {
		s = 200 - quality*2
	}
	for i := range q {
		for j := range q[i] {
			x := (int(unscaledQuant[i][j])*s + 50) / 100
			q[i][j] = uint8(max(1, min(x, 255)))
		}
	}
	return q
}

func appendMarker(dst []byte, marker uint8, n int) []byte {
	return append(dst, 0xff, marker, byte(n>>8), byte(n))
}

func appendDQT(dst []byte, quant *[nQuantIndex][blockSize]byte) []byte {
	dst = appendMarker(dst, dqtMarker, 2+int(nQuantIndex)*(1+blockSize))
	for i := range quant {
		dst = append(dst, byte(i))
		dst = append(dst, quant[i][:]...)
	}
	return dst
}

func appendSOF0(dst []byte, w, h int) []byte {
	dst = appendMarker(dst, sof0Marker, 8+3*3)
	dst = append(dst, 8, byte(h>>8), byte(h), byte(w>>8), byte(w), 3)
	// 4:2:0: luminance 2×2, chrominance 1×1.
	return append(dst, 1, 0x22, 0, 2, 0x11, 1, 3, 0x11, 1)
}

func appendDHT(dst []byte) []byte {
	n := 2
	for _, s := range theHuffmanSpec {
		n += 1 + 16 + len(s.value)
	}
	dst = appendMarker(dst, dhtMarker, n)
	for i, s := range theHuffmanSpec {
		dst = append(dst, "\x00\x10\x01\x11"[i])
		dst = append(dst, s.count[:]...)
		dst = append(dst, s.value...)
	}
	return dst
}

type picture struct {
	pix    []byte
	stride int
	w, h   int
}

// scan entropy-codes the MCU rows [from, to), starting a restart interval:
// DC predictions start from zero and the last byte is padded with ones.
func (p *picture) scan(quant *[nQuantIndex][blockSize]byte, from, to, cols int) []byte {
	e := bits{quant: quant, buf: make([]byte, 0, (to-from)*cols*16*16/8)}
	var (
		b                           block
		cb, cr                      [4]block
		prevDCY, prevDCCb, prevDCCr int32
	)
	for my := from; my < to; my++ {
		for mx := 0; mx < cols; mx++ {
			for i := 0; i < 4; i++ {
				xOff := (i & 1) * 8
				yOff := (i & 2) * 4
				p.toYCbCr(mx*16+xOff, my*16+yOff, &b, &cb[i], &cr[i])
				prevDCY = e.writeBlock(&b, 0, prevDCY)
			}
			scale(&b, &cb)
			prevDCCb = e.writeBlock(&b, 1, prevDCCb)
			scale(&b, &cr)
			prevDCCr = e.writeBlock(&b, 1, prevDCCr)
		}
	}
	// Pad the last byte with 1's.
	e.emit(0x7f, 7)
	return e.buf
}

// toYCbCr converts the 8x8 region whose top-left corner is (x, y) to its
// YCbCr values, repeating the last column and row past the edges (image/jpeg's
// rgbaToYCbCr reading BGRX).
func (p *picture) toYCbCr(x, y int, yBlock, cbBlock, crBlock *block) {
	xmax, ymax := p.w-1, p.h-1
	for j := 0; j < 8; j++ {
		row := p.pix[min(y+j, ymax)*p.stride:]
		for i := 0; i < 8; i++ {
			px := row[min(x+i, xmax)*4:]
			yy, cb, cr := color.RGBToYCbCr(px[2], px[1], px[0])
			yBlock[8*j+i] = int32(yy)
			cbBlock[8*j+i] = int32(cb)
			crBlock[8*j+i] = int32(cr)
		}
	}
}

// bits accumulates the entropy-coded data of one restart interval.
type bits struct {
	quant       *[nQuantIndex][blockSize]byte
	buf         []byte
	bits, nBits uint32
}

// emit emits the least significant nBits bits of bits to the bit-stream.
// The precondition is bits < 1<<nBits && nBits <= 16.
func (e *bits) emit(bits, nBits uint32) {
	nBits += e.nBits
	bits <<= 32 - nBits
	bits |= e.bits
	for nBits >= 8 {
		b := uint8(bits >> 24)
		e.buf = append(e.buf, b)
		if b == 0xff {
			e.buf = append(e.buf, 0x00)
		}
		bits <<= 8
		nBits -= 8
	}
	e.bits, e.nBits = bits, nBits
}

// emitHuff emits the given value with the given Huffman encoder.
func (e *bits) emitHuff(h huffIndex, value int32) {
	x := theHuffmanLUT[h][value]
	e.emit(x&(1<<24-1), x>>24)
}

// emitHuffRLE emits a run of runLength copies of value encoded with the given
// Huffman encoder.
func (e *bits) emitHuffRLE(h huffIndex, runLength, value int32) {
	a, b := value, value
	if a < 0 {
		a, b = -value, value-1
	}
	var nBits uint32
	if a < 0x100 {
		nBits = uint32(bitCount[a])
	} else {
		nBits = 8 + uint32(bitCount[a>>8])
	}
	e.emitHuff(h, runLength<<4|int32(nBits))
	if nBits > 0 {
		e.emit(uint32(b)&(1<<nBits-1), nBits)
	}
}

// writeBlock writes a block of pixel data using the given quantization table,
// returning the post-quantized DC value of the DCT-transformed block. b is in
// natural (not zig-zag) order.
func (e *bits) writeBlock(b *block, q quantIndex, prevDC int32) int32 {
	fdct(b)
	// Emit the DC delta.
	dc := div(b[0], 8*int32(e.quant[q][0]))
	e.emitHuffRLE(huffIndex(2*q+0), 0, dc-prevDC)
	// Emit the AC components.
	h, runLength := huffIndex(2*q+1), int32(0)
	for zig := 1; zig < blockSize; zig++ {
		ac := div(b[unzig[zig]], 8*int32(e.quant[q][zig]))
		if ac == 0 {
			runLength++
		} else {
			for runLength > 15 {
				e.emitHuff(h, 0xf0)
				runLength -= 16
			}
			e.emitHuffRLE(h, runLength, ac)
			runLength = 0
		}
	}
	if runLength > 0 {
		e.emitHuff(h, 0x00)
	}
	return dc
}
