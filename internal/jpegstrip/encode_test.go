package jpegstrip

import (
	"bytes"
	"image"
	"image/jpeg"
	"math/rand/v2"
	"runtime"
	"testing"
)

// scene is a w×h BGRX picture with gradients, noise and sharp edges, with
// stride bytes per row (padding filled with garbage).
func scene(w, h, stride int) []byte {
	r := rand.New(rand.NewPCG(1, 2))
	pix := make([]byte, h*stride)
	for i := range pix {
		pix[i] = byte(r.IntN(256))
	}
	for y := 0; y < h; y++ {
		for x := 0; x < w; x++ {
			o := y*stride + x*4
			switch {
			case x < w/3: // text-like marks
				v := byte(30)
				if (x/3+y/5)%4 == 0 {
					v = 230
				}
				pix[o], pix[o+1], pix[o+2] = v, v, v
			case y < h/2: // gradient
				pix[o], pix[o+1], pix[o+2] = byte(x), byte(y), byte(x+y)
			default: // noise stays
			}
		}
	}
	return pix
}

func rgbaOf(pix []byte, stride, w, h int) *image.RGBA {
	img := image.NewRGBA(image.Rect(0, 0, w, h))
	for y := 0; y < h; y++ {
		for x := 0; x < w; x++ {
			s, d := pix[y*stride+x*4:], img.Pix[y*img.Stride+x*4:]
			d[0], d[1], d[2], d[3] = s[2], s[1], s[0], 0xff
		}
	}
	return img
}

func TestSameAsImageJPEG(t *testing.T) {
	for _, sz := range [][3]int{{1, 1, 4}, {17, 9, 80}, {64, 48, 256}, {333, 251, 1400}} {
		w, h, stride := sz[0], sz[1], sz[2]
		pix := scene(w, h, stride)
		for _, q := range []int{1, 50, 85, 100} {
			var want bytes.Buffer
			if err := jpeg.Encode(&want, rgbaOf(pix, stride, w, h), &jpeg.Options{Quality: q}); err != nil {
				t.Fatal(err)
			}
			got, err := Encode(nil, pix, stride, w, h, q, 1)
			if err != nil {
				t.Fatal(err)
			}
			if !bytes.Equal(got, want.Bytes()) {
				t.Errorf("%dx%d q%d: %d bytes, image/jpeg %d", w, h, q, len(got), want.Len())
			}
		}
	}
}

// Groups decode to the same pixels as one group: restart intervals change
// only how DC values are predicted.
func TestGroupsDecodeTheSame(t *testing.T) {
	w, h, stride := 1706, 960, 1706*4
	pix := scene(w, h, stride)
	one, _ := Encode(nil, pix, stride, w, h, 85, 1)
	ref, err := jpeg.Decode(bytes.NewReader(one))
	if err != nil {
		t.Fatal(err)
	}
	for _, parts := range []int{2, 7, 8, 16, 60, 1000} {
		b, err := Encode(nil, pix, stride, w, h, 85, parts)
		if err != nil {
			t.Fatal(err)
		}
		img, err := jpeg.Decode(bytes.NewReader(b))
		if err != nil {
			t.Fatalf("%d parts: %v", parts, err)
		}
		if !bytes.Equal(img.(*image.YCbCr).Y, ref.(*image.YCbCr).Y) || !bytes.Equal(img.(*image.YCbCr).Cb, ref.(*image.YCbCr).Cb) || !bytes.Equal(img.(*image.YCbCr).Cr, ref.(*image.YCbCr).Cr) {
			t.Errorf("%d parts decode differently", parts)
		}
		if len(b) > len(one)*102/100 {
			t.Errorf("%d parts: %d bytes, one part %d", parts, len(b), len(one))
		}
	}
}

func TestBadInput(t *testing.T) {
	if _, err := Encode(nil, make([]byte, 10), 8, 2, 2, 85, 1); err == nil {
		t.Error("short buffer accepted")
	}
	if _, err := Encode(nil, nil, 0, 0, 0, 85, 1); err == nil {
		t.Error("empty picture accepted")
	}
}

func BenchmarkEncode(b *testing.B) {
	w, h := 1706, 960
	pix := scene(w, h, w*4)
	for _, parts := range []int{1, runtime.GOMAXPROCS(0)} {
		b.Run(map[bool]string{true: "serial", false: "parallel"}[parts == 1], func(b *testing.B) {
			var out []byte
			for b.Loop() {
				out, _ = Encode(out[:0], pix, w*4, w, h, 85, parts)
			}
			b.SetBytes(int64(w * h * 4))
		})
	}
	b.Run("image/jpeg", func(b *testing.B) {
		img := rgbaOf(pix, w*4, w, h)
		var buf bytes.Buffer
		for b.Loop() {
			buf.Reset()
			jpeg.Encode(&buf, img, &jpeg.Options{Quality: 85})
		}
	})
}
